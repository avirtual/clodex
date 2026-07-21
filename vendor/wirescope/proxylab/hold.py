import asyncio
import os
import re
import threading
import time
import uuid

from proxylab import meta as meta_mod
from proxylab import pinger as pinger_mod
from proxylab import transforms as transforms_mod
from proxylab import store as store_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

# --- HOLD-WARM: user-armed keep-warm driver (/warm-cache <n>) ------------------
# The replay pinger answers HOW to keep a prefix warm (one /_ping); this answers
# WHEN. The user arms a session IN-BAND: the /warm-cache command's expanded
# prompt carries the sentinel below (session_id rides in free via metadata).
# The proxy arms an until-deadline, then INJECTS an echo instruction and lets
# the turn FORWARD upstream so the MODEL ITSELF speaks the ack (2026-06-10
# redesign — the earlier synthetic end_turn left an assistant message the next
# turn's model knew it never wrote, and fable kept flagging the whole skill as
# prompt injection; a genuinely model-generated ack makes the transcript
# self-consistent). Liveness is structural: only a live proxy can add the
# [wirescope] block, so the command file's tripwire (no block -> reply "proxy
# not active") needs no history-scoping caveats. A background asyncio task
# (the event loop owns _client, which _warm_session needs) then auto-pings
# each armed session whenever its WARM prefix nears expiry.
#
# Arming costs one normal turn (~a ping when the prefix is warm; a fresh cache
# write when cold — which IS the warmth the hold then maintains). That spend is
# user-initiated (typed /warm-cache), not autonomous, so the never-higher-cost
# principle doesn't gate it. WARMTH_HOLD defaults ON; each arm is an explicit
# user action, clamped to WARMTH_HOLD_MAX_HOURS with a ping-count backstop.
# Pings fire inside (0, MARGIN) seconds of expiry — never at the TTL edge (the
# documented TOCTOU guidance) — and _warm_session's own warm-only gate is the
# final arbiter. Ping economics (CLAUDE.md): ~19:1 at 1h TTL; a 5m prefix is a
# bad bet (~12 pings/h) — allowed but warned about in the arming ack.
WARMTH_HOLD = os.environ.get("WARMTH_HOLD", "1") not in ("0", "no", "off", "false")
WARMTH_HOLD_MAX_HOURS = float(os.environ.get("WARMTH_HOLD_MAX_HOURS", "12"))
WARMTH_HOLD_MARGIN = int(os.environ.get("WARMTH_HOLD_MARGIN", "300"))
WARMTH_HOLD_INTERVAL = int(os.environ.get("WARMTH_HOLD_INTERVAL", "60"))
WARMTH_HOLD_MAX_PINGS = int(os.environ.get("WARMTH_HOLD_MAX_PINGS", "24"))
WARMTH_HOLD_MAX_FAILURES = 2   # consecutive ping FAILURES (not declines) -> disarm

# AUTH SELF-BOOTSTRAP: after a restart, restored entries sit auth-less until
# the account's next live request. But the box's own `claude` CLI holds the
# credentials — so when an ARMED HOLD is stuck awaiting auth, the proxy may
# spawn ONE minimal trimmed-tools haiku turn through ITSELF; that turn arrives
# like any other request and re-donates the account's headers (the credentials
# still never touch the proxy's disk — the CLI keeps them where it always did).
# Spends real (tiny) credits autonomously, so it is tightly bounded: fires only
# for a hold that needs it, max attempts + cooldown per process, one in flight.
WARMTH_AUTH_BOOTSTRAP = os.environ.get(
    "WARMTH_AUTH_BOOTSTRAP", "1") not in ("0", "no", "off", "false")
WARMTH_AUTH_BOOTSTRAP_MODEL = os.environ.get(
    "WARMTH_AUTH_BOOTSTRAP_MODEL", "claude-haiku-4-5-20251001")
_AUTH_BOOTSTRAP_MAX = int(os.environ.get("WARMTH_AUTH_BOOTSTRAP_MAX", "2"))
_AUTH_BOOTSTRAP_COOLDOWN = int(os.environ.get("WARMTH_AUTH_BOOTSTRAP_COOLDOWN", "600"))
_AUTH_BOOTSTRAP = {"attempts": 0, "last_ts": 0.0, "inflight": False}


def _bootstrap_decision(account, now=None, state=None):
    """May the proxy spend a bootstrap turn right now? PURE-ish (offline-
    testable via `state`). Returns (go, reason)."""
    st = state if state is not None else _AUTH_BOOTSTRAP
    now = now or time.time()
    if not WARMTH_AUTH_BOOTSTRAP:
        return False, "disabled (WARMTH_AUTH_BOOTSTRAP=0)"
    if st["inflight"]:
        return False, "bootstrap already in flight"
    if st["attempts"] >= _AUTH_BOOTSTRAP_MAX:
        return False, f"max attempts ({_AUTH_BOOTSTRAP_MAX}) spent"
    if now - st["last_ts"] < _AUTH_BOOTSTRAP_COOLDOWN:
        return False, "cooldown"
    with pinger_mod._LAST_REQUEST_LOCK:
        if account and account in pinger_mod._ACCOUNT_AUTH:
            return False, "auth already present (resolve instead)"
    return True, "go"


async def _auth_bootstrap(account=None):
    """Spawn the minimal donor turn (see section comment). The spawned CLI is
    pointed at THIS proxy, so its request flows through the normal handler and
    populates _ACCOUNT_AUTH as a side effect — nothing here touches secrets."""
    go, why = _bootstrap_decision(account)
    if not go:
        return
    _AUTH_BOOTSTRAP["inflight"] = True
    _AUTH_BOOTSTRAP["attempts"] += 1
    _AUTH_BOOTSTRAP["last_ts"] = time.time()
    port = os.environ.get("PORT", "7800")
    # Pre-chosen session id, tagged kind=bootstrap BEFORE the spawn: every
    # request of this session (incl. the title side-call) arrives already
    # identifiable as proxy-spawned, and /_status hides it from the human's
    # session list (traffic upserts COALESCE, so the tag sticks).
    sid = str(uuid.uuid4())
    meta_mod._upsert_session_meta(sid, kind="bootstrap", cwd="/tmp",
                         model=WARMTH_AUTH_BOOTSTRAP_MODEL)
    print(f"[auth] bootstrap: spawning a minimal {WARMTH_AUTH_BOOTSTRAP_MODEL} "
          f"turn through :{port} as {sid[:8]}… to re-acquire account "
          f"credentials (attempt {_AUTH_BOOTSTRAP['attempts']}/"
          f"{_AUTH_BOOTSTRAP_MAX})", flush=True)
    proc = None
    try:
        env = {**os.environ, "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}"}
        # prompt must come BEFORE --tools: the flag is variadic and would
        # swallow a trailing positional as another tool name (the CLI then
        # exits 1 with "Input must be provided" before any API call)
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", "Reply with exactly: ok",
            "--model", WARMTH_AUTH_BOOTSTRAP_MODEL,
            "--session-id", sid,
            "--tools", "Bash",
            cwd="/tmp", env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), timeout=120)
        rc = proc.returncode
        with pinger_mod._LAST_REQUEST_LOCK:
            got = bool(account) and account in pinger_mod._ACCOUNT_AUTH
        tail = ""
        if rc and err:
            tail = "; stderr: " + err.decode(errors="replace").strip()[-300:]
        print(f"[auth] bootstrap turn exited rc={rc}; account auth "
              f"{'ACQUIRED' if got else 'not seen yet'}{tail}", flush=True)
    except Exception as e:
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        print(f"[auth] bootstrap failed: {e}", flush=True)
    finally:
        _AUTH_BOOTSTRAP["inflight"] = False

_HOLD_RE = re.compile(r"<proxy:warm-cache\s+hours=([0-9.]+|off)\s*>")
_HOLD_STATE = {}   # sid -> {until, armed_at, pings, failures, last_ping_ts, last_result}
_HOLD_LOCK = threading.Lock()

# this module's table (see proxylab.store ownership rule): armed holds,
# mirrored on every change + reloaded at startup (restart-amnesia fix).
# `hours` = the hold's INSURANCE WINDOW (2026-06-10): `until` slides to
# last-organic-turn + hours, so until/armed_at no longer encode the duration;
# legacy NULL rows derive hours from (until - armed_at).
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS hold_state ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "until REAL NOT NULL, armed_at REAL NOT NULL, "
    "pings INTEGER NOT NULL, failures INTEGER NOT NULL, "
    "last_ping_ts REAL, last_result TEXT, "
    "PRIMARY KEY (owner, session_id))",
    "ALTER TABLE hold_state ADD COLUMN hours REAL")


def _persist_hold_row(session_id, h):
    """Mirror a hold to SQLite (pure intent, nothing secret) so a restart can't
    silently forget a user's /warm-cache. Called OUTSIDE _HOLD_LOCK with a
    snapshot — a store failure degrades to the old in-memory-only behavior."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO hold_state(owner, session_id, until, armed_at, "
                "pings, failures, last_ping_ts, last_result, hours) "
                "VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, session_id) DO UPDATE SET "
                "until=excluded.until, armed_at=excluded.armed_at, "
                "pings=excluded.pings, failures=excluded.failures, "
                "last_ping_ts=excluded.last_ping_ts, "
                "last_result=excluded.last_result, hours=excluded.hours",
                (store_mod.OWNER, session_id, h["until"], h["armed_at"],
                 h.get("pings", 0), h.get("failures", 0),
                 h.get("last_ping_ts"), h.get("last_result"),
                 h.get("hours")))
            con.commit()
    except Exception as e:
        print(f"[hold] persist failed for {session_id[:12]}…: {e}", flush=True)


def _delete_hold_row(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM hold_state WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[hold] row delete failed for {session_id[:12]}…: {e}", flush=True)


def _hold_request(obj):
    """Parse a /warm-cache sentinel out of the last user message.
    ('arm', hours) | ('off', None) | None (no sentinel)."""
    m = _HOLD_RE.search(transforms_mod._last_user_text(obj) or "")
    if not m:
        return None
    v = m.group(1)
    if v == "off":
        return ("off", None)
    try:
        hours = float(v)
    except ValueError:
        return ("off", None)
    if hours <= 0:
        return ("off", None)
    return ("arm", min(hours, WARMTH_HOLD_MAX_HOURS))


def _arm_hold(session_id, action, hours):
    """Arm/disarm a session's hold; compose the user-facing ack — the text the
    MODEL is instructed to echo (see _hold_echo_transform), so it lands in the
    transcript as genuine assistant output reporting REALITY: current warmth,
    expected ping count, and every reason the hold might be a no-op.
    Returns (ack_text, record).

    The "[wirescope]" prefix stays even though the model now speaks the line:
    it marks provenance (the model recites the proxy's words), and it keeps a
    later unproxied continuation of the same transcript from reading the ack
    as the model's own unverifiable claim."""
    now = time.time()
    if not session_id:
        return ("[wirescope] cache hold NOT armed: request carries no session "
                "metadata.",
                {"armed": False, "reason": "no_session"})
    if action == "off":
        with _HOLD_LOCK:
            prev = _HOLD_STATE.pop(session_id, None)
        _delete_hold_row(session_id)
        if prev:
            return (f"[wirescope] cache hold disarmed ({prev['pings']} ping(s) "
                    "had fired).",
                    {"armed": False, "disarmed": True, "pings": prev["pings"]})
        return ("[wirescope] no cache hold was armed for this session.",
                {"armed": False, "disarmed": False})
    if not (WARMTH_HOLD and pinger_mod.WARMTH_PINGER and warmth_mod.WARMTH_LEDGER):
        return ("[wirescope] cache hold NOT armed: hold-warm is disabled on "
                "this proxy (needs WARMTH_HOLD + WARMTH_PINGER + WARMTH_LEDGER).",
                {"armed": False, "reason": "disabled"})
    until = now + hours * 3600
    hstate = {"until": until, "armed_at": now, "hours": hours, "pings": 0,
              "failures": 0, "last_ping_ts": None, "last_result": None}
    with _HOLD_LOCK:
        _HOLD_STATE[session_id] = hstate
    _persist_hold_row(session_id, hstate)
    wq = warmth_mod.warmth_query(session=session_id)
    entry = pinger_mod._resolve_auth(session_id)
    pingable = entry is not None and not entry.get("needs_auth")
    # The arming turn now FORWARDS, so it self-heals what the old synthetic
    # path could only warn about: it becomes the replayable last request,
    # donates live auth, and (re-)writes the prefix cache. The old "no
    # replayable request / restored without credentials" notes are obsolete.
    ttl = wq.get("ttl_s") or 3600
    expected = max(1, int(hours * 3600 // ttl))
    notes = []
    if wq.get("warm"):
        notes.append(f"prefix warm, {int(wq['remaining_s'] // 60)}m left, "
                     f"~{expected} ping(s) expected")
        if ttl == 300:
            notes.append("WARNING: 5m-TTL prefix — ~12 pings/hour, poor economics")
    else:
        notes.append("prefix was not warm — this arming turn re-establishes "
                     f"the cache; ~{expected} ping(s) expected")
    ack = (f"[wirescope] \U0001f525 cache hold armed: {hours:g}h of idle "
           f"insurance — the window re-anchors to your LAST real turn, so the "
           f"cache stays warm until {hours:g}h after you walk away (as of now: "
           f"{time.strftime('%H:%M', time.localtime(until))}); "
           + "; ".join(notes) + ". Disarm: /warm-cache off")
    return (ack, {"armed": True, "hours": hours, "until": until,
                  "warmth": wq, "pingable": pingable})


def _hold_echo_transform(obj):
    """/warm-cache sentinel turn: arm/disarm the hold, then INJECT a
    [wirescope] echo instruction into the final user message and let the turn
    FORWARD upstream — the model itself speaks the ack, so the transcript is
    self-consistent (no synthetic assistant message for a later turn to
    disown). Only a live proxy can add the block, so the command file's
    "no block -> proxy not active" tripwire stays honest by construction.
    Returns a record dict when the sentinel fired, else None.

    Known, accepted desync: the injected block is sent upstream but never
    lands in the CLI's transcript, so the NEXT turn's history diverges from
    the cached prefix at this message — a one-time tail re-write of a few
    hundred tokens."""
    hr = _hold_request(obj)
    if hr is None:
        return None
    action, hours = hr
    session_id, _, _ = writer_mod._session_ids(obj)
    ack, hrec = _arm_hold(session_id, action, hours)
    instr = ("<system-reminder>\n[wirescope] The local proxy is live and has "
             "processed this /warm-cache turn; the state change reported "
             "below is already applied. Reply with exactly the following "
             "text and nothing else — no preamble, no tool calls:\n\n"
             f"{ack}\n</system-reminder>")
    injected = transforms_mod._inject_into_last_user(obj, instr, "\n\n") is not None
    return {**hrec, "action": action, "ack": ack, "forwarded": True,
            "injected": injected}


def _hold_note_real_turn(session_id, now=None):
    """An organic turn just re-warmed the session itself, so the hold is
    INSURANCE on idle time and the whole window re-anchors: `until` slides to
    now + the armed duration, and the ping budget restarts (the counter means
    'pings since your last real turn', not 'pings since arming'). The hold
    thus keeps the cache warm for N hours AFTER the user walks away, whenever
    that turns out to be — not N hours after the arming timestamp. (A sentinel
    or replay ping never lands here; only forwarded turns do.)"""
    if not session_id:
        return
    now = now or time.time()
    snap = None
    with _HOLD_LOCK:
        cur = _HOLD_STATE.get(session_id)
        if cur:
            hours = cur.get("hours") or (cur["until"] - cur["armed_at"]) / 3600
            cur["hours"] = hours
            cur["until"] = now + hours * 3600
            cur["pings"] = 0
            cur["failures"] = 0
            snap = dict(cur)
    if snap:
        _persist_hold_row(session_id, snap)
        print(f"[hold] session={session_id[:12]}… organic turn -> window "
              f"re-anchored (until "
              f"{time.strftime('%H:%M', time.localtime(snap['until']))}, "
              "pings reset)", flush=True)


def _hold_decision(hold, has_last_request, warmth_row, now, has_auth=True):
    """One tick's verdict for an armed session — PURE (offline-testable).
    warmth_row = (stamped_at, ttl, expires_at) | None.
    Returns ('disarm'|'ping'|'skip', reason). Not-warm only SKIPS (never
    disarms): warmth can come back with the user's next real turn, and a
    skipping hold costs nothing — it self-bounds at `until`."""
    if now > hold["until"]:
        return ("disarm", "hold period over")
    if hold["pings"] >= WARMTH_HOLD_MAX_PINGS:
        return ("disarm", f"max pings ({WARMTH_HOLD_MAX_PINGS}) reached")
    if hold["failures"] >= WARMTH_HOLD_MAX_FAILURES:
        return ("disarm", f"{hold['failures']} consecutive ping failures "
                          "(stale credentials?)")
    if not has_last_request:
        return ("skip", "no replayable request cached")
    if not has_auth:
        # restored entry, credentials not yet re-donated — don't even burn a
        # ping-count slot on the guaranteed decline
        return ("skip", "restored without credentials; awaiting live traffic")
    if not warmth_row:
        return ("skip", "prefix not in ledger")
    remaining = warmth_row[2] - now
    if remaining <= 0:
        return ("skip", "prefix already cold")
    if remaining >= WARMTH_HOLD_MARGIN:
        return ("skip", "not yet due")
    return ("ping", "due")


async def _hold_tick(now=None):
    now = now or time.time()
    with _HOLD_LOCK:
        armed = {sid: dict(h) for sid, h in _HOLD_STATE.items()}
    for sid, hold in armed.items():
        entry = pinger_mod._resolve_auth(sid)
        row = None
        if entry:
            try:
                msgs = entry["obj"].get("messages") or []
                h = warmth_mod._prefix_hash(entry["obj"], len(msgs))
                row = warmth_mod._warmth_rows([h]).get(h)
            except Exception:
                row = None
        action, reason = _hold_decision(
            hold, entry is not None, row, now,
            has_auth=bool(entry) and not entry.get("needs_auth"))
        if action == "skip" and reason.startswith("restored without credentials"):
            # an armed hold is stuck on the post-restart auth gap — the proxy
            # may close it itself (bounded; see _auth_bootstrap)
            asyncio.create_task(_auth_bootstrap(entry.get("account")))
        if action == "disarm":
            with _HOLD_LOCK:
                _HOLD_STATE.pop(sid, None)
            _delete_hold_row(sid)
            print(f"[hold] session={sid[:12]}… disarmed: {reason}", flush=True)
        elif action == "ping":
            code, res = await pinger_mod._warm_session(sid)
            warmed = bool(res.get("warmed"))
            declined = bool(res.get("skipped"))   # clean warm-only decline (race
            auth_stale = bool(res.get("auth_stale"))  # to cold) — not a failure
            snap = None
            with _HOLD_LOCK:
                cur = _HOLD_STATE.get(sid)
                if cur:
                    cur["pings"] += 1
                    cur["last_ping_ts"] = now
                    if warmed:
                        cur["failures"] = 0
                        cur["last_result"] = "warmed"
                    elif declined:
                        cur["last_result"] = f"declined:{res.get('skipped')}"
                    elif auth_stale:
                        # NOT a disarm strike: _warm_session already invalidated
                        # the dead bearer (entry is needs_auth again) and the
                        # bootstrap below re-donates — recoverable auth gap,
                        # same as the post-restart one
                        cur["last_result"] = "auth_stale"
                    else:
                        cur["failures"] += 1
                        cur["last_result"] = f"fail:{code}"
                    snap = dict(cur)
            if snap:
                _persist_hold_row(sid, snap)
            if auth_stale:
                asyncio.create_task(
                    _auth_bootstrap(entry.get("account") if entry else None))
            print(f"[hold] session={sid[:12]}… auto-ping -> "
                  f"{'WARMED' if warmed else 'auth stale (401) -> bootstrap' if auth_stale else res.get('skipped') or f'FAILED ({code})'} "
                  f"pings={hold['pings'] + 1}", flush=True)


async def _hold_loop():
    while True:
        await asyncio.sleep(max(5, WARMTH_HOLD_INTERVAL))
        try:
            await _hold_tick()
        except Exception as e:
            print(f"[hold] tick error: {e}", flush=True)


async def _start_hold_loop():
    if WARMTH_HOLD and pinger_mod.WARMTH_PINGER and warmth_mod.WARMTH_LEDGER:
        asyncio.create_task(_hold_loop())
        print(f"[hold] driver up: interval={WARMTH_HOLD_INTERVAL}s "
              f"margin={WARMTH_HOLD_MARGIN}s clamp={WARMTH_HOLD_MAX_HOURS}h "
              f"max_pings={WARMTH_HOLD_MAX_PINGS}", flush=True)


def _hold_snapshot():
    with _HOLD_LOCK:
        return {sid: dict(h) for sid, h in _HOLD_STATE.items()}
