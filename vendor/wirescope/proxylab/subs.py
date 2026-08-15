import asyncio
import fnmatch
import json
import os
import threading
import time
import uuid
from urllib.parse import urlparse

import httpx
from starlette.responses import Response

from proxylab import codex as codex_mod
from proxylab import quota as quota_mod
from proxylab import store as store_mod
from proxylab import warmth as warmth_mod

# --- SUBSCRIBERS (on by default; active only for /agent/ routes) --------------
# Generic, app-agnostic push feed: any local app registers an endpoint
# (POST /_subscribe) and receives events for the agent sessions it owns —
# streaming assistant text (text.delta), per-request receipts with usage/
# cost/warmth (turn.completed), and session teardown (session.ended).
# Protocol contract: SUBSCRIBERS.md (hand that file to consumers).
#
# This is the agnostic successor to the wb intent tee: the proxy ships
# normalized text + wire receipts; intent grammars ([wb:…], [cli:…]) are the
# consumer's to parse. Delivery is at-most-once fire-and-forget on an
# isolated short-timeout client — a dead subscriber never blocks or fails
# client-bound bytes. Durable truth stays pull (/_status); push is liveness.
#
#   SUBSCRIBERS              default on; 0/empty disables the subsystem
#   SUBSCRIBERS_ALLOW_REMOTE default off: callback URLs must be loopback
#                            (a registration endpoint that POSTs response
#                            text to arbitrary URLs is an exfil primitive)
#   SUBSCRIBERS_TOKEN        if set, /_subscribe requires this bearer
#   SUBSCRIBERS_DELTA_MS     text.delta coalescing window (default 300)
#   SUBSCRIBERS_MAX_FAILURES consecutive failures before suspension (10)
SUBSCRIBERS = os.environ.get("SUBSCRIBERS", "1") not in ("", "0")
SUBSCRIBERS_ALLOW_REMOTE = os.environ.get("SUBSCRIBERS_ALLOW_REMOTE", "0") not in ("", "0")
SUBSCRIBERS_TOKEN = os.environ.get("SUBSCRIBERS_TOKEN", "")
SUBSCRIBERS_DELTA_MS = int(os.environ.get("SUBSCRIBERS_DELTA_MS", "300") or 300)
SUBSCRIBERS_MAX_FAILURES = int(os.environ.get("SUBSCRIBERS_MAX_FAILURES", "10") or 10)

_EVENT_TYPES = ("text.delta", "turn.completed", "session.ended")

_SUBS_LOCK = threading.Lock()
_SUBS = {}              # url -> subscriber record (the registry of truth)
_STATS = {"delivered": 0, "failed": 0, "suspensions": 0, "dropped_no_loop": 0}
_SESSION_AGENT = {}     # session_id -> agent name (for session.ended routing;
                        # in-memory: best-effort across restarts, by design)

# Isolated short-timeout client (same isolation discipline as the wb tee): a
# slow subscriber endpoint must never stall a streaming forward.
_sub_client = httpx.AsyncClient(timeout=httpx.Timeout(5.0), follow_redirects=False)


# --- persistence (this module's table; see proxylab.store ownership rule) -----
# Owner-scoped registrations. The callback token persists too — it is the
# SUBSCRIBER's shared secret for its own endpoint, not an Anthropic credential
# (those never persist, standing rule). Documented in SUBSCRIBERS.md.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS subscribers ("
    "owner TEXT NOT NULL, url TEXT NOT NULL, id TEXT NOT NULL, "
    "name TEXT, token TEXT, agents TEXT NOT NULL, "
    "events TEXT NOT NULL, created_at REAL NOT NULL, "
    "suspended INTEGER NOT NULL DEFAULT 0, "
    "PRIMARY KEY (owner, url))")


def _persist(sub):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("INSERT OR REPLACE INTO subscribers "
                        "(owner, url, id, name, token, agents, events, created_at, suspended) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (store_mod.OWNER, sub["url"], sub["id"], sub.get("name"),
                         sub.get("token") or "", json.dumps(sub["agents"]),
                         json.dumps(sub["events"]), sub["created_at"],
                         1 if sub.get("suspended") else 0))
            con.commit()
    except Exception as e:
        print(f"[subs] persist failed for {sub.get('url')}: {e}", flush=True)


def _unpersist(url):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM subscribers WHERE owner=? AND url=?",
                        (store_mod.OWNER, url))
            con.commit()
    except Exception as e:
        print(f"[subs] unpersist failed for {url}: {e}", flush=True)


def _load_subscribers():
    """Reload registrations at startup (restart-amnesia discipline: a proxy
    restart must not silently unsubscribe every consumer)."""
    if not SUBSCRIBERS:
        return 0
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT url, id, name, token, agents, events, created_at, suspended "
                "FROM subscribers WHERE owner=?", (store_mod.OWNER,)).fetchall()
    except Exception as e:
        print(f"[subs] load failed: {e}", flush=True)
        return 0
    with _SUBS_LOCK:
        for (url, sid, name, token, agents, events, created_at, suspended) in rows:
            _SUBS[url] = {"id": sid, "url": url, "name": name,
                          "token": token or "", "agents": json.loads(agents),
                          "events": json.loads(events), "created_at": created_at,
                          "suspended": bool(suspended), "failures": 0,
                          "delivered": 0, "failed": 0}
    if rows:
        print(f"[subs] restored {len(rows)} subscriber(s)", flush=True)
    return len(rows)


# --- registry ------------------------------------------------------------------
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _validate(payload):
    """Returns (error_string | None, normalized record fields)."""
    if not isinstance(payload, dict):
        return "body must be a JSON object", None
    url = payload.get("url")
    if not isinstance(url, str) or not url:
        return "missing url", None
    try:
        p = urlparse(url)
    except Exception:
        return "unparseable url", None
    if p.scheme not in ("http", "https") or not p.hostname:
        return "url must be http(s)", None
    if not SUBSCRIBERS_ALLOW_REMOTE and p.hostname not in _LOOPBACK_HOSTS:
        return ("callback url must be loopback "
                "(SUBSCRIBERS_ALLOW_REMOTE=1 lifts this)"), None
    agents = payload.get("agents")
    if (not isinstance(agents, list) or not agents
            or not all(isinstance(a, str) and a for a in agents)):
        return "agents must be a non-empty list of glob strings", None
    events = payload.get("events")
    if (not isinstance(events, list) or not events
            or not all(e in _EVENT_TYPES for e in events)):
        return f"events must be a non-empty subset of {list(_EVENT_TYPES)}", None
    name = payload.get("name")
    token = payload.get("token")
    if name is not None and not isinstance(name, str):
        return "name must be a string", None
    if token is not None and not isinstance(token, str):
        return "token must be a string", None
    return None, {"url": url, "agents": agents, "events": events,
                  "name": name, "token": token or ""}


def subscribe(payload):
    """Upsert by url; reactivates a suspended subscription. (code, body)."""
    err, fields = _validate(payload)
    if err:
        return 400, {"ok": False, "error": err}
    with _SUBS_LOCK:
        old = _SUBS.get(fields["url"])
        sub = {"id": old["id"] if old else uuid.uuid4().hex[:12],
               "created_at": old["created_at"] if old else time.time(),
               "suspended": False, "failures": 0,
               "delivered": old["delivered"] if old else 0,
               "failed": old["failed"] if old else 0,
               **fields}
        _SUBS[sub["url"]] = sub
    _persist(sub)
    print(f"[subs] registered {sub['name'] or sub['id']} -> {sub['url']} "
          f"agents={sub['agents']} events={sub['events']}", flush=True)
    return 200, {"ok": True, **_redact(sub)}


def unsubscribe(url=None, sub_id=None):
    with _SUBS_LOCK:
        key = url if url in _SUBS else next(
            (u for u, s in _SUBS.items() if sub_id and s["id"] == sub_id), None)
        sub = _SUBS.pop(key, None) if key else None
    if sub:
        _unpersist(sub["url"])
        print(f"[subs] removed {sub['name'] or sub['id']} ({sub['url']})", flush=True)
    return sub is not None


def _redact(sub):
    out = {k: v for k, v in sub.items() if k != "token"}
    out["has_token"] = bool(sub.get("token"))
    return out


def list_subscribers():
    with _SUBS_LOCK:
        return [_redact(s) for s in _SUBS.values()]


def _stats():
    with _SUBS_LOCK:
        return {"enabled": SUBSCRIBERS, "count": len(_SUBS),
                "suspended": sum(1 for s in _SUBS.values() if s["suspended"]),
                **_STATS}


def _match(agent, event):
    """Active subscribers for (agent, event). Plain (non-/agent/) traffic uses
    agent='ext' and is never pushed — the call sites only invoke this for
    route-identified requests, and the guard here makes that structural."""
    if not SUBSCRIBERS or not agent or agent == "ext":
        return []
    with _SUBS_LOCK:
        # fnmatchCASE: plain fnmatch case-normalizes per-platform (lowercases
        # on Windows) — namespace routing must not depend on the host OS.
        return [s for s in _SUBS.values()
                if not s["suspended"] and event in s["events"]
                and any(fnmatch.fnmatchcase(agent, pat) for pat in s["agents"])]


# --- delivery --------------------------------------------------------------------
async def _deliver(sub, envelope):
    headers = {"Content-Type": "application/json",
               "X-Wirescope-Event": envelope["event"]}
    if sub.get("token"):
        headers["Authorization"] = f"Bearer {sub['token']}"
    ok = False
    try:
        resp = await _sub_client.post(sub["url"], json=envelope, headers=headers)
        ok = 200 <= resp.status_code < 300
        if not ok:
            print(f"[subs] {sub['name'] or sub['id']} {envelope['event']} "
                  f"-> {resp.status_code} {resp.text[:200]}", flush=True)
    except Exception as e:
        print(f"[subs] {sub['name'] or sub['id']} {envelope['event']} failed: {e}",
              flush=True)
    with _SUBS_LOCK:
        live = _SUBS.get(sub["url"])
        if live is None:                     # unsubscribed mid-flight
            return
        if ok:
            _STATS["delivered"] += 1
            live["delivered"] += 1
            live["failures"] = 0
            return
        _STATS["failed"] += 1
        live["failed"] += 1
        live["failures"] += 1
        suspend = (not live["suspended"]
                   and live["failures"] >= SUBSCRIBERS_MAX_FAILURES)
        if suspend:
            live["suspended"] = True
            _STATS["suspensions"] += 1
            snapshot = dict(live)
    if not ok and suspend:
        _persist(snapshot)
        print(f"[subs] SUSPENDED {snapshot['name'] or snapshot['id']} after "
              f"{snapshot['failures']} consecutive failures; re-POST /_subscribe "
              "to reactivate", flush=True)


def dispatch(event, agent, session_id, request_id, data, subs=None):
    """Fan one event out to matching subscribers, fire-and-forget. Must run on
    the event loop (handler/body_iter do); off-loop calls drop + count."""
    subs = _match(agent, event) if subs is None else subs
    if not subs:
        return 0
    envelope = {"v": 1, "event": event, "agent": agent,
                "session_id": session_id, "request_id": request_id,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "data": data}
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        _STATS["dropped_no_loop"] += len(subs)
        return 0
    for sub in subs:
        asyncio.create_task(_deliver(sub, envelope))
    return len(subs)


# --- the per-request text tee -----------------------------------------------------
def note_session(agent, session_id):
    """session->agent for session.ended routing; called for every agent-routed
    model request regardless of current subscriptions (a subscriber that
    registers mid-session still gets the teardown event)."""
    if session_id and agent and agent != "ext":
        _SESSION_AGENT[session_id] = agent


def _tee_for(agent, session_id, request_id, wire="anthropic"):
    """A _SubTee when anyone wants this request's text (delta subscribers need
    the stream; turn.completed subscribers need the full accumulated text —
    the capture meta caps text at _META_TEXT_CAP, the tee doesn't). None when
    nobody is listening, so the forward path pays nothing."""
    note_session(agent, session_id)
    if not (_match(agent, "text.delta") or _match(agent, "turn.completed")):
        return None
    return _SubTee(agent, session_id, request_id, wire=wire)


class _SubTee:
    """Incremental SSE -> normalized-text events, provider-agnostic (same SSE
    framing + dialect decode the wb tee uses). Coalesces text.delta flushes to
    ~SUBSCRIBERS_DELTA_MS; offsets make reassembly order-independent. Always
    accumulates the full turn text for turn.completed."""

    def __init__(self, agent, session_id, request_id, wire="anthropic"):
        self.agent = agent
        self.session_id = session_id
        self.request_id = request_id
        self.wire = wire
        self.provider = "openai" if wire == "openai" else "anthropic"
        self.buf = bytearray()      # undecoded SSE bytes
        self.text = ""              # accumulated assistant text (full turn)
        self.sent_offset = 0
        self._last_flush = time.monotonic()
        self._closed = False

    def feed(self, chunk):
        if not chunk or self._closed:
            return
        self.buf.extend(chunk)
        while True:
            i_lf = self.buf.find(b"\n\n")
            i_crlf = self.buf.find(b"\r\n\r\n")
            if i_crlf != -1 and (i_lf == -1 or i_crlf < i_lf):
                cut, blen = i_crlf, 4
            elif i_lf != -1:
                cut, blen = i_lf, 2
            else:
                break
            raw = bytes(self.buf[:cut]).decode("utf-8", "replace")
            del self.buf[:cut + blen]
            data_lines = [ln[5:].lstrip() for ln in raw.split("\n")
                          if ln.startswith("data:")]
            if not data_lines:
                continue
            try:
                obj = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                continue                 # incl. openai's bare "data: [DONE]"
            t = codex_mod._sse_text_delta(obj, self.wire)
            if t:
                self.text += t
        if (len(self.text) > self.sent_offset
                and (time.monotonic() - self._last_flush) * 1000 >= SUBSCRIBERS_DELTA_MS):
            self._flush()

    def _flush(self):
        chunk, offset = self.text[self.sent_offset:], self.sent_offset
        self.sent_offset = len(self.text)
        self._last_flush = time.monotonic()
        dispatch("text.delta", self.agent, self.session_id, self.request_id,
                 {"provider": self.provider, "text": chunk, "offset": offset})

    def close(self):
        """Stream end — flush the tail. Runs from body_iter's finally, so it
        fires even when the upstream connection drops mid-stream."""
        if self._closed:
            return
        self._closed = True
        if len(self.text) > self.sent_offset:
            self._flush()


# --- turn.completed assembly ---------------------------------------------------
def _hints_receipt(session_id):
    """Tail-hint attribution for the turn.completed receipt: which hint ids rode
    the last request of this session, their sources, and the uncached token cost.
    Imported lazily — subs must not gain a hard dependency on the hints registry
    (a module creates only its own tables and knows only what it must)."""
    if not session_id:
        return None
    try:
        from . import hints as hints_mod
        log = hints_mod.last_injection(session_id)
    except Exception:
        return None
    if not log or not log.get("hint_ids"):
        return None
    return {"hint_ids": log["hint_ids"], "sources": log.get("sources"),
            "chars": log.get("chars"), "est_tokens": log.get("est_tokens"),
            "mode": log.get("mode"), "uncached": True,
            "placement": hints_mod.placement_report(session_id)}


def emit_turn_completed_anthropic(agent, session_id, request_id, *, meta, bill,
                                  stop, status_code, text, role, title_call,
                                  session_totals, context):
    subs = _match(agent, "turn.completed")
    if not subs:
        return 0
    totals = None
    if session_totals:
        totals = {k: session_totals.get(k) for k in
                  ("requests", "turns", "refusals", "input_tokens",
                   "output_tokens", "cache_read_tokens", "cache_write_tokens",
                   "est_usd")}
    warm = None
    if session_id:
        try:
            w = warmth_mod.warmth_query(session=session_id)
            warm = {"warm": w.get("warm"), "ttl_s": w.get("ttl_s"),
                    "remaining_s": w.get("remaining_s")}
        except Exception:
            pass
    ctx = ({k: context.get(k) for k in
            ("turns_in_context", "n_messages", "max_tool_result_chars")}
           if context else None)
    data = {"provider": "anthropic",
            "model": bill.get("model"),
            "status_code": status_code,
            "anthropic_request_id": stop.get("request_id"),
            "message_id": meta.get("message_id"),
            "stop_reason": stop.get("stop_reason"),
            "stop_details": stop.get("stop_details"),
            "refusal": stop.get("stop_reason") == "refusal",
            "turn_end": bool(stop.get("is_turn")),
            "role": role,
            "title_call": bool(title_call),
            "text": text or "",
            "tool_uses": meta.get("tool_uses") or [],
            "usage": bill.get("tokens"),
            "cost": {"est_usd": bill.get("est_usd"),
                     "unpriced": bool(bill.get("unpriced"))},
            "session_totals": totals,
            "context": ctx,
            "warmth": warm,
            # What tail hints rode THIS request, and what they cost. Attribution
            # is a correctness property: a hint that changes behavior with no
            # record of firing makes the change unattributable. None when the
            # registry was empty (the resting case).
            "hints": _hints_receipt(session_id),
            # ACCOUNT plan quota as of this turn (the API reports it on the
            # response headers we just consumed). Account-scoped, so it's the
            # same for every agent — a consumer keeps ONE copy, not one per
            # session. None when the deployment isn't tracking it.
            "quota": quota_mod.receipt_view()}
    return dispatch("turn.completed", agent, session_id, request_id, data,
                    subs=subs)


def emit_turn_completed_openai(agent, session_id, request_id, *, meta,
                               status_code, text, bill=None,
                               session_totals=None):
    subs = _match(agent, "turn.completed")
    if not subs:
        return 0
    u = meta.get("usage") or {}
    usage = {"input_tokens": u.get("input_tokens"),
             "output_tokens": u.get("output_tokens"),
             "cached_tokens": (u.get("input_tokens_details") or {}).get("cached_tokens"),
             "reasoning_tokens": (u.get("output_tokens_details") or {}).get("reasoning_tokens")}
    totals = None
    if session_totals:
        totals = {k: session_totals.get(k) for k in
                  ("requests", "turns", "refusals", "input_tokens",
                   "output_tokens", "cache_read_tokens", "cache_write_tokens",
                   "est_usd")}
    data = {"provider": "openai",
            "model": meta.get("resolved_model"),
            "status_code": status_code,
            "response_id": meta.get("response_id"),
            "status": meta.get("status"),
            "text": text or "",
            "usage": usage,
            # API-EQUIVALENT estimate (PRICES_OPENAI): chatgpt-plan traffic is
            # never dollar-billed; this prices the same tokens at API rates.
            "cost": ({"est_usd": bill.get("est_usd"),
                      "unpriced": bool(bill.get("unpriced"))}
                     if bill else None),
            "session_totals": totals, "context": None,
            "warmth": None}
    return dispatch("turn.completed", agent, session_id, request_id, data,
                    subs=subs)


def emit_session_ended(session_id, reason):
    agent = _SESSION_AGENT.get(session_id)
    if not agent:
        return 0
    return dispatch("session.ended", agent, session_id, None,
                    {"reason": reason})


# --- HTTP endpoint (/_subscribe) -------------------------------------------------
async def handle_subscribe(request):
    if SUBSCRIBERS_TOKEN:
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {SUBSCRIBERS_TOKEN}":
            return Response(json.dumps({"ok": False, "error": "bad bearer"}),
                            status_code=401, media_type="application/json")
    if not SUBSCRIBERS:
        return Response(json.dumps({"ok": False, "error": "SUBSCRIBERS=0"}),
                        status_code=503, media_type="application/json")
    if request.method == "GET":
        return Response(json.dumps({"subscribers": list_subscribers()}, indent=2),
                        media_type="application/json")
    if request.method == "DELETE":
        q = request.query_params
        removed = unsubscribe(url=q.get("url"), sub_id=q.get("id"))
        return Response(json.dumps({"ok": removed,
                                    "removed": removed}),
                        status_code=200 if removed else 404,
                        media_type="application/json")
    if request.method == "POST":
        try:
            payload = json.loads(await request.body())
        except Exception:
            return Response(json.dumps({"ok": False, "error": "invalid JSON body"}),
                            status_code=400, media_type="application/json")
        code, body = subscribe(payload)
        return Response(json.dumps(body), status_code=code,
                        media_type="application/json")
    return Response(json.dumps({"ok": False, "error": "method not allowed"}),
                    status_code=405, media_type="application/json")


_load_subscribers()
