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

from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import core as core_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import pinger as pinger_mod
from proxylab import restore as restore_mod
from proxylab import subs as subs_mod
from proxylab import store as store_mod
from proxylab import transforms as transforms_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

# Stable product marker. Many proxies can sit on ANTHROPIC_BASE_URL in front of
# the model backend; a subscriber needs a cheap, unauthenticated way to tell
# OURS apart from a generic forwarder before it tries to register, pull stats,
# or warm the cache. /_identity is that handshake: a consumer confirms
# `product == "wirescope"`, reads `protocols`/`capabilities` to decide what it
# may use, and `endpoints` for where. Additive-only (mirror SUBSCRIBERS.md's
# versioning rule): never remove a field, bump `protocols.<name>` on a break.
# (identity protocol 2: renamed product logproxy -> wirescope, 2026-06-13.)
PRODUCT = "wirescope"
IDENTITY_PROTOCOL = 2


def _identity():
    """The 'is this our proxy?' handshake — see PRODUCT above. Read-only,
    spends nothing; capabilities reflect LIVE flags so a consumer integrates
    conditionally (e.g. only attempt /_ping when ping is actually enabled)."""
    return {
        "wirescope": True,                # quick boolean for the lazy check
        "product": PRODUCT,               # the authoritative discriminator
        "vendor": "proxy-lab",
        "version": core_mod.VERSION,      # release tag or git-describe (dev tree)
        "protocols": {
            # protocol/contract versions a consumer can branch on
            "identity": IDENTITY_PROTOCOL,
            "subscribers": 1,             # SUBSCRIBERS.md envelope "v"
            "wirescope": 1,               # WIRESCOPE.md [wirescope:...] spec (v1:
            #                               renamed ws:->wirescope:, spawn + keep)
        },
        # what THIS process can actually do right now (env flags can disable
        # subsystems) — a subscriber should gate features on these, not assume
        "capabilities": {
            # A/B control arm: when true this port is a byte-verbatim forwarder
            # (whole mutation chain skipped) — the experiment's CONTROL. Analyzers
            # read this to label an arm without guessing from the env.
            "passthrough": transforms_mod.PASSTHROUGH,
            "subscribers": subs_mod.SUBSCRIBERS,
            "warmth": warmth_mod.WARMTH_LEDGER,
            "ping": pinger_mod.WARMTH_PINGER,
            "hold": hold_mod.WARMTH_HOLD,
            "stats": True,                # /_status is always served
            "session_view": True,         # /_session HTML
            "context_view": True,         # /_context tool-roster JSON
            "context_composition": True,  # /_context per-category token breakdown
            "context_utilization": True,  # /_context?...&utilization=1 used/deadweight
            "context_skills": True,       # /_context per-skill roster + utilization
            "context_report": True,       # /_report?session= cost/efficiency report
            "context_timeline": True,     # /_report?...&detail=1 series + /_timeline HTML
            "bust_locator": True,         # /_bust?session= cache-divergence forensics
            "prune": True,                # /_prune capture-dir retention (GET readout
                                          # + POST two-tier prune; see INTEGRATION.md)
            "cost_by_line": True,         # per-agent-line cost split: cost.main_est_usd
                                          # + sub_agents[].est_usd (+ /_report scope.agents)
            "since_compact": True,        # /_status session.since_compact rollup
                                          # {turns,requests,est_usd,boundary_ts,compacted}
                                          # from the last /compact boundary (or start)
            "pot": True,                  # /_pot[?days=N] boiling-pot tier 2: per-file
                                          # {reads,redundant_reads,redundant_tokens}
                                          # heat; files[] ranked by redundant_tokens
                                          # + window totals (kill-criteria metric)
            # prior-turn thinking strip: per-session consumer opt-in via /_strip
            # or [wirescope:strip-thinking on]. `default` = the global flag (what
            # `effective` is when no per-session override is set). When the proxy
            # ships globally off (the consumer-opt-in stance), default is false but
            # the capability is True (the lever exists) — gate on this, not version.
            # L2 is NOT a separate capability: they're levels of THIS mechanism.
            # L1 = prior-turn thinking only; L2 = L1 PLUS the bust-riding
            # tool-result strips (edit-ack collapse + failed-call stubbing) PLUS
            # read+edit FOLD (apply same-turn edits onto the Read buffer). Each
            # level contains the lower. Gate a level on `max_level >= N`, NOT a
            # per-feature key. Set per session via /_strip?level=N or
            # [wirescope:strip-thinking l2]. (L3 retired 2026-06-20: fold folded
            # into L2; a legacy l3/level=3 input clamps to 2.)
            "strip_thinking": {"available": True,
                               "default": transforms_mod.STRIP_PRIOR_THINKING,
                               "max_body_ratio": transforms_mod.STRIP_THINK_MAX_BODY_RATIO,
                               "levels": [0, 1, 2], "max_level": 2,
                               "default_level": transforms_mod._global_strip_level()},
            "codex": True,                # /agent/<name>/openai HTTP routing
            "codex_websocket": codex_mod._websocket_available(),
            # wirescope directives (WIRESCOPE.md): agent-name always honored,
            # omit/replace gated by WS_OMIT, keep always honored; `spawn` =
            # whether spawn-position (messages[0] head) directives are read at
            # all; `omit_default` = operator policy already stripped from every
            # subagent spawn (so a spawner needs no knowledge for that case)
            "wirescope": {"agent_name": True, "omit": transforms_mod.WS_OMIT,
                          "replace": transforms_mod.WS_OMIT, "keep": True,
                          "spawn": writer_mod.WS_SPAWN_DIRECTIVES,
                          "omit_default": transforms_mod.WS_OMIT_DEFAULT,
                          "spawner_hint": transforms_mod.WS_SPAWNER_HINT,
                          # per-agent /_hint override of spawner_hint (keyed by
                          # route name; on=0 = wirescope invisible to that
                          # agent's model while observability still runs).
                          "hint_override": True,
                          # tool-roster trim: `tools` (allowlist), `strip-tools`
                          # (denylist), `keep-tools` (override); gated by
                          # WS_STRIP_TOOLS, same spawn/body/sticky plumbing.
                          "strip_tools": transforms_mod.WS_STRIP_TOOLS,
                          # `[wirescope:strip-thinking on|off]` per-session opt-in
                          # (twin of the /_strip endpoint); always parsed.
                          "strip_thinking": True,
                          # `[wirescope:keep-mcp <server>]` per-agent re-admit of
                          # a STRIP_MCP_SERVERS-filtered family; always parsed.
                          "keep_mcp": True},
            # MCP-server tool strip (STRIP_MCP_SERVERS): the LIVE configured set
            # of server prefixes this port surgically drops from tools[]. A
            # consumer gating its own --strict-mcp-config should check the actual
            # server is in `servers` here, NOT just that traffic is routed — a
            # routed port with strip OFF (empty servers) still ships those tools,
            # so "routed" alone is the wrong contract boundary. Empty list = the
            # feature is off on this port (kill switch or unconfigured).
            "strip_mcp": {"available": True,
                          "servers": sorted(transforms_mod.STRIP_MCP_SERVERS)},
        },
        "endpoints": {
            "identity": "/_identity",
            "status": "/_status",
            "subscribe": "/_subscribe",
            "warm": "/_warm",
            "ping": "/_ping",
            "hold": "/_hold",
            "end": "/_end",
            "admin": "/_admin",
            "session": "/_session",
            "context": "/_context",
            "report": "/_report",
            "timeline": "/_timeline",
            "bust": "/_bust",
            "strip": "/_strip",
            "hint": "/_hint",
            "prune": "/_prune",
            "pot": "/_pot",
        },
        "docs": "INTEGRATION.md",         # front-door contract; push deep-dive = SUBSCRIBERS.md
    }


def _status_snapshot(session=None, all_sessions=False, limit=None):
    """Everything a human (or the statusline) wants to know about the sessions
    this proxy tracks, one read-only JSON. Universe = in-memory pingable
    sessions ∪ armed holds ∪ durable session_meta rows (last 24h unless all=1).
    Identity (title/cwd/model) is SQLite-durable; pingability/hold/cost are
    in-memory by design (nothing replayable survives a restart anyway).

    `limit` (used by /_admin) caps the most-recently-active N sessions BEFORE
    the per-session warmth/segment enrichment, so a 24h window with hundreds/
    thousands of sessions doesn't query + render them all every refresh. Armed
    holds are never dropped; `session`/`all_sessions` bypass the cap. The cut is
    by last_seen, and a warm prefix implies recent activity, so warm sessions
    survive the cap in practice. Reports proxy.sessions_total/truncated."""
    now = time.time()
    with pinger_mod._LAST_REQUEST_LOCK:
        last_real = {sid: (e["ts"], bool(e.get("needs_auth")),
                           codex_mod._is_openai_body(e.get("obj")))
                     for sid, e in pinger_mod._LAST_REQUEST.items()}
    holds = hold_mod._hold_snapshot()
    meta_rows, meta_err = {}, None
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            q = ("SELECT session_id, title, cwd, model, first_seen, last_seen, "
                 "kind, ended_at, end_reason, agent FROM session_meta")
            if session:
                cur = con.execute(q + " WHERE session_id=?", (session,))
            elif all_sessions:
                cur = con.execute(q)
            else:
                cur = con.execute(q + " WHERE last_seen > ?", (now - 86400,))
            meta_rows = {r[0]: r for r in cur.fetchall()}
    except Exception as e:
        meta_err = f"store: {e}"
    sids = set(meta_rows) | set(last_real) | set(holds)
    if session:
        sids &= {session}
    sessions_total = len(sids)
    truncated = False
    if (limit is not None and not session and not all_sessions
            and sessions_total > limit):
        # rank by best-known last activity (meta last_seen ∪ last real turn),
        # keep the top `limit`, but never drop an armed hold.
        def _activity(sid):
            r = meta_rows.get(sid)
            lr = last_real.get(sid)
            return max((r[5] if r else 0) or 0, lr[0] if lr else 0)
        keep = set(holds)
        ranked = sorted(sids - keep, key=_activity, reverse=True)
        sids = keep | set(ranked[:max(0, limit - len(keep))])
        truncated = True
    sessions = []
    for sid in sids:
        r = meta_rows.get(sid)
        kind = r[6] if r else None
        if kind and not (session or all_sessions):
            continue  # proxy-spawned utility session (auth bootstrap) — not
                      # the human's; visible via ?all=1 or direct ?session=
        wq = warmth_mod.warmth_query(session=sid)
        tot = billing_mod._SESSION_TOTALS.get(sid)        # .get: never create via defaultdict
        lr = last_real.get(sid)               # (ts, needs_auth) | None
        hold = holds.get(sid)
        if hold:
            # what THIS hold should still need: idle span / ttl, anchored at
            # the LAST REAL TURN (an organic turn re-warms for free and resets
            # the ping counter, so both sides of n/expected restart together).
            # The global ping cap is only the safety bound.
            hold = dict(hold)
            ttl = wq.get("ttl_s") or 3600
            ref = max(hold["armed_at"], (lr[0] if lr else 0))
            hold["expected_pings"] = min(
                hold_mod.WARMTH_HOLD_MAX_PINGS,
                max(1, int((hold["until"] - ref) // ttl)))
        ended = meta_mod._ENDED.get(sid)
        if not ended and r and r[7]:
            ended = {"ts": r[7], "reason": r[8] or "unspecified"}
        # The route agent name IS the session name when present — it's the
        # operator's own label, stabler than a generated summary (and SDK/
        # headless sessions never make the title side-call at all). Bracketed
        # so a label reads as a label. Consumers wanting the raw learned
        # title have the `summary` field. Last resort, for an un-routed session
        # that never made the title side-call either (e.g. a headless run
        # pointed straight at the port): name it after the session_id's first
        # segment (~8 hex) so it's still uniquely identifiable rather than
        # nameless. `~`-marked to read distinctly from a [route] label, and it
        # ranks BELOW the learned title so a plain interactive CLI keeps its
        # real title.
        agent_name = r[9] if r else None
        sessions.append({
            "session_id": sid,
            "kind": kind,
            "ended": ended,
            "agent": agent_name,
            "summary": r[1] if r else None,
            "title": (f"[{agent_name}]" if agent_name else None) or
                     (r[1] if r else None) or
                     (f"~{sid.split('-')[0]}" if sid else None),
            "cwd": r[2] if r else None,
            "model": r[3] if r else None,
            "first_seen": r[4] if r else None,
            "last_seen": (r[5] if r else None) or (lr[0] if lr else None),
            "last_real_turn_ts": lr[0] if lr else None,
            # openai-wire entries are view-only — never pingable, never
            # awaiting auth (nothing is ever replayed on that wire)
            "pingable": bool(lr and not lr[1] and not lr[2]),
            "awaiting_auth": bool(lr and lr[1] and not lr[2]),
            "warmth": {"state": ("warm" if wq.get("warm")
                                 else "cold" if wq.get("found") else "absent"),
                       "remaining_s": wq.get("remaining_s"),
                       "ttl_s": wq.get("ttl_s"),
                       # leading-breakpoint segments (tools / tools+system),
                       # content-addressed → shared across sessions with
                       # identical layouts; display-grade only
                       "segments": warmth_mod.warmth_segments(sid)},
            # REAL-BUST rollup (2026-07-06): per-class cumulative counts + the
            # last bust, each class carrying its own fault + fix_hint so a chip
            # renders severity/tooltip from the payload. Supersedes the old
            # `cold_resumes` scalar (which counted ONLY the `lapse` class and
            # missed every warm content-divergence bust); lapse now lives in
            # busts.by_class.lapse. None when the session never had a real bust.
            "busts": warmth_mod.bust_summary(sid),
            "hold": hold,
            # est_usd/requests = the WHOLE tree (subagents share the parent's
            # session_id, so every line under it rolls in); main_est_usd = the
            # main line's own share (by_line decomposition; sub shares ride
            # sub_agents[].est_usd). None for pre-feature sessions.
            "cost": ({"est_usd": tot["est_usd"], "requests": tot["requests"],
                      "unpriced_requests": tot["unpriced_requests"],
                      "main_est_usd": (round(tot["by_line"]["main"]["est_usd"], 6)
                                       if (tot.get("by_line") or {}).get("main")
                                       else None)}
                     if tot else None),
            # per-window rollup from the last detected /compact boundary (or
            # session start): {turns, requests, est_usd, boundary_ts, compacted}.
            # Cumulative cost/turns_completed answer "how big is the whole
            # session"; this answers "where is THIS context at" (clodex). null
            # for pre-feature/no-traffic sessions; absent on pre-release payloads.
            "since_compact": billing_mod.since_compact(tot),
            "refusals": (tot or {}).get("refusals", 0),
            # last ≤20 classifier hits, wire-truth detail (full stop_details);
            # the CLI only ever showed a generic toast
            "refusal_events": (tot or {}).get("refusal_events") or None,
            # receipt-counted completed turns + the latest request-derived
            # heaviness snapshot (turns_in_context resets at /compact)
            "turns_completed": (tot or {}).get("turns"),
            "context": meta_mod._context_stats(sid),
            # per-session thinking-strip state, so a consumer can RECONCILE its
            # configured intent against proxy-truth (closes the fire-once-and-
            # forget desync) — reconcile against `configured_level`, never the
            # guard. See _strip_state.
            "strip": _strip_state(sid),
            # Task-spawned subagents that share this session_id (each with its
            # own model + request count) — shown under the main agent so the two
            # are obviously distinct and neither overwrites the other.
            # `last_active_s` (server-computed now - last_seen) is folded in so a
            # consumer derives running/idle/done off a skew-free fact (clodex
            # subagent child rows; policy/aging stay client-side).
            "sub_agents": _subagents_with_active(sid, now),
        })
    sessions.sort(key=lambda s: s.get("last_seen") or 0, reverse=True)
    res = {"proxy": {"version": core_mod.VERSION,
                     "log_dir": str(core_mod.LOG_DIR), "upstream": core_mod.UPSTREAM,
                     "upstream_openai": codex_mod.UPSTREAM_OPENAI,
                     "uptime_s": round(now - core_mod._START_TS, 1),
                     "flags": {"hold": hold_mod.WARMTH_HOLD, "pinger": pinger_mod.WARMTH_PINGER,
                               "ledger": warmth_mod.WARMTH_LEDGER,
                               "block_cold_ping": warmth_mod.WARMTH_BLOCK_COLD_PING},
                     "subscribers": subs_mod._stats(),
                     "codex": dict(codex_mod._CODEX_STATS),
                     "hold_config": {"margin_s": hold_mod.WARMTH_HOLD_MARGIN,
                                     "interval_s": hold_mod.WARMTH_HOLD_INTERVAL,
                                     "max_hours": hold_mod.WARMTH_HOLD_MAX_HOURS,
                                     "max_pings": hold_mod.WARMTH_HOLD_MAX_PINGS},
                     "tracked_last_requests": len(last_real),
                     "holds_armed": len(holds),
                     "sessions_total": sessions_total,
                     "sessions_shown": len(sessions),
                     "sessions_truncated": truncated,
                     "restored_at_start": dict(restore_mod._RESTORED),
                     "totals": dict(billing_mod._TOTALS),
                     "totals_since_start": billing_mod._since_start()},
           "sessions": sessions}
    if meta_err:
        res["proxy"]["session_meta_error"] = meta_err
    return res


def _strip_state(sid):
    """Per-session thinking-strip state for /_status — the proxy-truth a consumer
    (clodex) reconciles its configured intent against, killing the fire-once-and-
    forget desync (a /_strip POST that silently didn't land left the consumer
    believing L2 while the wire shipped L0).

    RECONCILE AGAINST `configured_level` (+ check `source=="override"`): it is the
    level the proxy WILL apply going forward = the per-session override if one is
    recorded, else the deployment global default. When a consumer's POST /_strip
    landed, the override is recorded and `configured_level` reflects it on the very
    next poll; when it didn't land, `configured_level` falls back to the global
    default (here 0) and `source` stays "global_default" — that mismatch is the
    re-POST signal. An explicit override IMMEDIATELY forces the guard latch (the
    setter eats the one-time warm re-cache the consumer asked for), so for an
    override-set session there is NO cold-gated holding-off to fight.

    Do NOT reconcile against the guard: `guard.latched` is the cold-gated
    strip/no-strip DECISION and is only ever held off (`latched:null`) on the
    AUTOMATIC/global path (sessions with no override). Re-POSTing because the guard
    reads null would fight a legitimate cold-gate — and is unnecessary, since
    setting an override resolves the guard immediately. Guard fields are for
    DIAGNOSIS only. `riders_available` = the L2 bundle (read/edit fold + edit-ack/
    tool-error free-rider stubs) is in the configured level; those riders fire
    CONDITIONALLY per turn (only inside a region the thinking-strip already busted),
    so this is "in the ceiling," not "fired this turn"."""
    override = transforms_mod._STRIP_OVERRIDE.get(sid)
    global_default = transforms_mod._global_strip_level()
    configured = override if override is not None else global_default
    latched = transforms_mod._STRIP_GUARD_LATCH.get(sid)   # bool | None (not yet decided)
    return {
        "configured_level": configured,
        "source": "override" if override is not None else "global_default",
        "global_default_level": global_default,
        "riders_available": configured >= 2,
        "guard": {"latched": latched,
                  "decision": (None if latched is None
                               else "strip" if latched else "no_strip")},
    }


def _subagents_with_active(sid, now):
    """The session's `sub_agents[]` for /_status, each augmented with the one
    server-computed FACT a consumer can't compute skew-free on its own:
    `last_active_s` = now - last_seen (float secs) — plus the instance's own
    cost share (`est_usd`, from billing's per-line by_line bucket, keyed by
    the same instance key; None for pre-feature traffic). Policy (running/
    idle/done) and aging stay the consumer's — we emit no `status`. Snapshot
    entries are fresh dict copies (meta clones them), so mutating is safe.
    None passthrough."""
    subs = meta_mod._subagents_snapshot(sid)
    if not subs:
        return subs
    by_line = (billing_mod._SESSION_TOTALS.get(sid) or {}).get("by_line") or {}
    for s in subs:
        ls = s.get("last_seen")
        s["last_active_s"] = round(now - ls, 1) if ls else None
        b = by_line.get(s.get("key"))
        s["est_usd"] = round(b["est_usd"], 6) if b else None
    return subs


def _last_assistant_activity(obj):
    """(last_text, last_tool, last_tool_input) from the LATEST assistant message
    in a forwarded request body. text = that message's text blocks joined; tool =
    its last tool_use (name + verbatim `input`). This is one-turn-stale by
    construction — the request body holds the transcript up to the last COMPLETED
    turn, never the in-flight response. All None when there's no assistant turn."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list):
        return None, None, None
    for m in reversed(msgs):
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        c = m.get("content")
        blocks = (c if isinstance(c, list)
                  else [{"type": "text", "text": c}] if isinstance(c, str) else [])
        texts, tool, tin = [], None, None
        for b in blocks:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                texts.append(b.get("text") or "")
            elif bt == "tool_use":
                tool = b.get("name")          # last one wins = most recent in turn
                tin = b.get("input")
        return ("\n".join(t for t in texts if t).strip() or None), tool, tin
    return None, None, None


def _clamp_strings(val, maxlen):
    """Clamp every string VALUE nested in val to maxlen chars, preserving the JSON
    STRUCTURE (never truncating keys or the shape — only leaf string values), so a
    popover can preview multi-arg tool inputs without pulling full file bodies.
    Returns (clamped_copy, any_truncated)."""
    truncated = False

    def go(v):
        nonlocal truncated
        if isinstance(v, str):
            if len(v) > maxlen:
                truncated = True
                return v[:maxlen]
            return v
        if isinstance(v, list):
            return [go(x) for x in v]
        if isinstance(v, dict):
            return {k: go(x) for k, x in v.items()}
        return v

    return go(val), truncated


def _subagent_detail(session, child, maxlen=None):
    """On-demand detail for ONE subagent instance (clodex popover): the latest
    assistant text + tool from its last forwarded request body. `child` is the
    instance key from `sub_agents[].key` (agent-id when present, else role).
    Facts-only, in-memory, off the poll path. `found:false` + `reason` (200, never
    4xx — action-endpoint convention) for the absent cases:
      unknown_child   — no such instance key under this (live) session
      no_request_body — instance is in sub_agents[] but no body was ever captured
      session_cold    — session swept/ended/restored, in-memory bodies gone
    `maxlen` clamps string values in last_text/last_tool_input in place; `truncated`
    is true iff any clamp fired."""
    snap = meta_mod._subagents_snapshot(session) or []
    match = next((s for s in snap if s.get("key") == child), None)
    entry = meta_mod._subagent_request(session, child)   # {"obj","ts",...} | None
    if entry is None:
        reason = ("no_request_body" if match else
                  "unknown_child" if snap else "session_cold")
        return {"session": session, "child": child, "found": False,
                "reason": reason}
    obj = entry.get("obj") or {}
    last_text, last_tool, last_tool_input = _last_assistant_activity(obj)
    truncated = False
    if maxlen and maxlen > 0:
        if isinstance(last_text, str) and len(last_text) > maxlen:
            last_text, truncated = last_text[:maxlen], True
        if last_tool_input is not None:
            last_tool_input, ti_trunc = _clamp_strings(last_tool_input, maxlen)
            truncated = truncated or ti_trunc
    return {"session": session, "child": child, "found": True,
            "role": (match or {}).get("role"),
            "model": (match or {}).get("model") or obj.get("model"),
            "display_name": (match or {}).get("display_name"),
            "turn_ts": entry.get("ts"),
            "last_text": last_text or None,
            "last_tool": last_tool,
            "last_tool_input": last_tool_input,
            "truncated": truncated}


# Chars -> tokens divisors. PROSE (system text, messages, thinking) tokenizes at
# ~4 ch/tok. Dense JSON tool SCHEMAS (short keys, punctuation, enum literals)
# tokenize ~40% denser: wire-calibrated 2026-07-18 against a session's own
# `/context` — 90,812 ch of tools[] reported as 32.7k tokens = 2.78 ch/tok, where
# the /4 estimate lowballed it to 23.3k (~30% under). So tool schemas get their
# own divisor; prose keeps /4. analyze_tools.py mirrors _SCHEMA_CHARS_PER_TOK at
# its tool-schema call sites. Ranking (what to trim) is robust to the exact ratio;
# the divisor split only matters for the absolute est_tokens shown next to /context.
_CHARS_PER_TOK = 4
_SCHEMA_CHARS_PER_TOK = 2.8


def _tool_roster(obj):
    """The tool composition of ONE forwarded request body (the post-transform
    obj — i.e. what actually reached the model, reflecting any wirescope
    tool-trim/sort). Returns {count, names, total_schema_chars, est_tokens,
    per_tool:[{name, schema_chars, est_tokens}]} with per_tool biggest-first
    (the 'what to trim' view). None for an openai/codex body (different wire,
    server-side caching, no anthropic tools[]) or when there are no tools."""
    if not isinstance(obj, dict) or codex_mod._is_openai_body(obj):
        return None
    tools = obj.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    per = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        chars = len(json.dumps(t, ensure_ascii=False))
        per.append({"name": t.get("name"), "schema_chars": chars,
                    "est_tokens": int(chars / _SCHEMA_CHARS_PER_TOK)})
    per.sort(key=lambda x: x["schema_chars"], reverse=True)
    total = sum(p["schema_chars"] for p in per)
    return {"count": len(per), "names": [p["name"] for p in per],
            "total_schema_chars": total,
            "est_tokens": int(total / _SCHEMA_CHARS_PER_TOK),
            "per_tool": per}


def _is_injected_reminder(text):
    """A user-role text block that is harness-injected context, NOT genuine user
    prompt: the `<system-reminder>` bundle (carries # claudeMd / # userEmail /
    # currentDate, plus our relocated env tail) and <command-*>/<local-command-*>
    expansions. Bucketed apart from real `user` text so the composition reflects
    what's actually a person's words vs auto-loaded context."""
    t = (text or "").lstrip()
    return (t.startswith("<system-reminder>") or t.startswith("<command-")
            or t.startswith("<local-command-"))


def _reminder_section_chars(text, hdr):
    """Char span of one CLI reminder section (# claudeMd / # userEmail /
    # currentDate) for COMPOSITION SIZING — from its header to the NEXT reminder
    header, else the LAST </system-reminder> (the structural close), else end.

    Distinct from the forward-path strip helper on purpose: that one fail-safe
    stops at the FIRST </system-reminder> so an `omit` never over-strips. But a
    memory file (this very CLAUDE.md / HANDOFF) routinely QUOTES </system-reminder>
    in its prose — the strip extent then truncates mid-content and the rest of the
    block lands in the `system` bucket (the "system prompt 51k" miscount). Sizing
    instead spans by reminder HEADERS (calibrated lowercase-camelCase, never a
    Title-Case content heading) and falls back to the LAST close tag (rfind), so a
    quoted </system-reminder> inside the body can't truncate the measurement. 0 if
    the header is absent."""
    m = re.search(r"(?m)^[ \t]*" + re.escape(hdr) + r"[ \t]*$", text)
    if not m:
        return 0
    rest = text[m.end():]
    nxt = re.search(transforms_mod._WS_SECTION_HDR_RE, rest)
    if nxt:
        return (m.end() + nxt.start()) - m.start()
    close = rest.rfind("</system-reminder>")
    end = m.end() + (close if close != -1 else len(rest))
    return end - m.start()


# The CLI injects the agent roster and the skills list as fixed-opener blocks,
# detected by their canonical lead line (tool word is Agent in clodex / Task in
# vanilla CC, hence the \w+). TWO wire shapes seen, BOTH must match:
#   (old/sonnet) a <system-reminder>-wrapped block inside messages[0]
#   (opus-4-8 mid-conversation-system beta) a trailing role:"system" message,
#     UNWRAPPED — text starts directly with the opener, no <system-reminder>.
# Hence the optional wrapper prefix. The match is ANCHORED to the block start
# (^) on purpose: these exact strings also appear mid-text in tool-results and
# assistant turns when an agent is *discussing* them — a substring match would
# false-positive, the anchor won't. Detecting them lets composition attribute
# their carriage (~1k tok/turn) apart from the agent system prompt, and a
# consumer can attach a trim lever (deny built-in agents / skillOverrides off).
# Whole-block categories: the entire block is the roster/list.
_RE_REMINDER_AGENTS = re.compile(
    r"^(?:<system-reminder>\s*)?Available agent types for the \w+ tool:")
_RE_REMINDER_SKILLS = re.compile(
    r"^(?:<system-reminder>\s*)?The following skills are available for use with the \w+ tool:")
# The opus-4-8 wire CONCATENATES the roster + skills list into ONE role:"system"
# message (agents first, then the skills opener on its own line). This finds that
# inner boundary so a combined block splits agents|skills (line-anchored: only a
# real list opener, never a mid-sentence mention).
_RE_SKILLS_LINE = re.compile(
    r"(?m)^The following skills are available for use with the \w+ tool:")


def _reminder_kind(text):
    """Classify a context block by its anchored opener: 'agents' (CLI agent
    roster), 'skills' (CLI skills list), or None (the # claudeMd/# userEmail
    context bundle, any other reminder/command expansion, or genuine
    conversation — all handled elsewhere). Matches both the <system-reminder>-
    wrapped form (old wire, messages[0]) and the unwrapped trailing role:"system"
    form (opus-4-8 mid-conversation-system beta)."""
    t = (text or "").lstrip()
    if _RE_REMINDER_AGENTS.match(t):
        return "agents"
    if _RE_REMINDER_SKILLS.match(t):
        return "skills"
    return None


# A skills-block entry: a column-0 `- <name>:` line (the CLI formats each skill
# as `- skill-name: <description>`). Same shape as the agent-roster entries, so
# we only ever scan it on the slice that starts AT the skills opener (agents that
# precede it in the opus-4-8 combined block are excluded by construction).
_RE_SKILL_ENTRY = re.compile(r"(?m)^- ([a-z0-9][\w.-]*):")


def _iter_body_texts(obj):
    """Yield every text string in a request body: system[] blocks (or a string
    system), then each message's text blocks. The home of the injected skills
    list on both wires (system[] / messages[0] reminder / trailing role:system)."""
    sysf = obj.get("system")
    if isinstance(sysf, list):
        for b in sysf:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                yield b["text"]
    elif isinstance(sysf, str):
        yield sysf
    for m in obj.get("messages") or []:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, str):
            yield c
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text" \
                        and isinstance(b.get("text"), str):
                    yield b["text"]


def _find_skills_block(obj):
    """The CLI skills list as a raw substring (opener through end of its block),
    found wherever it rides — own <system-reminder>, messages[0], or the opus-4-8
    combined trailing role:system message (slice from the skills opener so the
    agent roster ahead of it is dropped). None if no skills are loaded."""
    for t in _iter_body_texts(obj):
        m = _RE_SKILLS_LINE.search(t)
        if m:
            block = t[m.start():]
            end = block.find("</system-reminder>")
            return block[:end] if end != -1 else block
    return None


def _skill_roster(obj):
    """The skills composition of ONE forwarded body — the per-skill twin of
    _tool_roster. Returns {count, names, total_schema_chars, est_tokens,
    per_skill:[{name, schema_chars, est_tokens}]} biggest-first ('what to trim';
    the lever is skillOverrides:{name:off}, which actually reclaims the tokens —
    permissions.deny only gates invocation). Each skill's size = chars from its
    `- name:` line to the next entry (last entry → end of block). None for a
    codex body or when no skills block is present."""
    if not isinstance(obj, dict) or codex_mod._is_openai_body(obj):
        return None
    block = _find_skills_block(obj)
    if not block:
        return None
    entries = list(_RE_SKILL_ENTRY.finditer(block))
    if not entries:
        return None
    per = []
    for i, e in enumerate(entries):
        start = e.start()
        end = entries[i + 1].start() if i + 1 < len(entries) else len(block)
        chars = end - start
        per.append({"name": e.group(1), "schema_chars": chars,
                    "est_tokens": chars // _CHARS_PER_TOK})
    per.sort(key=lambda x: x["schema_chars"], reverse=True)
    total = sum(p["schema_chars"] for p in per)
    return {"count": len(per), "names": [p["name"] for p in per],
            "total_schema_chars": total, "est_tokens": total // _CHARS_PER_TOK,
            "per_skill": per}


def _composition(obj, total_tokens=None):
    """Token composition of ONE forwarded body, by category — 'what is taking up
    the context window'. Generic vocabulary any consumer can render:
    system / claudemd / useremail / agents / skills / tools / user / assistant /
    thinking / tool_calls / tool_results (file reads & command output land in
    tool_results, usually the bulk). claudemd & useremail are split out of the
    system-reminder so a consumer can attach a real trim lever (the wirescope
    omit directives); agents (the CLI agent roster) & skills (the CLI skills
    list) are likewise split out of their own system-reminder blocks — each
    ~hundreds of tok/turn that would otherwise hide inside 'system', and each
    has its own trim lever (deny built-in agents / deny skills in settings).

    Sizing is char-based (len, /4 — same basis as _tool_roster/analyze_tools.py);
    this is a READ-only endpoint computation, never on the forward path. When a
    real receipt `total_tokens` is given (main line), categories are scaled to
    sum to it (basis 'receipt') so the breakdown agrees with the wire-measured
    window total; otherwise raw char-estimate (basis 'estimate'). None for an
    openai/codex body or an empty one."""
    if not isinstance(obj, dict) or codex_mod._is_openai_body(obj):
        return None
    chars = collections.defaultdict(int)
    sysf = obj.get("system")
    if isinstance(sysf, list):
        for b in sysf:
            if isinstance(b, dict):
                chars["system"] += len(b.get("text") or "")
    elif isinstance(sysf, str):
        chars["system"] += len(sysf)
    for t in (obj.get("tools") or []):
        if isinstance(t, dict):
            chars["tools"] += len(json.dumps(t, ensure_ascii=False))
    for m in (obj.get("messages") or []):
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        c = m.get("content")
        blocks = (c if isinstance(c, list)
                  else [{"type": "text", "text": c}] if isinstance(c, str) else [])
        for b in blocks:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                text = b.get("text") or ""
                kind = _reminder_kind(text)        # agents/skills, any wire shape
                if kind == "agents":               # checked FIRST: the opus-4-8
                    #  roster arrives unwrapped (not an injected-reminder) AND may
                    #  carry the skills list appended in the same block -> split.
                    m = _RE_SKILLS_LINE.search(text)
                    if m:
                        chars["agents"] += m.start()
                        chars["skills"] += len(text) - m.start()
                    else:
                        chars["agents"] += len(text)
                elif kind == "skills":
                    chars["skills"] += len(text)
                elif _is_injected_reminder(text):
                    cm = _reminder_section_chars(text, "# claudeMd")
                    ue = _reminder_section_chars(text, "# userEmail")
                    chars["claudemd"] += cm
                    chars["useremail"] += ue
                    chars["system"] += max(0, len(text) - cm - ue)
                else:
                    chars["assistant" if role == "assistant" else "user"] += len(text)
            elif bt in ("thinking", "redacted_thinking"):
                # signature + redacted data ship on the wire (and a strip removes
                # them) -> count them, so this agrees with _strip_thinking_panel.
                body = (b.get("thinking") or "") + (b.get("data") or "")
                sig = b.get("signature") or ""
                chars["thinking"] += (len(body) + len(sig) if (body or sig)
                                      else len(json.dumps(b, ensure_ascii=False)))
            elif bt == "tool_use":
                chars["tool_calls"] += len(json.dumps(b, ensure_ascii=False))
            elif bt == "tool_result":
                bc = b.get("content")
                ln = (len(bc) if isinstance(bc, str)
                      else sum(len(x.get("text") or "") for x in bc
                               if isinstance(x, dict)) if isinstance(bc, list)
                      else len(json.dumps(bc, ensure_ascii=False)) if bc is not None
                      else 0)
                chars["tool_results"] += ln
    # tools[] is dense JSON schema -> its own divisor; every other category is
    # prose. Matters for the tools-vs-rest split before the receipt rescale.
    raw = {k: (int(v / _SCHEMA_CHARS_PER_TOK) if k == "tools" else v // _CHARS_PER_TOK)
           for k, v in chars.items() if v > 0}
    raw_total = sum(raw.values())
    if not raw_total:
        return None
    if total_tokens and total_tokens > 0:
        basis, total = "receipt", total_tokens
        scale = total_tokens / raw_total
        cats = [{"category": k, "tokens": round(v * scale)} for k, v in raw.items()]
    else:
        basis, total, scale = "estimate", raw_total, 1.0
        cats = [{"category": k, "tokens": v} for k, v in raw.items()]
    for c in cats:
        c["pct"] = round(100.0 * c["tokens"] / total, 1) if total else 0.0
    cats.sort(key=lambda x: x["tokens"], reverse=True)
    out = {"total_tokens": total, "basis": basis, "by_category": cats}
    spt = _strip_thinking_panel(obj, scale, total)
    if spt:
        out["strip_prior_thinking"] = spt
    ste = _strip_tool_errors_panel(obj, scale, total)
    if ste:
        out["strip_prior_tool_errors"] = ste
    sea = _strip_edit_acks_panel(obj, scale, total)
    if sea:
        out["strip_prior_edit_acks"] = sea
    return out


def _strip_thinking_panel(obj, scale, total):
    """Decision panel for STRIP_PRIOR_THINKING: how much of the window is
    PRIOR-turn thinking (the strippable, reclaimable slice) vs current-turn
    thinking (signed, untouchable), the body/thinking ratio the monster guard
    gates on, the live would-strip verdict, and the per-turn read reclaim. Reuses
    the transform's own helpers so `would_strip`/`body_thinking_ratio` match the
    real gate exactly (no drift). None when there is no prior thinking to strip."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_user = max((i for i, m in enumerate(msgs)
                     if transforms_mod._is_real_user_turn(m)), default=-1)
    if last_user <= 0:
        return None
    prior = msgs[:last_user]
    pt_ch = sum(transforms_mod._msg_thinking_chars(m) for m in prior
                if isinstance(m, dict) and m.get("role") == "assistant")
    if not pt_ch:
        return None
    pb_ch = sum(transforms_mod._msg_nonthinking_chars(m) for m in prior
                if isinstance(m, dict))
    cur_ch = sum(transforms_mod._msg_thinking_chars(m) for m in msgs[last_user:]
                 if isinstance(m, dict) and m.get("role") == "assistant")
    ratio = round(pb_ch / pt_ch, 2)
    mbr = transforms_mod.STRIP_THINK_MAX_BODY_RATIO
    prior_tok = round((pt_ch // _CHARS_PER_TOK) * scale)
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(prior_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"prior_thinking_tokens": prior_tok,
            "current_thinking_tokens": round((cur_ch // _CHARS_PER_TOK) * scale),
            "prior_body_tokens": round((pb_ch // _CHARS_PER_TOK) * scale),
            "body_thinking_ratio": ratio, "max_body_ratio": mbr,
            "would_strip": (mbr <= 0 or ratio <= mbr),
            "pct_of_window": round(100.0 * prior_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": prior_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


def _strip_tool_errors_panel(obj, scale, total):
    """Decision panel for STRIP_PRIOR_TOOL_ERRORS: how much of the window is
    PRIOR-turn failed-call carriage — both halves the strip reclaims, the fat
    assistant `tool_use.input` (old/new string the model tried) plus its paired
    `is_error` result — counted over the strippable region (before the last real
    user boundary; current turn's error is the live retry signal, never counted).
    Reuses the transform's id-pairing so the figures match the real strip. Note
    the strip free-rides the thinking-strip bust, so `would_strip` is also gated
    on prior thinking being present to strip. None when there are no prior errors."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_user = max((i for i, m in enumerate(msgs)
                     if transforms_mod._is_real_user_turn(m)), default=-1)
    if last_user <= 0:
        return None
    prior = msgs[:last_user]
    # Pass 1: error result ids + their reclaimable body chars (minus the marker).
    error_ids, result_ch, n_results = set(), 0, 0
    mk = len(transforms_mod.ERROR_ELIDED_MARKER)
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_result"
                    and b.get("is_error")):
                continue
            tuid = b.get("tool_use_id")
            if tuid is not None:
                error_ids.add(tuid)
            body = b.get("content")
            n = len(body) if isinstance(body, str) else len(json.dumps(body, default=str))
            if n > mk:
                result_ch += n - mk
                n_results += 1
    if not error_ids:
        return None
    # Pass 2: the matching failed-call inputs (the larger half), minus the stub.
    call_ch, n_calls = 0, 0
    sk = len(json.dumps(transforms_mod.ERROR_CALL_STUB, default=str))
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_use"
                    and b.get("id") in error_ids):
                continue
            inp = b.get("input")
            n = len(json.dumps(inp, default=str)) if inp is not None else 0
            if n > sk:
                call_ch += n - sk
                n_calls += 1
    reclaim_ch = result_ch + call_ch
    if reclaim_ch <= 0:
        return None
    reclaim_tok = round((reclaim_ch // _CHARS_PER_TOK) * scale)
    cur_think = sum(transforms_mod._msg_thinking_chars(m) for m in msgs[last_user:]
                    if isinstance(m, dict) and m.get("role") == "assistant")
    prior_think = sum(transforms_mod._msg_thinking_chars(m) for m in prior
                      if isinstance(m, dict) and m.get("role") == "assistant")
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(reclaim_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"failed_calls": n_calls, "error_results": n_results,
            "failed_call_tokens": round((call_ch // _CHARS_PER_TOK) * scale),
            "error_result_tokens": round((result_ch // _CHARS_PER_TOK) * scale),
            # free-rides the thinking-strip bust -> only fires when prior thinking
            # is also strippable this turn (no bust to ride otherwise) AND L2 (or
            # the scratch-A/B flag) is enabled for the session.
            "would_strip": bool((transforms_mod.STRIP_PRIOR_TOOL_ERRORS
                                 or transforms_mod._strip_l2_enabled(obj))
                                and prior_think > 0),
            "rides_thinking_bust": prior_think > 0,
            "pct_of_window": round(100.0 * reclaim_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": reclaim_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


def _strip_edit_acks_panel(obj, scale, total):
    """Decision panel for the L2 edit-ack collapse: how much of the window is
    PRIOR-turn Edit/Write SUCCESS-ack boilerplate that L2 collapses to "ok" — the
    OTHER half of L2 (the failed-call panel above is the first half). Counted over
    the strippable region (before the last real user boundary; the current turn's
    ack carries the live 'no need to Read it back' nudge, never counted). Reuses
    the transform's edit-id pairing + ack fragments so the figures match the real
    strip. Like the errors panel, the collapse free-rides the thinking-strip bust,
    so `would_strip` is also gated on prior thinking being present. None when there
    are no collapsible prior acks."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_user = max((i for i, m in enumerate(msgs)
                     if transforms_mod._is_real_user_turn(m)), default=-1)
    if last_user <= 0:
        return None
    prior = msgs[:last_user]
    edit_ids = transforms_mod._edit_result_ids(prior)
    if not edit_ids:
        return None
    mk = len(transforms_mod.EDIT_ACK_MARKER)
    ack_ch, n_acks = 0, 0
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_result"
                    and b.get("tool_use_id") in edit_ids):
                continue
            if b.get("is_error"):
                continue
            body = b.get("content")
            if not isinstance(body, str) or body == transforms_mod.EDIT_ACK_MARKER:
                continue
            if not any(frag in body for frag in transforms_mod._EDIT_ACK_FRAGMENTS):
                continue
            if len(body) <= mk:
                continue
            ack_ch += len(body) - mk
            n_acks += 1
    if ack_ch <= 0:
        return None
    reclaim_tok = round((ack_ch // _CHARS_PER_TOK) * scale)
    prior_think = sum(transforms_mod._msg_thinking_chars(m) for m in prior
                      if isinstance(m, dict) and m.get("role") == "assistant")
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(reclaim_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"collapsed_acks": n_acks,
            "edit_ack_tokens": reclaim_tok,
            # free-rides the thinking-strip bust -> only fires when prior thinking
            # is also strippable this turn AND L2 (or the scratch-A/B flag) is on.
            "would_strip": bool((transforms_mod.STRIP_PRIOR_EDIT_ACKS
                                 or transforms_mod._strip_l2_enabled(obj))
                                and prior_think > 0),
            "rides_thinking_bust": prior_think > 0,
            "pct_of_window": round(100.0 * reclaim_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": reclaim_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


def _utilization(session):
    """Lifetime tool-USE tally for a session, scanned from its capture dir
    (LOG_DIR/<session>/). Answers 'of the tools loaded every turn, which ever
    got exercised?' — the deadweight question, made per-session and live.

    On-demand only (a disk scan): callers gate it behind
    `/_context?...&utilization=1` so the 10s poll / admin path never pays for it.
    Scoped to the ONE session dir => naturally bounded to the live session_id (a
    /clear mints a fresh id => fresh dir => the tally never spans the boundary).

    Mirrors analyze_tools.py's accounting, joined request<->response by file
    stem: only turns that LOADED tools AND actually RAN (200) count as a 'chance
    to use' (a no-tools title side-call or an errored turn is not evidence of
    waste). `used` is the RAW invocation count (3 Reads in one turn = 3; from
    response meta.tool_uses), per clodex's contract.

    Returns {key -> {evaluable_turns, by_tool: {name -> used_count}}} keyed by
    agent line: 'main' for the routed parent/unknown-role turns, else the
    subagent INSTANCE's x-claude-code-agent-id (fallback role) — the same key
    _context_snapshot resolves per agent, so the merge lines up. Empty map for a
    cold/absent dir."""
    out = {}
    d = core_mod.LOG_DIR / session
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.request.json")):
        try:
            rec = json.loads(f.read_text())
        except Exception:
            continue
        summ = rec.get("summary") or {}
        if not (summ.get("n_tools") or 0):
            continue                       # no tools loaded => not a use-chance
        role = summ.get("role")
        key = "main" if role in ("parent", "unknown", None) \
            else (summ.get("agent_id") or role)
        rp = f.with_name(f.name.replace(".request.json", ".response.json"))
        ok, called = False, []
        try:
            resp = json.loads(rp.read_text())
            ok = resp.get("status_code") == 200
            called = (resp.get("meta") or {}).get("tool_uses") or []
        except Exception:
            pass
        g = out.setdefault(key, {"evaluable_turns": 0,
                                 "by_tool": collections.Counter()})
        if ok:
            g["evaluable_turns"] += 1
            for name in called:
                if name:
                    g["by_tool"][name] += 1
    return out


def _apply_utilization(tools, ustats):
    """Fold one agent line's lifetime tally (from _utilization) into its tools
    roster IN PLACE: stamp per_tool[].used, re-sort deadweight-first (never-used
    first, then biggest schema = the 'trim me' order clodex renders), and return
    a rollup {basis, evaluable_turns, loaded, used_distinct, deadweight_tokens}.
    deadweight_tokens = per-turn schema carriage of the currently-loaded tools
    that were never called — the concrete 'free up ~N tokens' payoff. None when
    there is no roster (codex / no tools)."""
    if not tools:
        return None
    by_tool = (ustats or {}).get("by_tool") or {}
    evaluable = (ustats or {}).get("evaluable_turns", 0)
    for p in tools["per_tool"]:
        p["used"] = int(by_tool.get(p["name"], 0))
    tools["per_tool"].sort(key=lambda x: (x["used"] > 0, -x["est_tokens"]))
    used_distinct = sum(1 for p in tools["per_tool"] if p["used"] > 0)
    deadweight = sum(p["est_tokens"] for p in tools["per_tool"] if p["used"] == 0)
    return {"basis": "capture-scan", "evaluable_turns": evaluable,
            "loaded": tools["count"], "used_distinct": used_distinct,
            "deadweight_tokens": deadweight}


def _skill_utilization(session):
    """Lifetime skill-INVOCATION tally for a session, scanned from its capture
    dir — the per-skill twin of _utilization. Answers 'of the skills loaded every
    turn, which ever got invoked?'.

    The skill NAME is not in response meta.tool_uses (that records only the tool
    name "Skill") — it lives in the assistant `tool_use` block's INPUT
    (`{skill, args}`), which surfaces in the message history of LATER requests.
    So we scan request bodies' assistant tool_use blocks where name=="Skill" and
    count by input["skill"]. History accumulates, so the SAME tool_use id repeats
    across a line's turns → we dedupe by id (counted once, at first sighting).
    Ids never cross agent lines (separate threads), so the global seen-set is safe.

    evaluable_turns = turns that LOADED skills (the list was in the body) AND ran
    200 — the 'chance to invoke', mirroring _utilization's tool accounting.

    Returns {key -> {evaluable_turns, by_skill: {name -> count}}}, key resolved
    the same way as _utilization ('main' / subagent agent_id-or-role)."""
    out = {}
    d = core_mod.LOG_DIR / session
    if not d.is_dir():
        return out
    seen = set()                          # tool_use ids counted once per session
    for f in sorted(d.glob("*.request.json")):
        try:
            rec = json.loads(f.read_text())
        except Exception:
            continue
        body = rec.get("body") or {}
        if not isinstance(body, dict):
            continue
        summ = rec.get("summary") or {}
        role = summ.get("role")
        key = "main" if role in ("parent", "unknown", None) \
            else (summ.get("agent_id") or role)
        g = out.setdefault(key, {"evaluable_turns": 0,
                                 "by_skill": collections.Counter()})
        if any(_RE_SKILLS_LINE.search(t) for t in _iter_body_texts(body)):
            rp = f.with_name(f.name.replace(".request.json", ".response.json"))
            try:
                if json.loads(rp.read_text()).get("status_code") == 200:
                    g["evaluable_turns"] += 1
            except Exception:
                pass
        for m in body.get("messages") or []:
            if not isinstance(m, dict) or m.get("role") != "assistant":
                continue
            c = m.get("content")
            if not isinstance(c, list):
                continue
            for b in c:
                if not (isinstance(b, dict) and b.get("type") == "tool_use"
                        and b.get("name") == "Skill"):
                    continue
                bid = b.get("id")
                if bid in seen:
                    continue
                seen.add(bid)
                sk = (b.get("input") or {}).get("skill")
                if sk:
                    g["by_skill"][sk] += 1
    return out


def _apply_skill_utilization(skills, ustats):
    """Fold a session's skill-invocation tally into its skill roster IN PLACE:
    stamp per_skill[].used, re-sort deadweight-first, and return a rollup
    {basis, evaluable_turns, loaded, used_distinct, deadweight_tokens} — the
    per-skill twin of _apply_utilization. deadweight_tokens = per-turn carriage of
    loaded-but-never-invoked skills (the skillOverrides:off reclaim payoff). None
    when there is no roster."""
    if not skills:
        return None
    by_skill = (ustats or {}).get("by_skill") or {}
    evaluable = (ustats or {}).get("evaluable_turns", 0)
    for p in skills["per_skill"]:
        p["used"] = int(by_skill.get(p["name"], 0))
    skills["per_skill"].sort(key=lambda x: (x["used"] > 0, -x["est_tokens"]))
    used_distinct = sum(1 for p in skills["per_skill"] if p["used"] > 0)
    deadweight = sum(p["est_tokens"] for p in skills["per_skill"] if p["used"] == 0)
    return {"basis": "capture-scan", "evaluable_turns": evaluable,
            "loaded": skills["count"], "used_distinct": used_distinct,
            "deadweight_tokens": deadweight}


def _context_snapshot(session, utilization=False):
    """`GET /_context?session=<id>`: the tool rosters loaded for a session,
    main/parent line and each subagent INSTANCE reported separately (they carry
    distinct, possibly wirescope-trimmed sets). Read-only over the in-memory
    last forwarded request bodies (parent in pinger._LAST_REQUEST, subagents in
    meta._SUBAGENT_LAST_REQ) — so it answers 'what tools are enabled for session
    X right now'. No disk lookup: an ended/restored/cold session with nothing in
    memory returns agents=[] plus an explanatory note.

    When `utilization=True` each agent's tools roster is additionally enriched
    with per-tool `used` counts + a `utilization` rollup (deadweight pricing)
    via a one-time disk scan of the session's capture dir (_utilization) — the
    'did the loaded tools pay off?' view. Off by default so the cheap in-memory
    path is unchanged for the poll/admin callers."""
    agents = []
    util = _utilization(session) if utilization else {}
    skutil = _skill_utilization(session) if utilization else {}
    with pinger_mod._LAST_REQUEST_LOCK:
        main = pinger_mod._LAST_REQUEST.get(session)
        main = dict(main) if main else None     # shallow copy; obj read outside lock
    if main:
        obj = main.get("obj")
        # main line carries a real usage receipt -> anchor the composition total
        # to the wire-measured window size so it agrees with /_status.input_tokens
        total = meta_mod._input_token_total(meta_mod._LAST_USAGE.get(session))
        roster = _tool_roster(obj)
        entry = {
            "line": "main", "role": "parent", "agent_id": None,
            "display_name": None,
            "model": (obj or {}).get("model") if isinstance(obj, dict) else None,
            "wire": "openai" if codex_mod._is_openai_body(obj) else "anthropic",
            "last_seen": main.get("ts"),
            "tools": roster,
            "skills": _skill_roster(obj),
            "composition": _composition(obj, total)}
        if utilization:
            entry["utilization"] = _apply_utilization(roster, util.get("main"))
            entry["skills_utilization"] = _apply_skill_utilization(
                entry["skills"], skutil.get("main"))
        agents.append(entry)
    for s in meta_mod._subagent_request_objs(session):
        obj = s.get("obj")
        roster = _tool_roster(obj)
        entry = {
            "line": "subagent", "role": s.get("role"),
            "agent_id": s.get("agent_id"), "display_name": s.get("display_name"),
            "model": s.get("model"),
            "wire": "openai" if codex_mod._is_openai_body(obj) else "anthropic",
            "last_seen": s.get("last_seen"),
            "tools": roster,
            "skills": _skill_roster(obj),
            "composition": _composition(obj)}    # no sub receipt -> estimate
        if utilization:
            ukey = s.get("agent_id") or s.get("role")
            entry["utilization"] = _apply_utilization(roster, util.get(ukey))
            entry["skills_utilization"] = _apply_skill_utilization(
                entry["skills"], skutil.get(ukey))
        agents.append(entry)
    note = None
    if not agents:
        note = ("no in-memory request for this session "
                "(cold/restored/ended); query while it is active")
    return {"session_id": session, "agents": agents, "note": note}
