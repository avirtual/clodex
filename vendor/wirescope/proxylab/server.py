import asyncio
import atexit
import collections
import contextlib
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
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket

from proxylab import billing as billing_mod
from proxylab import canary as canary_mod
from proxylab import codex as codex_mod
from proxylab import core as core_mod
from proxylab import fold as fold_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import pinger as pinger_mod
from proxylab import prune as prune_mod
from proxylab import receipts as receipts_mod
from proxylab import report as report_mod
from proxylab import restore as restore_mod
from proxylab import status as status_mod
from proxylab import subs as subs_mod
from proxylab import transforms as transforms_mod
from proxylab import views as views_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

def _record_openai_context(obj, *, session_id, base_path, upstream_path,
                           agent, model):
    """Record Codex request metadata used by /_status, /_admin, and /_session.

    Shared by the HTTP/SSE and WebSocket transports so the provider-specific
    session behavior stays identical whichever wire Codex chooses.
    """
    if not (session_id and isinstance(obj, dict)
            and base_path.rstrip("/").endswith(("/responses",
                                                "/chat/completions"))):
        return
    pinger_mod._clear_session_ended(session_id)   # live turn = resume
    # /_session context view (NOT replayable — pinger declines openai)
    pinger_mod._cache_last_request_openai(session_id, obj, upstream_path)
    fields = {"model": model, "agent": agent}
    try:
        inp = obj.get("input") or []
        texts = [c.get("text") or "" for it in inp if isinstance(it, dict)
                 for c in (it.get("content") or [])
                 if isinstance(c, dict)]
        joined = "\n".join(texts)
        mcwd = re.search(r"<cwd>([^<]+)</cwd>", joined)
        if mcwd:
            fields["cwd"] = mcwd.group(1)
        prompts = [tx for it in inp if isinstance(it, dict)
                   and it.get("role") == "user"
                   for c in (it.get("content") or []) if isinstance(c, dict)
                   for tx in [c.get("text") or ""]
                   if tx and not tx.lstrip().startswith("<")]
        if prompts:
            fields["title"] = prompts[0].strip().splitlines()[0][:80]
    except Exception:
        pass
    writer_mod._enqueue_meta(session_id, **fields)


async def _handle_openai(request: Request, n, raw, agent, upstream_path, ts):
    """The /agent/<name>/openai/... path: forward to UPSTREAM_OPENAI with the
    chatgpt-backend rewrite, capture request+response, tee subscribers, price
    the receipts (API-equivalent). Deliberately NO transform/warmth/canary
    machinery — see the OPENAI/CODEX PROVIDER block up top."""
    base_path = upstream_path.split("?")[0]
    chatgpt_mode = codex_mod._is_chatgpt_backend(codex_mod.UPSTREAM_OPENAI)
    codex_mod._CODEX_STATS["requests"] += 1

    # ---- observer-side decode + parse (forward the ORIGINAL bytes) ----
    body_bytes, dec_err = codex_mod._content_decode(
        raw, request.headers.get("content-encoding"))
    obj = None
    try:
        obj = json.loads(body_bytes) if body_bytes else {}
    except Exception:
        pass
    model = (obj or {}).get("model")
    # codex carries session identity in HEADERS (plus prompt_cache_key in-body)
    session_id = (request.headers.get("session-id")
                  or request.headers.get("thread-id")
                  or (obj or {}).get("prompt_cache_key"))
    session_key = session_id or writer_mod.NO_SESSION
    out_dir = core_mod.LOG_DIR / session_key
    stem = f"{n:03d}-{agent}-codex-{writer_mod._short_model(model)}-{ts}"

    client = request.client
    record = {"seq": n, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "agent": agent, "provider": "openai",
              "method": request.method, "path": upstream_path,
              "client": {"host": client.host, "port": client.port} if client else None,
              "request_headers": core_mod._safe_headers(request.headers)}
    if dec_err:
        record["decode_error"] = dec_err
    if isinstance(obj, dict):
        record["body"] = obj
        inp = obj.get("input") or []
        record["summary"] = {
            "model": model, "session_id": session_id,
            "instructions_chars": len(obj.get("instructions") or ""),
            "n_input": len(inp) if isinstance(inp, list) else None,
            "n_tools": len(obj.get("tools") or []),
            "tool_names": [t.get("name") or t.get("type")
                           for t in (obj.get("tools") or [])
                           if isinstance(t, dict)],
            "reasoning": obj.get("reasoning"),
            "prompt_cache_key": obj.get("prompt_cache_key"),
            "store": obj.get("store"), "stream": obj.get("stream"),
        }
        _record_openai_context(obj, session_id=session_id, base_path=base_path,
                               upstream_path=upstream_path, agent=agent,
                               model=model)
    elif raw:
        record["body_raw"] = body_bytes.decode("utf-8", "replace")[:4000]
    writer_mod._enqueue_json(out_dir / f"{stem}.request.json", record)

    # ---- /v1/models stub (chatgpt backend has no platform model list) ----
    if chatgpt_mode and base_path.rstrip("/").endswith("/models"):
        out = {"models": [{"id": mid, "object": "model",
                           "created": int(time.time()), "owned_by": "openai"}
                          for mid in codex_mod.CODEX_MODELS_STUB],
               "object": "list"}
        writer_mod._enqueue_json(out_dir / f"{stem}.response.json",
                      {"seq": n, "agent": agent, "provider": "openai",
                       "endpoint": "models", "status_code": 200,
                       "stub": True, "body": out})
        return Response(json.dumps(out), media_type="application/json")

    # ---- forward (original bytes; auth rewritten for the chatgpt backend) ----
    fwd_headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in core_mod._HOP}
    fwd_headers["accept-encoding"] = "identity"   # readable SSE for the capture
    up_path = upstream_path
    if chatgpt_mode:
        up_path, fwd_headers = codex_mod._rewrite_chatgpt_request(up_path, fwd_headers)
    req = core_mod._client.build_request(request.method, codex_mod.UPSTREAM_OPENAI + up_path,
                                headers=fwd_headers, content=raw)
    up = await core_mod._client.send(req, stream=True)
    resp_headers = {k: v for k, v in up.headers.items()
                    if k.lower() not in {"connection", "transfer-encoding",
                                         "content-length", "keep-alive"}}
    # POST /responses|/chat/completions IS the model wire — capture + tee it
    # path-based, never content-type-based (success can ship with NO
    # content-type header at all on the chatgpt backend)
    is_model_call = (request.method == "POST"
                     and base_path.rstrip("/").endswith(("/responses",
                                                         "/chat/completions")))
    chunks = []
    # Generic subscriber tee (SUBSCRIBERS.md); every request here is /agent/-
    # routed by construction, so the agent identity gate is the route itself.
    sub_tee = (subs_mod._tee_for(agent, session_id, f"{n}-{ts}", wire="openai")
               if is_model_call else None)

    async def body_iter():
        try:
            async for chunk in up.aiter_raw():
                if is_model_call:
                    chunks.append(chunk)
                yield chunk
                if sub_tee is not None:  # after yield: client bytes come first
                    sub_tee.feed(chunk)
        finally:
            if sub_tee is not None:
                sub_tee.close()
            await up.aclose()
            if is_model_call and chunks:
                blob = b"".join(chunks)
                writer_mod._enqueue_bytes(out_dir / f"{stem}.response.sse", blob)
                # everything derived from the finished response — billing,
                # view state, capture, subscriber receipt — lives in receipts
                receipts_mod.openai(
                    blob, n=n, ts=ts, agent=agent, model=model,
                    session_id=session_id, session_key=session_key,
                    out_dir=out_dir, stem=stem, status_code=up.status_code,
                    resp_headers=dict(up.headers),
                    tee_text=(sub_tee.text if sub_tee is not None else None))

    return StreamingResponse(body_iter(), status_code=up.status_code,
                             headers=resp_headers,
                             media_type=up.headers.get("content-type"))


def _upstream_websocket_url(base_url, upstream_path):
    """Convert an HTTP(S) upstream base + path to a WS(S) endpoint."""
    if base_url.startswith("https://"):
        return "wss://" + base_url[len("https://"):].rstrip("/") + upstream_path
    if base_url.startswith("http://"):
        return "ws://" + base_url[len("http://"):].rstrip("/") + upstream_path
    return base_url.rstrip("/") + upstream_path


def _websocket_forward_headers(headers):
    """Headers safe to pass as additional headers on a fresh WS handshake."""
    blocked = set(core_mod._HOP) | {
        "accept-encoding", "connection", "host", "sec-websocket-accept",
        "sec-websocket-extensions", "sec-websocket-key", "sec-websocket-protocol",
        "sec-websocket-version", "upgrade",
    }
    return {k: v for k, v in headers.items() if k.lower() not in blocked}


def _websocket_sendable_close_code(code, fallback=1000):
    """Return a WebSocket close code legal to send on the wire.

    ASGI/websockets can report synthetic close codes such as 1005/1006/1015.
    Those are diagnostic values only; sending them in a close frame raises
    ProtocolError and turns an otherwise successful tunnel into a noisy relay
    failure.
    """
    try:
        code = int(code)
    except (TypeError, ValueError):
        return fallback
    if code in {1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011,
                1012, 1013, 1014}:
        return code
    if 3000 <= code <= 4999:
        return code
    return fallback


def _websocket_close_reason(reason, fallback=""):
    """Return a close reason that fits the 123-byte WebSocket limit."""
    reason = fallback if reason is None else str(reason)
    raw = reason.encode("utf-8")
    if len(raw) <= 123:
        return reason
    return raw[:123].decode("utf-8", "ignore")


async def _websockets_connect(url, headers, subprotocols=None, user_agent=None):
    """websockets.connect compatibility shim across 10.x-15.x keyword names."""
    try:
        import websockets
    except Exception as e:  # pragma: no cover - dependency/runtime guard
        raise RuntimeError(
            "WebSocket proxy support requires the 'websockets' package; "
            "install from requirements.txt"
        ) from e
    kwargs = {"subprotocols": subprotocols or None, "open_timeout": 5,
              "ping_interval": None}
    if user_agent is not None:
        kwargs["user_agent_header"] = user_agent
    try:
        return await websockets.connect(url, additional_headers=headers, **kwargs)
    except TypeError:
        kwargs.pop("user_agent_header", None)  # websockets<14 used extra_headers only
        return await websockets.connect(url, extra_headers=headers, **kwargs)


async def websocket_handler(websocket: WebSocket):
    """Tunnel Codex /responses WebSockets to the OpenAI/ChatGPT upstream.

    HTTP/SSE remains the canonical captured path. This WS path is deliberately a
    transparent tunnel with lightweight frame capture so Codex clients that try
    WS first do not fall through as HTTP GET /responses and produce noisy 405s.
    """
    path = websocket.url.path
    mo = codex_mod._ROUTE_OPENAI.match(path)
    if not mo:
        await websocket.close(code=1008)
        return

    n = next(core_mod._counter)
    ts = time.strftime("%H%M%S")
    agent = mo.group("name")
    upstream_path = mo.group("rest") or "/"
    if websocket.url.query:
        upstream_path += "?" + websocket.url.query
    base_path = upstream_path.split("?")[0]
    chatgpt_mode = codex_mod._is_chatgpt_backend(codex_mod.UPSTREAM_OPENAI)
    codex_mod._CODEX_STATS["requests"] += 1

    session_id = (websocket.headers.get("session-id")
                  or websocket.headers.get("thread-id"))
    session_key = session_id or writer_mod.NO_SESSION
    out_dir = core_mod.LOG_DIR / session_key
    stem = f"{n:03d}-{agent}-codex-ws-{ts}"
    client = websocket.client
    record = {"seq": n, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "agent": agent, "provider": "openai", "transport": "websocket",
              "method": "WEBSOCKET", "path": upstream_path,
              "client": {"host": client.host, "port": client.port} if client else None,
              "request_headers": core_mod._safe_headers(websocket.headers)}
    writer_mod._enqueue_json(out_dir / f"{stem}.request.json", record)

    fwd_headers = _websocket_forward_headers(websocket.headers)
    user_agent = fwd_headers.pop("user-agent", None)
    requested_subprotocols = [p.strip() for p in
                              (websocket.headers.get("sec-websocket-protocol") or "").split(",")
                              if p.strip()]
    up_path = upstream_path
    if chatgpt_mode:
        up_path, fwd_headers = codex_mod._rewrite_chatgpt_request(up_path, fwd_headers)
    upstream_url = _upstream_websocket_url(codex_mod.UPSTREAM_OPENAI, up_path)

    frames = []
    close_status = {"client": None, "upstream": None, "error": None}

    try:
        up = await _websockets_connect(upstream_url, fwd_headers,
                                       subprotocols=requested_subprotocols,
                                       user_agent=user_agent)
    except Exception as e:
        codex_mod._CODEX_STATS["errors"] += 1
        close_status["error"] = f"connect: {type(e).__name__}: {e}"
        writer_mod._enqueue_json(out_dir / f"{stem}.transport.json",
                     {"seq": n, "agent": agent, "provider": "openai",
                      "transport": "websocket", "endpoint": base_path,
                      "status": "connect_failed", "upstream_url": upstream_url,
                      "error": close_status["error"]})
        await websocket.close(code=1011)
        return

    await websocket.accept(subprotocol=getattr(up, "subprotocol", None))
    client_gone = {"value": False}
    # PER-TURN capture state. Codex 0.141 multiplexes the WHOLE conversation over
    # ONE long-lived WS connection (a response.create / response.completed pair per
    # turn), so capture MUST be per-RESPONSE, not once-per-connection — the original
    # latched on the first turn (model_seen / receipt_done set once) and silently
    # dropped every turn after it, leaving an active session looking uncaptured.
    # Each response.create opens a fresh turn (own seq+stem, own frame buffer); each
    # terminal event finalizes THAT turn and resets for the next. The connection
    # stem/n stay reserved for the handshake .request.json + transport.json.
    turn = {"n": None, "stem": None, "model": None, "frames": [], "open": False,
            "count": 0}

    def maybe_record_request_obj(data):
        try:
            obj = json.loads(data)
        except Exception:
            return
        if not isinstance(obj, dict) or obj.get("type") != "response.create":
            return
        turn["n"] = next(core_mod._counter)
        turn["stem"] = f"{turn['n']:03d}-{agent}-codex-ws-{time.strftime('%H%M%S')}"
        turn["model"] = obj.get("model")
        turn["frames"] = []
        turn["open"] = True
        turn["count"] += 1
        _record_openai_context(obj, session_id=session_id, base_path=base_path,
                               upstream_path=upstream_path, agent=agent,
                               model=turn["model"])
        writer_mod._enqueue_json(out_dir / f"{turn['stem']}.request.body.json", obj)

    def maybe_finalize_ws_receipt(data):
        if not turn["open"]:
            return
        try:
            obj = json.loads(data)
        except Exception:
            return
        if not isinstance(obj, dict) or obj.get("type") not in (
                "response.completed", "response.incomplete",
                "response.failed", "error"):
            return
        blob = "".join(f"data: {frame}\n\n" for frame in turn["frames"])
        raw = blob.encode("utf-8")
        writer_mod._enqueue_bytes(out_dir / f"{turn['stem']}.response.sse", raw)
        receipts_mod.openai(
            raw, n=turn["n"], ts=ts, agent=agent, model=turn["model"],
            session_id=session_id, session_key=session_key,
            out_dir=out_dir, stem=turn["stem"], status_code=200, resp_headers={})
        turn["open"] = False

    async def client_to_upstream():
        try:
            while True:
                msg = await websocket.receive()
                typ = msg.get("type")
                if typ == "websocket.disconnect":
                    client_gone["value"] = True
                    close_status["client"] = {"code": msg.get("code"),
                                               "reason": msg.get("reason")}
                    await up.close(
                        code=_websocket_sendable_close_code(msg.get("code"),
                                                            fallback=1001),
                        reason=_websocket_close_reason(
                            msg.get("reason"), fallback="client disconnected"),
                    )
                    break
                if "text" in msg:
                    data = msg["text"]
                    maybe_record_request_obj(data)
                    frames.append({"dir": "client", "type": "text",
                                   "bytes": len(data.encode("utf-8")),
                                   "preview": data[:1000]})
                    await up.send(data)
                elif "bytes" in msg:
                    data = msg["bytes"]
                    frames.append({"dir": "client", "type": "bytes",
                                   "bytes": len(data),
                                   "preview_hex": data[:128].hex()})
                    await up.send(data)
        except Exception as e:
            if not client_gone["value"]:
                close_status["error"] = close_status["error"] or f"client_to_upstream: {type(e).__name__}: {e}"
            with contextlib.suppress(Exception):
                await up.close(code=1011, reason="client relay failed")

    async def upstream_to_client():
        try:
            async for data in up:
                if isinstance(data, str):
                    if turn["open"]:
                        turn["frames"].append(data)
                    frames.append({"dir": "upstream", "type": "text",
                                   "bytes": len(data.encode("utf-8")),
                                   "preview": data[:1000]})
                    await websocket.send_text(data)
                    maybe_finalize_ws_receipt(data)
                else:
                    frames.append({"dir": "upstream", "type": "bytes",
                                   "bytes": len(data),
                                   "preview_hex": data[:128].hex()})
                    await websocket.send_bytes(data)
        except Exception as e:
            if not client_gone["value"]:
                close_status["error"] = close_status["error"] or f"upstream_to_client: {type(e).__name__}: {e}"
        finally:
            close_status["upstream"] = {"code": getattr(up, "close_code", None),
                                         "reason": getattr(up, "close_reason", None)}
            if not client_gone["value"]:
                with contextlib.suppress(Exception):
                    await websocket.close(
                        code=_websocket_sendable_close_code(
                            getattr(up, "close_code", None), fallback=1011),
                        reason=_websocket_close_reason(
                            getattr(up, "close_reason", None),
                            fallback="upstream closed"),
                    )

    try:
        tasks = [asyncio.create_task(client_to_upstream()),
                 asyncio.create_task(upstream_to_client())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        for task in done:
            task.result()
    except Exception as e:
        codex_mod._CODEX_STATS["errors"] += 1
        close_status["error"] = close_status["error"] or f"relay: {type(e).__name__}: {e}"
    finally:
        with contextlib.suppress(Exception):
            await up.close()
        writer_mod._enqueue_json(out_dir / f"{stem}.transport.json",
                     {"seq": n, "agent": agent, "provider": "openai",
                      "transport": "websocket", "endpoint": base_path,
                      "upstream_url": upstream_url, "status": "closed",
                      "close": close_status, "n_frames": len(frames),
                      "turns_captured": turn["count"],
                      "turn_open_at_close": turn["open"]})
        if frames:
            writer_mod._enqueue_json(out_dir / f"{stem}.frames.json",
                         {"seq": n, "agent": agent, "provider": "openai",
                          "transport": "websocket", "frames": frames})


async def handler(request: Request) -> Response:
    # ---- identity: "is this our proxy?" handshake for subscribers -------------
    # GET /_identity — read-only, unauthenticated, spends nothing. Lets a
    # consumer confirm product == "wirescope" + read capabilities/protocols
    # before it registers / pulls stats / warms cache (see SUBSCRIBERS.md).
    if request.method == "GET" and request.url.path.rstrip("/") == "/_identity":
        res = status_mod._identity()
        return Response(json.dumps(res, indent=2),
                        media_type="application/json",
                        headers={"X-Wirescope-Version": core_mod.VERSION})

    # ---- status: what sessions are tracked + warmth/hold/identity/cost --------
    # GET /_status[?session=<id>][&all=1] — read-only, spends nothing.
    if request.method == "GET" and request.url.path == "/_status":
        q = request.query_params
        res = status_mod._status_snapshot(session=q.get("session"),
                               all_sessions=q.get("all") in ("1", "yes", "true"))
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # ---- context: tool rosters loaded for a session (main + each subagent) -----
    # GET /_context?session=<id> — read-only, spends nothing. Surfaces what
    # /_status deliberately omits: the actually-forwarded tool set per agent line
    # (post-transform, so wirescope trims show). In-memory only; cold/ended
    # sessions return agents=[] + note.
    if request.method == "GET" and request.url.path.rstrip("/") == "/_context":
        sess = request.query_params.get("session")
        if not sess:
            return Response(json.dumps({"error": "session required"}),
                            status_code=400, media_type="application/json")
        util = request.query_params.get("utilization") in ("1", "yes", "true")
        res = status_mod._context_snapshot(sess, utilization=util)
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # GET /_subagents?session=<sid>&child=<key>[&detail=1][&maxlen=N] — on-demand
    # per-subagent detail for a popover: latest assistant text + tool from that
    # instance's last forwarded request body (one turn stale; never the in-flight
    # stream). `child` = the sub_agents[].key from /_status. Read-only, in-memory,
    # OFF the 5s poll path (transcripts are heavy). found:false + reason
    # (unknown_child|no_request_body|session_cold) for the absent cases — all 200,
    # 400 only on missing params (action-endpoint convention). `maxlen` clamps
    # string values in-place so a popover never pulls full file bodies.
    if request.method == "GET" and request.url.path.rstrip("/") == "/_subagents":
        q = request.query_params
        sess, child = q.get("session"), q.get("child")
        if not sess or not child:
            return Response(json.dumps({"error": "session and child required"}),
                            status_code=400, media_type="application/json")
        try:
            maxlen = int(q.get("maxlen")) if q.get("maxlen") else None
        except (TypeError, ValueError):
            maxlen = None
        res = status_mod._subagent_detail(sess, child, maxlen=maxlen)
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # POST /_compact?session=<id>&path=<jsonl> — offline transcript compaction
    # (the bake): rewrite a parked session's JSONL on disk to the maximal SAFE-to-
    # drop set (today: thinking-only), preserving session_id so `--resume` still
    # resolves. Bakes ⊆ safe-to-drop (model-correctness, owned in-repo by
    # bake_session); the wire-delta it produces is a COST signal, not a safety gate
    # — reported in `wire_delta` so a consumer fires it on COLD resume (re-cache
    # unavoidable there) and warns on a warm "slim now". Integrity-gated + backed
    # up + atomic: on any problem returns {ok:false, reason} (200) so the caller
    # resumes the ORIGINAL untouched. `path` is required (the consumer resolves it;
    # we never guess and overwrite). 400 only on missing params.
    if request.method == "POST" and request.url.path.rstrip("/") == "/_compact":
        q = request.query_params
        sess, path = q.get("session"), q.get("path")
        if not sess or not path:
            return Response(json.dumps({"error": "session and path required"}),
                            status_code=400, media_type="application/json")
        # `level` = the consumer's intended bake DEPTH (at cold restore it holds
        # the intent; the proxy has no live override to read). v1 bakes THINKING
        # ONLY regardless of level — thinking is always model-safe (whole-block
        # delete, signature never touched) and it's the durable win whenever the
        # wire was carrying it. The L2 FOLD-bake (edit-ack/failed-call) is a
        # different risk class (durable content MUTATION in the transcript, not a
        # deletion) and stays a wire-only transform for now -> reported, not yet
        # applied. So `baked_families` is the authoritative "what actually changed".
        try:
            level = int(q.get("level")) if q.get("level") is not None else None
        except (TypeError, ValueError):
            level = None
        import bake_session
        res = bake_session.compact_file(path, expect_session=sess)
        res["session"] = sess
        res["requested_level"] = level
        res["baked_families"] = ["thinking"]
        if level is not None and level >= 2:
            res["folds_deferred"] = True   # L2 folds stay wire-only in v1
        if "carriage_tokens_removed_est" in res:    # consumer-friendly alias
            res["tokens_removed"] = res["carriage_tokens_removed_est"]
        # warmth at compaction time + whether this session's wire was ALREADY
        # being thinking-stripped live -> the cost classification of what we
        # removed: already_live = bytes the wire dropped anyway (disk/CPU win,
        # free recycle); wire_carried = bytes the wire still shipped (durable
        # token win, but a one-time re-cache on the next forward).
        wq = warmth_mod.warmth_query(session=sess)
        res["warmth_state"] = ("warm" if wq.get("warm")
                               else "cold" if wq.get("found") else "absent")
        st = status_mod._strip_state(sess)
        stripped_live = (st["configured_level"] >= 1
                         and (st.get("guard") or {}).get("decision") == "strip")
        if res.get("ok") and not res.get("noop"):
            # pure-thinking turns are the ONE case bake diverges from live-strip
            # (live-strip's empty-content guard KEEPS an all-thinking turn it can't
            # empty; bake deletes it). So on a strip-ACTIVE session the bake is
            # byte-identical to the wire — hence pure cache RECYCLE — IFF
            # pure_thinking_turns == 0; each such turn re-caches once even when
            # strip is live (then permanently slimmer than live-strip can manage).
            pure = res.get("pure_thinking_turns", 0)
            res["wire_delta"] = {
                "thinking_stripped_live": stripped_live,
                "pure_thinking_turns": pure,
                "byte_identical_to_live_wire": bool(stripped_live and pure == 0),
                "classification": (
                    "already_live" if (stripped_live and pure == 0)
                    else "pure_thinking_recache" if stripped_live
                    else "wire_carried"),
                "note": (
                    "byte-identical to the live-stripped wire — pure cache recycle, "
                    "disk/CPU only" if (stripped_live and pure == 0) else
                    f"strip is live, but {pure} pure-thinking turn(s) bake out beyond "
                    "what live-strip can drop — one-time re-cache there, then slimmer "
                    "forever" if stripped_live else
                    "removed wire-carried bytes — durable token win, "
                    "one-time re-cache on next forward")}
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # GET /_report?session=<id>[&detail=1] — read-only, spends nothing. The
    # per-session cost/efficiency report (where the tokens AND dollars went +
    # findings + verdict). DISK-based (works on ended/historical sessions),
    # heavy (scans the whole capture dir) -> on-demand only, off the poll path.
    if request.method == "GET" and request.url.path.rstrip("/") == "/_report":
        sess = request.query_params.get("session")
        if not sess:
            return Response(json.dumps({"error": "session required"}),
                            status_code=400, media_type="application/json")
        detail = request.query_params.get("detail") in ("1", "yes", "true")
        res = report_mod.session_report(sess, detail=detail)
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # GET /_bust?session=<id> — read-only cache-divergence forensics. Per main-line
    # transition: WHERE the prefix first diverged (survived-prefix depth from the
    # receipt + the byte-change vs the previous turn) and HOW BIG the re-write was,
    # flagging the actionable static-prefix busts (a model swap, a date rollover)
    # apart from routine cold-resume history rewrites. DISK-based, on-demand.
    if request.method == "GET" and request.url.path.rstrip("/") == "/_bust":
        sess = request.query_params.get("session")
        if not sess:
            return Response(json.dumps({"error": "session required"}),
                            status_code=400, media_type="application/json")
        res = report_mod.bust_series(sess)
        return Response(json.dumps(res, indent=2), media_type="application/json")

    # ---- capture-dir retention -------------------------------------------------
    # GET /_prune — free size readout: where the disk went + what the default
    # cutoffs would reclaim (one fs walk, nothing deleted). POST /_prune?
    # older_than=30d[&tier=receipts|full][&scope=sessions|no-session|all]
    # [&dry_run=1] — execute a prune pass. older_than is REQUIRED (destructive
    # endpoint, no implicit default) and floored at 1h; warm/held sessions and
    # anything with recent activity are never touched (proxylab/prune.py).
    # Action-endpoint convention: 400 only for malformed input; outcome in body.
    if request.url.path.rstrip("/") == "/_prune":
        if request.method == "GET":
            return Response(json.dumps(prune_mod.prune_scan(), indent=2),
                            media_type="application/json")
        if request.method == "POST":
            q = request.query_params
            age = prune_mod._parse_age(q.get("older_than"))
            if age is None or age < prune_mod._MIN_AGE_S:
                return Response(json.dumps(
                    {"error": "older_than required (e.g. 30d / 12h), min 1h"}),
                    status_code=400, media_type="application/json")
            tier = q.get("tier") or "receipts"
            scope = q.get("scope") or "all"
            if tier not in ("receipts", "full") or scope not in (
                    "sessions", "no-session", "all"):
                return Response(json.dumps(
                    {"error": "tier in {receipts,full}; "
                              "scope in {sessions,no-session,all}"}),
                    status_code=400, media_type="application/json")
            dry = q.get("dry_run") in ("1", "yes", "true")
            res = prune_mod.prune(age, tier=tier, scope=scope, dry_run=dry)
            if not dry:
                print(f"[prune] tier={tier} scope={scope} "
                      f"older_than={q.get('older_than')} -> "
                      f"{res['files_deleted']} files / "
                      f"{res['bytes_reclaimed'] / 1e6:.1f} MB reclaimed "
                      f"({res['sessions_pruned']} sessions)", flush=True)
            return Response(json.dumps(res, indent=2),
                            media_type="application/json")

    # ---- timeline page: per-request cost evolution, for humans -----------------
    # GET /_timeline?session=<id> — read-only HTML render of the cost-over-time
    # dashboard (the visual companion to /_report?detail=1). DISK-based, heavy,
    # on-demand only (same cost profile as /_report).
    if request.method == "GET" and request.url.path.rstrip("/") == "/_timeline":
        sess = request.query_params.get("session")
        if not sess:
            return Response("missing ?session=", status_code=400,
                            media_type="text/plain")
        rep = report_mod.session_report(sess, detail=True)
        return Response(views_mod._render_timeline_html(sess, rep),
                        media_type="text/html; charset=utf-8")

    # ---- admin page: the same snapshot for humans ------------------------------
    # GET /_admin[?session=<id>][&all=1] — read-only HTML view of /_status.
    if request.method == "GET" and request.url.path.rstrip("/") == "/_admin":
        q = request.query_params
        all_s = q.get("all") in ("1", "yes", "true")
        sess = q.get("session")
        try:
            show = int(q.get("show") or 60)
        except (TypeError, ValueError):
            show = 60
        show = max(10, min(show, 2000))
        res = status_mod._status_snapshot(
            session=sess, all_sessions=all_s,
            limit=(None if (all_s or sess) else show))
        return Response(views_mod._render_admin_html(
                            res, host=request.headers.get("host", ""), show=show),
                        media_type="text/html; charset=utf-8")

    # ---- session context view: the replayable last request, for humans --------
    # GET /_session?session=<id> — read-only HTML rendering of the session's
    # captured context (body only, never headers).
    if request.method == "GET" and request.url.path.rstrip("/") == "/_session":
        sess = request.query_params.get("session")
        if not sess:
            return Response("missing ?session=", status_code=400,
                            media_type="text/plain")
        # ?sub=<instance-key> (or legacy ?role=<role>) -> the per-subagent view
        # (shares the parent's session_id; latest captured turn, never the
        # parent's pingable request nor the parent's response/usage receipts).
        # The key is the x-claude-code-agent-id when the spawn had one, else the
        # role — so concurrent same-role subagents each get their own page.
        # ?turn=<i> — the turn NAVIGATOR: render the i-th main-line captured
        # request (0-based, chronological) from disk, with prev/next arrows and a
        # 'vs previous turn' cache panel (this turn's read/write + the bust locus
        # from report.bust_series). Every request is captured, so turns are just
        # positions in the on-disk series. Disk-based + heavy, on-demand only.
        turn_q = request.query_params.get("turn")
        if turn_q is not None:
            try:
                ti = int(turn_q)
            except (TypeError, ValueError):
                return Response("turn must be an integer", status_code=400,
                                media_type="text/plain")
            entry, t_resp, t_usage, nav = views_mod._load_request_by_index(sess, ti)
            bust_t = None
            if nav.get("i") is not None:
                series = report_mod.bust_series(sess)
                by_stem = {t["stem"]: t for t in series["transitions"]}
                turns = views_mod._main_line_turns(sess)
                cur = turns[nav["i"]]
                bust_t = by_stem.get(cur["stem"])
                # Forensic jumps: nearest real cache-bust either side of this
                # turn (skips the warm-append turns a step-walk plods through).
                # bust_series filters p["ok"] while _main_line_turns doesn't, so
                # the two index spaces can diverge — map bust STEMS back to
                # turn-navigator indices (the space &turn= addresses).
                stem_to_i = {t["stem"]: j for j, t in enumerate(turns)}
                bi = sorted(stem_to_i[t["stem"]] for t in series["busts"]
                            if t["stem"] in stem_to_i)
                ci = nav["i"]
                nav["prev_bust"] = max((j for j in bi if j < ci), default=None)
                nav["next_bust"] = min((j for j in bi if j > ci), default=None)
                nav["n_busts"] = len(bi)
            return Response(views_mod._render_session_html(
                                sess, entry,
                                status_mod._status_snapshot(session=sess),
                                resp=t_resp, usage=t_usage, nav=nav, bust_t=bust_t),
                            media_type="text/html; charset=utf-8")
        subkey = request.query_params.get("sub") or request.query_params.get("role")
        if subkey:
            sub_entry = meta_mod._subagent_request(sess, subkey)
            if sub_entry is None:
                # cold fallback: swept subagent state, but the captures remain
                sub_entry, _, _ = views_mod._load_last_request_disk(sess,
                                                                    subkey=subkey)
            return Response(views_mod._render_session_html(
                                sess, sub_entry,
                                status_mod._status_snapshot(session=sess),
                                subrole=subkey),
                            media_type="text/html; charset=utf-8")
        with pinger_mod._LAST_REQUEST_LOCK:
            entry = pinger_mod._LAST_REQUEST.get(sess)
        if entry is None:
            entry = views_mod._load_last_request_row(sess)
        # Codex over WebSocket is a DELTA protocol: each turn's request carries
        # only the new delta (turns chain server-side), so the in-memory/SQLite
        # last-request entry is just the final chunk. Rebuild the whole thread
        # from the per-turn capture files. The reconstruction stitches the final
        # answer in as its last item, so don't also render the standalone resp.
        recon = report_mod.codex_ws_transcript(sess)
        # Cold-session VIEW fallback: the sweeper deletes the replayable entry
        # (memory + SQLite mirror) once the prefix is provably cold — right for
        # replay, wrong to blank the read-only view while the capture files are
        # still on disk. Rebuild view/answer/receipts from the captures instead.
        disk_resp = disk_usage = None
        if entry is None and recon is None:
            entry, disk_resp, disk_usage = views_mod._load_last_request_disk(sess)
        return Response(views_mod._render_session_html(
                            sess, recon or entry,
                            status_mod._status_snapshot(session=sess),
                            resp=None if recon else (meta_mod._LAST_RESPONSE.get(sess)
                                                     or disk_resp),
                            usage=meta_mod._LAST_USAGE.get(sess) or disk_usage),
                        media_type="text/html; charset=utf-8")

    # ---- warmth read endpoint (local consumers: statusline / hook / pinger) ---
    # GET /_warm?h=<prefix-hash>  or  /_warm?session=<session_id>
    if request.method == "GET" and request.url.path == "/_warm":
        q = request.query_params
        res = warmth_mod.warmth_query(hash_hex=q.get("h"), session=q.get("session"))
        return Response(json.dumps(res), media_type="application/json")

    # ---- keep-warm HOLD: arm/disarm idle insurance for a session --------------
    # GET  /_hold?session=<id>                  -> current hold (read-only, free)
    # POST /_hold?session=<id>&hours=<n>        -> arm n hours of idle insurance
    # POST /_hold?session=<id>&hours=0  (|&action=off) -> disarm
    # The programmatic twin of the in-band `/warm-cache` command (which arms by
    # injecting a <proxy:warm-cache hours=N> sentinel into a forwarded turn).
    # Unlike that path this does NOT forward a turn, so the pinger can only keep
    # the cache warm if the session already has a replayable last request + live
    # auth (see `pingable`/`awaiting_auth` in the reply); otherwise the hold is
    # recorded and the session's next real turn re-anchors + donates them.
    if request.url.path.rstrip("/") == "/_hold":
        q = request.query_params
        sess = q.get("session")
        if not sess:
            return Response(json.dumps({"ok": False, "reason": "missing ?session="}),
                            status_code=400, media_type="application/json")
        if request.method == "GET":
            hold = hold_mod._hold_snapshot().get(sess)
            return Response(json.dumps({"ok": True, "session": sess, "hold": hold}),
                            media_type="application/json")
        raw_h, act = q.get("hours"), q.get("action")
        if act == "off" or raw_h in ("0", "off"):
            arm_action, hours = "off", None
        else:
            try:
                hours = float(raw_h)
            except (TypeError, ValueError):
                return Response(json.dumps({"ok": False, "reason": "missing/invalid ?hours="}),
                                status_code=400, media_type="application/json")
            if hours <= 0:
                arm_action, hours = "off", None
            else:
                # match the in-band path's clamp to the configured ceiling
                arm_action = "arm"
                hours = min(hours, hold_mod.WARMTH_HOLD_MAX_HOURS)
        # Same discipline as /_ping: we never warm a non-warm prefix. Arming
        # over HTTP does NOT forward a turn, so a hold on a cold/absent prefix
        # has nothing to keep warm — it would be a no-op until a real turn
        # re-establishes the cache. Decline it (force=1 to arm anyway, e.g. when
        # the caller knows a turn is imminent). Disarm is never gated.
        # Convention (matches /_ping): a deliberate decline is a SUCCESSFUL
        # request with a structured outcome (200, ok:true, armed:false,
        # skipped:<state>) — NOT an HTTP error. 4xx is reserved for malformed
        # requests (missing session / bad hours). Branch on `armed`, not status.
        if arm_action == "arm" and q.get("force") not in ("1", "yes", "on", "true"):
            wq = warmth_mod.warmth_query(session=sess)
            state = ("warm" if wq.get("warm")
                     else "cold" if wq.get("found") else "absent")
            if state != "warm":
                return Response(json.dumps(
                    {"ok": True, "armed": False, "skipped": state, "session": sess,
                     "warmth_state": state, "warmth": wq,
                     "reason": f"prefix is '{state}', not warm; arming over HTTP does "
                               "not forward a turn, so there is nothing to keep warm — "
                               "it would be a no-op until a real turn re-establishes "
                               "the cache. Declined (force=1 to arm anyway, or send a "
                               "turn through the proxy first)."}),
                    media_type="application/json")
        ack, rec = hold_mod._arm_hold(sess, arm_action, hours)
        print(f"[hold] session={sess[:12]}… HTTP {arm_action} -> "
              f"armed={rec.get('armed')} reason={rec.get('reason')}", flush=True)
        return Response(json.dumps({"ok": True, "ack": ack, **rec}),
                        media_type="application/json")

    # ---- keep-warm pinger: replay a session's cached last request -------------
    # POST/GET /_ping?session=<id>[&force=1] — intercepted, never forwarded as a
    # normal turn. Locates the session's cached last request and replays it as a
    # thinking-off, max_tokens:1 cache-read to slide the TTL. (force=1 re-warms a
    # provably-cold prefix instead of declining.)
    if request.url.path == "/_ping":
        q = request.query_params
        sess = q.get("session")
        if not sess:
            return Response(json.dumps({"ok": False, "reason": "missing ?session="}),
                            status_code=400, media_type="application/json")
        force = q.get("force") in ("1", "yes", "on", "true")
        code, res = await pinger_mod._warm_session(sess, force=force)
        print(f"[ping] session={sess[:12]}… -> {res.get('warmed') and 'WARMED' or res.get('skipped') or 'FAIL'} "
              f"prior={res.get('prior_warmth')} read={res.get('cache_read_input_tokens')} "
              f"remaining={res.get('remaining_s')}", flush=True)
        return Response(json.dumps(res), status_code=code,
                        media_type="application/json")

    # ---- session teardown: stop caching a finished session --------------------
    # GET/POST /_end?session=<id>[&reason=clear] — wire to the CLI's SessionEnd
    # hook so a /clear or exit forgets the session's cached request immediately;
    # the background sweeper is the backstop for crashes/kills the hook misses.
    if request.url.path == "/_end":
        sess = request.query_params.get("session")
        if not sess:
            return Response(json.dumps({"ok": False, "reason": "missing ?session="}),
                            status_code=400, media_type="application/json")
        res = pinger_mod._end_session(sess, reason=request.query_params.get("reason", "unspecified"))
        subs_mod.emit_session_ended(sess, res["reason"])
        print(f"[end] session={sess[:12]}… reason={res['reason']} "
              f"ended={res['ended']} hold_disarmed={res['hold_disarmed']} "
              f"retained={res['retained']} (sweeper reaps later)", flush=True)
        return Response(json.dumps(res), media_type="application/json")

    # ---- per-session strip-prior-thinking toggle (consumer opt-in) ------------
    # GET  /_strip?session=<id>             -> current effective level (read-only)
    # POST /_strip?session=<id>&level=2     -> set the strip LEVEL (0 off / 1 L1
    #                                          thinking / 2 L2 = L1 + bust-riders)
    # POST /_strip?session=<id>&on=1|0      -> legacy bool twin (on=L1, off=level 0)
    # POST /_strip?session=<id>&action=clear -> drop the override (fall back global)
    # The programmatic twin of the `[wirescope:strip-thinking <off|on|l2>]`
    # directive, so a consumer (clodex) can flip an agent from its UI without a
    # forwarded turn. Body convention: HTTP status = request validity, outcome in
    # the JSON. `effective`/`override` are int levels; `enabled` mirrors level>=1.
    if request.url.path.rstrip("/") == "/_strip":
        q = request.query_params
        sess = q.get("session")
        if not sess:
            return Response(json.dumps({"ok": False, "reason": "missing ?session="}),
                            status_code=400, media_type="application/json")
        gdef = transforms_mod._global_strip_level()

        def _body(override):
            eff = override if override is not None else gdef
            return {"ok": True, "session": sess, "override": override,
                    "global_default": gdef, "effective": eff,
                    "enabled": eff >= 1, "l2": eff >= 2, "l3": eff >= 3}
        if request.method == "GET":
            return Response(json.dumps(_body(transforms_mod._STRIP_OVERRIDE.get(sess))),
                            media_type="application/json")
        action = (q.get("action") or "").lower()
        level_raw = q.get("level")
        on_raw = q.get("on")
        if action == "clear" or on_raw in ("clear", "none") or level_raw in ("clear", "none"):
            new = transforms_mod._strip_thinking_set_override(sess, None)
        elif level_raw is not None:
            lv = {"l1": 1, "l2": 2, "l3": 3}.get(level_raw.lower())
            if lv is None:
                try:
                    lv = int(level_raw)
                except ValueError:
                    return Response(json.dumps({"ok": False, "session": sess,
                                    "reason": f"bad level={level_raw!r} (0|1|2|3|l1|l2|l3)"}),
                                    status_code=400, media_type="application/json")
            new = transforms_mod._strip_thinking_set_override(sess, lv)
        else:
            on = (on_raw in ("1", "yes", "on", "true")) if on_raw is not None else True
            new = transforms_mod._strip_thinking_set_override(sess, 1 if on else 0)
        print(f"[strip] session={sess[:12]}… level={new} (global={gdef})", flush=True)
        return Response(json.dumps(_body(new)), media_type="application/json")

    # ---- subscriber registry: app-agnostic push feed (see SUBSCRIBERS.md) -----
    # GET/POST/DELETE /_subscribe — consumers register an endpoint + agent globs
    # and receive text.delta / turn.completed / session.ended for their sessions.
    if request.url.path.rstrip("/") == "/_subscribe":
        return await subs_mod.handle_subscribe(request)

    n = next(core_mod._counter)
    raw = await request.body()
    ts = time.strftime("%H%M%S")

    # ---- route: strip /agent/<name>/<provider> prefix, capture agent name ----
    path = request.url.path
    m = core_mod._ROUTE.match(path)
    if m:
        agent = m.group("name")
        upstream_path = m.group("rest") or "/"
    else:
        mo = codex_mod._ROUTE_OPENAI.match(path)
        if mo:
            up_rest = mo.group("rest") or "/"
            if request.url.query:
                up_rest += "?" + request.url.query
            return await _handle_openai(request, n, raw,
                                        mo.group("name"), up_rest, ts)
        agent = "ext"
        upstream_path = path
    if request.url.query:
        upstream_path += "?" + request.url.query

    # ---- parse + summarize the request body ----
    role, model = "unknown", None
    session_id = account_uuid = None
    title_call = False
    side_call = False
    obj = None      # stays None on an unparseable body -> every transform/gate is
                    # skipped and the ORIGINAL bytes forward verbatim (fail-open:
                    # a parse failure must degrade to passthrough, never to a 500)
    client = request.client
    record = {"seq": n, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "agent": agent, "method": request.method, "path": upstream_path,
              # inbound transport identity — the "who" behind no-session calls
              "client": {"host": client.host, "port": client.port} if client else None,
              "request_headers": core_mod._safe_headers(request.headers)}
    try:
        obj = json.loads(raw) if raw else {}
        record["body"] = obj
        # VERSION-DRIFT CANARY (read-only): fingerprint the ORIGINAL CLI request
        # shape BEFORE any of our transforms, so we detect CLI/wire changes (incl.
        # a new 4th cache_control marker), not our own mutations.
        if obj and upstream_path.split("?")[0].endswith("/v1/messages"):
            cres = canary_mod._canary_check(obj, request.headers, n)
            if cres is not None:
                record["canary"] = cres
        # EXPERIMENTAL piggyback: mutate the outbound payload, forward modified bytes
        ws_display_name = None     # captured pre-strip below; passed to meta
        # Per-instance key (present iff subagent, stable across that instance's
        # turns): threads into _ws_omit so a spawn directive remembered on turn 1
        # re-applies on continuation turns; reused for _capture_session_meta below.
        agent_id = request.headers.get("x-claude-code-agent-id")
        # PASSTHROUGH (A/B control arm): skip the entire mutation chain so the
        # forwarded bytes equal the received bytes. Capture/billing/warmth below
        # still run (they only read obj). One guard instead of N per-feature 0s.
        if obj and not transforms_mod.PASSTHROUGH:
            changed = False
            # SIDE-CALL MODEL DOWNSHIFT: rewrite the model of one-shot
            # WebFetch-summarize / WebSearch utility calls (the CLI ships them
            # on the session's MAIN model — a fetched page as uncached input at
            # fable rates). Cache-safe: these bodies carry no cache_control.
            # First in the chain so the rewrite is visible to capture/billing
            # and to the beta-header strip at forward time below.
            scd = transforms_mod._sidecall_downshift(obj)
            if scd:
                record["sidecall_downshift"] = scd
                changed = True
                print(f"[sidecall] #{n} {agent} {scd['kind']} downshift "
                      f"{scd['from_model']} -> {scd['to_model']}", flush=True)
            appended, reason = transforms_mod._decide_injection(obj)
            if appended:
                orig = transforms_mod._inject_into_last_user(obj, appended, transforms_mod.INJECT_SEP)
                if orig is not None:
                    record["injection"] = {"appended": appended, "reason": reason,
                                           "marker": transforms_mod.INJECT_MARKER,
                                           "original_last_user": orig,
                                           "final_last_user": transforms_mod._last_user_text(obj)}
                    changed = True
            # Invisible standing protocol instruction (UX): append to the user's
            # prompt on genuine prompt turns only (skip tool_result continuations).
            if transforms_mod.SHORTCIRCUIT_INSTRUCT and transforms_mod._last_user_text(obj):
                orig2 = transforms_mod._inject_into_last_user(obj, transforms_mod.SHORTCIRCUIT_INSTRUCT, "\n\n")
                if orig2 is not None:
                    record["injection_shortcircuit"] = {"appended": transforms_mod.SHORTCIRCUIT_INSTRUCT}
                    changed = True
            # Best placement: patch the terminal tools' own descriptions in tools[]
            patched = transforms_mod._patch_tool_descriptions(obj)
            if patched:
                record["toolpatch"] = {"tools": patched}
                changed = True
            # System-prompt delivery (stable-position, cache-riding, invisible).
            if transforms_mod._patch_system(obj):
                record["syspatch"] = True
                changed = True
            # Proxy-side `rest` split: relocate static prose to an env-independent
            # cache prefix (byte-identical model-visible text; cache boundary only).
            sp = transforms_mod._split_system_rest(obj)
            if sp:
                record["rest_split"] = sp
                changed = True
            # Design-2: relocate env+date to a tail block, mark CLAUDE.md (model-visible).
            rel = transforms_mod._relocate_env_to_tail(obj)
            if rel:
                record["env_relocate"] = rel
                changed = True
            # System-section strip: drop configured `# Heading` sections (model-visible).
            strp = transforms_mod._strip_system_sections(obj)
            if strp:
                record["system_strip"] = strp
                changed = True
            # WIRESCOPE [wirescope:omit ...]: strip author-opted-out context
            # sections (# claudeMd / # userEmail) from messages[0]. Effective
            # targets merge body + spawn directives (per-agent + per-call opt-in).
            wso = transforms_mod._ws_omit(obj, agent_id=agent_id)
            if wso:
                record["ws_omit"] = wso
                if wso.get("omitted") or wso.get("replaced"):
                    changed = True
            # WIRESCOPE [wirescope:tools|strip-tools|keep-tools ...]: trim the
            # tool roster on the wire (allowlist/denylist), so a spawner can
            # customize a predefined subagent without editing its file. Must run
            # BEFORE the directive-strip below (it reads the same directives).
            wst = transforms_mod._ws_strip_tools(obj, agent_id=agent_id)
            if wst:
                record["ws_tools"] = wst
                if wst.get("removed"):
                    changed = True
            # STRIP_MCP_SERVERS: surgically drop a named MCP server's tool family
            # (mcp__<server>__*) from tools[] for every routed CLI — the targeted
            # alternative to --strict-mcp-config (real MCPs untouched). Default
            # off in code, on for the lab via start_proxy.sh. Per-agent re-admit:
            # [wirescope:keep-mcp <server>]. Runs before the directive-strip below.
            smcp = transforms_mod._strip_mcp_tools(obj, agent_id=agent_id)
            if smcp:
                record["strip_mcp"] = smcp
                if smcp.get("removed"):
                    changed = True
            # WIRESCOPE [wirescope:strip-thinking ...]: resolve the strip decision
            # into the sticky per-session store NOW, BEFORE the directive-strip
            # below removes the line from the wire — otherwise a directive placed
            # in the (append-)system region is consumed before _strip_prior_thinking
            # (further down the chain) can read it, and turn 1 silently never
            # strips. Idempotent; endpoint-set overrides are untouched (no directive
            # -> no-op). Persists the directive opt-in so it survives restarts too.
            transforms_mod._strip_thinking_enabled(obj, agent_id=agent_id)
            # WIRESCOPE: capture the display name BEFORE removing the directives,
            # then strip every [wirescope:...] line from system so the model never
            # sees our control lines (and they cost no prefix tokens). Strip is
            # unconditional; the name is forwarded to meta below.
            ws_display_name = writer_mod._subagent_marker_name(obj)
            wstr = transforms_mod._ws_strip_directives(obj)
            if wstr:
                record["ws_strip"] = wstr
                changed = True
            # WIRESCOPE v1 spawn directives: strip the strict-head [wirescope:...]
            # lines from messages[0]'s prompt block (already read + acted on).
            wstrs = transforms_mod._ws_strip_spawn_directives(obj)
            if wstrs:
                record["ws_strip_spawn"] = wstrs
                changed = True
            # WIRESCOPE: optional spawner discovery hint (operator opt-in, the
            # one model-visible proxy-authored line; spawner-only, Agent/Task-gated).
            whint = transforms_mod._ws_spawner_hint(obj)
            if whint:
                record["ws_spawner_hint"] = whint
                changed = True
            # Tool sort: alphabetize tools[] for a byte-stable first cache segment.
            srt = transforms_mod._sort_tools(obj)
            if srt:
                record["tool_sort"] = srt
                changed = True
            # Strip the discarded history cache_control on a (busted) compact req.
            scc = transforms_mod._strip_compact_cache(obj)
            if scc:
                record["strip_compact_cache"] = scc
                if scc.get("removed_message_markers"):
                    changed = True
            # STRIP PRIOR-TURN THINKING (experimental): drop thinking blocks from
            # completed prior turns; current turn untouched. Busts message cache
            # from the strip point (recouped by cheaper reads). Monster guard may
            # decline (stripped:False) -> recorded for observability, no mutation.
            spt = transforms_mod._strip_prior_thinking(obj, agent_id=agent_id)
            if spt:
                record["strip_prior_thinking"] = spt
                if spt.get("removed_thinking_blocks"):
                    changed = True
            # COLLAPSE PRIOR-TURN EDIT/WRITE ACKS: replace the success boilerplate
            # with "ok" — but ONLY inside the region the thinking-strip just busted
            # (free-rider). Originating its own bust to reclaim ~1.4k tok/turn is a
            # ~1400-turn loss, so when thinking didn't strip (spt None/declined) we
            # pass busted_from=None and it collapses nothing. Current turn untouched.
            busted_from = spt.get("earliest_idx") if (spt and spt.get("stripped")) else None
            sea = transforms_mod._strip_prior_edit_acks(
                obj, agent_id=agent_id, busted_from=busted_from)
            if sea:
                record["strip_prior_edit_acks"] = sea
                if sea.get("collapsed_edit_acks"):
                    changed = True
            # STUB PRIOR-TURN FAILED CALLS (experimental, scratch-port A/B; OFF on
            # :7800): a failed Edit etc. re-rides as the fat tool_use input + its
            # is_error result; in a completed prior turn the recovery is already
            # recorded downstream, so both halves are deadweight. Free-rides the
            # SAME thinking-strip bust as the edit-ack strip (busted_from=None ->
            # strips nothing). Current turn's error kept (live retry signal).
            ste = transforms_mod._strip_prior_tool_errors(
                obj, agent_id=agent_id, busted_from=busted_from)
            if ste:
                record["strip_prior_tool_errors"] = ste
                if ste.get("stubbed_error_results") or ste.get("stubbed_failed_calls"):
                    changed = True
            # FOLD same-turn Read+Edit chains (part of STRIP LEVEL 2): apply the
            # edit onto the Read body so downstream turns see the file's FINAL
            # shape directly, and stub the now-redundant Edit input + ack.
            # Deterministic + memoized -> byte-stable across turns (warm after the
            # transition turn). Gated by the L2 strip level
            # (`[wirescope:strip-thinking l2]` / /_strip?level=2 / STRIP_L2) — no
            # separate flag, runs alongside the other L2 optimizations. Settled
            # turns only (current turn's read+edit stay live until history). See
            # fold.py.
            fld = fold_mod.fold_read_edits(obj, agent_id=agent_id)
            if fld:
                record["fold_read_edits"] = fld
                if fld.get("folded_read_bodies") or fld.get("stubbed_edit_calls") or fld.get("stubbed_edit_acks"):
                    changed = True
            # TASK-REMINDER STRIP (part of STRIP LEVEL 2): drop the CLI's
            # accreting "task tools haven't been used" nags wherever they
            # appear in history. L2-gated inside the transform (rides
            # _strip_l2_enabled, so the level directive resolved above at
            # _strip_thinking_enabled is already in force); kill-switch
            # STRIP_TASK_REMINDERS can force it off. No busted_from — nags
            # arrive at the tail, so stripping them never originates a bust.
            trs = transforms_mod._strip_task_reminders(obj, agent_id=agent_id)
            if trs:
                record["task_reminder_strip"] = trs
                changed = True
            # HOLD-WARM: /warm-cache sentinel turn -> arm/disarm + inject the
            # echo instruction; the turn then forwards like any other (the
            # model speaks the ack; this request becomes the replayable,
            # warm, auth-donating last request). LAST in the chain so the
            # instruction is the final text the model reads.
            if upstream_path.split("?")[0].endswith("/v1/messages"):
                he = hold_mod._hold_echo_transform(obj)
                if he:
                    record["hold_echo"] = he
                    changed = True
                    print(f"[hold] #{n} {he['action']} -> "
                          f"{'ARMED ' + str(he.get('hours') or '') if he.get('armed') else 'not armed'}"
                          f" (forwarding; model echoes the ack)", flush=True)
            if changed:
                raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        role = writer_mod._classify_role(obj, agent_id=agent_id)
        model = obj.get("model")
        session_id, account_uuid, device_id = writer_mod._session_ids(obj)
        sysf = obj.get("system")
        sys_chars = len(writer_mod._sys_text(obj))
        msgs = obj.get("messages", []) or []
        msg_chars = len(json.dumps(msgs))
        record["summary"] = {
            "model": model,
            "session_id": session_id,
            "account_uuid": account_uuid,
            "device_id": device_id,
            "role": role,
            "system_chars": sys_chars,
            "system_blocks": len(sysf) if isinstance(sysf, list) else (1 if sysf else 0),
            "n_messages": len(msgs),
            "messages_chars": msg_chars,
            "n_tools": len(obj.get("tools", []) or []),
            "tool_names": [t.get("name") for t in (obj.get("tools") or []) if isinstance(t, dict)],
            # per-instance key for the /_context utilization scan (present iff a
            # subagent turn; lets the disk tally attribute each sub line apart)
            "agent_id": agent_id,
        }
        # session identity for /_status: bump last_seen/model; hunt the cwd
        # until found; flag the title side-call so the response capture can
        # harvest the session title the CLI generates anyway.
        if upstream_path.split("?")[0].endswith("/v1/messages"):
            title_call = meta_mod._is_title_call(obj)
            # side_call = any transient non-agent request sharing the session_id:
            # the title generator OR a health/quota probe. Both must stay out of
            # the durable identity/replay/view/turn-count state; only the TRUE
            # title call additionally harvests its answer as the session title.
            side_call = title_call or meta_mod._is_probe_call(obj)
            # subagents (Task-spawned) share the parent's session_id; pass role
            # so a sub turn is logged distinctly and never overwrites the parent
            # agent's identity/model on the /_status row. The agent-id header
            # (present iff subagent, distinct per spawn) keys concurrent subs apart;
            # read once above the transform chain and reused here.
            meta_mod._capture_session_meta(session_id, obj, model,
                                           agent=(agent if m else None),
                                           role=role, side_call=side_call,
                                           agent_id=agent_id,
                                           display_name=ws_display_name)
            # heaviness snapshot from the model-visible history (main line
            # only: a subagent's small history must not clobber the parent's)
            if session_id and not side_call and role in ("parent", "unknown"):
                meta_mod._CONTEXT_STATS[session_id] = {**meta_mod._turn_stats(obj),
                                              "ts": time.time()}
    except Exception as e:
        record["parse_error"] = str(e)
        record["body_raw"] = raw.decode("utf-8", "replace")

    # one subdirectory per session; count_tokens/probes (no metadata) -> NO_SESSION
    session_key = session_id or writer_mod.NO_SESSION
    out_dir = core_mod.LOG_DIR / session_key
    stem = f"{n:03d}-{agent}-{role}-{writer_mod._short_model(model)}-{ts}"
    writer_mod._enqueue_json(out_dir / f"{stem}.request.json", record)

    # (HOLD-WARM arming now happens in the transform chain above — the
    # sentinel turn is forwarded with an injected echo instruction, so it
    # flows through the normal capture/billing/warmth path like any turn.)

    # ---- WARMTH: decline a provably-COLD keep-warm ping ----------------------
    # A keep-warm ping for a prefix the ledger knows is already busted has lost its
    # meaning: forwarding would only cold-WRITE the discarded prefix at the write
    # premium. Synthesize an end_turn here and skip upstream entirely (0 tokens).
    if isinstance(obj, dict) and upstream_path.split("?")[0].endswith("/v1/messages"):
        cp = warmth_mod._cold_ping_decision(obj)
        if cp:
            msg_id = f"msg_coldping_{n:06d}"
            ack = "Keep-warm ping declined: cache already expired."
            blob = transforms_mod._synth_end_turn_sse(model, ack, msg_id)
            writer_mod._enqueue_bytes(out_dir / f"{stem}.response.sse", blob)
            writer_mod._enqueue_json(out_dir / f"{stem}.response.json",
                {"seq": n, "agent": agent, "role": role, "model": model,
                 "session_id": session_id, "endpoint": "messages",
                 "status_code": 200, "billing": None, "usage": {}, "meta": {},
                 "cold_ping_block": {**cp, "upstream_called": False,
                                     "synthetic_message_id": msg_id,
                                     "ack": ack}})
            print(f"[warmth] #{n} {agent}/{role} declined COLD keep-warm ping "
                  f"({cp['hash'][:12]}…); upstream skipped, 0 tokens", flush=True)
            return StreamingResponse(iter([blob]), status_code=200,
                                     media_type="text/event-stream")

    # ---- SHORTCIRCUIT (experimental): answer the wrap-up turn locally --------
    # If this request is the tool_result continuation of a model-declared
    # terminal edit, synthesize "Done." here and SKIP the upstream call entirely:
    # the ~one-turn context carriage is never shipped, never billed. The file was
    # already modified by the CLI before it sent this request, so nothing about
    # the edit is lost — only the redundant round trip to hear the model stop.
    sc = None
    if isinstance(obj, dict) and upstream_path.split("?")[0].endswith("/v1/messages"):
        # RELAY (model's own prose, matched by tool_use_id) takes precedence; in
        # relay mode the sentinel is stripped from history so the canned path
        # won't fire. Without relay, fall back to the history-sentinel decision.
        sc = transforms_mod._shortcircuit_relay_decision(obj) or transforms_mod._shortcircuit_decision(obj)
    if sc:
        msg_id = f"msg_shortcircuit_{n:06d}"
        blob = transforms_mod._synth_end_turn_sse(model, sc["ack"], msg_id)
        writer_mod._enqueue_bytes(out_dir / f"{stem}.response.sse", blob)
        writer_mod._enqueue_json(out_dir / f"{stem}.response.json",
            {"seq": n, "agent": agent, "role": role, "model": model,
             "session_id": session_id, "endpoint": "messages",
             "status_code": 200, "billing": None, "usage": {}, "meta": {},
             "shortcircuit": {**sc, "upstream_called": False,
                              "synthetic_message_id": msg_id,
                              "note": "wrap-up turn answered locally; upstream "
                                      "NOT called; 0 tokens billed"}})
        _tools = sc.get("tools") or sc.get("tool") or sc.get("tool_use_ids") or []
        print(f"[shortcircuit] #{n} {agent}/{role} elided wrap-up after "
              f"{','.join(_tools) if isinstance(_tools, list) else _tools} -> "
              f"{sc['ack']!r} (upstream skipped, 0 tokens)", flush=True)
        return StreamingResponse(iter([blob]), status_code=200,
                                 media_type="text/event-stream")

    # ---- forward upstream; tee the response stream to a .sse file ----
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in core_mod._HOP}
    fwd_headers["accept-encoding"] = "identity"  # force uncompressed so we can read the SSE
    # Downshifted side-call: drop beta tokens the target model may not support
    # (defensive — context-1m is unsupported on haiku; the body rewrite happened
    # up in the transform chain, this is its header half. SIDECALL_BETA_STRIP).
    if "sidecall_downshift" in record and transforms_mod.SIDECALL_BETA_STRIP:
        _beta = fwd_headers.get("anthropic-beta")
        if _beta:
            _kept = [t.strip() for t in _beta.split(",")
                     if t.strip() and t.strip() not in transforms_mod.SIDECALL_BETA_STRIP]
            fwd_headers["anthropic-beta"] = ",".join(_kept)
            record["sidecall_downshift"]["beta_stripped"] = sorted(
                set(t.strip() for t in _beta.split(",")) - set(_kept))
    # Stash this (post-transform) request so POST /_ping?session= can replay it.
    # Only the MAIN LINE (parent agent) is the session's durable, pingable
    # request: a subagent, title side-call, or quota probe shares the session_id
    # but is transient — it must not replace what /_ping replays nor re-anchor the
    # keep-warm hold (else we'd keep a finished subagent's context warm instead
    # of the main agent's, or pin a one-token probe as the replayable body).
    if upstream_path.split("?")[0].endswith("/v1/messages"):
        if not side_call and not writer_mod._is_subagent_role(role):
            pinger_mod._cache_last_request(session_id, obj, fwd_headers, upstream_path,
                                account_uuid)
            if "hold_echo" not in record:      # the arming turn itself isn't
                hold_mod._hold_note_real_turn(session_id)   # organic; real turns restart
                                                   # the ping budget + window
    req = core_mod._client.build_request(request.method, core_mod.UPSTREAM + upstream_path,
                                headers=fwd_headers, content=raw)
    up = await core_mod._client.send(req, stream=True)
    resp_headers = {k: v for k, v in up.headers.items()
                    if k.lower() not in {"connection", "transfer-encoding",
                                         "content-length", "keep-alive"}}
    base_path = upstream_path.split("?")[0]
    is_messages = base_path.endswith("/v1/messages")
    is_count = base_path.endswith("/count_tokens")
    capture = is_messages or is_count
    chunks = []

    mutate = is_messages and transforms_mod._resp_mutating()
    relay = is_messages and transforms_mod._relay_active()
    buffer_resp = mutate or relay    # both need the full SSE before we can rewrite

    # Generic subscriber tee (SUBSCRIBERS.md): agent-identified routes (m)
    # only, never plain Claude Code traffic; None when no registered
    # subscriber matches this agent, so plain traffic pays nothing.
    sub_tee = (subs_mod._tee_for(agent, session_id, f"{n}-{ts}")
               if m is not None and is_messages else None)

    async def body_iter():
        out_blob = None
        try:
            async for chunk in up.aiter_raw():
                if capture:
                    chunks.append(chunk)
                if not buffer_resp:     # stream verbatim; when buffering we hold
                    yield chunk
                if sub_tee is not None:  # after yield: client bytes come first
                    sub_tee.feed(chunk)
            if buffer_resp and chunks:
                full = b"".join(chunks)
                # relay stashes prose + blanks it as a side effect; compute ONCE
                out_blob = transforms_mod._relay_capture_and_strip(full) if relay else transforms_mod._mutate_sse(full)
                yield out_blob          # emit rewritten response once
        finally:
            if sub_tee is not None:
                sub_tee.close()     # flush the tail text.delta, if any
            await up.aclose()
            if capture and chunks:
                blob = b"".join(chunks)
                if is_messages:
                    writer_mod._enqueue_bytes(out_dir / f"{stem}.response.sse", blob)
                    if mutate:
                        writer_mod._enqueue_bytes(out_dir / f"{stem}.response.mutated.sse",
                                       transforms_mod._mutate_sse(blob))
                    if relay and out_blob is not None:
                        writer_mod._enqueue_bytes(out_dir / f"{stem}.response.relayed.sse", out_blob)
                # everything derived from the finished response — billing, view
                # state, ledger stamp, capture, subscriber receipt — lives in
                # receipts; the closure only owns bytes and routing identity
                receipts_mod.anthropic(
                    blob, n=n, ts=ts, agent=agent, role=role, model=model,
                    session_id=session_id, session_key=session_key, obj=obj,
                    agent_header_id=agent_id,
                    title_call=title_call, side_call=side_call, is_messages=is_messages,
                    routed=(m is not None), out_dir=out_dir, stem=stem,
                    status_code=up.status_code, resp_headers=dict(up.headers),
                    tee_text=(sub_tee.text if sub_tee is not None else None),
                    response_injection=({"append": transforms_mod.RESP_APPEND,
                                         "replace": transforms_mod.RESP_REPLACE}
                                        if mutate else None))

    return StreamingResponse(body_iter(), status_code=up.status_code,
                             headers=resp_headers,
                             media_type=up.headers.get("content-type"))


# Reload persisted state BEFORE serving: armed holds resume (skipping until
# auth is re-donated), totals continue instead of zeroing, the cwd hunt skips
# known sessions. Runs at import so the offline tests exercise it too.
restore_mod._restore_state()

@contextlib.asynccontextmanager
async def _lifespan(app):
    # the hold-warm driver must live on the event loop (it awaits _warm_session
    # on the shared _client). Use the lifespan context manager rather than the
    # on_startup= / on_shutdown= constructor hooks: those were deprecated in
    # Starlette 0.26 and REMOVED in the 1.x line, so on_startup= breaks (and is
    # silently dropped) on a freshly-resolved unpinned install. lifespan= has
    # been supported since 0.13, so this works on both old and new Starlette.
    await hold_mod._start_hold_loop()
    yield


_routes = [Route("/{path:path}", handler,
                 methods=["GET", "POST", "PUT", "DELETE"])]
if codex_mod._websocket_available():
    _routes.append(WebSocketRoute("/{path:path}", websocket_handler))

app = Starlette(routes=_routes, lifespan=_lifespan)
