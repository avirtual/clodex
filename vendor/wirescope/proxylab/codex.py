import json
import os
import re
from pathlib import Path

from proxylab import billing as billing_mod

# --- OPENAI / CODEX PROVIDER (route + capture only; 2026-06-11) ----------------
# /agent/<name>/openai/<rest> routes to the OpenAI-side upstream. Default
# upstream is the ChatGPT backend — the only OpenAI-wire client in the fleet is
# codex in ChatGPT-OAuth subscription mode; set UPSTREAM_OPENAI=
# https://api.openai.com for platform API-key traffic (no rewrite then).
#
# CAPTURE + ROUTING only. None of the Anthropic levers (cache transforms,
# warmth ledger/pinger/hold, canary, SC) applies on this wire: caching is
# SERVER-side (prompt_cache_key is a routing hint; the cache itself is
# content-addressed across sessions — verified live, cached_tokens grew across
# distinct session uuids) and usage exposes it per turn
# (input_tokens_details.cached_tokens). Codex request bodies are
# zstd-compressed; we decode OBSERVER-SIDE for the capture and forward the
# ORIGINAL bytes + content-encoding untouched.
#
# ChatGPT-backend mode (ported from agent-workbench components/proxy/proxy.py
# #2342/#2346, probed live in logs_codexprobe/):
#   * strip the /v1 path prefix (backend serves /responses, not /v1/responses)
#   * replace Authorization with the OAuth bearer + chatgpt-account-id from
#     ~/.codex/auth.json, RE-READ PER REQUEST (codex's own refresh rewrites it;
#     never copied anywhere — same never-persist posture as _ACCOUNT_AUTH)
#   * stub GET /v1/models (the backend has no platform model-list endpoint)
#   * treat POST /responses as SSE no matter the content-type (success
#     responses can arrive with NO content-type header at all)
# Codex 0.139+ tries a WebSocket to /responses first; 0.141+ appears to require
# that path and no longer reliably falls back to HTTP POST. Keep an emergency
# CODEX_WEBSOCKET=0 kill switch, but default to the WS route when the dependency
# is present.
_ROUTE_OPENAI = re.compile(r"^/agent/(?P<name>[A-Za-z0-9_.-]+)/openai(?P<rest>/.*)?$")
UPSTREAM_OPENAI = os.environ.get("UPSTREAM_OPENAI",
                                 "https://chatgpt.com/backend-api/codex")
CODEX_AUTH_FILE = Path(os.environ.get(
    "CODEX_AUTH_FILE", str(Path.home() / ".codex" / "auth.json")))
# model ids served by the /v1/models stub (content barely matters to codex —
# it only needs a 200 with the {"models":[...]} shape)
CODEX_MODELS_STUB = [m for m in os.environ.get(
    "CODEX_MODELS_STUB", "gpt-5.4").split(",") if m]
_CODEX_STATS = {"requests": 0, "responses": 0, "input_tokens": 0,
                "cached_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
                "errors": 0}
CODEX_WEBSOCKET = os.environ.get("CODEX_WEBSOCKET", "1").lower() not in (
    "0", "no", "off", "false")

try:                                    # stdlib since 3.14
    from compression import zstd as _zstd
except Exception:                       # pragma: no cover — py<3.14
    _zstd = None


def _websocket_available():
    if not CODEX_WEBSOCKET:
        return False
    try:
        import websockets  # noqa: F401
        return True
    except Exception:
        return False


def _content_decode(raw, encoding):
    """Observer-side body decode for the capture. Returns (bytes, error|None);
    on any failure the RAW bytes come back — capture degrades, forward never."""
    enc = (encoding or "").lower().strip()
    if not raw or enc in ("", "identity"):
        return raw, None
    try:
        if enc == "zstd":
            if _zstd is None:
                return raw, "zstd: stdlib compression.zstd unavailable"
            return _zstd.decompress(raw), None
        if enc == "gzip":
            import gzip
            return gzip.decompress(raw), None
        if enc == "deflate":
            import zlib
            return zlib.decompress(raw), None
    except Exception as e:
        return raw, f"{enc}: {e}"
    return raw, f"unknown content-encoding: {enc}"


def _is_chatgpt_backend(upstream):
    return "chatgpt.com/backend-api" in (upstream or "")


def _is_openai_body(obj):
    """Responses-API request shape (codex) vs anthropic messages shape — the
    discriminator for mixed-provider stores (_LAST_REQUEST, last_request rows)."""
    return (isinstance(obj, dict) and "messages" not in obj
            and ("input" in obj or "instructions" in obj))


def _is_prompt_item_openai(item):
    """Prompt-bearing user input item (the openai-wire analogue of
    _is_prompt_msg): a user message with real text — codex wraps machine
    context (<environment_context>, <permissions instructions>) in <…> blocks."""
    if not (isinstance(item, dict) and item.get("type") == "message"
            and item.get("role") == "user"):
        return False
    return any((c.get("text") or "").lstrip()
               and not (c.get("text") or "").lstrip().startswith("<")
               for c in (item.get("content") or []) if isinstance(c, dict))


def _read_codex_auth(path=None):
    """(access_token, account_id) from codex's auth.json; (None, None) on any
    error — the request then forwards as-is and upstream rejects it cleanly."""
    try:
        data = json.loads((path or CODEX_AUTH_FILE).read_text())
        tokens = data.get("tokens") or {}
        return tokens.get("access_token"), tokens.get("account_id")
    except Exception:
        return None, None


def _rewrite_chatgpt_request(upstream_path, headers, auth_path=None):
    """Strip the /v1 prefix and swap in ChatGPT OAuth headers (mutates and
    returns `headers`). Path untouched when auth.json is unreadable — a clean
    upstream 401 beats a half-rewritten request."""
    access_token, account_id = _read_codex_auth(auth_path)
    if not access_token:
        return upstream_path, headers
    if upstream_path.startswith("/v1/"):
        upstream_path = upstream_path[3:]
    elif upstream_path.split("?")[0] == "/v1":
        upstream_path = "/" + upstream_path[3:].lstrip("/")
    for k in list(headers):
        if k.lower() == "authorization":
            del headers[k]
    headers["authorization"] = f"Bearer {access_token}"
    if account_id:
        headers["chatgpt-account-id"] = account_id
    # mirror codex's native headers so upstream's client classifier stays happy
    headers.setdefault("originator", "codex_cli_rs")
    headers.setdefault("openai-beta", "responses=experimental")
    return upstream_path, headers


def _sse_text_delta(obj, wire):
    """Assistant text out of one decoded SSE data object, per wire dialect."""
    if wire == "openai":
        if obj.get("type") == "response.output_text.delta":      # Responses API
            d = obj.get("delta")
            return d if isinstance(d, str) and d else None
        choices = obj.get("choices")                             # Chat Completions
        if isinstance(choices, list) and choices:
            c = (choices[0].get("delta") or {}).get("content")
            return c if isinstance(c, str) and c else None
        return None
    if obj.get("type") != "content_block_delta":                 # anthropic
        return None
    delta = obj.get("delta") or {}
    if delta.get("type") == "text_delta":
        return delta.get("text") or None
    return None


def _output_items_from_sse(blob):
    """Ordered list of COMPLETED assistant output items (message / reasoning /
    function_call) from a captured Responses-API SSE stream — the assistant side
    of one codex turn, for the codex-WS transcript reconstructor (report.py).

    Each `response.output_item.done` event carries the FULL item, so we take
    those and ignore the incremental deltas. Returns [] on a non-SSE/error body
    (4xx errors come back unframed) — the reconstructor just shows no output for
    that turn rather than failing."""
    items = []
    if isinstance(blob, (bytes, bytearray)):
        s = blob.decode("utf-8", "replace")
    else:
        s = blob or ""
    if "data:" not in s:
        return items
    for frame in re.split(r"\r?\n\r?\n", s):
        data_lines = [ln[5:].lstrip() for ln in frame.split("\n")
                      if ln.startswith("data:")]
        if not data_lines:
            continue
        try:
            obj = json.loads("\n".join(data_lines))
        except Exception:
            continue
        if obj.get("type") == "response.output_item.done":
            it = obj.get("item")
            if isinstance(it, dict):
                items.append(it)
    return items


def _parse_openai_response(blob):
    """Usage/meta out of a captured Responses-API SSE stream (or a plain JSON
    error body — 4xx come back unframed). response.completed carries the FULL
    response object incl. usage; text is capped (the .sse has the real thing)."""
    meta = {"text": "", "usage": None, "resolved_model": None,
            "response_id": None, "status": None, "error": None}
    s = blob.decode("utf-8", "replace")
    if "data:" not in s:
        try:
            meta["error"] = json.loads(s)
        except Exception:
            meta["error"] = s[:500] or None
        return meta
    for frame in re.split(r"\r?\n\r?\n", s):
        data_lines = [ln[5:].lstrip() for ln in frame.split("\n")
                      if ln.startswith("data:")]
        if not data_lines:
            continue
        try:
            obj = json.loads("\n".join(data_lines))
        except Exception:
            continue
        t = obj.get("type")
        if t == "response.output_text.delta":
            if len(meta["text"]) < billing_mod._META_TEXT_CAP:
                meta["text"] += obj.get("delta") or ""
        elif t in ("response.completed", "response.incomplete", "response.failed"):
            r = obj.get("response") or {}
            meta["usage"] = r.get("usage")
            meta["resolved_model"] = r.get("model")
            meta["response_id"] = r.get("id")
            meta["status"] = r.get("status")
            if t == "response.failed" and r.get("error"):
                meta["error"] = r.get("error")
        elif t == "error":
            meta["error"] = obj
    meta["text"] = meta["text"][:billing_mod._META_TEXT_CAP]
    return meta
