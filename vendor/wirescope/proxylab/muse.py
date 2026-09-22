import json
import os
import re
import time
from urllib.parse import urlsplit

from proxylab import core as core_mod

# --- META / MUSE CODE PROVIDER (route + capture + pricing; 2026-09-22) --------
# /agent/<name>/meta/<rest> routes Meta's Muse Code CLI (`muse`) to
# UPSTREAM_META. Muse speaks the OpenAI Responses API on the wire (POST
# /responses, SSE, usage.input_tokens_details.cached_tokens), so it rides the
# codex handler with a provider switch; what differs is everything AROUND the
# model call, and every line below was read off a local capture, not guessed:
#   * session identity is the `x-tbh-session-id` header; the body's
#     `prompt_cache_key` is `tbh:main:<session-uuid>` on the main line and
#     `tbh:<kind>:<session8>:<h>:<h>` on the CLI's reminder-observer side-calls
#     (goal-reminder / skill-reminder / verify-reminder), each of which carries
#     its OWN x-tbh-session-id. The 8-char fragment is the only link back to
#     the parent, so we remember main uuids by prefix and file the side-calls
#     under the parent session as a priced-apart bucket (one "say hi" prompt =
#     1 main call + 3 observer calls of 8k-25k instruction chars each).
#   * tools arrive as ONE `type:"namespace"` tool named `muse` wrapping the
#     nested `type:"function"` tools — a flat roster must unwrap it.
#   * the model catalog `GET /muse-code/models` (and the other /muse-code/*
#     product paths) is requested at the ORIGIN with the --base-url path prefix
#     DROPPED, and a 4xx on it aborts the run before any model call. So the
#     proxy serves /muse-code/* at its root, forwarding to the upstream origin.
#   * that catalog (OpenAI-style `{object,data:[{id,metadata:{"muse-code":…}}]}`,
#     live 2026-09-22) carries model ids, limits and `is_hidden` but NO cost
#     rows — so the price table below is the published list price, and the
#     catalog is learned for its ROSTER (which ids exist, their context
#     limits) plus any `cost` block that appears later (parsed if present,
#     never assumed). A model the catalog names that the table does not
#     price is reported unpriced, never guessed.
#   * every response stream carries ONE `response.subscription_usage` event:
#     {subscription:{tier, weekly:{resets_at,used_percent},
#     window:{resets_at,used_percent,window_duration_mins:300}}} — the plan
#     quota, account-scoped like the anthropic ratelimit headers; surfaced
#     as `subscription` on the receipt, turn.completed and /_status.
# Caching is server-side with no TTL (cached_tokens is the only warmth signal):
# NO warmth/pinger/hold/transform/quota machinery applies, exactly as for codex.
_ROUTE_META = re.compile(r"^/agent/(?P<name>[A-Za-z0-9_.-]+)/meta(?P<rest>/.*)?$")
_ROUTE_META_PRODUCT = re.compile(r"^/muse-code/")
UPSTREAM_META = os.environ.get("UPSTREAM_META", "https://api.meta.ai/v1").rstrip("/")


def _origin(url):
    u = urlsplit(url)
    return f"{u.scheme}://{u.netloc}"


UPSTREAM_META_ORIGIN = os.environ.get("UPSTREAM_META_ORIGIN") or _origin(UPSTREAM_META)
_MUSE_STATS = {"requests": 0, "responses": 0, "input_tokens": 0,
               "cached_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
               "errors": 0, "product_requests": 0, "sidecalls": 0,
               "sidecalls_deferred": 0, "catalog_learned_at": None,
               "catalog_models": [], "subscription": None}

# Published Muse Spark list price (USD per 1M tokens), fetched 2026-09-22;
# the live catalog carries no cost rows (verified), so this IS the table —
# a catalog `cost` block, should one appear, overrides a row (source=catalog).
# Longest-prefix: the `-contributor` variants price as their base model.
PRICES_META = {
    "muse-spark-1.3": {"in": 1.25, "cached_in": 0.15, "out": 4.25},
    "muse-spark-1.2": {"in": 1.25, "cached_in": 0.15, "out": 4.25},
}
CATALOG_LIMITS = {}          # model id -> {context, output} off the catalog
_CATALOG_FILE = core_mod.LOG_DIR / "_meta_catalog.json"
_CACHE_KEY_RE = re.compile(r"^tbh:(?P<kind>[a-z-]+):(?P<sess>[0-9a-f-]{8,})")
_SESSION_BY_PREFIX = {}      # session8 -> full main-line session uuid
_SESSION_BY_PREFIX_MAX = 512


def _is_muse_body(obj):
    """A Responses-API body that came from muse: the namespace tool wrapper
    or the tbh: cache-key vocabulary (either alone is decisive; codex uses
    neither)."""
    if not isinstance(obj, dict):
        return False
    pck = obj.get("prompt_cache_key")
    if isinstance(pck, str) and pck.startswith("tbh:"):
        return True
    return any(isinstance(t, dict) and t.get("type") == "namespace"
               for t in (obj.get("tools") or []))


def _parse_cache_key(pck):
    """`tbh:main:<uuid>` -> {kind:"main", session:<uuid>}; `tbh:<kind>:<s8>:…`
    -> {kind, session:<s8>}. None when it is not muse vocabulary."""
    if not isinstance(pck, str):
        return None
    m = _CACHE_KEY_RE.match(pck)
    if not m:
        return None
    return {"kind": m.group("kind"), "session": m.group("sess")}


# The TUI's IDLE side-calls ride the MAIN cache key (`tbh:main:<session>`,
# the session's own x-tbh-session-id) so nothing in the key vocabulary
# separates them from the conversation. What does: they ship NO `tools` and
# NO `instructions` (one live session, 27 main-key captures: the 21
# conversation calls all carry both, the 6 idle calls carry neither), and
# their last input item is a user
# message opening with a fixed prompt. Openers are the exact bytes off the
# captures (session 01a0ca63, 2026-09-22; seqs 045/076/084 byte-identical
# for the tip-picker, seq 113 for the away-recap), never paraphrased:
#   tip-picker  — after every turn, once the user is idle: picks one feature
#                 tip from a candidate list or answers `NONE` (~5.3k in,
#                 ~400 out of reasoning, per turn).
#   away-recap  — when the user returns after stepping away: a two-line
#                 Title:/Recap: of the current task.
# Before this classifier they were filed as the main line: the idle call
# became the session's last request (so /_context showed tools:null
# whenever the seat was idle), counted as a turn, and priced under
# `main_est_usd`. An unlisted call of the same SHAPE files as `idle` — a
# name for the shape, so a new idle prompt still cannot clobber the
# conversation's view state.
_IDLE_SIDECALL_OPENERS = (
    ("tip-picker", "You are picking one optional feature tip for a user who "
                   "just finished a turn and is idle."),
    ("away-recap", "The user stepped away and is coming back. Return exactly "
                   "two plain-text lines."),
)


def _idle_sidecall_kind(obj):
    """The idle side-call kind of a main-key body, or None for a conversation
    call. Shape first (no tools, no instructions), then the opener."""
    if not isinstance(obj, dict) or obj.get("tools") or obj.get("instructions"):
        return None
    inp = obj.get("input")
    if not isinstance(inp, list) or not inp:
        return None
    last = inp[-1]
    if not (isinstance(last, dict) and last.get("type") == "message"
            and last.get("role") == "user"):
        return None
    c = last.get("content")
    text = (c if isinstance(c, str)
            else "".join(b.get("text") or "" for b in (c or []) if isinstance(b, dict)))
    text = text.lstrip()
    for kind, opener in _IDLE_SIDECALL_OPENERS:
        if text.startswith(opener):
            return kind
    return "idle"


def _session_identity(headers, obj):
    """(session_id, sidecall_kind, parent_prefix) for one muse request.
    Main line: the x-tbh-session-id header (== the cache key's uuid),
    remembered by its 8-char prefix; parent_prefix None. Side-call: resolved
    to the PARENT session through that prefix map (its own header id is a
    throwaway per-observer uuid). When the parent is not (yet) known the call
    keys on its own header id and parent_prefix is the fragment to retry —
    live-measured: the skill-reminder observer fires BEFORE the main call
    of the same prompt (seq 2 vs 3, same second), so a first-turn side-call
    is always an orphan at request time and resolves by receipt time.
    A main-key body with the idle side-call shape (`_idle_sidecall_kind`)
    is a side-call of that kind on the session itself — same treatment,
    no prefix hop."""
    own = headers.get("x-tbh-session-id") or headers.get("x-meta-ai-gateway-session-id")
    ck = _parse_cache_key((obj or {}).get("prompt_cache_key")) if isinstance(obj, dict) else None
    if ck is None:
        return own, None, None
    if ck["kind"] == "main":
        sid = own or ck["session"]
        _SESSION_BY_PREFIX[sid[:8]] = sid
        if len(_SESSION_BY_PREFIX) > _SESSION_BY_PREFIX_MAX:
            _SESSION_BY_PREFIX.pop(next(iter(_SESSION_BY_PREFIX)))
        return sid, _idle_sidecall_kind(obj), None
    prefix = ck["session"][:8]
    parent = _SESSION_BY_PREFIX.get(prefix)
    if parent:
        return parent, ck["kind"], None
    return (own or ck["session"]), ck["kind"], prefix


def _resolve_parent(prefix):
    return _SESSION_BY_PREFIX.get(prefix) if prefix else None


def _subscription_usage(blob, now=None):
    """The plan-quota snapshot off a response stream's
    `response.subscription_usage` event (last one wins), stamped with `at`;
    None when the stream carried none. Also cached account-wide on
    _MUSE_STATS["subscription"] (the newest reading, like quota_state)."""
    if not blob:
        return None
    found = None
    for line in blob.splitlines():
        if not line.startswith(b"data:"):
            continue
        if b"response.subscription_usage" not in line:
            continue
        try:
            d = json.loads(line[5:].strip())
        except Exception:
            continue
        if d.get("type") == "response.subscription_usage" and isinstance(d.get("subscription"), dict):
            found = d["subscription"]
    if found is None:
        return None
    snap = dict(found)
    snap["at"] = round(now if now is not None else time.time(), 3)
    _MUSE_STATS["subscription"] = snap
    return snap


def _flatten_namespace_tools(tools):
    """The flat function list behind muse's namespace wrapper (non-namespace
    entries pass through untouched, so a codex-style flat list is a no-op)."""
    out = []
    for t in tools or []:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "namespace":
            out.extend(x for x in (t.get("tools") or []) if isinstance(x, dict))
        else:
            out.append(t)
    return out


def _rate(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def learn_catalog(body, now=None):
    """Learn the model ROSTER (+ limits, + any cost block) from a captured
    /muse-code/models response. Returns {"models": n, "priced": m}: `models`
    = rows recognised, `priced` = rows that carried a parseable cost (0 on
    the live catalog — it has none). A model on the roster with no price
    row in PRICES_META is announced once, so an unpriced id is loud before
    its first turn rather than after."""
    if isinstance(body, (bytes, bytearray)):
        try:
            body = json.loads(body)
        except Exception:
            return {"models": 0, "priced": 0}
    rows = (body or {}).get("data") if isinstance(body, dict) else None
    models, priced = [], 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        mid = row.get("id") or row.get("model_id")
        if not mid:
            continue
        mc = (row.get("metadata") or {}).get("muse-code") or {}
        models.append(mid)
        lim = mc.get("limit") or row.get("limit")
        if isinstance(lim, dict):
            CATALOG_LIMITS[mid] = {"context": lim.get("context"),
                                   "output": lim.get("output")}
        cost = mc.get("cost") or row.get("cost") or {}
        i, o, c = _rate(cost.get("input")), _rate(cost.get("output")), _rate(cost.get("cached"))
        if i is not None and o is not None:
            PRICES_META[mid] = {"in": i, "cached_in": c if c is not None else i,
                                "out": o, "currency": cost.get("currency") or "USD",
                                "source": "catalog"}
            priced += 1
    if models:
        _MUSE_STATS["catalog_learned_at"] = round(now if now is not None else time.time(), 3)
        _MUSE_STATS["catalog_models"] = models
        unpriced = [m for m in models if not any(m.startswith(p) for p in PRICES_META)]
        if unpriced:
            print(f"[muse] catalog names {unpriced} with no PRICES_META row — "
                  "their traffic will be unpriced (catalog carries no cost)", flush=True)
        try:
            _CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            _CATALOG_FILE.write_text(json.dumps(
                {"learned_at": _MUSE_STATS["catalog_learned_at"],
                 "models": models, "limits": CATALOG_LIMITS,
                 "prices": PRICES_META}, indent=1))
        except OSError:
            pass
    return {"models": len(models), "priced": priced}


def _load_catalog():
    """Boot-time reload of the last learned catalog (a restart between two
    catalog fetches must not fall back to the seed)."""
    try:
        saved = json.loads(_CATALOG_FILE.read_text())
    except (OSError, ValueError):
        return 0
    prices = saved.get("prices") if isinstance(saved, dict) else None
    if not isinstance(prices, dict):
        return 0
    n = 0
    for mid, p in prices.items():
        if isinstance(p, dict) and "in" in p and "out" in p:
            PRICES_META[mid] = p
            n += 1
    lim = saved.get("limits")
    if isinstance(lim, dict):
        CATALOG_LIMITS.update(lim)
    if saved.get("models"):
        _MUSE_STATS["catalog_models"] = list(saved["models"])
        _MUSE_STATS["catalog_learned_at"] = saved.get("learned_at")
    return n


_load_catalog()
