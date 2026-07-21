import json
import os
import threading
import time

from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import core as core_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import store as store_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

# --- PINGER: keep a prefix warm by REPLAYING a session's last request ---------
# The old keep-warm path made a caller reconstruct an entire `--resume
# --fork-session` payload (tools, cwd, system, history) just to smuggle a
# sentinel turn past the proxy. But the proxy ALREADY sees the exact, fully
# transformed last request of every session — the precise bytes the backend
# content-addressed. So the dance collapses to: cache that last request in
# memory, and let `POST /_ping?session=<id>` replay it with thinking off and
# `max_tokens:1`. Identical cacheable prefix => a cache READ that slides the TTL,
# for ~1 output token. The caller only needs the session_id.
#
# The cache holds auth/version headers too (so the replay matches the original's
# beta namespace + credentials) — IN MEMORY ONLY, never written to disk.
WARMTH_PINGER = os.environ.get("WARMTH_PINGER", "1") not in ("0", "no", "off", "false")
_LAST_REQUEST_MAX = int(os.environ.get("WARMTH_PINGER_MAX", "2000"))
# entry: {"obj","headers","path","ts","account","needs_auth"} — needs_auth=True
# marks an entry RESTORED from SQLite after a restart: its body/path are real
# but the secret headers are absent until the account re-donates them.
_LAST_REQUEST = {}
_LAST_REQUEST_LOCK = threading.Lock()
# account_uuid -> {secret header: value}, harvested from live traffic. Auth is
# ACCOUNT-level, not session-level, so the first live request after a restart
# re-arms every restored entry of that account. IN MEMORY ONLY, never on disk.
# Mutated only under _LAST_REQUEST_LOCK. (Unbounded, but accounts ~ 1/box.)
_ACCOUNT_AUTH = {}

# this module's table (see proxylab.store ownership rule): the replayable last
# request, BODY + NON-SECRET headers only. The body is no more secret than the
# LOG_DIR captures (same post-transform bytes); auth headers NEVER land on
# disk (standing rule) — re-attached at runtime from _ACCOUNT_AUTH.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS last_request ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "account_uuid TEXT, path TEXT NOT NULL, ts REAL NOT NULL, "
    "body TEXT NOT NULL, headers TEXT NOT NULL, "
    "PRIMARY KEY (owner, session_id))")


def _persist_last_request_row(session_id, account_uuid, path, ts, obj, safe_headers):
    """Writer-thread upsert of the replayable request (body + NON-SECRET
    headers — secrets were split off before enqueue, see _cache_last_request)."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO last_request(owner, session_id, account_uuid, "
                "path, ts, body, headers) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, session_id) DO UPDATE SET "
                "account_uuid=excluded.account_uuid, path=excluded.path, "
                "ts=excluded.ts, body=excluded.body, headers=excluded.headers",
                (store_mod.OWNER, session_id, account_uuid, path, ts,
                 json.dumps(obj, ensure_ascii=False),
                 json.dumps(safe_headers, ensure_ascii=False)))
            con.commit()
    except Exception as e:
        print(f"[lastreq] persist failed for {session_id[:12]}…: {e}", flush=True)


def _delete_last_request_row(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM last_request WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[lastreq] delete failed for {session_id[:12]}…: {e}", flush=True)


def _cache_last_request(session_id, obj, fwd_headers, upstream_path,
                        account_uuid=None):
    """Stash the just-forwarded (post-transform) messages request so a later
    /_ping can replay it. obj is not reused after this turn, so we keep the ref;
    headers are kept whole (incl. auth + anthropic-beta) so the replay rides the
    same cache namespace — evicted oldest-first past the cap. The body + the
    non-secret headers are also MIRRORED to SQLite (restart-amnesia, item h);
    the secret headers go only to the in-memory _ACCOUNT_AUTH registry."""
    if not (WARMTH_PINGER and session_id and isinstance(obj, dict)):
        return
    headers = dict(fwd_headers)
    auth = {k: v for k, v in headers.items() if k.lower() in core_mod._SECRET_HEADERS}
    safe = {k: v for k, v in headers.items() if k.lower() not in core_mod._SECRET_HEADERS}
    ts = time.time()
    evicted = None
    with _LAST_REQUEST_LOCK:
        if account_uuid and auth:
            _ACCOUNT_AUTH[account_uuid] = auth
            # fresh credentials close the auth gap: the bootstrap budget is
            # per OUTAGE (2 consecutive failed spawns), not per process — a
            # long hold may legitimately need a refresh every OAuth expiry
            hold_mod._AUTH_BOOTSTRAP["attempts"] = 0
        _LAST_REQUEST[session_id] = {"obj": obj, "headers": headers,
                                     "path": upstream_path, "ts": ts,
                                     "account": account_uuid,
                                     "needs_auth": False}
        if len(_LAST_REQUEST) > _LAST_REQUEST_MAX:
            evicted = min(_LAST_REQUEST.items(), key=lambda kv: kv[1]["ts"])[0]
            _LAST_REQUEST.pop(evicted, None)
    writer_mod._enqueue_last_request(session_id, account_uuid, upstream_path, ts, obj, safe)
    if evicted:
        writer_mod._enqueue_last_request_delete(evicted)


def _cache_last_request_openai(session_id, obj, upstream_path):
    """Codex flavor of _cache_last_request: stored for the /_session context
    view (+ restart parity via the same mirror table), NOT for replay — the
    pinger declines openai bodies (caching is server-side; there is no
    client-side TTL to slide). No headers kept: nothing here is ever re-sent."""
    if not (session_id and isinstance(obj, dict)):
        return
    ts = time.time()
    evicted = None
    with _LAST_REQUEST_LOCK:
        _LAST_REQUEST[session_id] = {"obj": obj, "headers": {},
                                     "path": upstream_path, "ts": ts,
                                     "account": None, "provider": "openai",
                                     "needs_auth": False}
        if len(_LAST_REQUEST) > _LAST_REQUEST_MAX:
            evicted = min(_LAST_REQUEST.items(), key=lambda kv: kv[1]["ts"])[0]
            _LAST_REQUEST.pop(evicted, None)
    writer_mod._enqueue_last_request(session_id, None, upstream_path, ts, obj, {})
    if evicted:
        writer_mod._enqueue_last_request_delete(evicted)


def _resolve_auth(session_id):
    """Return the session's cached entry, re-attaching account-level credentials
    to a restored (auth-less) one when its account has since sent live traffic.
    The entry stays needs_auth=True — and pings decline gracefully — until the
    donation arrives."""
    with _LAST_REQUEST_LOCK:
        e = _LAST_REQUEST.get(session_id)
        if not e or not e.get("needs_auth"):
            return e
        donated = _ACCOUNT_AUTH.get(e.get("account"))
        if donated:
            e = dict(e)
            e["headers"] = {**e["headers"], **donated}
            e["needs_auth"] = False
            _LAST_REQUEST[session_id] = e
        return e


def _invalidate_stale_auth(session_id, account):
    """A 401 on a replay means the cached bearer went stale (OAuth expiry):
    drop it from the account registry and flip the session entry back to
    needs_auth, so nothing retries the dead headers and the existing no-auth
    path (clean skip + auth bootstrap) takes over until fresh credentials
    are donated."""
    with _LAST_REQUEST_LOCK:
        if account:
            _ACCOUNT_AUTH.pop(account, None)
        live = _LAST_REQUEST.get(session_id)
        if live:
            live["needs_auth"] = True

async def _warm_session(session_id, force=False):
    """Replay a session's cached last request as a minimal keep-warm ping. Returns
    (http_status, json_result). Identical cacheable prefix => the backend serves a
    cache READ and slides the TTL; thinking off + max_tokens:1 keeps output to one
    token. Pings IFF the prefix is warm — skips anything else (a non-warm replay
    would be a cold-write at the write premium) unless force=1."""
    if not WARMTH_PINGER:
        return 404, {"ok": False, "reason": "pinger disabled (WARMTH_PINGER=0)"}
    entry = _resolve_auth(session_id)
    entry = dict(entry) if entry else None
    if not entry:
        return 404, {"ok": False, "session": session_id,
                     "reason": "no cached request for this session yet "
                               "(it must have made >=1 messages call through "
                               "this proxy since start)"}
    if entry.get("needs_auth"):
        # Restored after a restart, body intact but credentials (rightly) not
        # persisted — a clean DECLINE, not a failure: the account's next live
        # turn re-donates auth and pings resume.
        return 200, {"ok": True, "warmed": False, "skipped": "no_auth",
                     "session": session_id,
                     "reason": "replayable request restored without credentials "
                               "(auth never persists); waiting for live traffic "
                               "from the same account to re-attach them"}
    src = entry["obj"]
    if codex_mod._is_openai_body(src):
        return 200, {"ok": True, "warmed": False, "skipped": "openai_wire",
                     "session": session_id,
                     "reason": "codex/openai session — caching is server-side, "
                               "there is no client TTL to slide; entry kept for "
                               "the /_session view only"}
    msgs = src.get("messages") or []
    if not msgs:
        return 400, {"ok": False, "session": session_id,
                     "reason": "cached request has no messages"}
    # A ping is ONLY ever a win on a WARM prefix: a 0.10x cache READ that slides
    # the TTL, buying a future write. On anything else — cold, absent, store
    # error — replaying is a cache WRITE at the premium "for the sake of the
    # ping": exactly the higher cost the pinger exists to avoid. So ping IFF
    # warm; everything else declines. force=1 is the only override (deliberately
    # (re)establish a cache). Goal: never higher cost.
    h_full = warmth_mod._prefix_hash(src, len(msgs))
    prior = warmth_mod.warmth_state(h_full)
    if prior != "warm" and not force:
        return 200, {"ok": True, "warmed": False, "skipped": prior,
                     "session": session_id, "hash": h_full, "prior_warmth": prior,
                     "note": f"prefix is '{prior}', not warm; a ping only refreshes "
                             "a warm cache — replaying would be a cold-write at the "
                             "write premium. Declined (force=1 to establish it)."}
    # Minimal warming variant: identical cacheable prefix (tools/system/messages
    # untouched -> same content hash), one output token, non-streaming. We turn
    # thinking OFF so max_tokens can be 1 (an enabled thinking budget forces
    # max_tokens > budget => real output cost); but a `context_management`
    # thinking-clearing strategy (e.g. clear_thinking_*) then 400s "requires
    # thinking to be enabled", so drop it too. Neither field is part of the cached
    # prefix, so the cache READ is preserved. `tools` MUST stay (it's IN the prefix).
    warm = dict(src)
    warm.pop("thinking", None)
    warm.pop("context_management", None)
    warm["max_tokens"] = 1
    warm["stream"] = False
    body = json.dumps(warm, ensure_ascii=False).encode("utf-8")
    headers = {k: v for k, v in entry["headers"].items()
               if k.lower() != "content-length"}
    headers["content-type"] = "application/json"
    headers["accept-encoding"] = "identity"
    try:
        r = await core_mod._client.post(core_mod.UPSTREAM + entry["path"], headers=headers,
                               content=body)
    except Exception as e:
        return 502, {"ok": False, "session": session_id,
                     "reason": f"upstream error: {e}"}
    try:
        data = r.json()
    except Exception:
        data = {}
    u = data.get("usage") or {}
    usage = {"input_tokens": u.get("input_tokens"),
             "output_tokens": u.get("output_tokens"),
             "cache_read_input_tokens": u.get("cache_read_input_tokens"),
             "cache_creation_input_tokens": u.get("cache_creation_input_tokens")}
    ok = r.status_code == 200
    res = {"ok": ok, "warmed": ok, "session": session_id,
           "status_code": r.status_code, "prior_warmth": prior, "hash": h_full,
           "usage": usage, "request_id": r.headers.get("request-id")}
    if ok:
        rec = warmth_mod._record_warmth(warm, usage)   # refresh the ledger off this replay
        if rec:
            res["ttl_s"] = rec["ttl"]
            res["remaining_s"] = float(rec["ttl"])   # just stamped: full ttl left
        res["cache_read_input_tokens"] = usage.get("cache_read_input_tokens")
        res["cache_hit"] = bool((usage.get("cache_read_input_tokens") or 0) > 0)
    else:
        res["error"] = data or r.text[:500]
        if r.status_code == 401:
            _invalidate_stale_auth(session_id, entry.get("account"))
            res["auth_stale"] = True
    return (200 if ok else r.status_code), res


# --- session teardown + housekeeping sweep ------------------------------------
# Two complementary ways to stop persisting a finished session's cached state:
#   (1) EXPLICIT signal — `GET/POST /_end?session=<id>[&reason=clear]`, driven by
#       the CLI's SessionEnd hook (reason=clear / logout / exit / other). Precise,
#       but unreliable: a crash / `kill -9` / sleep never fires it.
#   (2) HOUSEKEEPING sweep — with the SQLite ledger, EXPIRY IS ENFORCED BY THE
#       READ PREDICATE, so this thread is hygiene only: drop in-memory cached
#       last-requests whose prefix lapsed past the grace (memory + credential
#       lifetime), purge long-expired warmth rows (disk space), prune stale
#       session heads. It may run late or never without changing ANY gate
#       decision — unlike the old in-memory sweeper, whose deletions were
#       semantic and erased cold evidence at bare ttl.
WARMTH_SWEEP_INTERVAL = int(os.environ.get("WARMTH_SWEEP_INTERVAL", "300"))
_LAST_REQUEST_GRACE = int(os.environ.get("WARMTH_LAST_REQUEST_GRACE", "600"))
# How long an EXPIRED row stays on disk before the purge removes it. Pure
# observability slack (lets logs/tests still see 'cold' vs 'absent'); decisions
# never depend on it.
_WARMTH_PURGE_SLACK = int(os.environ.get("WARMTH_PURGE_SLACK", str(7 * 86400)))


def _end_session(session_id, reason="unspecified"):
    """SessionEnd MARKER (2026-06-11 redesign; was a hard delete). A /clear or
    CLI exit marks the session ended instead of erasing its runtime state — a
    one-shot `claude -p` fires SessionEnd the moment its answer lands, and the
    old instant teardown destroyed exactly the post-mortem debug state
    (/_session view, context stats, last answer) those runs need. Ended is a
    durable fact in session_meta (a session can always be --resume'd; a live
    turn clears the mark). The HOLD is still disarmed immediately (never spend
    autonomously on an ended session); everything else stays until the
    staleness sweeper reaps it like any idle session's state. Idempotent."""
    now = time.time()
    with hold_mod._HOLD_LOCK:
        dropped_hold = hold_mod._HOLD_STATE.pop(session_id, None) is not None
    with _LAST_REQUEST_LOCK:
        has_lr = session_id in _LAST_REQUEST
    known = (has_lr or session_id in meta_mod._CONTEXT_STATS
             or session_id in billing_mod._SESSION_TOTALS or session_id in meta_mod._ENDED)
    marked = False
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM hold_state WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            # UPDATE, not upsert: the hook fires for unproxied sessions too —
            # never invent identity rows for sessions this proxy never saw.
            cur = con.execute(
                "UPDATE session_meta SET ended_at=?, end_reason=?, last_seen=? "
                "WHERE session_id=?", (now, reason, now, session_id))
            if cur.rowcount == 0:   # meta-less but head-indexed = still ours
                known = known or bool(con.execute(
                    "SELECT 1 FROM session_head WHERE session_id=?",
                    (session_id,)).fetchone())
            con.commit()
            marked = cur.rowcount > 0
    except Exception:
        pass
    if marked or known:
        meta_mod._ENDED[session_id] = {"ts": now, "reason": reason}
        marked = True
    return {"ok": True, "session": session_id, "reason": reason,
            "ended": marked, "hold_disarmed": dropped_hold,
            "retained": {"last_request": has_lr,
                         "context": session_id in meta_mod._CONTEXT_STATS},
            "remaining_sessions": len(_LAST_REQUEST)}


def _clear_session_ended(session_id):
    """A live turn on an ended session = a resume: drop the marker (memory +
    durable column). Cheap no-op for the common (never-ended) case."""
    if session_id not in meta_mod._ENDED:
        return False
    meta_mod._ENDED.pop(session_id, None)
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("UPDATE session_meta SET ended_at=NULL, end_reason=NULL "
                        "WHERE session_id=?", (session_id,))
            con.commit()
    except Exception:
        pass
    print(f"[end] session={session_id[:12]}… RESUMED — ended marker cleared",
          flush=True)
    return True


def _prefix_age_ttl(entry, now):
    """(seconds since the prefix was last cached, ttl) for a cached request,
    consulting the warmth store — which a /_ping REFRESHES — so an actively
    kept-warm session is judged by its last ping, not its original turn. Falls
    back to the entry's own timestamp + 1h when the store has no record."""
    obj = entry["obj"]
    msgs = obj.get("messages") or []
    if msgs:
        try:
            h = warmth_mod._prefix_hash(obj, len(msgs))
            r = warmth_mod._warmth_rows([h]).get(h)
            if r:
                return now - r[0], r[1]
        except Exception:
            pass
    return now - entry["ts"], 3600


def _sweep_state(now=None):
    """Housekeeping only (see section comment): correctness lives in the read
    predicate, never in these deletions. Lock order LAST_REQUEST -> DB."""
    now = now or time.time()
    with _LAST_REQUEST_LOCK:
        stale = [sid for sid, e in _LAST_REQUEST.items()
                 if (lambda a, t: a > t + _LAST_REQUEST_GRACE)(*_prefix_age_ttl(e, now))]
        for sid in stale:
            _LAST_REQUEST.pop(sid, None)
    # lazy import: transforms is a heavier module, not needed at boot here; the
    # sweep is a cross-cutting teardown (like the meta_mod pops below) so reaching
    # into transforms' own sticky store for hygiene is consistent.
    from proxylab import transforms as _transforms_mod
    from proxylab import fold as _fold_mod
    for sid in stale:
        # companion debug state rides the same staleness verdict (since the
        # /_end redesign nothing else deletes it; ended markers + session_meta
        # identity stay — they're durable facts, not runtime state)
        meta_mod._CONTEXT_STATS.pop(sid, None)
        meta_mod._LAST_RESPONSE.pop(sid, None)
        meta_mod._LAST_USAGE.pop(sid, None)
        meta_mod._SUBAGENTS.pop(sid, None)
        meta_mod._SUBAGENT_LAST_REQ.pop(sid, None)
        _transforms_mod._ws_forget(sid)   # sticky wirescope spawn memory
        _transforms_mod._marker_state_forget(sid)   # owned-marker anchor memory
        _fold_mod._forget(sid)            # fold maps + override
        meta_mod.writer_mod._forget_session_fp(sid)   # main-line fingerprint
    purged = heads = lr_aged = busts = 0
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            purged = con.execute("DELETE FROM warmth WHERE expires_at < ?",
                                 (now - _WARMTH_PURGE_SLACK,)).rowcount
            heads = con.execute("DELETE FROM session_head WHERE updated_at < ?",
                                (now - _WARMTH_PURGE_SLACK,)).rowcount
            # keep the last_request mirror in step with the in-memory drop —
            # otherwise the next restart resurrects entries the sweep already
            # judged stale (ts-based deletes would be wrong here: a row's ts is
            # the original turn, but an actively-pinged session stays fresh via
            # the ledger, which is what the in-memory predicate consulted).
            if stale:
                con.executemany(
                    "DELETE FROM last_request WHERE owner=? AND session_id=?",
                    [(store_mod.OWNER, s) for s in stale])
            # DEAD-OWNER debris (2026-07-19): the mirror delete above only ever
            # tracks THIS owner's in-memory drops, so rows from a LOG_DIR that
            # never boots again (scratch arms, A/B runs) are unreachable by any
            # purge and accrete full request bodies forever. Age on ts IS safe
            # at purge-slack scale, despite the mirror comment above: pings can
            # keep a prefix warm at most ~13h past its last organic turn (12h
            # hold cap + 1h TTL), and ts is that turn — 7d-old rows are cold
            # for every owner, live or dead. A live owner's in-memory entry is
            # unaffected (its next persist re-inserts). session_bust rides the
            # same age purge: the sweeper reaps session_head but used to orphan
            # its bust pair; last_ts is stamped on every upsert.
            lr_aged = con.execute("DELETE FROM last_request WHERE ts < ?",
                                  (now - _WARMTH_PURGE_SLACK,)).rowcount
            busts = con.execute(
                "DELETE FROM session_bust WHERE COALESCE(last_ts, 0) < ?",
                (now - _WARMTH_PURGE_SLACK,)).rowcount
            con.commit()
    except Exception:
        pass
    return {"last_request_dropped": len(stale), "warmth_purged": purged,
            "session_heads_dropped": heads, "last_request_aged": lr_aged,
            "session_busts_dropped": busts,
            "last_request_size": len(_LAST_REQUEST)}


def _sweeper_loop():
    while True:
        time.sleep(max(30, WARMTH_SWEEP_INTERVAL))
        try:
            res = _sweep_state()
            if (res["last_request_dropped"] or res["warmth_purged"]
                    or res["session_heads_dropped"] or res["last_request_aged"]
                    or res["session_busts_dropped"]):
                print(f"[sweep] dropped lr={res['last_request_dropped']} "
                      f"purged={res['warmth_purged']} heads={res['session_heads_dropped']} "
                      f"aged_lr={res['last_request_aged']} busts={res['session_busts_dropped']} "
                      f"(lr={res['last_request_size']})", flush=True)
        except Exception:
            pass


if WARMTH_PINGER or warmth_mod.WARMTH_LEDGER:
    threading.Thread(target=_sweeper_loop, name="warmthsweeper", daemon=True).start()
