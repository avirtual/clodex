"""Tail hints — model-visible reminders delivered UNCACHED at the request tail.

WHAT THIS IS
A registry of short text strings that a consumer (clodex) or the proxy itself
attaches to a session, injected as a NEW trailing text block on the last user
message. Two properties define the channel:

  1. NEVER CACHED. The block lands strictly downstream of the deepest
     cache_control marker, so it is outside every cached prefix segment. That
     is what makes a hint EDITABLE: changing the text costs nothing but the
     tail tokens, where a cached-prefix edit would reshape a marked segment and
     re-pay the whole write (Bogdan's reason for choosing the tail — a control
     plane you can't edit without paying for the edit isn't really live).
  2. NEVER IN THE TRANSCRIPT. Request-side injection only; the CLI persists
     what IT sent, so a hint never accretes turn-over-turn the way the CLI's
     own `<system-reminder>` nags do (measured: 4+/session accumulating).

     THIS PROPERTY IS STRUCTURAL, SO DO NOT "VERIFY" IT BY GREPPING A TRANSCRIPT
     (Bogdan's point, 2026-07-29). We mutate the OUTBOUND body; the CLI writes its
     transcript from its OWN records, which never contained our addition. There is
     no path by which the text can arrive, so a transcript grep can only ever find
     copies the session authored itself (clodex measured 8 such hits on a clean
     session: it quoting the text, a compact summary carrying it forward,
     attachments, and `curl /_hints` output in a tool_result — this module's own
     read endpoint contaminates the search). The grep is therefore VACUOUS, and a
     vacuous check that reads as a passed absence test is worse than none. The
     invariant worth testing is the PLACEMENT one (below), which is real.

Cost is honest and priced: HINT tokens ride at 1x input on every request that
carries them (no cache discount, by design). Measured against the managed
corpus (mean request $0.0935, 85k of cache-read carriage), a ~35-token hint is
$0.000175/request -> break-even at one prevented wasted request per ~534.

TWO CLASSES, SPLIT BY WHO OWNS THE GROUND TRUTH (clodex's rule; the split is
about single-sourcing, not convenience — two writers for one fact means no way
to tell which is stale, and a pushed guess about proxy state dressed in an
authoritative wrapper is strictly worse than no hint):

  * AGENT-SCOPED (`?agent=<route>`) — constant behavioral prohibitions. Keyed
    by ROUTE NAME so it survives /clear id-rotation and can be set pre-launch.
    PERSISTED. No freshness story, so TTL is optional.
  * SESSION-SCOPED (`?session=<id>`) — transient FACTS. IN-MEMORY ONLY, never
    persisted: a fact that survives a proxy restart is lying about live state.
    TTL is REQUIRED — a fact with no expiry is one somebody must remember to
    retract, and the failure mode is silent (it keeps shipping and reads as
    current).
  * PROXY-NATIVE (`?hints=<name>` on a session) — facts the PROXY measures
    (upstream health, context pressure). The proxy populates the body and owns
    freshness; a consumer only enables them BY NAME and never writes the text.

EFFICACY IS UNPROVEN AND THE MEASUREMENT CANNOT SETTLE IT. Priors: the CLI's
own task-tools nag measured 0% uptake; a cached-prefix Bash prohibition measured
~27% with a CI spanning zero (n=18.8k). Detecting the break-even 25% effect at
the observed 0.325% base rate needs ~67k Bash calls per arm = ~291 days at the
current rate. So this ships on ECONOMICS (bounded tiny downside, positive EV
under any plausible effect size), not on evidence, and every measurement report
must carry its CI + the smallest detectable effect so an underpowered look is
never recorded as a null. See CHANGELOG for the pre-registered arm design.
"""
import fnmatch
import json
import os
import re
import time

from . import core as core_mod
from . import store as store_mod
from . import writer as writer_mod

# Master kill switch (deployment-level). Default ON: the registry is EMPTY at
# rest, so an enabled-but-unregistered proxy injects nothing and costs nothing —
# the option value of the channel is separate from any hint's efficacy.
HINTS = os.environ.get("HINTS", "1") not in ("0", "no", "off", "false")

# Total budget across all hints on one request. The cap DECLINES an oversized
# set rather than truncating it: a silently truncated hint reads as present and
# isn't, which is the same false-green class as an underpowered null.
HINTS_MAX_CHARS = int(os.environ.get("HINTS_MAX_CHARS", "3500"))
# Per-hint ceiling, so one pathological string can't eat the whole budget.
# INVARIANT: keep this meaningfully BELOW HINTS_MAX_CHARS. The two caps are
# checked in different places, so a per-hint value at or above the total makes a
# hint pass one gate and die at the next — a limit that says yes and means no.
# The headroom is deliberate: the total must fit the largest single hint PLUS a
# standing prohibition riding alongside it. test_hints asserts the RELATIONSHIP,
# never the two numbers separately.
HINTS_MAX_ONE = int(os.environ.get("HINTS_MAX_ONE", "2500"))
# Hard ceiling on registered hints per scope (registry hygiene, not wire cost).
HINTS_MAX_PER_SCOPE = int(os.environ.get("HINTS_MAX_PER_SCOPE", "16"))
# When a cache marker sits on the trailing role:"system" roster message, the last
# USER message is no longer the deepest position, so a user-tail append would land
# inside a cached segment. This falls back to appending after that marker instead
# (still strictly deepest, invariant intact).
# DEFAULT ON, wire-proven 2026-07-21 on :7815: 3/3 live turns carrying a hint on a
# marked trailing role:"system" message returned 200 / end_turn, with cache reads
# working on the repeat turns (2,701 read / 682 write — the append did NOT bust the
# prefix) and the marked block left unmutated. Without it the affected sessions
# never receive a hint AT ALL and do so silently, which is the worse failure: only
# 6/400 captures need it, but the shape is SESSION-CONCENTRATED (recurs at msg 77
# and 134 in one agent's sessions). Set =0 to force the strict user-tail-only
# placement (declines are then visible in the record as `marker_downstream` with
# `fallback_available`).
SYSTEM_TAIL_FALLBACK = os.environ.get("HINTS_SYSTEM_TAIL_FALLBACK", "1") not in (
    "0", "no", "off", "false")

# id: lowercase token, so it's safe in a URL and readable in a capture diff.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# chars that make a registered agent scope a GLOB rather than an exact name
_GLOB_CHARS = frozenset("*?[")

# ---- registries -------------------------------------------------------------
# agent route -> {id: hint}, PERSISTED (constant prohibitions).
_AGENT_HINTS = {}
# session id -> {id: hint}, IN-MEMORY ONLY (transient facts; see module docstring).
_SESSION_HINTS = {}
# session id -> set of proxy-native hint NAMES the consumer enabled.
_NATIVE_ON = {}

# A hint: {"id","text","set_at","ttl_s","source"}.
#   source: "agent" | "session" | "native:<name>"
# ttl_s None = no expiry (agent scope only; session scope requires a number).

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS agent_hints ("
    "owner TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, "
    "text TEXT NOT NULL, set_at REAL NOT NULL, ttl_s REAL, "
    "PRIMARY KEY (owner, agent, id))",
    # additive migration: the turn-start gate (see _at_turn_start)
    "ALTER TABLE agent_hints ADD COLUMN turn_start_only INTEGER")


def _persist_agent(agent, hint):
    # ONE-SHOT PAYLOADS ARE NEVER PERSISTED, even in agent scope (which otherwise
    # survives restart). Same reasoning as session facts: an armed catalogue that
    # outlives the proxy describes a decision that has probably already been made,
    # and its `expect_session` very likely names a conversation that is gone. The
    # required ttl bounds the staleness; not persisting removes it. A consumer
    # re-posts — which it must be able to do anyway, since a pop can be declined.
    if hint.get("once"):
        return
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO agent_hints(owner, agent, id, text, set_at, ttl_s, "
                "turn_start_only) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, agent, id) DO UPDATE SET "
                "text=excluded.text, set_at=excluded.set_at, ttl_s=excluded.ttl_s, "
                "turn_start_only=excluded.turn_start_only",
                (store_mod.OWNER, agent, hint["id"], hint["text"],
                 hint["set_at"], hint.get("ttl_s"),
                 1 if hint.get("turn_start_only") else 0))
            con.commit()
    except Exception as e:
        print(f"[hints] persist failed for {agent}/{hint['id']}: {e}", flush=True)


def _unpersist_agent(agent, hint_id=None):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            if hint_id:
                con.execute("DELETE FROM agent_hints WHERE owner=? AND agent=? "
                            "AND id=?", (store_mod.OWNER, agent, hint_id))
            else:
                con.execute("DELETE FROM agent_hints WHERE owner=? AND agent=?",
                            (store_mod.OWNER, agent))
            con.commit()
    except Exception as e:
        print(f"[hints] row delete failed for {agent}: {e}", flush=True)


def load_agent_hints():
    """Reload persisted agent-scoped hints at boot (restore.py calls this).
    Session-scoped facts are deliberately NOT restored — see module docstring."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT agent, id, text, set_at, ttl_s, turn_start_only "
                "FROM agent_hints WHERE owner=?", (store_mod.OWNER,)).fetchall()
    except Exception as e:
        print(f"[hints] load failed: {e}", flush=True)
        return 0
    for agent, hid, text, set_at, ttl_s, tso in rows:
        _AGENT_HINTS.setdefault(agent, {})[hid] = {
            "id": hid, "text": text, "set_at": set_at, "ttl_s": ttl_s,
            "turn_start_only": bool(tso), "source": "agent"}
    if rows:
        print(f"[hints] restored {len(rows)} agent hint(s) across "
              f"{len(_AGENT_HINTS)} route(s)", flush=True)
    return len(rows)


# ---- validation + mutation --------------------------------------------------
def _validate(payload, *, require_ttl):
    """(error, hints) — hints is a list of normalized dicts. `require_ttl` is
    True for session scope (transient facts must expire on their own)."""
    items = payload.get("hints")
    if not isinstance(items, list) or not items:
        return "hints must be a non-empty list", None
    if len(items) > HINTS_MAX_PER_SCOPE:
        return f"too many hints (max {HINTS_MAX_PER_SCOPE})", None
    out = []
    total = 0
    for it in items:
        if not isinstance(it, dict):
            return "each hint must be an object", None
        hid = it.get("id")
        if not isinstance(hid, str) or not _ID_RE.match(hid):
            return (f"bad id {hid!r} (lowercase, digits, dashes; <=64ch)"), None
        text = it.get("text")
        if not isinstance(text, str) or not text.strip():
            return f"hint {hid!r}: text must be a non-empty string", None
        if len(text) > HINTS_MAX_ONE:
            # DECLINE, never truncate.
            return (f"hint {hid!r}: text is {len(text)}ch, over the "
                    f"{HINTS_MAX_ONE}ch per-hint cap (declined, not truncated)"), None
        ttl = it.get("ttl_s")
        if ttl is not None:
            try:
                ttl = float(ttl)
            except (TypeError, ValueError):
                return f"hint {hid!r}: ttl_s must be a number", None
            if ttl <= 0:
                return f"hint {hid!r}: ttl_s must be > 0", None
        elif require_ttl:
            return (f"hint {hid!r}: ttl_s is REQUIRED for session-scoped facts "
                    "(a fact with no expiry keeps shipping and reads as current)"), None
        tso = it.get("turn_start_only", False)
        if not isinstance(tso, bool):
            return f"hint {hid!r}: turn_start_only must be true or false", None
        once = it.get("once", False)
        if not isinstance(once, bool):
            return f"hint {hid!r}: once must be true or false", None
        mlo = it.get("main_line_only", False)
        if not isinstance(mlo, bool):
            return f"hint {hid!r}: main_line_only must be true or false", None
        xs = it.get("expect_session")
        if xs is not None and (not isinstance(xs, str) or not xs.strip()):
            return f"hint {hid!r}: expect_session must be a non-empty string", None
        if once and ttl is None:
            # REQUIRED in BOTH scopes (agent scope otherwise allows ttl_s:null).
            # A one-shot with no expiry waits forever for an eligible request and
            # then describes a decision that already happened — a stale catalogue
            # is worse than none.
            return (f"hint {hid!r}: ttl_s is REQUIRED for once:true "
                    "(an armed payload with no expiry goes stale, not away)"), None
        total += len(text)
        entry = {"id": hid, "text": text.strip(), "ttl_s": ttl,
                 "set_at": time.time(), "turn_start_only": tso,
                 "source": "session" if require_ttl else "agent"}
        # Pop fields exist ONLY on one-shot entries. Keeping them off ordinary
        # hints preserves the exact-key-set invariant that proves the injector
        # writes no per-request state onto a registry entry — an assertion worth
        # more than the tidiness of a uniform schema.
        if once or mlo or xs:
            entry.update({"once": once, "main_line_only": mlo,
                          "expect_session": xs.strip() if xs else None})
        if once:
            entry["armed_at"] = time.time()
        out.append(entry)
    if total > HINTS_MAX_CHARS:
        # NAME THE CULPRIT. The total is shared across scopes, so one oversized
        # hint can decline an unrelated standing prohibition; a bare "over cap"
        # attributes that to the injection rather than to the hint that ate the
        # budget — the loud failure masking the silent one.
        biggest = max(out, key=lambda h: len(h["text"]))
        dropped = [h["id"] for h in out if h["id"] != biggest["id"]]
        return {"reason": (f"hint set is {total}ch, over the {HINTS_MAX_CHARS}ch "
                           "total cap (declined, not truncated)"),
                "offender": biggest["id"], "offender_chars": len(biggest["text"]),
                "dropped": dropped}, None
    ids = [h["id"] for h in out]
    if len(set(ids)) != len(ids):
        return "duplicate hint ids in one request", None
    return None, out


def set_hints(payload, *, agent=None, session=None, mode="merge"):
    """Register hints on a scope. (code, body). `mode` merge (default, upsert by
    id) or replace (the posted set becomes the whole scope)."""
    if agent is None and session is None:
        return 400, {"ok": False, "reason": "need ?agent= or ?session="}
    err, hints = _validate(payload, require_ttl=session is not None)
    if err:
        # an over-total decline carries attribution (offender/dropped); the rest
        # are plain strings.
        return 400, ({"ok": False, **err} if isinstance(err, dict)
                     else {"ok": False, "reason": err})
    reg = _AGENT_HINTS if agent is not None else _SESSION_HINTS
    key = agent if agent is not None else session
    cur = {} if mode == "replace" else dict(reg.get(key) or {})
    if mode == "replace" and agent is not None:
        _unpersist_agent(agent)
    for h in hints:
        cur[h["id"]] = h
    if len(cur) > HINTS_MAX_PER_SCOPE:
        return 400, {"ok": False, "reason": f"scope would hold {len(cur)} hints "
                     f"(max {HINTS_MAX_PER_SCOPE}); clear some first"}
    reg[key] = cur
    if agent is not None:
        for h in hints:
            _persist_agent(agent, h)
    scope = f"agent={agent}" if agent is not None else f"session={(session or '')[:12]}…"
    print(f"[hints] {scope} {mode}: +{len(hints)} -> {len(cur)} registered "
          f"({sum(len(h['text']) for h in cur.values())}ch)", flush=True)
    return 200, {"ok": True, **read_scope(agent=agent, session=session)}


def clear_hints(*, agent=None, session=None, hint_id=None):
    """Drop one hint (hint_id) or the whole scope. Idempotent — clearing an
    absent hint is a success, so a consumer can clear unconditionally without a
    read-modify-write (clodex's ask: clearing as cheap as setting)."""
    reg = _AGENT_HINTS if agent is not None else _SESSION_HINTS
    key = agent if agent is not None else session
    removed = 0
    if hint_id:
        if (reg.get(key) or {}).pop(hint_id, None) is not None:
            removed = 1
        if agent is not None:
            _unpersist_agent(agent, hint_id)
    else:
        removed = len(reg.pop(key, {}) or {})
        if agent is not None:
            _unpersist_agent(agent)
        if session is not None:
            _NATIVE_ON.pop(session, None)
    if not (reg.get(key) or {}):
        reg.pop(key, None)
    return 200, {"ok": True, "removed": removed,
                 **read_scope(agent=agent, session=session)}


def set_native(session, names):
    """Enable proxy-native hints BY NAME for a session. The proxy owns the text
    and its freshness; a consumer never writes these bodies."""
    from . import hints_native as native_mod
    unknown = [n for n in names if n not in native_mod.PROVIDERS]
    if unknown:
        return 400, {"ok": False, "reason": f"unknown native hint(s): {unknown}",
                     "available": sorted(native_mod.PROVIDERS)}
    if names:
        _NATIVE_ON[session] = set(names)
    else:
        _NATIVE_ON.pop(session, None)
    print(f"[hints] session={session[:12]}… native={sorted(names)}", flush=True)
    return 200, {"ok": True, **read_scope(session=session)}


# session -> the last injection log, so receipts can attach hint attribution to
# the turn.completed receipt. ATTRIBUTION IS A CORRECTNESS PROPERTY, not a
# nicety (clodex's framing): if a hint changes behavior and nothing records that
# it fired, the behavior change is unattributable — the consumer's output shifts
# and neither side can point at why. Bounded; last-write-wins per session.
_LAST_INJECTION = {}
_LAST_INJECTION_MAX = 512


def last_injection(session_id):
    """What rode the most recent request for this session, or None."""
    return _LAST_INJECTION.get(session_id)


# session -> Counter-ish {mode_or_decline: n}. WHY THIS EXISTS: a session that
# gets `user_tail` on every request and one where the system_tail FALLBACK was
# exercised both look like "healthy, hints delivered" from a single request
# record — so a clean run would read as proof the fallback works when the shape
# never even occurred. Per-session mode tallies make "never exercised" distinct
# from "exercised and worked" (clodex's ask; the same absent-effect-reads-as-
# verified-negative trap as an underpowered null).
_MODE_TALLY = {}


# ---- one-shot pop: RESERVE at injection, COMMIT on a 200 --------------------
# request-id -> [(scope_kind, scope_key, hint_id, session_id), ...]
# WHY TWO PHASES: 5.9% of forwarded requests never reach a 200 (3.60% no response
# at all, 1.19% 404, 0.86% 429, 0.21% 529), and failures CLUSTER — 1,160 failure
# runs, median 1 but p90 6 and max 38 CONSECUTIVE. Popping at injection would
# silently discard a payload through an entire shed storm, and the consumer could
# not tell that from delivered-and-ignored. So injection only RESERVES; the pop
# commits at receipts.anthropic on a 200 and ROLLS BACK otherwise, leaving the
# entry armed to ride the retry with no re-POST.
_RESERVED = {}
_RESERVED_MAX = 512


def _reserve_pops(req_id, hints, session_id):
    """Note which one-shot entries rode this request (called at injection)."""
    if not req_id:
        return
    items = [h for h in hints if h.get("once")]
    if not items:
        return
    if len(_RESERVED) > _RESERVED_MAX:
        _RESERVED.clear()            # bound; an orphaned reservation just re-arms
    _RESERVED[req_id] = [(h.get("source"), h.get("_scope"), h["id"], session_id)
                         for h in items]


def commit_pops(req_id, status_code, session_id=None):
    """COMMIT (200) or ROLL BACK (anything else) the pops reserved for a request.
    Called from receipts.anthropic — the single turn-finalize convergence both
    wires already call, which has status_code/session_id/role/agent_header_id in
    scope. Returns a small log dict for the receipt, or None."""
    items = _RESERVED.pop(req_id, None)
    if not items:
        return None
    if status_code != 200:
        # ROLLBACK is a no-op by construction: the entry was never removed. Said
        # out loud anyway so "rolled back" is a visible third state next to
        # never-delivered and delivered-unused.
        return {"popped": [], "rolled_back": [i[2] for i in items],
                "status_code": status_code}
    popped = []
    for kind, scope, hid, sid in items:
        reg = _AGENT_HINTS if kind == "agent" else _SESSION_HINTS
        key = scope if kind == "agent" else sid
        entry = (reg.get(key) or {}).get(hid)
        if entry is None:
            continue
        entry["delivered_session"] = session_id or sid
        entry["delivered_at"] = time.time()
        reg[key].pop(hid, None)
        if kind == "agent":
            _unpersist_agent(key, hid)
        if not reg.get(key):
            reg.pop(key, None)
        popped.append(hid)
        print(f"[hints] POP {hid} delivered to session="
              f"{str(session_id or sid)[:12]}… (200)", flush=True)
    return {"popped": popped, "rolled_back": [], "status_code": status_code,
            "delivered_session": session_id}


def _note_injection(session_id, log):
    if not session_id:
        return
    if len(_LAST_INJECTION) > _LAST_INJECTION_MAX:
        _LAST_INJECTION.clear()          # crude bound; attribution is per-turn
        _MODE_TALLY.clear()
    _LAST_INJECTION[session_id] = log
    key = log.get("mode") or f"declined:{log.get('declined')}"
    _MODE_TALLY.setdefault(session_id, {})
    _MODE_TALLY[session_id][key] = _MODE_TALLY[session_id].get(key, 0) + 1


def placement_report(session_id):
    """Per-session placement tallies: which mode each hint-carrying request used,
    so `fallback never exercised` is DISTINGUISHABLE from `fallback worked`.
    `fallback_exercised` is the honest headline — False means this session tells
    you nothing about the system_tail path, however clean the run looks."""
    tally = _MODE_TALLY.get(session_id)
    if not tally:
        # No request of this session has reached the injector at all. Distinct
        # from "reached it and matched nothing" — see `unmatched` below.
        return {"requests_seen": 0, "note": "no request of this session has "
                "reached the hint injector yet"}
    modes = {k: v for k, v in tally.items() if not k.startswith("_")}
    unmatched = modes.pop("unmatched", 0)
    applied = sum(v for k, v in modes.items() if not k.startswith("declined:"))
    out = {"by_mode": modes, "requests_with_hints": applied,
           "fallback_exercised": modes.get("system_tail", 0) > 0,
           "declines": {k: v for k, v in modes.items() if k.startswith("declined:")}}
    if unmatched:
        # LOUD by design: this is always a misconfiguration.
        out["unmatched_requests"] = unmatched
        out["seen_agent"] = tally.get("_seen_agent")
        out["misconfigured"] = True
        out["note"] = (
            f"{unmatched} request(s) arrived with a NON-EMPTY hint registry but "
            f"resolved to zero hints — the wire agent name is "
            f"{tally.get('_seen_agent')!r}, which matches no registered scope. "
            f"Register that exact name, or a glob covering it "
            f"(POST /_hints?agent=<pattern>, e.g. 'clodex-*').")
    return out


def forget(session_id):
    """Drop a session's transient facts + attribution (sweeper / _end)."""
    _SESSION_HINTS.pop(session_id, None)
    _NATIVE_ON.pop(session_id, None)
    _LAST_INJECTION.pop(session_id, None)
    _MODE_TALLY.pop(session_id, None)


def _live(h, now=None):
    """False iff the hint has aged past its ttl."""
    now = now or time.time()
    ttl = h.get("ttl_s")
    return ttl is None or (now - h["set_at"]) < ttl


def _expire(reg, key, now):
    """Drop expired hints from a scope in place; returns the dropped ids."""
    cur = reg.get(key)
    if not cur:
        return []
    dead = [hid for hid, h in cur.items() if not _live(h, now)]
    for hid in dead:
        cur.pop(hid, None)
    if not cur:
        reg.pop(key, None)
    return dead


def read_scope(*, agent=None, session=None):
    """Registry view for one scope, with per-hint AGE so a stale fact is visible
    rather than discovered by a model acting on old state."""
    now = time.time()
    out = {}
    if agent is not None:
        _expire(_AGENT_HINTS, agent, now)
        out["agent"] = agent
        out["agent_hints"] = [{**{k: v for k, v in h.items()},
                               "age_s": round(now - h["set_at"], 1)}
                              for h in (_AGENT_HINTS.get(agent) or {}).values()]
    if session is not None:
        _expire(_SESSION_HINTS, session, now)
        out["session"] = session
        out["session_hints"] = [{**{k: v for k, v in h.items()},
                                 "age_s": round(now - h["set_at"], 1)}
                                for h in (_SESSION_HINTS.get(session) or {}).values()]
        out["native_enabled"] = sorted(_NATIVE_ON.get(session) or ())
    # ARMED READBACK: a one-shot still in the registry has not been delivered.
    # POSTED-BUT-NEVER-SERVED must be distinguishable from NEVER-POSTED — the
    # consumer's only other evidence is the model's behavior, which reads the
    # same either way. `armed` is derived, never stored, so it cannot go stale.
    for k in ("agent_hints", "session_hints"):
        for h in out.get(k) or []:
            if h.get("once"):
                h["armed"] = True
                h["armed_age_s"] = (round(now - h["armed_at"], 1)
                                    if h.get("armed_at") else None)
    out["caps"] = {"total_chars": HINTS_MAX_CHARS, "per_hint_chars": HINTS_MAX_ONE,
                   "per_scope": HINTS_MAX_PER_SCOPE}
    out["enabled"] = HINTS
    return out


def _matching_agent_scopes(agent):
    """Registered agent scopes that apply to `agent`, exact match first then GLOB
    patterns (fnmatchcase, same vocabulary as the subscriber feed's `agents`).

    GLOBS ARE NECESSARY, NOT A CONVENIENCE. A consumer's real route name is not
    always the name it registers: clodex's managed hop rewrites the route to a
    derived `<team>-<seat>-<hash>` name (`clodex-clodex-889de1bd`), which carries a
    per-seat hash nobody can know before the first request. Exact-name-only keying
    made the whole agent scope silently unusable for the one consumer it was built
    for — hints registered under `clodex` resolved to [] forever, with no error.
    So `POST /_hints?agent=clodex-*` is the supported way to cover a seat family."""
    out = []
    if agent is None:
        return out
    if agent in _AGENT_HINTS:
        out.append(agent)
    for pat in _AGENT_HINTS:
        if pat != agent and _GLOB_CHARS.intersection(pat) and fnmatch.fnmatchcase(agent, pat):
            out.append(pat)
    return out


def _at_turn_start(msgs):
    """True iff this request is the FIRST of its turn — the user's message is the
    newest thing in the window and the model has not yet acted on it.

    WHY THIS GATE EXISTS (clodex's use case, and the billing shape behind it):
    hint tokens ride UNCACHED at 1x on EVERY request that carries them, and a
    turn is not one request — a tool loop is N. A hint that answers "what did the
    user just type" (a retrieved memory, a task fact) is relevant on request 1 and
    is pure carriage by round 14, re-billed each round with no cache discount. A
    constant behavioral prohibition is the opposite: it must be present at the
    moment the model reaches for the forbidden action, which is exactly those
    later rounds. So the gate is PER HINT, not a global mode, and defaults OFF
    (every existing hint keeps riding every request).

    Detection reuses the SHARED settled boundary — never inline it (transforms.py
    is explicit about this: the strips and the pin must agree on where the current
    turn starts). At turn start nothing after that boundary is an assistant
    message; once the model emits its first tool_use, one is, and stays for the
    rest of the turn. Scanning for `assistant` rather than comparing against
    len(msgs)-1 is what makes this correct on the opus-4-8 wire shape, where a
    trailing role:"system" roster message sits AFTER the user's turn."""
    try:
        from . import transforms as transforms_mod
        boundary = transforms_mod._settled_boundary(msgs)
    except Exception:
        return None                    # can't judge -> caller declines to gate
    if boundary < 0:
        return None                    # no real user turn in the window at all
    return not any(isinstance(m, dict) and m.get("role") == "assistant"
                   for m in msgs[boundary + 1:])


def _is_raw_subagent(obj, agent_id=None):
    """The POP predicate: does this request carry a RAW subagent signal?

    Deliberately NOT `writer._classify_role(...) == "parent"` and NOT
    `_genuine_subagent`. Those apply a fingerprint backstop that files a
    raw-signalled request as parent when its content fingerprint matches the
    session's main line — correct for BILLING (keeps a leaked/forked turn out of a
    subagent bucket) and wrong HERE, where the same request must be refused.
    Measured: 979 requests (2.75% of parent-classified traffic) carry a live raw
    signal and are still classified parent; lineage-hash testing puts 676 of them
    as GENUINE subagents misfiled, only 303 as the fork/leak pattern.

    ONE FIELD, TWO CONSUMERS, OPPOSITE CORRECTNESS CRITERIA — so read the signals,
    never the verdict. Fails CLOSED: on either signal, or on any error, the answer
    is "treat as subagent" and the payload stays armed. An unserved payload is
    recoverable (the consumer re-posts / the next request takes it); a mis-served
    one is consumed by something that cannot act on it and is indistinguishable at
    the consumer from "the model ignored it", which corrupts the only instrument
    available for tuning retrieval."""
    if agent_id:
        return True
    try:
        from . import writer as writer_mod
        return bool(writer_mod._billing_is_subagent(obj or {}))
    except Exception:
        return True                    # can't judge -> fail closed


def _pop_eligible(h, obj, session, agent_id):
    """(ok, reason) — may this request CONSUME this one-shot payload?"""
    if h.get("main_line_only") and _is_raw_subagent(obj, agent_id):
        return False, "subagent"
    want = h.get("expect_session")
    if want and want != session:
        # The guard that matters. A route name does NOT identify a conversation:
        # 516 route-level session switches on main-line traffic, 53 of them TRUE
        # interleaves where a conversation resumed on a route after another ran.
        # The strays are not subagents (strict predicate removes 0 of the 53) but
        # separate top-level CLI processes — one-shot `hi` probes sharing a live
        # route, which pass main_line_only honestly. Without this assertion the
        # catalogue lands in a two-message throwaway and the receipt reads
        # DELIVERED. Available at all only because the wire session_id IS the
        # CLI's sessionId (758/788 = 96.2% match transcript filenames).
        return False, "session_mismatch"
    return True, None


def effective(session, agent, obj=None, gate_info=None):
    """The resolved hint list for a request, most-specific-last (session facts
    read after agent prohibitions). Union by id: a narrower scope re-declaring an
    id SUPPRESSES the inherited one. Expiry is evaluated HERE, per request — so a
    fact that lapses BETWEEN HOPS of one turn vanishes on the next hop rather than
    persisting to the end of the turn (clodex's ask; mid-turn is exactly when a
    fact like `upstream is shedding` changes)."""
    now = time.time()
    merged = {}
    # hid -> the scope the winning entry came from, so a committed pop can find
    # its registry row again. Tracked SEPARATELY because the merged values ARE
    # the registry entries and must never be annotated (a per-request note
    # written there would persist into every later request).
    origin = {}
    if agent:
        # exact scope first, then glob scopes (later wins on id collision, so a
        # more specific exact registration is applied last = takes precedence)
        for scope in reversed(_matching_agent_scopes(agent)):
            _expire(_AGENT_HINTS, scope, now)
            for hid, h in (_AGENT_HINTS.get(scope) or {}).items():
                merged[hid] = h
                origin[hid] = ("agent", scope)
    if session:
        _expire(_SESSION_HINTS, session, now)
        for hid, h in (_SESSION_HINTS.get(session) or {}).items():
            merged[hid] = h
            origin[hid] = ("session", session)
        names = _NATIVE_ON.get(session)
        if names:
            from . import hints_native as native_mod
            for name in sorted(names):
                nh = native_mod.render(name, session=session, obj=obj)
                if nh:                       # a provider with nothing to say
                    merged[nh["id"]] = nh    # declines rather than shipping noise
    hints = [merged[k] for k in sorted(merged)]
    # ONE-SHOT ELIGIBILITY. Filter before the turn-start gate so a declined pop is
    # never mistaken for a gated one. Non-once hints are untouched.
    if any(h.get("once") for h in hints):
        agent_id = (gate_info or {}).get("agent_id")
        keep, declined, armed = [], {}, []
        for h in hints:
            if not h.get("once"):
                keep.append(h)
                continue
            ok, why = _pop_eligible(h, obj, session, agent_id)
            if ok:
                kind, scope = origin.get(h["id"], (h.get("source"), None))
                # a SHALLOW COPY carries the scope to the reserver without
                # touching the registry entry itself.
                keep.append({**h, "_scope": scope, "source": kind})
                armed.append(h["id"])
            else:
                declined[h["id"]] = why
        hints = keep
        if gate_info is not None:
            if declined:
                gate_info["pop_declined"] = declined
            if armed:
                gate_info["pop_reserved"] = armed
    gated = [h["id"] for h in hints if h.get("turn_start_only")]
    if gated and obj is not None:
        # FAIL OPEN on can't-judge (None): the gate is a COST optimization, not a
        # safety property, so an unjudgeable shape should still deliver. Silently
        # never firing is the worse failure (same reasoning as SYSTEM_TAIL_FALLBACK)
        # and costs the one thing the gate was saving. Never annotate the hint
        # dicts themselves — they ARE the registry entries, so a per-request note
        # written there would persist into every later request.
        at_start = _at_turn_start((obj or {}).get("messages") or [])
        if gate_info is not None:
            gate_info.update({"at_turn_start": at_start, "gated_ids": gated})
        if at_start is False:
            hints = [h for h in hints if not h.get("turn_start_only")]
            if gate_info is not None:
                gate_info["withheld"] = gated
    return hints


# ---- the wire transform ----------------------------------------------------
def _deepest_marker_index(msgs):
    """(msg_idx, block_idx) of the deepest cache_control marker in messages[],
    or None. The hint MUST land strictly after this to stay uncached."""
    deepest = None
    for i, m in enumerate(msgs):
        c = m.get("content") if isinstance(m, dict) else None
        if not isinstance(c, list):
            continue
        for j, b in enumerate(c):
            if isinstance(b, dict) and b.get("cache_control"):
                deepest = (i, j)
    return deepest


def _last_user_idx(msgs):
    """Index of the last role==user message. Scans BACKWARD past the trailing
    role:"system" roster message the opus-4-8 wire shape appends after the user
    turn, so messages[-1] is often NOT the user's."""
    for i in range(len(msgs) - 1, -1, -1):
        if isinstance(msgs[i], dict) and msgs[i].get("role") == "user":
            return i
    return None


def _wrap(hints):
    """The `<system-reminder>` envelope. Text is LITERAL — no interpolation, no
    templating: this lands inside a wrapper the model treats as authoritative, so
    there must be no path for anything upstream to compose text into it."""
    body = "\n\n".join(h["text"] for h in hints)
    return f"<system-reminder>\n{body}\n</system-reminder>"


def _note_unmatched(session_id, agent):
    """Record a request that resolved to ZERO hints while the registry was
    NON-EMPTY. This is ALWAYS a misconfiguration (a scope registered under a name
    nothing resolves to) and it must be LOUD: `placement:null` previously could not
    be told apart from "no requests seen yet", so a resolution mismatch presented
    as silence — hints simply never fired and nothing said so. Found live when
    clodex's managed hop rewrote its route to `clodex-clodex-889de1bd` while the
    hints were registered under `clodex`. Same class as `fallback_exercised:false`,
    one layer up: the layer deciding whether ANY hint fires."""
    if not session_id:
        return
    _MODE_TALLY.setdefault(session_id, {})
    t = _MODE_TALLY[session_id]
    t["unmatched"] = t.get("unmatched", 0) + 1
    t["_seen_agent"] = agent          # the name that actually arrived on the wire


def inject(obj, agent=None, session_id=None, agent_id=None, req_id=None):
    """Append the effective hint set as a NEW trailing text block on the last
    user message. Returns a log dict (for the request record) or None.

    SAFETY INVARIANT: declines unless the insert position is strictly deeper than
    every cache_control marker. Never edits an existing block — appending is what
    keeps this out of a cached segment; concatenating into the marker-bearing tail
    block would mutate marked content and cause a recurring per-turn bust (the
    flaw in transforms._inject_into_last_user for this purpose)."""
    if not HINTS:
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    if session_id is None:
        session_id = (writer_mod._session_ids(obj) or [None])[0]
    gate = {"agent_id": agent_id}
    hints = effective(session_id, agent, obj=obj, gate_info=gate)
    if not hints:
        if gate.get("pop_declined"):
            # a refused pop is the GUARD WORKING — never let it read as an
            # unmatched-scope misconfiguration (or as silence).
            return {"declined": "pop_ineligible", "pop_declined": gate["pop_declined"]}
        # A turn-start-gated hint withheld mid-loop is the gate WORKING, not a
        # misconfiguration — don't let it masquerade as an unmatched-scope error.
        if gate.get("withheld"):
            return {"declined": "turn_start_gate", "withheld": gate["withheld"]}
        # Registry non-empty but nothing resolved -> misconfiguration, not rest.
        if _AGENT_HINTS or _SESSION_HINTS or _NATIVE_ON:
            _note_unmatched(session_id, agent)
        return None
    ui = _last_user_idx(msgs)
    if ui is None:
        return {"declined": "no_user_message"}
    tgt = msgs[ui]
    c = tgt.get("content")
    if isinstance(c, str):
        if not c:
            return {"declined": "empty_string_content"}
        # string == [{type:text}] for cache identity (wire-proven); converting
        # lets us append without touching the original text.
        c = tgt["content"] = [{"type": "text", "text": c}]
    if not isinstance(c, list):
        return {"declined": "unmarkable_content"}
    deepest = _deepest_marker_index(msgs)
    insert_at = (ui, len(c))
    mode = "user_tail"
    if deepest is not None and insert_at <= deepest:
        # A marker sits at or after the last USER message -> appending there would
        # land INSIDE a cached segment and bust it every turn. Measured on 400 real
        # captures: 6/400 (1.5%), every one a marker on the trailing role:"system"
        # roster message — and SESSION-CONCENTRATED (recurs at 77/134 messages in
        # one agent's sessions), so for those sessions a user-tail-only injector
        # never fires at all.
        # FALLBACK: append after the deepest marker instead, when that marker sits
        # on the LAST message and that message takes blocks. Position (last, len)
        # is strictly deeper than every marker, so the invariant holds. The target
        # is the opus-4-8 mid-conversation-system roster — already the CLI's own
        # channel for ambient system context, so a `<system-reminder>` is in
        # register there. Default OFF pending live wire proof that the API accepts
        # an extra text block on a role:"system" message; until then we decline
        # (visible in the record, never silent).
        if not (SYSTEM_TAIL_FALLBACK and deepest[0] == len(msgs) - 1):
            return {"declined": "marker_downstream", "deepest_marker": list(deepest),
                    "insert_at": list(insert_at),
                    "fallback_available": deepest[0] == len(msgs) - 1}
        tm = msgs[deepest[0]]
        tc = tm.get("content")
        if not isinstance(tc, list) or not tc:
            return {"declined": "fallback_unmarkable",
                    "deepest_marker": list(deepest)}
        tgt, c, ui = tm, tc, deepest[0]
        insert_at = (ui, len(c))
        mode = "system_tail"
    text = _wrap(hints)
    total = len(text)
    if total > HINTS_MAX_CHARS + 64:          # +envelope slack
        return {"declined": "over_cap", "chars": total}
    c.append({"type": "text", "text": text})
    log = {"hint_ids": [h["id"] for h in hints],
           "sources": {h["id"]: h.get("source") for h in hints},
           "chars": total, "est_tokens": max(1, total // 4),
           "msg_idx": ui, "block_idx": len(c) - 1, "mode": mode,
           "deepest_marker": list(deepest) if deepest else None,
           "uncached": True}
    if gate.get("gated_ids"):
        log["turn_start_gate"] = {k: gate[k] for k in
                                  ("at_turn_start", "gated_ids", "withheld")
                                  if k in gate}
    if gate.get("pop_declined"):
        log["pop_declined"] = gate["pop_declined"]
    if gate.get("pop_reserved"):
        # RESERVED, not popped: the entry stays armed until receipts.anthropic
        # sees a 200. Only reserve once the payload is actually ON the request —
        # every decline path above returns before this point.
        log["pop_reserved"] = gate["pop_reserved"]
        _reserve_pops(req_id, hints, session_id)
    _note_injection(session_id, log)
    return log
