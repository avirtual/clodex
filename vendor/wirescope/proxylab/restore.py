import json
import time

from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import core as core_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import pinger as pinger_mod
from proxylab import store as store_mod

# --- RESTART-AMNESIA (open item h): reload persisted state at startup ----------
# Principle: every relevant in-memory structure is persisted/reconstructible, so
# a restart recovers most of what the process held — the proxy must not "return
# clueless". What each piece restores from:
#   _HOLD_STATE      <- hold_state table (expired rows reaped on load)
#   _LAST_REQUEST    <- last_request table (bodies + non-secret headers; entries
#                       come back needs_auth=True until the account's first live
#                       request re-donates credentials — see _resolve_auth)
#   _TOTALS et al.   <- the _totals.json/_session.json snapshots already written
#                       on every request (LOG_DIR-lifetime semantics + a
#                       since_start delta)
#   _META_CWD_DONE   <- session_meta (cwd IS NOT NULL = stop hunting)
# Explicitly OK to lose: _SC_FIRED, _PENDING_RELAY, _UNPRICED_WARNED (ephemeral
# per-turn / cosmetic). Warmth ledger + session_head/meta were already durable.
_RESTORED = {"holds": 0, "last_requests": 0, "totals": False,
             "session_totals": 0, "cwd_done": 0}

def _restore_holds(now=None):
    now = now or time.time()
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT session_id, until, armed_at, pings, failures, "
                "last_ping_ts, last_result, hours FROM hold_state WHERE owner=?",
                (store_mod.OWNER,)).fetchall()
            expired = [r[0] for r in rows if r[1] <= now]
            if expired:
                con.executemany(
                    "DELETE FROM hold_state WHERE owner=? AND session_id=?",
                    [(store_mod.OWNER, s) for s in expired])
                con.commit()
    except Exception as e:
        print(f"[restore] holds failed: {e}", flush=True)
        return 0
    restored = 0
    with hold_mod._HOLD_LOCK:
        for sid, until, armed_at, pings, failures, lpt, lres, hours in rows:
            if until > now and sid not in hold_mod._HOLD_STATE:
                hold_mod._HOLD_STATE[sid] = {"until": until, "armed_at": armed_at,
                                    "pings": pings, "failures": failures,
                                    "last_ping_ts": lpt, "last_result": lres,
                                    # legacy row: until never slid, so the
                                    # original span IS the duration
                                    "hours": hours or (until - armed_at) / 3600}
                restored += 1
    return restored


def _restore_last_requests(now=None):
    """Reload replayable request bodies (auth-less; newest first, capped). Rows
    past the same staleness predicate the sweeper uses are reaped instead."""
    now = now or time.time()
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT session_id, account_uuid, path, ts, body, headers "
                "FROM last_request WHERE owner=? ORDER BY ts DESC LIMIT ?",
                (store_mod.OWNER, pinger_mod._LAST_REQUEST_MAX)).fetchall()
    except Exception as e:
        print(f"[restore] last_requests failed: {e}", flush=True)
        return 0
    loaded, stale = 0, []
    for sid, acct, path, ts, body, hdrs in rows:
        try:
            bobj = json.loads(body)
            oai = codex_mod._is_openai_body(bobj)   # view-only entries never need auth
            entry = {"obj": bobj, "headers": json.loads(hdrs),
                     "path": path, "ts": ts, "account": acct,
                     "needs_auth": not oai,
                     **({"provider": "openai"} if oai else {})}
            age, ttl = pinger_mod._prefix_age_ttl(entry, now)
        except Exception:
            stale.append(sid)
            continue
        if age > ttl + pinger_mod._LAST_REQUEST_GRACE:
            stale.append(sid)
            continue
        with pinger_mod._LAST_REQUEST_LOCK:
            if sid not in pinger_mod._LAST_REQUEST:
                pinger_mod._LAST_REQUEST[sid] = entry
                loaded += 1
    if stale:
        try:
            con = store_mod.db()
            with store_mod.LOCK:
                con.executemany(
                    "DELETE FROM last_request WHERE owner=? AND session_id=?",
                    [(store_mod.OWNER, s) for s in stale])
                con.commit()
        except Exception:
            pass
    return loaded


def _restore_totals():
    """Reload the running totals from the snapshots _accumulate already writes
    on every request, then baseline since_start. Best-effort: a kill -9 may have
    lost the last enqueued snapshot — acceptable drift, flagged nowhere."""
    # (was `global _TOTALS_AT_START` pre-split; it lives in proxylab.billing
    # now and is rebound below via the module attribute)
    restored, nsess = False, 0
    try:
        p = core_mod.LOG_DIR / "_totals.json"
        if p.exists():
            data = json.loads(p.read_text())
            if isinstance(data, dict):
                billing_mod._TOTALS.update(data)
                restored = True
    except Exception as e:
        print(f"[restore] totals failed: {e}", flush=True)
    try:
        for sp in core_mod.LOG_DIR.glob("*/_session.json"):
            try:
                d = json.loads(sp.read_text())
                if isinstance(d, dict):
                    billing_mod._SESSION_TOTALS[sp.parent.name].update(d)
                    nsess += 1
            except Exception:
                continue
    except Exception:
        pass
    billing_mod._TOTALS_AT_START = json.loads(json.dumps(billing_mod._TOTALS))
    return restored, nsess


def _restore_cwd_done():
    """Sessions whose cwd is already in session_meta need no further hunting;
    the rest get their (cheap, capped) scan attempts back after a restart."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT session_id FROM session_meta "
                               "WHERE cwd IS NOT NULL").fetchall()
        meta_mod._META_CWD_DONE.update(r[0] for r in rows)
        return len(rows)
    except Exception as e:
        print(f"[restore] cwd_done failed: {e}", flush=True)
        return 0


def _restore_ended():
    """Reload SessionEnd markers so a restart doesn't forget which sessions
    ended (and so a post-restart live turn still clears the right mark)."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT session_id, ended_at, end_reason "
                               "FROM session_meta WHERE ended_at IS NOT NULL"
                               ).fetchall()
        for sid, ts, reason in rows:
            meta_mod._ENDED[sid] = {"ts": ts, "reason": reason or "unspecified"}
        return len(rows)
    except Exception:
        return 0


def _restore_strip_overrides():
    """Reload per-session strip overrides BEFORE the first post-restart turn, so
    an opted-in session keeps stripping (and its warm prefix stays consistent)
    instead of involuntarily flipping OFF and forcing a full-window re-write.
    The anti-flap fix — our control state must be as durable as the cache."""
    try:
        from proxylab import transforms as transforms_mod
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT session_id, enabled FROM strip_override "
                               "WHERE owner=?", (store_mod.OWNER,)).fetchall()
        for sid, enabled in rows:
            transforms_mod._STRIP_OVERRIDE[sid] = int(enabled)   # level 0/1/2
        return len(rows)
    except Exception as e:
        print(f"[restore] strip_overrides failed: {e}", flush=True)
        return 0


def _restore_hint_overrides():
    """Reload per-agent spawner-hint overrides BEFORE the first post-restart
    turn, so an A/B arm's hint state can't flip mid-experiment (a flip would
    also reshape the marked system prefix -> warm bust). Same durability
    rationale as strip_overrides; keyed by agent route name, not session."""
    try:
        from proxylab import transforms as transforms_mod
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT agent, enabled FROM hint_override "
                               "WHERE owner=?", (store_mod.OWNER,)).fetchall()
        for ag, enabled in rows:
            transforms_mod._HINT_OVERRIDE[ag] = int(enabled)
        return len(rows)
    except Exception as e:
        print(f"[restore] hint_overrides failed: {e}", flush=True)
        return 0


def _restore_strip_guard_latches():
    """Reload per-session strip-guard latches BEFORE the first post-restart turn,
    so the guard keeps its sticky decision instead of recomputing the ratio and
    re-flipping against a still-warm prefix. Same durability rationale as
    strip_overrides — anti-flap depends on the control state outliving restarts."""
    try:
        from proxylab import transforms as transforms_mod
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT session_id, strip FROM strip_guard_latch "
                               "WHERE owner=?", (store_mod.OWNER,)).fetchall()
        for sid, strip in rows:
            transforms_mod._STRIP_GUARD_LATCH[sid] = bool(strip)
        return len(rows)
    except Exception as e:
        print(f"[restore] strip_guard_latches failed: {e}", flush=True)
        return 0


def _restore_rider_latches():
    """Reload per-session rider latches BEFORE the first post-restart turn — the
    whole point of the latch is surviving exactly this moment: the first resumed
    request after a bake has no prior thinking, so without the latch the riders
    would skip and ship raw acks against the stub-carrying warm prefix."""
    try:
        from proxylab import transforms as transforms_mod
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute("SELECT session_id FROM rider_latch "
                               "WHERE owner=?", (store_mod.OWNER,)).fetchall()
        for (sid,) in rows:
            transforms_mod._RIDER_LATCH[sid] = True
        return len(rows)
    except Exception as e:
        print(f"[restore] rider_latches failed: {e}", flush=True)
        return 0


def _restore_state():
    now = time.time()
    _RESTORED["holds"] = _restore_holds(now)
    _RESTORED["last_requests"] = _restore_last_requests(now)
    _RESTORED["totals"], _RESTORED["session_totals"] = _restore_totals()
    _RESTORED["cwd_done"] = _restore_cwd_done()
    _RESTORED["ended"] = _restore_ended()
    _RESTORED["strip_overrides"] = _restore_strip_overrides()
    _RESTORED["hint_overrides"] = _restore_hint_overrides()
    _RESTORED["strip_guard_latches"] = _restore_strip_guard_latches()
    _RESTORED["rider_latches"] = _restore_rider_latches()
    print(f"[restore] holds={_RESTORED['holds']} "
          f"last_requests={_RESTORED['last_requests']} (auth-less until live "
          f"traffic) totals={'reloaded' if _RESTORED['totals'] else 'fresh'} "
          f"session_totals={_RESTORED['session_totals']} "
          f"cwd_known={_RESTORED['cwd_done']} "
          f"strip_overrides={_RESTORED['strip_overrides']} "
          f"strip_guard_latches={_RESTORED['strip_guard_latches']} "
          f"rider_latches={_RESTORED['rider_latches']}", flush=True)
