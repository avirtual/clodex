import atexit
import json
import os
import queue
import re
import threading
from pathlib import Path

# Siblings resolved LAZILY through the package object: writer is imported
# early (warmth's header pulls it in) and eager `from proxylab import
# meta/pinger/warmth` here would cascade their import while warmth is still
# partial (pinger reads warmth.WARMTH_LEDGER at module level). The references
# below run only on the writer thread, long after the package finished loading.
import proxylab

# --- async disk writer --------------------------------------------------------
# The proxy must add no visible overhead, so NOTHING on the request/response
# byte-path touches the disk. The handler only enqueues (an O(1) put); a single
# background daemon thread does the mkdir + json.dumps + write. One thread keeps
# writes serialized (stable file ordering) and avoids thread-explosion.
NO_SESSION = "_no-session"          # bucket for requests that carry no session_id
_WRITE_Q: "queue.Queue" = queue.Queue()

def _writer_loop():
    while True:
        item = _WRITE_Q.get()
        try:
            if item is None:
                return
            path, kind, data = item
            # path may legitimately be None (ledger with WARMTH_LOG_FILE=0,
            # session-meta upserts) — the old unconditional mkdir crashed there
            # and the bare except silently dropped the WHOLE item, ledger stamp
            # included.
            if path is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
            if kind == "meta":  # session_meta upsert (no file output)
                sid, fields = data
                proxylab.meta._upsert_session_meta(sid, **fields)
            elif kind == "lastreq":   # mirror a replayable request (no secrets)
                proxylab.pinger._persist_last_request_row(*data)
            elif kind == "lastreq_del":
                proxylab.pinger._delete_last_request_row(data)
            elif kind == "bytes":
                path.write_bytes(data)
            elif kind == "append":  # one JSON object per line (canary change-log)
                with path.open("a") as fh:
                    fh.write(json.dumps(data, ensure_ascii=False) + "\n")
            elif kind == "ledger":  # hash+touch the prefix-warmth ledger off-thread
                obj, usage, is_main = data
                rec = proxylab.warmth._record_warmth(obj, usage, is_main=is_main)
                if rec is not None:
                    segs = rec.get("segments") or {}
                    seg_s = ("".join(f" {k}={v['hash'][:6]}"
                                     for k, v in segs.items())) if segs else ""
                    bust_s = f" BUST={rec['bust_class']}" if rec.get("bust_class") else ""
                    print(f"[warmth] {rec['hash'][:12]} ttl={rec['ttl']}s "
                          f"{'PING' if rec['ping'] else 'turn'} "
                          f"warm_on_arrival={rec['warm_on_arrival']} "
                          f"(ledger={rec['ledger_size']}){seg_s}{bust_s}", flush=True)
                    if path is not None:
                        path.write_text(json.dumps(rec, indent=2, ensure_ascii=False))
            else:  # "json" — serialize off the event loop, in this thread
                path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        except Exception:
            pass
        finally:
            _WRITE_Q.task_done()


_writer_thread = threading.Thread(target=_writer_loop, name="logwriter", daemon=True)
_writer_thread.start()


def _flush_writes():
    """Drain pending writes on shutdown so no captures are lost."""
    try:
        _WRITE_Q.join()
        _WRITE_Q.put(None)
        _writer_thread.join(timeout=5)
    except Exception:
        pass


atexit.register(_flush_writes)


def _enqueue_json(path: Path, obj):
    _WRITE_Q.put((path, "json", obj))


def _enqueue_bytes(path: Path, blob: bytes):
    _WRITE_Q.put((path, "bytes", blob))


def _enqueue_append(path: Path, obj):
    _WRITE_Q.put((path, "append", obj))


def _enqueue_ledger(path, obj, usage, is_main=True):
    """Hand the (post-transform) request body + response usage to the writer
    thread, which hashes the cacheable prefix and refreshes the warmth ledger.
    `path` (a <stem>.warmth.json) is written too when WARMTH_LOG_FILE is on.
    `is_main` gates the session-head advance + bust classification (main line
    only — subagents share the parent's session_id)."""
    _WRITE_Q.put((path, "ledger", (obj, usage, is_main)))


def _enqueue_meta(session_id, **fields):
    """Upsert session_meta (title/cwd/model/last_seen) on the writer thread —
    the SQLite write never runs on the byte hot path."""
    if session_id:
        _WRITE_Q.put((None, "meta", (session_id, fields)))


def _enqueue_last_request(session_id, account_uuid, path, ts, obj, safe_headers):
    """Mirror a session's replayable last request to SQLite on the writer thread
    (JSON serialization of a multi-hundred-KB body stays off the event loop).
    obj is not reused after its turn, so passing the ref is safe."""
    _WRITE_Q.put((None, "lastreq",
                  (session_id, account_uuid, path, ts, obj, safe_headers)))


def _enqueue_last_request_delete(session_id):
    _WRITE_Q.put((None, "lastreq_del", session_id))


def _session_ids(obj):
    """Parse session_id/account_uuid/device_id out of metadata.user_id.

    metadata.user_id is itself a JSON STRING, e.g.
    '{"device_id":"…","account_uuid":"…","session_id":"…"}'. Only `messages`
    requests carry it; count_tokens/probes do not (-> NO_SESSION bucket)."""
    uid = (obj.get("metadata") or {}).get("user_id")
    if not uid:
        return None, None, None
    try:
        d = json.loads(uid)
        return d.get("session_id"), d.get("account_uuid"), d.get("device_id")
    except Exception:
        return None, None, None


def _sys_text(obj):
    sys = obj.get("system")
    if isinstance(sys, list):
        return " ".join(b.get("text", "") for b in sys if isinstance(b, dict))
    return sys or ""


# Roles that _classify_role assigns to TASK-spawned subagents. They share the
# parent's session_id on the wire (one session dir holds parent + every sub), so
# anything keyed by session_id (the /_status row, the replayable last request,
# the hold anchor) must NOT be overwritten by a subagent turn — the main agent
# is the durable, pingable line; subagents are transient. "parent"/"unknown" are
# the main line. See server.py + meta._capture_session_meta.
#
# "subagent" = the GENERIC bucket for a subagent whose system prompt matched no
# known signature below (a CUSTOM .claude/agents/<name> agent). We learn it from
# the billing header's ground-truth cc_is_subagent flag, not from prose; the wire
# carries no custom agent NAME, only the boolean, so all such turns collapse here.
SUBAGENT_ROLES = frozenset({"Plan", "verification", "general-purpose", "subagent"})


def _is_subagent_role(role):
    return role in SUBAGENT_ROLES


def _billing_is_subagent(obj):
    """Ground-truth subagent flag from the x-anthropic-billing-header (block 0 of
    system[]): `cc_is_subagent=true`. The routed MAIN agent USUALLY never sets it
    — but it CAN leak onto a parent turn alongside a recycled agent-id (the clodex
    stale-id case, wire-confirmed 2026-06-14), so this flag alone is not trusted to
    file a subagent bucket; see _genuine_subagent for the fingerprint backstop."""
    return "cc_is_subagent=true" in _sys_text(obj)


# CONTENT FINGERPRINT (the cc_version suffix). The CLI recomputes it every request
# from the ACTUAL body (SHA256 over chars of the first user message + version) and
# embeds it in the billing header, so it tracks the conversation LINEAGE and can
# NOT be stale relative to the body (confirmed against claude-code's
# fingerprint.ts). This is the one main/sub signal that survives the clodex
# stale-agent-id leak: a parent turn that arrives flagged cc_is_subagent=true with
# a recycled agent-id STILL carries the parent's fingerprint, because its body is
# the parent conversation. See _genuine_subagent.
_BILLING_FP_RE = re.compile(r"cc_version=([0-9a-f.]+)")
_SESSION_MAIN_FP = {}          # session_id -> the main line's content fingerprint


def _billing_fingerprint(obj):
    """The cc_version content fingerprint from the billing header, or None."""
    m = _BILLING_FP_RE.search(_sys_text(obj))
    return m.group(1) if m else None


def _note_main_fingerprint(session_id, obj):
    """Record the session's MAIN-line fingerprint — called ONLY from the durable
    main-line capture path (never a title side-call or a subagent), so it's the
    parent's stable first-message fingerprint that _genuine_subagent tests against."""
    if not session_id:
        return
    fp = _billing_fingerprint(obj)
    if fp:
        _SESSION_MAIN_FP[session_id] = fp


def _forget_session_fp(session_id):
    """Drop a session's main fingerprint (pinger sweep hook)."""
    _SESSION_MAIN_FP.pop(session_id, None)


def _genuine_subagent(obj, agent_id=None):
    """True only if this turn is a REAL subagent. SIGNAL (either suffices):
      - the CLI's header-flagged `cc_is_subagent=true` (its own Task/Agent subs), OR
      - a present `x-claude-code-agent-id` (the only signal carried by
        proxy/teammate-spawned agents — e.g. `opsguru2@session-…` — which are
        top-level CLI processes and so never set cc_is_subagent; same gap in
        clodex and bare CLI).
    In BOTH cases the FINGERPRINT BACKSTOP must clear it: a parent turn that
    leaked the flag + a recycled agent-id carries the MAIN line's body-derived
    fingerprint, so it reads NOT-genuine and stays on the main line — fail closed.
    PURE READ: never mutates _SESSION_MAIN_FP (the main path does, via
    _note_main_fingerprint), so transform-chain / classifier callers can't corrupt
    the reference with a title side-call.
    CAVEAT: fork-path subagents (subagent_type omitted) clone the parent's first
    message and thus its fingerprint -> read as main here. Safe under-attribution
    (a fork's turns roll into the parent view, never corrupting a real sub bucket);
    normal Task subs have their own first message -> own fingerprint."""
    if not (_billing_is_subagent(obj) or agent_id):
        return False
    sid = (_session_ids(obj) or [None])[0]
    main_fp = _SESSION_MAIN_FP.get(sid) if sid else None
    fp = _billing_fingerprint(obj)
    if main_fp and fp and fp == main_fp:
        return False               # leaked parent turn (stale agent-id)
    return True


# --- Wirescope directive protocol (`wirescope:`) — full spec in WIRESCOPE.md --
# Opt-in directives an agent author writes into the agent .md BODY (the only
# author-controlled text that reaches system[], since the CLI drops frontmatter
# and never sends an agent name). Form: `[wirescope:<directive> <value>]`, one
# per line, WHOLE-LINE AT COLUMN 1 — a directive mentioned inline in prose, a
# backticked example, or an indented quote is CONTENT, never a directive (and
# is left on the wire). The distinctive prefix alone proved insufficient: a
# prompt that DOCUMENTED the syntax (`[wirescope:tools Read,Grep,Glob]` as a
# teaching example) got INVOKED against that very agent under the old
# unanchored scan — collapsed its roster 31->1, which also cost it its spawn
# tool and thus the spawner hint (live incident 2026-07-12). A false match
# doesn't just delete text, it EXECUTES the verb; anchoring is the fix (same
# convention as the strict-head spawn parse, and as clodex's own column-1
# intent rule). To quote a directive safely: indent it or wrap it in backticks.
# Body directives are parsed from the system prompt; spawn directives (below)
# from the strict head of the spawn-prompt block. Unknown directives are
# silently ignored -> additive forever.
# A WHOLE-LINE directive: the entire line is exactly one directive (trailing
# whitespace tolerated via rstrip at the call sites; leading whitespace is NOT
# — indentation is the quoting escape).
_WS_LINE_RE = re.compile(
    r"^\[wirescope:([a-z][a-z0-9-]*)(?:[ \t]+([^\]\n]*))?\]$", re.IGNORECASE)

# Spawn-level directives (WIRESCOPE.md v1): read omit/keep/agent-name from the
# strict head of messages[0]'s spawn-prompt block, so behavior can be a property
# of the CALL — apply omit/keep to UNEDITABLE built-in subagents (Plan/Explore/
# general-purpose) by leading the Task prompt with a directive, no def edit /
# override-trap. messages[0] is frozen at spawn + resent verbatim and later
# turns append to messages[1..], so this position is NOT injectable by
# mid-conversation content (tool result, web page, etc.). Residual trust: the
# spawner must not place untrusted data as the literal leading token. Default ON
# (directive presence is the opt-in, like WS_OMIT); WS_SPAWN_DIRECTIVES=0 is a
# deployment kill-switch that disables all message-content directive parsing.
WS_SPAWN_DIRECTIVES = os.environ.get(
    "WS_SPAWN_DIRECTIVES", "1") not in ("0", "no", "off", "false")


def _ws_directive_pairs(text):
    """Ordered [(directive(lowercased), value(str, trimmed))] for every
    WHOLE-LINE column-1 `[wirescope:...]` line in `text` (duplicates kept, in
    order) — the form the action resolver needs (one target may carry several
    verbs across lines). Inline/indented/backticked mentions are content, not
    directives (see _WS_LINE_RE)."""
    out = []
    for raw in text.splitlines():
        m = _WS_LINE_RE.match(raw.rstrip())
        if m:
            out.append((m.group(1).lower(), (m.group(2) or "").strip()))
    return out


def _ws_body_pairs(obj):
    """Ordered directives from the request's system body."""
    return _ws_directive_pairs(_sys_text(obj))


def _ws_directives(obj):
    """System-body directives as {directive: value} (last duplicate wins) — the
    flat view used for single-valued directives like agent-name."""
    return dict(_ws_body_pairs(obj))


def _ws_prompt_block(obj):
    """messages[0]'s spawn-prompt text block: the first `user` text block that is
    NOT a <system-reminder> (those are harness-generated — blocks 0/1 in
    practice; the prompt/Task text is block 2). Returns the mutable block dict or
    None (no list-content messages[0], or none found)."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    m0 = msgs[0]
    if not isinstance(m0, dict) or m0.get("role") != "user":
        return None
    c = m0.get("content")
    if not isinstance(c, list):
        return None
    for b in c:
        if (isinstance(b, dict) and b.get("type") == "text"
                and isinstance(b.get("text"), str)
                and not b["text"].lstrip().startswith("<system-reminder>")):
            return b
    return None


def _parse_leading_pairs(text):
    """Ordered [(directive, value)] at the STRICT HEAD of `text`: leading blank
    lines are skipped, then a run of consecutive whole-line `[wirescope:...]`
    directives is consumed; parsing stops at the first non-blank, non-directive
    line. A directive not at the head is ignored."""
    out = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        m = _WS_LINE_RE.match(s)
        if not m:
            break
        out.append((m.group(1).lower(), (m.group(2) or "").strip()))
    return out


def _ws_strip_leading_directives(text):
    """Remove the strict-head `[wirescope:...]` directive lines (and any blank
    lines among/before them) from `text`. Mirrors _parse_leading_directives, so
    it strips exactly what was consumed. Returns (new_text, n_removed)."""
    lines = text.splitlines(keepends=True)
    i = removed = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        if _WS_LINE_RE.match(s):
            removed += 1
            i += 1
            continue
        break
    if not removed:
        return text, 0
    return "".join(lines[i:]).lstrip("\n"), removed


def _ws_spawn_pairs(obj):
    """Ordered leading `[wirescope:...]` directives from messages[0]'s spawn-prompt
    block, or [] (flag off / no prompt block / none present). See
    WS_SPAWN_DIRECTIVES."""
    if not WS_SPAWN_DIRECTIVES:
        return []
    b = _ws_prompt_block(obj)
    if b is None:
        return []
    return _parse_leading_pairs(b["text"])


def _ws_spawn_directives(obj):
    """Spawn-position directives as {directive: value} (last wins) — the flat
    view for single-valued directives like agent-name."""
    return dict(_ws_spawn_pairs(obj))


def _subagent_marker_name(obj):
    """The author-declared display label from `[wirescope:agent-name <label>]`,
    or None. A spawn-position directive overrides a body one (precedence spawn >
    body). Display-grade only (no gate reads it); len-capped at 64.

    Rejects an unsubstituted template PLACEHOLDER — a value wrapped in angle
    brackets like `<label>`/`<name>` — which a spawner emits when it copies the
    directive template verbatim without filling in a real name. Such a value is
    never a real label, so we drop it and fall back to the normal role/id
    naming rather than displaying the literal `<label>` in the admin view."""
    name = (_ws_spawn_directives(obj).get("agent-name")
            or _ws_directives(obj).get("agent-name"))
    if not name:
        return None
    name = name.strip()
    if name.startswith("<") and name.endswith(">"):   # unsubstituted placeholder
        return None
    return name[:64] if name else None


def _classify_role(obj, agent_id=None):
    """Infer the agent role from the system-prompt signature, with the wire's
    subagent signals (cc_is_subagent flag OR the x-claude-code-agent-id header,
    passed in by the caller) as the authoritative backstop. `agent_id` lets us
    file proxy/teammate-spawned agents (which never set cc_is_subagent) as
    subagents instead of silently absorbing their turns into the parent's main
    line (which also wrongly flips the session's TTL to the subagent 5m)."""
    s = _sys_text(obj)
    if "software architect and planning" in s:
        return "Plan"
    if "verification specialist" in s:
        return "verification"
    if "agent for Claude Code" in s or "Searching for code" in s:
        return "general-purpose"
    # Any remaining subagent (custom .claude/agents agent, a proxy/teammate-spawned
    # agent carrying only an agent-id, or a builtin whose signature drifted) is
    # flagged on the wire — keep it OFF the durable main line even though its prose
    # may say "Claude Code". Use the fingerprint-backed check (not the raw signals)
    # so a leaked parent turn (stale agent-id) is NOT mistaken for a subagent and
    # is correctly classified parent below.
    if _genuine_subagent(obj, agent_id=agent_id):
        return "subagent"
    if "Claude Code" in s:
        return "parent"
    return "unknown"


def _short_model(m):
    if not m:
        return "nomodel"
    return (m or "").replace("claude-", "").replace("[1m]", "").replace(".", "-")[:24]
