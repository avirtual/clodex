import asyncio
import atexit
import collections
import hashlib
import html
import itertools
import json
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route

from proxylab import core as core_mod
from proxylab import store as store_mod
from proxylab import writer as writer_mod

# --- prefix-warmth ledger (SQLite-backed, TWO-STATE) ---------------------------
# Records, per cached message-prefix, WHEN it was last stamped and at what TTL,
# so a separate consumer (statusline / hook / pinger / compact-strip) can answer
# "is this conversation's prefix still warm?" — something a per-session JSONL
# can't know, because warmth lives on the CONTENT-ADDRESSED prefix the backend
# caches, which a forked keep-alive ping shares but never writes back to the
# original session's transcript. So the proxy LEARNS it from response receipts
# and stores it here. (Persistence: proxylab.store — warmth rows are the
# GLOBAL-scope tenant there, keyed by prefix hash, shared across ports.)
#
# TWO-STATE SEMANTICS (2026-06-09 decision; replaces warm/cold/unknown): the
# expiry predicate IS the answer. warm = row exists AND expires_at > now;
# everything else is not-warm. Because the store is durable and stamps every
# response-confirmed cache event, absence ≈ expiry, so the compact-strip gate
# may act on absence without the old third 'unknown' state. The gates:
#   * ping  IFF warm   (anything else declines — never higher cost)
#   * strip IFF NOT warm ('cold'/'absent'); store 'error' or ledger 'off'
#     decline (can't judge -> take that gate's no-action path)
# warmth_state() still reports 'cold' (lapsed row not yet purged) vs 'absent'
# (no row) for OBSERVABILITY only — no gate distinguishes them.
#
# EXPIRY IS THE GC: correctness lives in the read predicate (expires_at > now),
# never in row deletion. The background sweep only reclaims disk space, with a
# generous slack, and may run late or never without changing any gate decision.
# (This deletes the old semantic sweeper, whose eager reaping at bare ttl erased
# the very cold-evidence the three-state compact gate needed — the bug that
# motivated the two-state redesign.)
WARMTH_LEDGER = os.environ.get("WARMTH_LEDGER", "1") not in ("0", "no", "off", "false")
WARMTH_LOG_FILE = os.environ.get("WARMTH_LOG_FILE", "1") not in ("0", "no", "off", "false")
WARMTH_PING_SENTINEL = os.environ.get("WARMTH_PING_SENTINEL")  # tail-msg marker => keep-warm ping
# A keep-warm ping exists to REFRESH a still-warm prefix before it lapses. On any
# NOT-warm prefix (lapsed, never seen, store error), forwarding the ping would
# cold-WRITE the discarded prefix at the write premium — the precise event the
# ping was meant to forestall, with nothing recovered. So forward IFF warm;
# everything else short-circuits with a synthetic end_turn (0 tokens).
WARMTH_BLOCK_COLD_PING = os.environ.get("WARMTH_BLOCK_COLD_PING") in (
    "1", "yes", "on", "true")
# this module's tables (see proxylab.store ownership rule): the ledger itself
# + the session->latest-head-hash index that lets /_warm resolve by session_id.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS warmth ("
    "hash TEXT PRIMARY KEY, stamped_at REAL NOT NULL, "
    "ttl INTEGER NOT NULL, expires_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS session_head ("
    "session_id TEXT PRIMARY KEY, hash TEXT NOT NULL, "
    "updated_at REAL NOT NULL)",
    # segment index (2026-06-12): the session's last-seen leading-breakpoint
    # hashes (marker 1 = tools, marker 2 = tools+system) — display-grade only,
    # see _segment_hashes. Additive migration.
    "ALTER TABLE session_head ADD COLUMN tools_hash TEXT",
    "ALTER TABLE session_head ADD COLUMN sys_hash TEXT",
    # cold-resume counter (2026-06-13): how many real turns landed on a LAPSED
    # head — i.e. the cache went cold between turns and the backend re-wrote the
    # whole prefix. A bursty long-lived session pays the write premium once per
    # resume; this counts that waste. Additive migration; old rows -> 0.
    # NOTE (2026-07-06): cold_resumes == the `lapse` bust class in session_bust
    # below; the bust classifier subsumes it (lapse is one of five classes). Kept
    # as the historical column, but /_status now surfaces the richer bust summary.
    "ALTER TABLE session_head ADD COLUMN cold_resumes INTEGER NOT NULL DEFAULT 0",
    # msg0 hash (2026-07-06): the session's last-seen hash of messages[0] (the
    # CLI's static context bundle — claudeMd / userEmail / currentDate / scratchpad
    # UUID). Lets the bust classifier split a PREAMBLE bust (messages[0] changed →
    # whole history re-writes, tools+system survive) from a CONVERSATION bust (a
    # mid-history message changed while msg0 held). Additive; old rows -> NULL.
    "ALTER TABLE session_head ADD COLUMN msg0_hash TEXT",
    # full-system hash (2026-07-06): the session's last-seen hash of the WHOLE
    # system[] array (billing header excluded), NOT just the marked segment. The
    # classifier's system check compares this so a change in a system block PAST
    # the last cache marker (e.g. our own trailing `[wirescope]` injection, or any
    # layout with the system prompt past the final marker) files as a `system`
    # bust, never a false `conversation`. Additive; old rows -> NULL. See
    # _sys_full_hash / _classify_bust. (The marked-segment hashes stay in
    # session_head.sys_hash for cross-session warmth sharing — different job.)
    "ALTER TABLE session_head ADD COLUMN sysfull_hash TEXT",
    # message count (2026-07-06): the session's last-seen len(messages[]). Normal
    # turns only GROW it; a sharp contraction on the same session (unchanged static
    # prefix) is a /compact collapsing the thread to a summary — the signal that
    # splits a benign `compact` from a `conversation` flap. Additive; old rows -> NULL.
    "ALTER TABLE session_head ADD COLUMN msg_count INTEGER",
    # REAL-BUST counter (2026-07-06): per-session cumulative count of turns whose
    # write landed UPSTREAM of the prior cache end (previously-cached tokens
    # invalidated + re-paid at the write premium) — NOT the normal tail-append
    # write every turn pays. Classified by WHERE the prefix first diverged, in
    # cache order: tools (total bust) / system (near-total) / preamble (messages[0])
    # / conversation (mid-history turn edited IN PLACE — usually an L2 transform
    # flapping = our bug) / compact (history contracted to a summary — expected,
    # benign) / lapse (cache timed out, byte-identical bytes, time-caused → keep-warm,
    # not peelable). The counter is the live per-request twin of report.bust_series;
    # /_bust serves the on-demand byte-level drill-down from disk. Owned by warmth.
    # `compact` column added additively after the fact -> old DBs migrate it in.
    "CREATE TABLE IF NOT EXISTS session_bust ("
    "session_id TEXT PRIMARY KEY, "
    "tools INTEGER NOT NULL DEFAULT 0, "
    "system INTEGER NOT NULL DEFAULT 0, "
    "preamble INTEGER NOT NULL DEFAULT 0, "
    "conversation INTEGER NOT NULL DEFAULT 0, "
    "lapse INTEGER NOT NULL DEFAULT 0, "
    "last_class TEXT, last_ts REAL, last_write_tokens INTEGER)",
    "ALTER TABLE session_bust ADD COLUMN compact INTEGER NOT NULL DEFAULT 0",
    # restart-attributed sub-count (2026-07-06): of the busts in each class, how
    # many STRADDLED A PROXY RESTART — i.e. the first main-line turn after this
    # process booted, classified against a head written by the PREVIOUS process
    # (prior head.updated_at < core._START_TS). This is the DEPLOY-TAX case: a
    # forwarded-prefix change from a code/vendor bump busts every warm session
    # once on resume, then self-heals. It's a permanent on-disk fact, so without
    # this attribution a content bust amber-flags the session for life on every
    # upgrade. The consumer excludes it: a class is a REAL (actionable) content
    # bust iff count > restart_between. Mirror columns, one per _BUST_CLASSES,
    # incremented ALONGSIDE the class counter only when the bust straddled a
    # restart. Additive migration; old rows -> 0.
    "ALTER TABLE session_bust ADD COLUMN tools_restart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE session_bust ADD COLUMN system_restart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE session_bust ADD COLUMN preamble_restart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE session_bust ADD COLUMN conversation_restart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE session_bust ADD COLUMN compact_restart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE session_bust ADD COLUMN lapse_restart INTEGER NOT NULL DEFAULT 0")


def _warmth_rows(hashes):
    """{hash: (stamped_at, ttl, expires_at)} for the given hashes (one query).
    Raises on store failure — each caller maps that to its gate's safe default."""
    hashes = [h for h in hashes if h]
    if not hashes:
        return {}
    con = store_mod.db()
    with store_mod.LOCK:
        q = ",".join("?" * len(hashes))
        cur = con.execute("SELECT hash, stamped_at, ttl, expires_at FROM warmth "
                          f"WHERE hash IN ({q})", hashes)
        return {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}


def _session_head_hash(session):
    con = store_mod.db()
    with store_mod.LOCK:
        r = con.execute("SELECT hash FROM session_head WHERE session_id=?",
                        (session,)).fetchone()
    return r[0] if r else None

def _strip_cache_control(node):
    """Deep copy of a message/content node with every `cache_control` removed, so
    an unchanged message hashes IDENTICALLY turn-over-turn (the rolling marker
    hops onto the new last message each turn — if we hashed it the 'same' history
    would change and a returning session would never match)."""
    if isinstance(node, dict):
        return {k: _strip_cache_control(v) for k, v in node.items()
                if k != "cache_control"}
    if isinstance(node, list):
        return [_strip_cache_control(v) for v in node]
    return node


def _canon_message(m):
    return json.dumps(_strip_cache_control(m), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False).encode("utf-8", "replace")


def _stable_sys_text(obj):
    """System text for the warmth fingerprint, EXCLUDING the volatile per-turn
    attribution block (`x-anthropic-billing-header: ... cch=N ...`) — it changes
    every turn but is out-of-band and does NOT participate in the prompt cache, so
    folding it in would make every turn's fingerprint differ (a guaranteed miss)."""
    sys = obj.get("system")
    if isinstance(sys, list):
        return " ".join(b.get("text", "") for b in sys if isinstance(b, dict)
                        and not b.get("text", "").startswith("x-anthropic-billing-header"))
    return sys or ""


def _sys_tools_fingerprint(obj):
    """A constant lead-in standing in for the tools+system prefix. Folding it in
    means a silent model / tool-set / system-prompt change invalidates the key
    (reads cold) instead of colliding with a different real cache entry."""
    tools = obj.get("tools") or []
    parts = [obj.get("model") or "",
             ",".join(sorted(t.get("name", "") for t in tools if isinstance(t, dict))),
             _stable_sys_text(obj)]
    return ("\x1f".join(parts)).encode("utf-8", "replace")


def _msg0_hash(obj):
    """blake2b of messages[0] (the CLI's static context bundle: claudeMd /
    userEmail / currentDate / scratchpad UUID), cache_control-stripped so a moved
    rolling marker doesn't read as a change. None when there's no first message.
    The bust classifier compares this turn-over-turn to tell a PREAMBLE bust
    (messages[0] changed) from a CONVERSATION bust (a deeper message changed)."""
    msgs = obj.get("messages") or []
    if not msgs:
        return None
    h = hashlib.blake2b(digest_size=20)
    h.update(_canon_message(msgs[0]))
    return h.hexdigest()


def _sys_full_hash(obj):
    """blake2b of the WHOLE system[] array (billing header excluded — it's
    out-of-band, never cached), cache_control-stripped. The bust classifier's
    system check compares this, NOT the marked-segment hash: every system[] block
    is upstream of messages[0] and participates in the messages[0] cache
    breakpoint, so a change in a block that sits PAST the last cache marker (e.g.
    our own trailing `[wirescope]` injection, or any layout where the system
    prompt lives past the final marker) is still a SYSTEM-region bust — folding
    the full array in files it as `system`/content, never a false `conversation`
    (which would render loud/self and blame the wrong subsystem). None when there
    is no system block. (Kept separate from _segment_hashes, whose marked-boundary
    hashes drive cross-session warmth SHARING — those must stay marker-aligned.)"""
    return hashlib.blake2b(
        _stable_sys_text(obj).encode("utf-8", "replace"), digest_size=20
    ).hexdigest() if obj.get("system") else None


# ---- REAL-BUST classifier (live per-request twin of report.bust_series) -------
# A "real bust" = a turn whose write landed UPSTREAM of the prior cache end
# (previously-cached tokens invalidated + re-paid at the write premium), NOT the
# normal tail-append write every turn pays to cache its own fresh content. We
# gate on the RECEIPT (the write fraction of the priced window — the bill is
# ground truth for "was there a rewrite and how big"), then classify WHERE the
# prefix first diverged from the prior head, in cache order. Pure hash + receipt
# comparison — no body retention needed (the byte-level drill-down is /_bust,
# served on demand from disk). Returns the class string or None (not a bust).
#
# write_frac >= this is a real bust. Data is bimodal (warm appends < ~0.05, real
# rewrites > ~0.35); 0.15 sits in the empty valley, matching report.bust_series.
BUST_WRITE_FRAC = float(os.environ.get("BUST_WRITE_FRAC", "0.15"))
# A history CONTRACTION to <= this fraction of the prior message count marks a
# `compact` (vs a `conversation` flap): normal turns only GROW the message array
# (+~2/turn), so a sharp drop on the same session (same static prefix) is a
# /compact or auto-compact collapsing the thread to a summary — an EXPECTED,
# benign rewrite, not our bug. Validated on a real capture: a compact went 349->4
# messages (0.01); a transform flap grew +2/+3 while editing one mid-history turn.
# 0.5 leaves wide margin (a task-reminder strip only drops 1-2 messages, and never
# upstream, so it never reaches this branch anyway).
BUST_COMPACT_MSG_RATIO = float(os.environ.get("BUST_COMPACT_MSG_RATIO", "0.5"))
# class -> (fault, fix_hint). fault drives clodex's chip color/severity (semantics
# in the payload, not hardcoded client-side — a new class needs no clodex change):
#   self        = our own bug (an L2 transform edited a settled prior turn) — LOUD
#   content     = a byte in the injected context changed — fixable by a peel/strip
#   environment = not our code + no per-turn fix: the cache timed out (keep-warm),
#                 or the history was deliberately compacted (expected, nothing to fix)
_BUST_FAULT = {
    "tools":        ("content", "tools[] changed upstream — a tool-set edit or an "
                                "MCP connector (re)attaching; stabilize/trim the roster"),
    "system":       ("content", "the system prompt changed — often a mid-session "
                                "/model swap leaving a stale prompt; pin the model/prompt"),
    "preamble":     ("content", "messages[0] (claudeMd / userEmail / currentDate / "
                                "scratchpad) changed — peel the volatile line to the tail"),
    "conversation": ("self",    "a settled prior turn was edited in place — an L2 transform "
                                "flapping (fold / thinking-strip / edit-ack); check the latch"),
    "compact":      ("environment", "the history was compacted (/compact or auto-compact) — "
                                "an expected one-time contraction to a summary, not a leak; "
                                "no per-turn fix"),
    "lapse":        ("environment", "the cache lapsed (idle > TTL) and re-wrote the whole "
                                "prefix — arm a keep-warm hold or ping to hold it"),
}


def _classify_bust(read, created, inp, *, prior, cur_tools, cur_sys, cur_sysfull,
                   cur_msg0, cur_msgs, lapsed):
    """Classify this turn's cache event against the prior session_head row.
    `prior` = (tools_hash, sys_hash, sysfull_hash, msg0_hash, msg_count) of the last
    head, or None on the session's first turn (an initial cold start is NOT a bust).
    Returns a class in {tools, system, preamble, conversation, compact, lapse} or
    None (normal append / not a bust). Most-upstream divergence wins (it dominates
    the cache cost), matching the canonical order tools -> system -> messages[0] ->
    deeper.

    The `tools` hash is the CUMULATIVE first-marker segment (_segment_hashes:
    tools + the 'You are Claude Code' preamble) — a tools[] edit moves it. For the
    SYSTEM check we compare TWO hashes: `sys` (the marked-segment hash, through the
    LAST system cache marker — the common model/prompt-swap path) AND `sysfull`
    (the WHOLE system[] array via _sys_full_hash). The second is what makes this
    robust to layout: every system[] block is upstream of messages[0], so a change
    in a block sitting PAST the last marker (our own trailing `[wirescope]`
    injection, or any layout with the system prompt past the final marker) is still
    a system-region bust — folding the full array in files it as `system`, never a
    false `conversation` (which renders loud/self and would blame the wrong
    subsystem). /_bust's disk diff stays the byte-exact ground truth.

    When the static prefix (tools + full system + msg0) is byte-identical, the write
    landed DEEPER (in the history), and we split three ways: a sharp message-count
    CONTRACTION (cur_msgs <= prior * BUST_COMPACT_MSG_RATIO) is a `compact` (normal
    turns only grow, so a collapse to a summary is the only thing that shrinks the
    array — expected, benign); else a LAPSED head is the time-caused `lapse` (cache
    died, bytes re-sent); else a settled mid-history turn actually changed in place
    = `conversation` (content — usually one of OUR L2 transforms flapping)."""
    window = (read or 0) + (created or 0) + (inp or 0)
    if window <= 0:
        return None
    if (created or 0) / window < BUST_WRITE_FRAC:
        return None                          # tail-append write, not a real bust
    if prior is None:
        return None                          # first turn = initial cold start
    p_tools, p_sys, p_sysfull, p_msg0, p_msgs = prior
    if p_tools is not None and p_tools != cur_tools:
        return "tools"
    if (p_sys is not None and p_sys != cur_sys) or \
       (p_sysfull is not None and p_sysfull != cur_sysfull):
        return "system"
    if p_msg0 is not None and p_msg0 != cur_msg0:
        return "preamble"
    # static prefix identical: the write landed in the HISTORY. A sharp contraction
    # = a compact (checked FIRST — it's a definite content event, more specific than
    # a coincident idle lapse); else a lapsed head = time-caused lapse; else a
    # settled mid-history turn changed in place = conversation (our transform).
    if (p_msgs and cur_msgs is not None
            and cur_msgs <= p_msgs * BUST_COMPACT_MSG_RATIO):
        return "compact"
    return "lapse" if lapsed else "conversation"


def _prefix_hash(obj, upto):
    """Chain-hash of the cacheable prefix: tools/system fingerprint + messages
    [0:upto], each canonicalized without cache_control. Simple full recompute
    (fast — blake2b over a few hundred KB is sub-ms); runs on the writer thread."""
    h = hashlib.blake2b(digest_size=20)
    h.update(_sys_tools_fingerprint(obj))
    for m in (obj.get("messages") or [])[:upto]:
        h.update(b"\x1e")
        h.update(_canon_message(m))
    return h.hexdigest()


def _segment_hashes(obj):
    """Hashes for the two leading CLI cache breakpoints. BOTH live in system[]:
    the canonical server order is tools -> system -> messages, and on the wire
    the CLI places no cache_control inside tools[] — it marks the system blocks
    that sit in front of the conversation (verified across the capture corpus:
    0 of ~6k real tool-carrying requests carry a tools[]-internal marker). The
    standard layout is:

        system[0]  x-anthropic-billing-header   (out-of-band, never cached)
        system[1]  "You are Claude Code…"        <- marker 1  (tools + preamble)
        system[2]  the full system prompt        <- marker 2  (+ system prompt)

    So marker 1 caches `tools + the 'you are Claude' preamble` and marker 2 adds
    the system prompt. We surface marker 1 as segment "tools" (the smallest
    shared prefix — tools + preamble) and the LAST marker as segment "system"
    (tools + preamble + system prompt). A single-marker layout can't separate
    the two, so it yields only "system".

    Keyed like the real cache: canonical post-transform bytes of the cumulative
    prefix up to each marked block, cache_control stripped, model folded in, the
    volatile billing-header block excluded (its per-session `cch` token would
    otherwise defeat the cross-session sharing this whole feature is for). Two
    sessions with byte-identical tools+system therefore compute the SAME hashes
    and share ledger rows — so /_status can show a session whose message tail
    lapsed while its tools/system segments stay warm via a sibling session.

    DISPLAY-GRADE, NOT GATE-GRADE: per-segment confirmation is inferred from the
    turn's aggregate usage receipt (the backend never says WHICH breakpoint it
    read vs wrote, and a sub-min-cacheable segment may be declined while a
    longer one caches). No gate may read these rows — eye candy only."""
    tools = obj.get("tools") if isinstance(obj.get("tools"), list) else []
    sys_ = obj.get("system") if isinstance(obj.get("system"), list) else []
    markers = [i for i, b in enumerate(sys_)
               if isinstance(b, dict) and b.get("cache_control")]
    if not markers:
        return {}
    model = (obj.get("model") or "").encode("utf-8", "replace")

    def _hash_upto(idx):
        # tools (all of them) + system blocks up to & including idx, minus the
        # out-of-band billing header; the cumulative prefix the server caches.
        stable = [b for b in sys_[:idx + 1]
                  if not (isinstance(b, dict) and
                          b.get("text", "").startswith("x-anthropic-billing-header"))]
        h = hashlib.blake2b(digest_size=20)
        h.update(model)
        h.update(b"\x1e")
        h.update(_canon_message(tools))
        h.update(b"\x1e")
        h.update(_canon_message(stable))
        return h.hexdigest()

    def _ttl(idx):
        cc = sys_[idx].get("cache_control") or {}
        return 3600 if cc.get("ttl") == "1h" else 300

    out = {}
    if len(markers) >= 2:               # marker 1 = tools + preamble
        out["tools"] = {"hash": _hash_upto(markers[0]), "ttl": _ttl(markers[0])}
    out["system"] = {"hash": _hash_upto(markers[-1]),   # last = + system prompt
                     "ttl": _ttl(markers[-1])}
    return out


def _marker_ttl(obj):
    """TTL (seconds) of the message-tail cache breakpoint: 3600 for ttl:'1h',
    else 300 (bare ephemeral). Falls back to the system markers."""
    for m in reversed(obj.get("messages") or []):
        c = m.get("content")
        if isinstance(c, list):
            for blk in c:
                if isinstance(blk, dict) and blk.get("cache_control"):
                    return 3600 if blk["cache_control"].get("ttl") == "1h" else 300
    sys = obj.get("system")
    if isinstance(sys, list):
        for b in sys:
            if isinstance(b, dict) and b.get("cache_control"):
                return 3600 if b["cache_control"].get("ttl") == "1h" else 300
    return 300


def _is_warm_ping(obj):
    """A recognized keep-warm ping: the LAST user message carries the sentinel.
    Such a turn refreshes the shared prefix but its own tail is throwaway, so we
    hash UP TO (not including) it."""
    if not WARMTH_PING_SENTINEL:
        return False
    for m in reversed(obj.get("messages") or []):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        text = c if isinstance(c, str) else " ".join(
            b.get("text", "") for b in c if isinstance(b, dict)) if isinstance(c, list) else ""
        return WARMTH_PING_SENTINEL in text
    return False


def warmth_warm(hash_hex):
    """Read side (for a statusline/hook/keep-warm decision): is this prefix still
    warm? Anything other than 'warm' is not-warm."""
    return warmth_state(hash_hex) == "warm"


def warmth_state(hash_hex):
    """TWO-STATE for decisions, four labels for logs: 'warm' (row exists,
    expires_at > now) vs not-warm, where not-warm is reported as 'cold' (lapsed
    row still on disk awaiting purge), 'absent' (no row), 'off' (ledger
    disabled), or 'error' (store failure). GATES test == 'warm' only; the
    compact-strip gate additionally requires 'cold'/'absent' to act (so
    'off'/'error' decline — absence is evidence, a broken store is not)."""
    if not WARMTH_LEDGER:
        return "off"
    if not hash_hex:
        return "absent"
    try:
        r = _warmth_rows([hash_hex]).get(hash_hex)
    except Exception:
        return "error"
    if not r:
        return "absent"
    return "warm" if r[2] > time.time() else "cold"


def warmth_query(hash_hex=None, session=None):
    """Resolve warmth for the GET /_warm endpoint. By hash (content-addressed,
    fork-proof) or by session_id (convenience: resolves to that session's latest
    head hash, which a fork's keep-warm ping refreshes under the hood). Head
    index is in the store too, so this survives a proxy restart."""
    try:
        h = hash_hex or (_session_head_hash(session) if session else None)
        if not h:
            return {"found": False, "warm": False, "session": session, "hash": hash_hex}
        r = _warmth_rows([h]).get(h)
    except Exception as e:
        return {"found": False, "warm": False, "session": session,
                "hash": hash_hex, "error": f"store: {e}"}
    if not r:
        return {"found": False, "warm": False, "session": session, "hash": h}
    ts, ttl, exp = r
    now = time.time()
    return {"found": True, "warm": now < exp, "session": session, "hash": h,
            "age_s": round(now - ts, 1), "ttl_s": ttl,
            "remaining_s": round(max(0.0, exp - now), 1)}


def warmth_segments(session):
    """Per-segment readout for /_status: the session's last-seen leading
    breakpoint hashes + their live warmth — "tools" = marker 1 (tools +
    preamble), "system" = marker 2 (+ system prompt); see _segment_hashes.
    Because the rows are content-addressed, sessions with identical tools and
    system prompts resolve to the SAME rows — so these can read warm off a
    sibling session's traffic while this session's own message tail is cold.
    Display-grade only; no gate reads this."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            r = con.execute("SELECT tools_hash, sys_hash FROM session_head "
                            "WHERE session_id=?", (session,)).fetchone()
        if not r or not (r[0] or r[1]):
            return None
        rows = _warmth_rows([r[0], r[1]])
    except Exception:
        return None
    now = time.time()
    out = {}
    for label, h in (("tools", r[0]), ("system", r[1])):
        if not h:
            continue
        row = rows.get(h)        # (stamped_at, ttl, expires_at) | None
        out[label] = {
            "hash": h,
            "state": ("warm" if row and row[2] > now
                      else "cold" if row else "absent"),
            "remaining_s": round(max(0.0, row[2] - now), 1) if row else None,
            "ttl_s": row[1] if row else None}
    return out or None


def cold_resumes(session):
    """How many real turns this session resumed from a COLD cache — each one a
    full prefix re-write at the write premium (the waste a long-lived but bursty
    session pays). 0 = it never went cold between turns (or only paid its initial
    start). Same cold notion as /_admin's warm/cold split; survives restarts
    (lives on session_head). Display/analytics-grade — no gate reads it."""
    if not session:
        return 0
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            r = con.execute("SELECT cold_resumes FROM session_head "
                            "WHERE session_id=?", (session,)).fetchone()
        return int(r[0]) if r and r[0] is not None else 0
    except Exception:
        return 0


# display + column order; compact and lapse are the two non-actionable
# (fault=environment) classes and sit last.
_BUST_CLASSES = ("tools", "system", "preamble", "conversation", "compact", "lapse")


def bust_summary(session):
    """The session's REAL-BUST rollup for /_status: per-class cumulative counts +
    the last bust (class / when / write size), with each class's presentation
    semantics (fault + fix_hint) folded IN so a consumer renders chip color and
    tooltip straight from the payload — a new class later needs no consumer change.
    None when the session never had a real bust (nothing to show). Main-line only
    (subagents never advance the head); survives restarts (session_bust table)."""
    if not session:
        return None
    cols = ", ".join(_BUST_CLASSES)          # class counters, in canonical order
    rcols = ", ".join(f"{c}_restart" for c in _BUST_CLASSES)   # deploy-tax subs
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            r = con.execute(
                f"SELECT {cols}, {rcols}, last_class, last_ts, last_write_tokens "
                "FROM session_bust WHERE session_id=?", (session,)).fetchone()
    except Exception:
        return None
    if not r:
        return None
    n = len(_BUST_CLASSES)
    by_class = {c: int(r[i] or 0) for i, c in enumerate(_BUST_CLASSES)}
    # per-class deploy-tax sub-count: busts that straddled a proxy restart.
    by_restart = {c: int(r[n + i] or 0) for i, c in enumerate(_BUST_CLASSES)}
    total = sum(by_class.values())
    if total <= 0:
        return None
    lc, lt, lw = r[2 * n], r[2 * n + 1], r[2 * n + 2]
    # non-zero classes, biggest-first, each carrying its own fault + fix_hint so
    # the consumer renders severity/colour from the data, not a hardcoded map.
    # restart_between = how many of this class's busts were the one-time deploy tax
    # (straddled a restart, self-heals): a REAL content bust exists iff
    # count > restart_between, so the chip can stay calm on a pure upgrade bust.
    classes = [{"class": c, "count": by_class[c], "restart_between": by_restart[c],
                "fault": _BUST_FAULT[c][0], "fix_hint": _BUST_FAULT[c][1]}
               for c in sorted(by_class, key=lambda c: -by_class[c]) if by_class[c]]
    last = None
    if lc:
        last = {"class": lc, "ts": lt, "write_tokens": int(lw or 0),
                "fault": _BUST_FAULT[lc][0], "fix_hint": _BUST_FAULT[lc][1]}
    # actionable = the busts a code/config change could have prevented (a self flap
    # or a content divergence). The two fault=environment classes are NOT
    # actionable: `lapse` (keep-warm territory) and `compact` (expected contraction).
    actionable = total - by_class["lapse"] - by_class["compact"]
    # ...and the deploy tax isn't actionable EITHER (a restart-straddling bust is a
    # one-time upgrade re-cache, not a fixable regression). actionable_excl_restart
    # is what a glance-level "needs attention?" chip should gate on — it excludes
    # environment classes AND every restart-straddling bust across all classes.
    restart_total = sum(by_restart.values())
    actionable_excl_restart = actionable - (
        restart_total - by_restart["lapse"] - by_restart["compact"])
    return {"total": total, "by_class": by_class, "by_restart": by_restart,
            "classes": classes, "actionable": actionable,
            "actionable_excl_restart": actionable_excl_restart, "last_bust": last}


def _cold_ping_decision(obj):
    """If this request is a keep-warm ping whose target prefix is NOT warm, return
    a decline record (caller short-circuits, never forwards). A ping only ever pays
    off on a WARM prefix (a cheap read that slides the TTL); on anything else
    (cold, absent, store error), forwarding is a cache WRITE at the premium for
    no gain — the higher cost the pinger exists to avoid. So forward IFF warm. Hash
    on the SAME basis `_record_warmth` uses for a ping (history up to, not
    including, the throwaway sentinel tail)."""
    if not WARMTH_BLOCK_COLD_PING or not _is_warm_ping(obj):
        return None
    msgs = obj.get("messages") or []
    upto = len(msgs) - 1                  # same as _record_warmth's ping path
    if upto <= 0:
        return None
    h = _prefix_hash(obj, upto)
    state = warmth_state(h)
    if state == "warm":
        return None                       # only a warm prefix is worth pinging
    return {"ping": True, "blocked": True, "warmth_state": state, "hash": h,
            "n_messages_hashed": upto,
            "note": f"declined ping: prefix is '{state}', not warm; forwarding "
                    "would write the prefix at the premium for no gain"}


def _record_warmth(obj, usage, is_main=True):
    """Refresh the ledger for the prefix this response just (re)cached, and return
    a small log record. Regular turn -> hash includes the last message (the entry
    the backend cached); ping -> excludes its throwaway tail.

    `is_main` gates the SESSION-HEAD advance (cold-resume + bust classification):
    subagents share the parent's session_id (they'd otherwise overwrite the head
    with a throwaway sub-prefix and manufacture false busts on the next main turn),
    so only the routed main line advances the head — matching meta.py's main-line
    identity guard. The shared warmth-table segment stamps are NOT gated: a
    subagent's tools/system prefix is genuinely warm and keeps the shared segment
    alive for siblings.

    The stamp is RESPONSE-CONFIRMED: a row exists ONLY because the backend told us
    a cache does. We stamp iff usage confirms caching actually happened this turn
    (`cache_creation > 0` = just written, or `cache_read > 0` = read & TTL slid).
    A response with both zero (e.g. a sub-min-cacheable prefix the backend declined
    to cache) is NOT stamped — marking it 'warm' would be a lie, and a later ping
    would write rather than read. The request is mere intent; the response is the
    receipt. (This receipt discipline is what makes the two-state 'absence ≈
    expiry' reading honest.)"""
    if not WARMTH_LEDGER:
        return None
    msgs = obj.get("messages") or []
    if not msgs:
        return None
    created = (usage or {}).get("cache_creation_input_tokens") or 0
    read = (usage or {}).get("cache_read_input_tokens") or 0
    if created <= 0 and read <= 0:
        return None                       # no cache confirmed -> nothing to stamp
    ping = _is_warm_ping(obj)
    upto = len(msgs) - 1 if ping else len(msgs)
    if upto <= 0:
        return None
    h = _prefix_hash(obj, upto)
    ttl = _marker_ttl(obj)
    # leading-breakpoint segment rows ride the same stamp: every breakpoint in
    # a cache-confirmed request was read or re-written, so their TTLs slid too
    segs = _segment_hashes(obj)
    now = time.time()
    try:
        sid = (writer_mod._session_ids(obj) or (None,))[0]
    except Exception:
        sid = None
    try:
        con = store_mod.db()
        rows = [(h, now, ttl, now + ttl)] + [
            (s["hash"], now, s["ttl"], now + s["ttl"]) for s in segs.values()]
        resumed = False
        bust_class = None
        head_advance = bool(sid and not ping and is_main)
        cur_msg0 = _msg0_hash(obj) if head_advance else None
        cur_sysfull = _sys_full_hash(obj) if head_advance else None
        cur_msgs = len(msgs) if head_advance else None
        inp = (usage or {}).get("input_tokens") or 0
        with store_mod.LOCK:
            # COLD-RESUME detection (before we restamp). A real turn whose
            # session we've seen before, arriving while that session's last head
            # had LAPSED (cold/absent), means the cache went cold between turns
            # and the backend re-wrote the whole prefix. The first turn of a
            # session (no prior head row) is an initial cold start, NOT a resume.
            # We read the prior head's warmth with the SAME head-hash notion that
            # /_admin's warm/cold split uses, so the counter and the table agree.
            # (Raw query, not warmth_state/_warmth_rows — those re-acquire LOCK,
            # which is non-reentrant.)
            new_resumes = 0
            prior_seg = None
            restart_straddle = False
            if head_advance:
                prev = con.execute(
                    "SELECT hash, cold_resumes, tools_hash, sys_hash, msg0_hash, "
                    "sysfull_hash, msg_count, updated_at FROM session_head "
                    "WHERE session_id=?", (sid,)).fetchone()
                if prev:
                    pe = con.execute("SELECT expires_at FROM warmth WHERE hash=?",
                                     (prev[0],)).fetchone()
                    resumed = (not pe) or (pe[0] <= now)
                    new_resumes = (prev[1] or 0) + (1 if resumed else 0)
                    # (tools_hash, sys_hash, sysfull_hash, msg0_hash, msg_count) —
                    # the order _classify_bust unpacks its `prior` tuple in.
                    prior_seg = (prev[2], prev[3], prev[5], prev[4], prev[6])
                    # DEPLOY-TAX detection: the prior head was written by a process
                    # that booted before this one (its updated_at predates our
                    # _START_TS) => the proxy restarted between the prior turn and
                    # now, so any bust on THIS turn is a one-time deploy/vendor-bump
                    # re-cache, not an in-session regression. Fires at most once per
                    # session per restart (we stamp updated_at=now below, so the
                    # next turn's prior head is in-process). See session_bust
                    # *_restart columns.
                    restart_straddle = (prev[7] or 0) < core_mod._START_TS
            con.executemany("INSERT INTO warmth(hash, stamped_at, ttl, expires_at) "
                            "VALUES(?,?,?,?) ON CONFLICT(hash) DO UPDATE SET "
                            "stamped_at=excluded.stamped_at, ttl=excluded.ttl, "
                            "expires_at=excluded.expires_at", rows)
            # a real turn advances this session's head; a fork's ping only
            # refreshes the shared hashes above (its fork-id head is irrelevant),
            # and a subagent turn (is_main=False) must not clobber the parent head.
            if head_advance:
                # REAL-BUST classification against the PRIOR head (before we
                # overwrite it). read/created/inp are this turn's receipt; the
                # prior segment hashes + lapse state say WHERE it diverged. Counted
                # into session_bust; the byte-level drill-down is /_bust (on disk).
                bust_class = _classify_bust(
                    read, created, inp, prior=prior_seg,
                    cur_tools=(segs.get("tools") or {}).get("hash"),
                    cur_sys=(segs.get("system") or {}).get("hash"),
                    cur_sysfull=cur_sysfull,
                    cur_msg0=cur_msg0, cur_msgs=cur_msgs, lapsed=resumed)
                if bust_class:
                    # increment the class counter, and — iff this bust straddled a
                    # restart — its deploy-tax sub-counter too, in the same upsert.
                    rcol = f"{bust_class}_restart"
                    rinc = 1 if restart_straddle else 0
                    con.execute(
                        f"INSERT INTO session_bust(session_id, {bust_class}, {rcol}, "
                        "last_class, last_ts, last_write_tokens) VALUES(?,1,?,?,?,?) "
                        "ON CONFLICT(session_id) DO UPDATE SET "
                        f"{bust_class}={bust_class}+1, {rcol}={rcol}+{rinc}, "
                        "last_class=excluded.last_class, last_ts=excluded.last_ts, "
                        "last_write_tokens=excluded.last_write_tokens",
                        (sid, rinc, bust_class, now, created))
                con.execute("INSERT INTO session_head(session_id, hash, updated_at, "
                            "tools_hash, sys_hash, msg0_hash, sysfull_hash, "
                            "msg_count, cold_resumes) VALUES(?,?,?,?,?,?,?,?,?) "
                            "ON CONFLICT(session_id) DO UPDATE SET "
                            "hash=excluded.hash, updated_at=excluded.updated_at, "
                            "tools_hash=excluded.tools_hash, sys_hash=excluded.sys_hash, "
                            "msg0_hash=excluded.msg0_hash, "
                            "sysfull_hash=excluded.sysfull_hash, "
                            "msg_count=excluded.msg_count, "
                            "cold_resumes=excluded.cold_resumes",
                            (sid, h, now,
                             (segs.get("tools") or {}).get("hash"),
                             (segs.get("system") or {}).get("hash"),
                             cur_msg0, cur_sysfull, cur_msgs, new_resumes))
            con.commit()
            size = con.execute("SELECT COUNT(*) FROM warmth").fetchone()[0]
    except Exception as e:
        # A failed stamp must be LOUD: it silently degrades a warm prefix to
        # 'absent', which the compact gate now acts on.
        print(f"[warmth] STORE WRITE FAILED {h[:12]}…: {e}", flush=True)
        return None
    return {"hash": h, "ttl": ttl, "ts": round(now, 3), "ping": ping,
            "n_messages_hashed": upto, "cache_read_input_tokens": read,
            "cache_creation_input_tokens": created,
            "warm_on_arrival": read > 0, "ledger_size": size,
            "cold_resume": resumed, "cold_resumes": new_resumes,
            "bust_class": bust_class,
            "segments": segs or None}
