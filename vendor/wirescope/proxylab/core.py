"""proxylab core: process identity + the constants everything else builds on.

wirescope began as a throwaway capture proxy (#2873/#2874) and grew into the
lab's analytical forward-proxy: byte-verbatim forwarding with full capture,
billing receipts, prefix-warmth economics, keep-warm pinger/holds, request
transforms, and an app-agnostic subscriber push feed (SUBSCRIBERS.md).
Mission unchanged: FIND & PRICE CONTEXT WASTE; STAY NON-INTRUSIVE. The module
map + durable conclusions live in CLAUDE.md; launch via start_proxy.sh /
run_release.sh (never as a CLI background job).

This module owns the shared foundation and IMPORTS NOTHING from the package
(everyone may import core): UPSTREAM, LOG_DIR, the request counter, version
self-report, the shared httpx client, the /agent/<name>/ route regex, and
header hygiene (_HOP, _SECRET_HEADERS, _safe_headers).

Capture layout (one subdirectory per session):
  LOG_DIR/<session_id>/<seq>-<agent>-<role>-<model>-<ts>.request.json
  LOG_DIR/<session_id>/<seq>-...-.response.sse | .response.json
  LOG_DIR/<session_id>/_session.json   per-session running total
  LOG_DIR/_no-session/...              count_tokens + probes (carry no metadata)
  LOG_DIR/_totals.json                 global process-lifetime total
The session_id is parsed out of metadata.user_id (itself a JSON string). All
disk writes go through the writer thread — nothing on the byte path blocks.

Point a CLI at the proxy either way:
  - bare:   ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  - routed: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/agent/<name>/anthropic
            (codex: .../agent/<name>/openai) — <name> becomes the session's
            agent identity: dump filenames, /_status titles, subscriber routing.
"""
import datetime
import itertools
import json
import os
import re
import time
from pathlib import Path

import httpx

UPSTREAM = "https://api.anthropic.com"
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/proxyclone/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)


def _session_dir(session):
    """LOG_DIR/<session>, traversal-confined. Endpoint `session=` params reach
    filesystem globs (/_report, /_timeline, /_session, /_context&utilization),
    so a traversal-shaped id ('../..', absolute, or anything with a separator)
    must not escape the capture root. Real ids are single path components
    (UUIDs / the NO_SESSION bucket). Invalid ids map to a reserved never-created
    name so every caller's existing is_dir()/OSError guard fails closed — no
    call-site changes, no new error paths."""
    s = str(session or "")
    if not s or "/" in s or "\\" in s or s in (".", ".."):
        return LOG_DIR / "_invalid-session-id"
    return LOG_DIR / s


# --- cheap capture reads ----------------------------------------------------
# A request record holds that turn's whole `messages` array (mean 0.37 MB, and
# 347 KB/turn on a long clodex session), so json.loads-ing one to reach a field
# the writer puts at the head or the tail is the single most expensive mistake a
# capture-dir scan can make: it is the difference between a scan that costs
# milliseconds and one that costs tens of seconds. These live in core rather
# than report because both report._bust_scan and status._capture_scan need them
# and core is the one module everyone may import.

# `"ts": "<iso>"` as the writer emits it at the head of a request record.
_TS_HEAD_RE = re.compile(rb'"ts"\s*:\s*"([^"]+)"')


def _head_ts(path, nbytes=200):
    """The capture's `ts` read from the first `nbytes` of a request record, WITHOUT
    parsing the body. `ts` is the 2nd key the writer emits (server.py `record = {...}`),
    measured at byte offset 17-20 across the corpus, so a 200-byte read is a ~10x
    guard rather than a gamble; a miss returns None and the caller falls back to a
    full parse. Exists because ordering the series needs only this one field while a
    full json.load pays for the whole `messages` array (mean 0.37 MB)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(nbytes)
    except OSError:
        return None
    m = _TS_HEAD_RE.search(head)
    return m.group(1).decode("utf-8", "replace") if m else None


def _epoch_ts(ts):
    """Capture timestamps come two ways: request.json `ts` is an ISO-8601 string
    ('2026-06-13T19:01:56'), warmth.json `ts` is an epoch float. Normalise to a
    float epoch (None if unparseable) so idle-gap and window math works."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return float(ts)
    try:
        return datetime.datetime.fromisoformat(ts).timestamp()
    except (ValueError, TypeError):
        return None


def _tail_summary(path, nbytes=4096):
    """The capture's `summary` dict read from the LAST `nbytes` of a request record,
    without parsing the body. The writer emits `summary` as the final key (verified:
    no key follows it anywhere in the corpus) and it measures <1 KB, so a 4 KB tail
    read reaches it whole; the scan finds the last `"summary"` and brace-matches its
    object. Returns None if it isn't found intact — caller falls back to a full parse,
    so this is an optimisation with a correct slow path, never a source of wrong data.

    Validated against a full parse on 4,134 requests sampled across all 1,039 capture
    dirs: 0 misses, 0 disagreements."""
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, 2)
            fh.seek(max(0, size - nbytes))
            tail = fh.read()
    except OSError:
        return None
    k = tail.rfind(b'"summary"')
    if k < 0:
        return None
    start = tail.find(b"{", k)
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(tail)):
        c = tail[i : i + 1]
        if c == b"{":
            depth += 1
        elif c == b"}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(tail[start : i + 1])
                except Exception:
                    return None
                return obj if isinstance(obj, dict) else None
    return None

# hop-by-hop + accept-encoding (we want an uncompressed SSE stream we can read)
_HOP = {"host", "content-length", "connection", "transfer-encoding",
        "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
        "trailers", "upgrade", "accept-encoding"}

_counter = itertools.count(1)
_START_TS = time.time()


def _detect_version():
    """Self-identify the running code so /_status//_admin say WHICH release
    serves a port (the handoff-notes way went stale within a day). Release
    worktrees carry a RELEASE stamp written by release.sh; a dev tree falls
    back to git describe and says so."""
    root = Path(__file__).resolve().parent.parent
    try:
        stamp = (root / "RELEASE").read_text().strip()
        if stamp:
            return stamp
    except OSError:
        pass
    try:
        import subprocess
        out = subprocess.run(
            ["git", "-C", str(root), "describe", "--tags", "--always", "--dirty"],
            capture_output=True, text=True, timeout=3)
        desc = out.stdout.strip()
        if out.returncode == 0 and desc:
            # an exact clean tag (old release worktrees predate the RELEASE
            # stamp) is the release itself; anything else is a dev state
            exact = "-g" not in desc and not desc.endswith("-dirty")
            return desc if exact else desc + " (dev tree)"
    except Exception:
        pass
    return "unknown"


VERSION = _detect_version()
print(f"[proxy] code version: {VERSION}", flush=True)
_client = httpx.AsyncClient(timeout=httpx.Timeout(600.0), follow_redirects=False)

# /agent/<name>/anthropic/<rest>  ->  (name, /<rest>)
_ROUTE = re.compile(r"^/agent/(?P<name>[A-Za-z0-9_.-]+)/anthropic(?P<rest>/.*)?$")

# Inbound transport identity. The body's session_id is absent on count_tokens
# pre-flights, but the CLI stamps these on EVERY request, and they identify the
# calling CLI process/build/account (the "who sent this" the metadata omits).
# Secrets are redacted — never write the caller's API key to disk.
_SECRET_HEADERS = {"authorization", "x-api-key", "cookie", "proxy-authorization",
                   "chatgpt-account-id", "openai-api-key",
                   # response-side: upstream CDNs (Cloudflare on the codex
                   # backend) set live session cookies — never persist them
                   "set-cookie"}


def _safe_headers(headers):
    return {k: ("<redacted>" if k.lower() in _SECRET_HEADERS else v)
            for k, v in headers.items()}


# Process-wide error counters (server increments, /_status reads — lives here
# because core is the one module everyone may import). A nonzero
# transform_errors means OUR chain crashed on some shape and the request
# forwarded fail-open with degraded capture — loud, not silent.
ERROR_COUNTS = {"transform_errors": 0, "meta_errors": 0}

# Opt-in control-plane auth (open item (g)): when set, every /_ endpoint except
# the /_identity discovery handshake requires it — Bearer header or ?token=.
# Unset (default) keeps the single-user-localhost open surface. The reason this
# exists: the open surface COMPOSES badly with the pinger's in-memory auth
# replay — /_ping can originate authenticated upstream SPEND, /_prune deletes
# captures, /_hold//_strip//_end mutate session state. Advertised on /_identity
# as capabilities.endpoint_token so a consumer knows to send it.
ENDPOINT_TOKEN = os.environ.get("ENDPOINT_TOKEN", "")
