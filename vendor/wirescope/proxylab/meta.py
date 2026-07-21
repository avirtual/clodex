import collections
import json
import re
import time

from proxylab import pinger as pinger_mod
from proxylab import store as store_mod
from proxylab import writer as writer_mod

# --- session metadata (title / cwd / model) for /_status ----------------------
# The CLI already tells us everything a session list needs; we just stop
# discarding it: the per-session TITLE-GENERATOR side-call (0 tools, system
# "Generate a concise, sentence-case title…", same wire session_id) answers with
# the session title, and the `# Environment` section (system block interactive,
# msg0 bundle headless, tail block after RELOCATE_ENV_TO_TAIL) carries the cwd.
_CWD_RE = re.compile(r"Primary working directory:\s*(.+)")
_TITLE_SYS_PREFIX = "Generate a concise, sentence-case title"
_META_CWD_TRIES = collections.defaultdict(int)  # sid -> scans attempted
_META_CWD_DONE = set()                          # sids whose cwd is stored
_ENDED = {}     # sid -> {"ts","reason"}: SessionEnd markers (mirror of
                # session_meta.ended_at; a live turn = resume, clears both)
_META_CWD_MAX_TRIES = 5    # env block shows up in the first turns or never

# this module's table (see proxylab.store ownership rule): durable session
# identity for /_status — title (harvested from the CLI's title side-call),
# cwd, model — so the session list is useful right after a restart, when the
# in-memory _LAST_REQUEST is empty. Column notes:
#   kind     — tags sessions the PROXY ITSELF spawned (auth bootstrap), kept
#              out of the human's session list. NULL = a real user session.
#   ended_at/end_reason — the SessionEnd MARKER (2026-06-11): a durable FACT,
#              not a delete (a live turn = resume, clears it); cleanup belongs
#              to the staleness sweeper.
#   agent    — the /agent/<name>/ route identity (2026-06-12), any wire. SDK
#              sessions never make the title side-call, so the route name is
#              the only label they'll ever have.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS session_meta ("
    "session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, "
    "model TEXT, first_seen REAL NOT NULL, last_seen REAL NOT NULL)",
    "ALTER TABLE session_meta ADD COLUMN kind TEXT",
    "ALTER TABLE session_meta ADD COLUMN ended_at REAL",
    "ALTER TABLE session_meta ADD COLUMN end_reason TEXT",
    "ALTER TABLE session_meta ADD COLUMN agent TEXT")


def _upsert_session_meta(session_id, title=None, cwd=None, model=None, now=None,
                         kind=None, agent=None):
    """Durable identity row; COALESCE keeps existing values when a field isn't
    supplied, so the per-request last_seen bump never erases title/cwd/kind."""
    if not session_id:
        return
    now = now or time.time()
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO session_meta(session_id, title, cwd, model, "
                "first_seen, last_seen, kind, agent) VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(session_id) DO UPDATE SET "
                "title=COALESCE(excluded.title, session_meta.title), "
                "cwd=COALESCE(excluded.cwd, session_meta.cwd), "
                "model=COALESCE(excluded.model, session_meta.model), "
                "kind=COALESCE(excluded.kind, session_meta.kind), "
                "agent=COALESCE(excluded.agent, session_meta.agent), "
                "last_seen=excluded.last_seen",
                (session_id, title, cwd, model, now, now, kind, agent))
            con.commit()
    except Exception as e:
        print(f"[meta] session_meta upsert failed for {session_id[:12]}…: {e}",
              flush=True)


# Heaviness signals derived from the REQUEST BODY — the model-visible history
# every request re-ships (the wire IS the transcript). Statelessly recomputed
# per turn, so it is resume/fork/restart-proof and resets at /compact for free
# (the summary replaces history; the summary message itself counts as 1).
# Replaces the statusline's JSONL heuristics with the bytes actually billed.
# Latest snapshot per session, in-memory only (next request repopulates).
_CONTEXT_STATS = {}
# Latest main-line response text per session (capped at _META_TEXT_CAP), so
# /_session can show the answer to the final user message — it exists only in
# the response until the next turn re-ships it. In-memory only; /_end drops it.
_LAST_RESPONSE = {}
# Latest main-line token receipts per session (the billing `tokens` dict +
# est_usd + ts), straight from the response: what was cache-read vs (re)written
# vs shipped uncached on the last turn. /_session's header bar. In-memory only.
_LAST_USAGE = {}


def _input_token_total(usage):
    """The session's current CONTEXT SIZE in input-side tokens, from the last
    turn's billing receipt: cache_read + cache_write(5m+1h, or flat) + uncached
    input — i.e. everything that was shipped TO the model that turn. ONE
    definition so /_session's header and /_status's `context.input_tokens`
    can never disagree. None when there's no usage yet."""
    if not usage:
        return None
    rd = usage.get("cache_read_input_tokens") or 0
    wr = ((usage.get("cache_write_5m_tokens") or 0)
          + (usage.get("cache_write_1h_tokens") or 0)) \
        or usage.get("cache_write_flat_tokens") or 0
    inp = usage.get("input_tokens") or 0
    return rd + wr + inp


def _context_stats(session_id):
    """The /_status `context` object: the request-derived heaviness snapshot
    (turns/messages/max_tool_result) PLUS `input_tokens` — the wire-measured
    context size from the last turn's receipt (matches the /_session header).
    None only if neither source has fired yet."""
    base = _CONTEXT_STATS.get(session_id)
    tot = _input_token_total(_LAST_USAGE.get(session_id))
    if base is None and tot is None:
        return None
    out = dict(base) if base else {}
    if tot is not None:
        out["input_tokens"] = tot
    return out


def _is_prompt_msg(m):
    """The shared 'a turn starts here' predicate: a user message carrying real
    prompt text (tool_result-only continuations, <command-*> expansions and
    system-reminder bundles don't count). Used by _turn_stats and the
    /_session turn grouping — one definition, so they can never disagree."""
    if not isinstance(m, dict) or m.get("role") != "user":
        return False
    c = m.get("content")
    blocks = (c if isinstance(c, list)
              else [{"type": "text", "text": c}] if isinstance(c, str) else [])
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "text":
            t = (b.get("text") or "").lstrip()
            if t and not t.startswith("<command-") \
                    and not t.startswith("<local-command-") \
                    and not t.startswith("<system-reminder>"):
                return True
    return False


def _turn_stats(obj):
    """{turns_in_context, max_tool_result_chars, n_messages} for a messages
    request (turn definition: _is_prompt_msg)."""
    msgs = obj.get("messages") or []
    turns, big = 0, 0
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        if _is_prompt_msg(m):
            turns += 1
        c = m.get("content")
        for b in (c if isinstance(c, list) else []):
            if isinstance(b, dict) and b.get("type") == "tool_result":
                bc = b.get("content")
                ln = (len(bc) if isinstance(bc, str)
                      else sum(len(x.get("text") or "") for x in bc
                               if isinstance(x, dict)) if isinstance(bc, list)
                      else 0)
                big = max(big, ln)
    return {"turns_in_context": turns, "max_tool_result_chars": big,
            "n_messages": len(msgs)}


def _extract_cwd(obj):
    """Find 'Primary working directory: …' wherever this CLI build put it:
    system text, the msg0 context bundle, or the relocated tail block. Scans
    only first user msg + last 3 messages (env never lives mid-history)."""
    m = _CWD_RE.search(writer_mod._sys_text(obj))
    if m:
        return m.group(1).strip()
    msgs = obj.get("messages") or []
    scan = msgs[:1] + msgs[-3:]
    for mm in scan:
        if mm.get("role") != "user":
            continue
        c = mm.get("content")
        if not isinstance(c, list):
            continue
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                m = _CWD_RE.search(b.get("text") or "")
                if m:
                    return m.group(1).strip()
    return None


def _title_from_text(text):
    """The title call answers plain text on some builds, structured-outputs
    JSON ('{"title": …}', beta structured-outputs-2025-12-15) on others —
    unwrap the latter."""
    t = (text or "").strip()
    if t.startswith("{"):
        try:
            d = json.loads(t)
            if isinstance(d, dict) and d.get("title"):
                return str(d["title"]).strip()
        except Exception:
            pass
    return t


def _is_title_call(obj):
    """The CLI's per-session title-generator side-call: zero tools + the title
    system prompt. Its response text IS the session title."""
    if obj.get("tools"):
        return False
    sys = obj.get("system")
    texts = ([b.get("text", "") for b in sys if isinstance(b, dict)]
             if isinstance(sys, list) else [sys or ""])
    return any(t.startswith(_TITLE_SYS_PREFIX) for t in texts)


# A health/availability PROBE (seen in the wild: an editor firing a one-token
# "quota" call on startup): a bare user message with NO system prompt, NO tools,
# and a tiny max_tokens. It shares the session_id but is NOT an agent turn — like
# the title side-call it must not own identity, become the replayable last
# request, clobber the context snapshot, re-anchor the hold, or resurrect an
# ended session. A genuine agent turn always ships a system prompt + tools and a
# large max_tokens, so the conjunction is unambiguous (and unlike the title call
# there is no title to harvest from a 1-token answer — keep it OUT of that path).
_PROBE_MAX_TOKENS = 16

def _is_probe_call(obj):
    if obj.get("tools") or obj.get("system"):
        return False
    mt = obj.get("max_tokens")
    if not isinstance(mt, int) or mt > _PROBE_MAX_TOKENS:
        return False
    msgs = obj.get("messages")
    return isinstance(msgs, list) and len(msgs) <= 1


# In-memory per-session subagent activity (Task-spawned subs share the parent's
# session_id). Keyed sid -> {role -> {model, requests, last_seen}} so /_status //
# _admin can show the main agent AND every subagent under it WITHOUT either
# clobbering the other's identity. Display-grade, repopulated by live traffic.
_SUBAGENTS = {}
# Latest request body per (session, subagent-instance), so /_session can render
# what a subagent was doing — the ↳ rows on /_admin link here. Keyed by the same
# INSTANCE KEY as _SUBAGENTS (the x-claude-code-agent-id header when present, so
# concurrent subagents — even same-role ones — stay distinct; role otherwise);
# display-only, never replayed/pinged, in-memory, swept with _SUBAGENTS. Entry
# shape is the subset of pinger._LAST_REQUEST that _render_session_html reads.
_SUBAGENT_LAST_REQ = {}

# matches the pre-@ part of an ANONYMOUS spawn's agent-id: a bare UUID/hex blob
# (with or without dashes) — those carry no human-given name to surface
_AGENT_ID_BLOB = re.compile(r"^[0-9a-fA-F-]{8,}$")


def _agent_id_label(agent_id):
    """Human-given name from an agent-id header (`name@session-…`), or None
    when the name part is a UUID/hex blob (anonymous spawn) or absent."""
    if not agent_id or not isinstance(agent_id, str):
        return None
    part = agent_id.split("@", 1)[0].strip()
    if not part or _AGENT_ID_BLOB.match(part):
        return None
    return part


def _note_subagent(session_id, role, model, now=None, obj=None, agent_id=None,
                   display_name=None):
    """Record one subagent turn under its parent session (never touches the
    parent's own identity row). Keyed by INSTANCE — the x-claude-code-agent-id
    header when the wire carries one (present iff subagent, distinct per spawn,
    stable across that instance's turns), so three subagents spawned at once stay
    three separate rows/pages even when they share a role; falls back to the role
    name when no agent-id is present. Tracks latest model + a running request
    count, and (when obj is given) the latest request body for the per-instance
    session view. `role` is kept as the human label; `agent_id` for display."""
    if not session_id or not role:
        return
    now = now or time.time()
    key = agent_id or role
    # opt-in label from `[wirescope:agent-name <name>]`. Server resolves it from the
    # pre-strip body and passes it in (the directives are stripped before meta
    # sees obj); fall back to parsing obj directly for callers that don't (tests).
    name = display_name if display_name is not None else (
        writer_mod._subagent_marker_name(obj) if isinstance(obj, dict) else None)
    # Named spawns (Agent tool `name:`) carry the given name as the pre-@ part
    # of the agent-id header; surface it as display_name so consumers need no
    # client-side derivation (clodex request 2026-07-07). Anonymous/built-in
    # spawns use a UUID/hex blob there — skipped, so their role label stands.
    # The directive name (above) still wins when both are present.
    if name is None:
        name = _agent_id_label(agent_id)
    roles = _SUBAGENTS.setdefault(session_id, {})
    e = roles.get(key)
    if e is None:
        roles[key] = {"key": key, "role": role, "agent_id": agent_id,
                      "display_name": name, "model": model, "requests": 1,
                      "last_seen": now, "first_seen": now}
    else:
        e["model"] = model or e["model"]
        e["role"] = role or e.get("role")
        e["display_name"] = name or e.get("display_name")   # sticky once seen
        e["requests"] += 1
        e["last_seen"] = now
    if isinstance(obj, dict):
        _SUBAGENT_LAST_REQ.setdefault(session_id, {})[key] = {
            "obj": obj, "ts": now, "needs_auth": False}


def _subagent_request(session_id, key):
    """The latest captured request entry for one subagent instance, or None.
    `key` is the instance key (agent-id or role) used by /_session."""
    return (_SUBAGENT_LAST_REQ.get(session_id) or {}).get(key)


def _subagents_snapshot(session_id):
    """The session's subagents for /_status, newest-active first; None if none.
    Each entry carries key/role/agent_id so views can link per-instance yet
    label by role."""
    roles = _SUBAGENTS.get(session_id)
    if not roles:
        return None
    out = [dict(v) for v in roles.values()]
    out.sort(key=lambda s: s.get("last_seen") or 0, reverse=True)
    return out


def _subagent_request_objs(session_id):
    """Join each subagent INSTANCE's identity (_SUBAGENTS: role/model/agent_id/
    display_name/last_seen) with its latest forwarded request body
    (_SUBAGENT_LAST_REQ), so a reader like /_context can inspect what each
    subagent actually carries (tools, etc.) WITHOUT reaching into the two
    private maps itself. `obj` is the post-transform body (None if no request
    body was ever captured for that instance). Newest-active first; [] if none."""
    roles = _SUBAGENTS.get(session_id)
    if not roles:
        return []
    reqs = _SUBAGENT_LAST_REQ.get(session_id) or {}
    out = []
    for key, v in roles.items():
        e = reqs.get(key)
        out.append({"key": key, "role": v.get("role"),
                    "agent_id": v.get("agent_id"),
                    "display_name": v.get("display_name"),
                    "model": v.get("model"), "last_seen": v.get("last_seen"),
                    "obj": e.get("obj") if e else None})
    out.sort(key=lambda s: s.get("last_seen") or 0, reverse=True)
    return out


def _capture_session_meta(session_id, obj, model, agent=None, role=None,
                          side_call=False, agent_id=None, display_name=None):
    """Per-request meta hook (handler, post-parse). The MAIN LINE (the parent
    agent, role parent/unknown, not a title/probe side-call) owns the durable
    identity row: it bumps last_seen + model and hunts the cwd. A SUBAGENT turn
    (Plan/general-purpose/verification/custom — same session_id on the wire) or a
    side-call (title generator, health/quota probe) must NOT overwrite the
    parent's model/identity; we only bump last_seen (the session is alive) and,
    for a real subagent, log its activity so /_status can show it distinctly.
    `agent` = the /agent/<name>/ route; `agent_id` = the x-claude-code-agent-id
    header (per-instance subagent key)."""
    if not session_id:
        return
    # A real turn (main line OR subagent) on an ended session = resume; a bare
    # side-call (e.g. a startup quota probe) must NOT resurrect it — that was the
    # post-restart "odd page": the SessionEnd hook stamped ended, then the probe
    # both un-ended it and clobbered the durable view with its 1-message body.
    if not side_call:
        pinger_mod._clear_session_ended(session_id)
    if side_call or writer_mod._is_subagent_role(role):
        if writer_mod._is_subagent_role(role):
            _note_subagent(session_id, role, model, obj=obj, agent_id=agent_id,
                           display_name=display_name)
        # last_seen only (model/cwd left untouched -> COALESCE keeps the parent's)
        writer_mod._enqueue_meta(session_id, agent=agent)
        return
    # Durable main line: stamp its content fingerprint so _genuine_subagent can
    # tell a real subagent (own fingerprint) from a parent turn that leaked
    # cc_is_subagent=true with a stale agent-id (carries THIS fingerprint).
    writer_mod._note_main_fingerprint(session_id, obj)
    cwd = None
    if session_id not in _META_CWD_DONE and _META_CWD_TRIES[session_id] < _META_CWD_MAX_TRIES:
        _META_CWD_TRIES[session_id] += 1
        cwd = _extract_cwd(obj)
        if cwd:
            _META_CWD_DONE.add(session_id)
            _META_CWD_TRIES.pop(session_id, None)
    writer_mod._enqueue_meta(session_id, cwd=cwd, model=model, agent=agent)
