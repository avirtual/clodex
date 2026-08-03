"""Context-window token ESTIMATION, calibrated against the wire receipt.

Why this module exists: `/_session` priced every cache breakpoint and turn chip
at a flat `chars // 4`, which ran **~33% under the truth** (median across 35
breakpoints in 10 sessions; worst case 188%). The header on the same page shows
the real receipt, so the two numbers disagreed by ~35k tokens on a 100k window
and the breakpoint implied a 40k uncached tail where the true tail was 2 tokens.

The correction rests on one fact the wire hands us for free, per request:

    cache_read_input_tokens + cache_creation_input_tokens
        == the EXACT token count of the prefix through the LAST cache marker

Measured against `/v1/messages/count_tokens` on 10 sessions, that identity holds
to a constant **+41…+45 tokens** of framing (0.04–0.24%) — an additive offset,
not a scale error. So every captured request carries one exactly-known point on
its own cumulative-token curve. We fit the level of the estimate to THAT point
(`calibrate()`), which is why the numbers agree with the header by construction
instead of by luck.

Four things the flat /4 got wrong, each measured rather than guessed:

1. **Per-segment density.** Dense JSON tool schemas tokenize far denser than
   prose. Marginal rate measured by adding tools one at a time: **2.71 ch/tok**
   for schemas, **3.38** for system prose, **2.98** for message JSON.
2. **Fixed tool preamble.** A request with tools[] pays ~**219 tok** of
   server-side tool-use scaffolding that exists in NO character we capture. This
   is what made small tools-only breakpoints read 50%+ low.
3. **Images tokenize by PIXEL AREA, not characters.** One captured 2000x552 PNG
   was 294,696 base64 chars but only **1,443 tokens** — 204 ch/tok against ~2.6
   for text. Any char-based estimate is off by ~80x on an image-bearing turn
   (this single session drove the 188% worst case). Images are priced by
   `w*h/750` and EXCLUDED from the char count.
4. **Request framing.** An empty request is **7 tok**, not 0.

Accuracy, vs `count_tokens` ground truth (the calibration anchor itself is
excluded from the "intermediate" figure, since it is fitted and would flatter
the result):

    estimator                       median    p90      max
    flat // 4  (what this replaces)  32.9%   66.6%   188.2%
    this module                       2.7%   16.6%    23.3%
    ... on 8 HELD-OUT sessions        1.5%   15.1%    18.4%

Held-out validation used a different random seed and excluded every session the
constants were fitted on, so the numbers above are not in-sample.

**These are still ESTIMATES.** The API reports usage per REQUEST only — there is
no per-block, per-message or per-section token attribution on the wire. The one
exact quantity is the calibration anchor. Callers that render a non-anchor
number should mark it approximate; `calibrate()` returns the anchor so a caller
can tell the two apart.

TWO THINGS ALREADY TRIED AND REJECTED, so they aren't re-attempted:

- **A second free anchor from `cache_read` alone.** Tempting, since a receipt
  carries both `cache_read` and `cache_read + cache_creation`. But `cache_read`
  is the prefix cached by an EARLIER request at an index we don't have; measured
  on a real capture it was 99,872 against second-to-last-marker truth of 48,666.
  It anchors nothing you can place.
- **Applying the correction to the messages segment only** (leaving the
  tools+system head on raw constants). Better in-sample and better on median,
  and it is WRONG: split by breakpoint type on 66 clean held-out breakpoints, it
  was a coin flip where the head dominates (19/40) and clearly worse wherever
  messages exist (max 17.7% vs 3.3%, winning 2/26). The median gain came from
  head-only breakpoints being the majority of the sample, not from the model
  being better. Scaling the whole prefix is what ships.
"""

import base64
import json
import struct

# Marginal ch/tok by segment, measured 2026-08-03 by incremental count_tokens
# (see module docstring). Tool schemas are denser than the 2.8 status.py uses
# for the same job; that constant was calibrated against a session's own
# /context readout rather than count_tokens, and is left alone here.
#
# SYSTEM was first grid-fitted at 3.38 against whole-request anchors, then
# re-measured DIRECTLY by differencing (count(tools+system) - count(tools)) over
# 12 sessions: median 3.11. The fit was biased because those anchors are
# message-dominated, so system prose barely constrained them — and the error
# lands entirely on the tools/system breakpoints, which carry no message
# content for the calibration to correct. Differencing isolates the segment;
# prefer it for any future re-measurement.
TOOLS_CHARS_PER_TOK = 2.71      # differenced: 2.69 median, 2.62–2.74
SYSTEM_CHARS_PER_TOK = 3.11     # differenced: 3.11 median, 2.43–3.18
MESSAGE_CHARS_PER_TOK = 2.98

# Costs that exist in no captured character.
TOOL_PREAMBLE_TOKENS = 219   # server-side tool-use scaffolding, iff tools[]
REQUEST_BASE_TOKENS = 7      # framing of an otherwise-empty request

_IMAGE_PIXELS_PER_TOK = 750
_IMAGE_MAX_TOKENS = 1600     # API caps a single image here
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# A calibration factor outside this range means the anchor and the body
# disagree about what was sent (a transform ran between capture and receipt, a
# truncated capture, a mismatched response). Clamp rather than propagate: a
# wrong-but-bounded estimate beats a confidently absurd one.
_K_MIN, _K_MAX = 0.6, 1.6


def image_tokens(block):
    """Tokens for one image block, from PIXEL AREA (`w*h/750`, capped).

    Base64 length is meaningless here — a measured 2000x552 PNG carried 294,696
    chars for 1,443 tokens. Reads dimensions from the PNG header, which needs
    only the first 24 bytes, so we decode a 64-char prefix rather than the whole
    payload. Falls back to a bytes-based guess for other formats (JPEG/WebP
    dimensions need real parsing and images are rare enough not to warrant it).
    """
    src = block.get("source") or {}
    data = src.get("data") or ""
    if not data:
        return 0
    try:
        head = data[:64]
        raw = base64.b64decode(head + "=" * ((4 - len(head) % 4) % 4))
        if raw[:8] == _PNG_MAGIC:
            w, h = struct.unpack(">II", raw[16:24])
            if w and h:
                return min(_IMAGE_MAX_TOKENS, round(w * h / _IMAGE_PIXELS_PER_TOK))
    except Exception:
        pass
    # ~3 bytes/px is a rough mid-quality compressed density; bounded by the cap.
    return min(_IMAGE_MAX_TOKENS, round(len(data) * 0.75 / _IMAGE_PIXELS_PER_TOK))


def message_cost(msg):
    """(chars, fixed_tokens) for one message.

    Image blocks contribute FIXED tokens and are removed from the char count —
    left in, one screenshot's base64 would swamp every other number on the page.
    Recurses into tool_result content, where images from Read/screenshot tools
    actually live."""
    fixed = 0

    def strip(b):
        nonlocal fixed
        if not isinstance(b, dict):
            return b
        if b.get("type") == "image":
            fixed += image_tokens(b)
            return {"type": "image", "source": {}}
        if b.get("type") == "tool_result" and isinstance(b.get("content"), list):
            return {**b, "content": [strip(x) for x in b["content"]]}
        return b

    content = msg.get("content")
    if isinstance(content, list):
        msg = {**msg, "content": [strip(b) for b in content]}
    return len(json.dumps(msg, ensure_ascii=False)), fixed


def raw_tokens(tools_ch=0, system_ch=0, message_ch=0, fixed_tokens=0,
               has_tools=False):
    """Uncalibrated token estimate for a prefix, from its segment char counts."""
    return (REQUEST_BASE_TOKENS
            + tools_ch / TOOLS_CHARS_PER_TOK
            + system_ch / SYSTEM_CHARS_PER_TOK
            + message_ch / MESSAGE_CHARS_PER_TOK
            + fixed_tokens
            + (TOOL_PREAMBLE_TOKENS if has_tools else 0))


def anchor_tokens(usage):
    """The EXACT token count of the prefix through the last cache marker, from a
    response receipt — or None when the receipt can't supply one.

    `cache_read + cache_write` is the whole cached prefix; `input_tokens` is the
    uncached tail after the last marker and is deliberately excluded. A receipt
    with no cache activity at all anchors nothing.

    Accepts BOTH shapes: the raw wire `cache_creation_input_tokens` and
    billing's normalized `cache_write_{5m,1h,flat}_tokens` (the shape
    `_entry_resp_usage` rebuilds from disk). Mirrors meta._input_token_total's
    5m+1h-else-flat rule so the two can't drift apart."""
    if not isinstance(usage, dict):
        return None
    read = usage.get("cache_read_input_tokens") or 0
    write = usage.get("cache_creation_input_tokens")
    if write is None:
        write = ((usage.get("cache_write_5m_tokens") or 0)
                 + (usage.get("cache_write_1h_tokens") or 0)) \
            or usage.get("cache_write_flat_tokens") or 0
    return (read + write) or None


def calibrate(anchor, anchor_raw, anchor_fixed=0):
    """Scale factor mapping this request's raw estimate onto its receipt.

    Fixed image tokens are already exact, so they are held OUT of both sides of
    the ratio — scaling them would corrupt a known quantity with a correction
    meant for the char-derived part. Returns 1.0 when nothing can be calibrated,
    so callers degrade to the raw estimate rather than to nonsense."""
    if not anchor:
        return None
    base = anchor_raw - anchor_fixed
    if base <= 0:
        return None
    k = (anchor - anchor_fixed) / base
    return min(_K_MAX, max(_K_MIN, k))


def apply(raw, fixed_tokens, k):
    """Apply a calibration factor, holding exact image tokens aside."""
    if k is None:
        return int(round(raw))
    return int(round((raw - fixed_tokens) * k + fixed_tokens))
