import asyncio
import atexit
import collections
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
from starlette.routing import Route

from proxylab import core as core_mod
from proxylab import writer as writer_mod

def _parse_usage_from_sse(raw_bytes):
    """Pull usage out of the captured SSE stream (message_start + message_delta)."""
    usage = {"input_tokens": None, "output_tokens": None,
             "cache_creation_input_tokens": None, "cache_read_input_tokens": None,
             "stop_reason": None}
    try:
        text = raw_bytes.decode("utf-8", "replace")
    except Exception:
        return usage
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            ev = json.loads(payload)
        except Exception:
            continue
        t = ev.get("type")
        if t == "message_start":
            u = (ev.get("message") or {}).get("usage") or {}
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                if u.get(k) is not None:
                    usage[k] = u[k]
            if u.get("output_tokens") is not None:
                usage["output_tokens"] = u["output_tokens"]
        elif t == "message_delta":
            u = ev.get("usage") or {}
            if u.get("output_tokens") is not None:
                usage["output_tokens"] = u["output_tokens"]
            d = ev.get("delta") or {}
            if d.get("stop_reason"):
                usage["stop_reason"] = d["stop_reason"]
    return usage


# response text kept in meta: was 500 (title harvest needs ~60); raised so the
# /_session view can show the LAST ANSWER — the reply to the final user message
# exists only in the response until the next turn re-ships it as input, so a
# request-only view always lagged one answer (user-reported 2026-06-10).
_META_TEXT_CAP = 4000


def _parse_response_meta(raw_bytes):
    """Capture the FULL metadata Anthropic returns, beyond the flat token counts.

    The flat `_parse_usage_from_sse` collapses cache tiers and drops everything
    else. This keeps the raw usage objects (cache_creation 5m/1h split,
    service_tier, inference_geo, output_tokens_details.thinking_tokens,
    iterations[]) plus message id, resolved model, stop details, content shape,
    and any error body. This is the "extra info from the Anthropic servers" the
    response carries that we were previously discarding.
    """
    meta = {"message_id": None, "resolved_model": None, "role": None,
            "stop_reason": None, "stop_sequence": None, "stop_details": None,
            "usage_start": None, "usage_final": None,
            "content_block_types": [], "tool_uses": [], "error": None,
            "text": ""}     # leading text, capped — enough for the title call
    try:
        text = raw_bytes.decode("utf-8", "replace")
    except Exception:
        return meta
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            ev = json.loads(payload)
        except Exception:
            continue
        t = ev.get("type")
        if t == "message_start":
            m = ev.get("message") or {}
            meta["message_id"] = m.get("id")
            meta["resolved_model"] = m.get("model")
            meta["role"] = m.get("role")
            meta["usage_start"] = m.get("usage")          # full obj (cache TTL split, service_tier, geo)
        elif t == "content_block_start":
            cb = ev.get("content_block") or {}
            meta["content_block_types"].append(cb.get("type"))
            if cb.get("type") == "tool_use":
                meta["tool_uses"].append(cb.get("name"))
        elif t == "content_block_delta":
            d = ev.get("delta") or {}
            if d.get("type") == "text_delta" and len(meta["text"]) < _META_TEXT_CAP:
                meta["text"] += d.get("text", "")
        elif t == "message_delta":
            if ev.get("usage") is not None:
                meta["usage_final"] = ev.get("usage")     # full obj (output_tokens_details, iterations[])
            d = ev.get("delta") or {}
            meta["stop_reason"] = d.get("stop_reason") or meta["stop_reason"]
            if d.get("stop_sequence") is not None:
                meta["stop_sequence"] = d.get("stop_sequence")
            meta["stop_details"] = d.get("stop_details") or meta["stop_details"]
        elif t in ("error", "rate_limit_error"):
            meta["error"] = ev.get("error") or ev
    return meta


# --- billing -----------------------------------------------------------------
# Approximate public list prices, USD per 1M tokens. EDIT as rates change.
# Matched by LONGEST model-name prefix (so "claude-opus-4-8" beats the legacy
# bare "claude-opus-4" entry). est_usd is a DERIVED estimate; the authoritative
# billing signal is the token breakdown itself. Write premiums: 5m=1.25x,
# 1h=2x; reads=0.10x of input. Verified against the API reference 2026-06-09.
# NOTE: opus REPRICED at 4.5 — $15/$75 is 4.0/4.1 ONLY; 4.5+ is $5/$25. Until
# this split, all opus-4.5+ captures (logs_opus) were over-priced ~3x.
PRICES = {
    "claude-fable-5":  {"in": 10.0, "out": 50.0, "cache_write_5m": 12.5,  "cache_write_1h": 20.0, "cache_read": 1.00},
    "claude-opus-4-5": {"in": 5.0,  "out": 25.0, "cache_write_5m": 6.25,  "cache_write_1h": 10.0, "cache_read": 0.50},
    "claude-opus-4-6": {"in": 5.0,  "out": 25.0, "cache_write_5m": 6.25,  "cache_write_1h": 10.0, "cache_read": 0.50},
    "claude-opus-4-7": {"in": 5.0,  "out": 25.0, "cache_write_5m": 6.25,  "cache_write_1h": 10.0, "cache_read": 0.50},
    "claude-opus-4-8": {"in": 5.0,  "out": 25.0, "cache_write_5m": 6.25,  "cache_write_1h": 10.0, "cache_read": 0.50},
    # legacy opus 4.0 / 4.1 (also catches their dated full ids)
    "claude-opus-4":   {"in": 15.0, "out": 75.0, "cache_write_5m": 18.75, "cache_write_1h": 30.0, "cache_read": 1.50},
    "claude-sonnet-4": {"in": 3.0,  "out": 15.0, "cache_write_5m": 3.75,  "cache_write_1h": 6.0,  "cache_read": 0.30},
    # sonnet-5 has TIME-DEPENDENT pricing: INTRODUCTORY ($2/$10) is in effect
    # through 2026-08-31; STANDARD ($3/$15, == sonnet-4) starts 2026-09-01.
    # Entry below is the INTRO rate (correct for all captures + live traffic
    # until the cutover). ⚠️ FLIP ON 2026-09-01 to in:3/out:15/w5m:3.75/
    # w1h:6.0/read:0.30 (or make _price_for date-aware — see note to fable).
    # Distinct model id (newer tokenizer, ~30% more tokens; wire counts already
    # reflect it, so no per-token adjustment — only the $/token rate differs).
    "claude-sonnet-5": {"in": 2.0,  "out": 10.0, "cache_write_5m": 2.50,  "cache_write_1h": 4.0,  "cache_read": 0.20},
    "claude-haiku-4":  {"in": 1.0,  "out": 5.0,  "cache_write_5m": 1.25,  "cache_write_1h": 2.0,  "cache_read": 0.10},
}

# OpenAI side (codex routes), same longest-prefix matching on their axes:
# no client cache writes (caching is server-side), cached input bills at 10%
# of input. developers.openai.com/api/docs/pricing, fetched 2026-06-12.
# NOTE: codex traffic rides a ChatGPT plan and is never dollar-billed —
# est_usd is the API-EQUIVALENT price of the same tokens, so codex carriage
# is comparable with the anthropic numbers in the same ledger.
PRICES_OPENAI = {
    "gpt-5.5":       {"in": 5.0,  "cached_in": 0.50,  "out": 30.0},
    "gpt-5.4":       {"in": 2.5,  "cached_in": 0.25,  "out": 15.0},
    "gpt-5.4-mini":  {"in": 0.75, "cached_in": 0.075, "out": 4.5},
    "gpt-5.3-codex": {"in": 1.75, "cached_in": 0.175, "out": 14.0},
}

def _new_totals():
    return {"requests": 0, "billed_requests": 0, "count_tokens_requests": 0,
            "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "est_usd": 0.0,
            # PRICING-BLINDNESS guard (open item f): est_usd EXCLUDES these.
            # A nonzero unpriced_requests means the cumulative $ is a floor,
            # not a total — the mission is to price waste, so say so loudly.
            "unpriced_requests": 0, "unpriced_models": [],
            # SERVER-SIDE refusal classifier hits (stop_reason:"refusal" —
            # zero content blocks, the model never ran; fable 2026-06-10).
            # Count + evidence -> a false-positive RATE and request_ids for
            # /feedback instead of anecdotes. The CLI hides all of this.
            "refusals": 0,
            # Completed user turns, RECEIPT-counted (2026-06-10): one terminal
            # response (stop_reason != tool_use) = one turn; tool-loop hops,
            # title side-calls and subagent traffic excluded at the call site
            # (stop["is_turn"]). CLI retries dedupe for free — a failed
            # request never produces a terminal response.
            "turns": 0}


_TOTALS = _new_totals()              # LOG_DIR-lifetime (reloaded at startup)
_SESSION_TOTALS = collections.defaultdict(_new_totals)    # per-session running totals
# Snapshot of _TOTALS right after the startup reload — /_status derives a
# "since_start" delta from it, so LOG_DIR-lifetime and this-process views both
# survive the restart-amnesia fix (item h: reload instead of zeroing).
_TOTALS_AT_START = {}


def _since_start():
    out = {}
    for k, v in _TOTALS.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            base = _TOTALS_AT_START.get(k)
            out[k] = round(v - (base if isinstance(base, (int, float)) else 0), 6)
    return out


_UNPRICED_WARNED = set()


def _price_for(model, table=None):
    """Longest-prefix match (the old first-dict-hit walk silently shadowed
    "claude-opus-4-8" with the legacy "claude-opus-4" entry). None = unpriced."""
    if not model:
        return None
    best = None
    for pfx, p in (PRICES if table is None else table).items():
        if model.startswith(pfx) and (best is None or len(pfx) > len(best[0])):
            best = (pfx, p)
    return best[1] if best else None


def _warn_unpriced(model, table_name):
    if model not in _UNPRICED_WARNED:
        _UNPRICED_WARNED.add(model)
        print(f"[pricing] WARNING: no {table_name} entry matches {model!r} — "
              "est_usd=None for its traffic; cumulative est_usd is now a FLOOR. "
              "Tracked in totals.unpriced_requests/unpriced_models; add rates "
              f"to {table_name}.", flush=True)


def _usd(tokens, rate_per_m):
    return round((tokens or 0) * rate_per_m / 1_000_000, 6)


def _billing(kind, model_resolved=None, usage_final=None, usage_start=None, count_tokens=None):
    """Formatted per-request billing. count_tokens is NOT billed for tokens
    (returns only an input count) — it spends request-rate-limit budget only."""
    if kind == "count_tokens":
        ct = count_tokens or {}
        return {"endpoint": "count_tokens", "billable": False,
                "note": "count_tokens not billed for tokens; consumes request-rate-limit only",
                "counted_input_tokens": ct.get("input_tokens"), "est_usd": 0.0}
    uf = usage_final or {}
    us = usage_start or {}
    cc = uf.get("cache_creation") or us.get("cache_creation") or {}
    tokens = {
        "input_tokens": uf.get("input_tokens", us.get("input_tokens")),
        "output_tokens": uf.get("output_tokens"),
        "cache_read_input_tokens": uf.get("cache_read_input_tokens", us.get("cache_read_input_tokens")),
        "cache_write_5m_tokens": cc.get("ephemeral_5m_input_tokens"),
        "cache_write_1h_tokens": cc.get("ephemeral_1h_input_tokens"),
        # flat total — fallback when the 5m/1h split is absent from the response
        "cache_write_flat_tokens": uf.get("cache_creation_input_tokens",
                                          us.get("cache_creation_input_tokens")),
        "thinking_tokens": (uf.get("output_tokens_details") or {}).get("thinking_tokens"),
        "service_tier": us.get("service_tier"),
    }
    p = _price_for(model_resolved)
    est = None
    unpriced = False
    basis = "approx public list USD/1M; edit PRICES"
    if p:
        w5, w1 = tokens["cache_write_5m_tokens"], tokens["cache_write_1h_tokens"]
        if w5 is None and w1 is None and tokens["cache_write_flat_tokens"]:
            # no TTL split returned: don't silently drop the write cost — price
            # the flat total at the cheaper 5m premium and say so in the basis.
            w5 = tokens["cache_write_flat_tokens"]
            basis += "; cache_creation split absent, flat total priced at 5m rate"
        est = round(_usd(tokens["input_tokens"], p["in"])
                    + _usd(tokens["output_tokens"], p["out"])
                    + _usd(tokens["cache_read_input_tokens"], p["cache_read"])
                    + _usd(w5, p["cache_write_5m"])
                    + _usd(w1, p["cache_write_1h"]), 6)
    elif model_resolved:
        # PRICING BLINDNESS guard: an unmatched model must be LOUD, not a silent
        # None that lets _totals.json keep reporting a confident under-count.
        unpriced = True
        _warn_unpriced(model_resolved, "PRICES")
    return {"endpoint": "messages", "billable": True, "model": model_resolved,
            "tokens": tokens, "est_usd": est, "unpriced": unpriced,
            "price_basis": basis}


def _billing_openai(model_resolved, usage):
    """Bill an openai /responses receipt in the same shape _bump consumes.
    OpenAI's input_tokens INCLUDES the cached portion — split it out so the
    shared totals keep anthropic semantics (input = uncached at full rate,
    cache_read = cached at the discounted rate). reasoning_tokens are part of
    output_tokens on their wire, surfaced as thinking_tokens."""
    u = usage or {}
    total_in = u.get("input_tokens") or 0
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens") or 0
    tokens = {
        "input_tokens": max(total_in - cached, 0),
        "output_tokens": u.get("output_tokens"),
        "cache_read_input_tokens": cached,
        "cache_write_5m_tokens": None, "cache_write_1h_tokens": None,
        "cache_write_flat_tokens": None,
        "thinking_tokens": (u.get("output_tokens_details") or {}).get("reasoning_tokens"),
        "service_tier": None,
    }
    p = _price_for(model_resolved, table=PRICES_OPENAI)
    est, unpriced = None, False
    basis = ("API-equivalent USD/1M (chatgpt-plan traffic is never "
             "dollar-billed); edit PRICES_OPENAI")
    if p:
        est = round(_usd(tokens["input_tokens"], p["in"])
                    + _usd(cached, p["cached_in"])
                    + _usd(tokens["output_tokens"], p["out"]), 6)
    elif model_resolved:
        unpriced = True
        _warn_unpriced(model_resolved, "PRICES_OPENAI")
    return {"endpoint": "responses", "billable": True, "model": model_resolved,
            "tokens": tokens, "est_usd": est, "unpriced": unpriced,
            "price_basis": basis}


def _bump(totals, bill, stop=None):
    totals["requests"] += 1
    if stop and stop.get("is_turn"):
        totals["turns"] = totals.get("turns", 0) + 1
    if stop and stop.get("stop_reason") == "refusal":
        totals["refusals"] = totals.get("refusals", 0) + 1
        # keep the FULL stop_details: the category + ToS explanation are the
        # only non-generic facts (the CLI flattens this to a toast), and the
        # /_session refusal banner renders them. `at` (epoch) lets the view
        # tell whether the captured last request IS the blocked context.
        ev = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "at": round(time.time(), 3),
              "model": bill.get("model"),
              "category": (stop.get("stop_details") or {}).get("category"),
              "stop_details": stop.get("stop_details"),
              "request_id": stop.get("request_id")}
        totals.setdefault("refusal_events", []).append(ev)
        del totals["refusal_events"][:-20]      # keep the last 20
    if bill.get("endpoint") == "count_tokens":
        totals["count_tokens_requests"] += 1
    else:
        totals["billed_requests"] += 1
        t = bill.get("tokens") or {}
        totals["input_tokens"] += t.get("input_tokens") or 0
        totals["output_tokens"] += t.get("output_tokens") or 0
        totals["cache_read_tokens"] += t.get("cache_read_input_tokens") or 0
        w = (t.get("cache_write_5m_tokens") or 0) + (t.get("cache_write_1h_tokens") or 0)
        totals["cache_write_tokens"] += w or (t.get("cache_write_flat_tokens") or 0)
        totals["est_usd"] = round(totals["est_usd"] + (bill.get("est_usd") or 0), 6)
        if bill.get("unpriced"):
            totals["unpriced_requests"] = totals.get("unpriced_requests", 0) + 1
            m = bill.get("model")
            models = totals.setdefault("unpriced_models", [])
            if m and m not in models:
                models.append(m)


def _accumulate(bill, session_key, stop=None, line=None):
    """Update the global + per-session running totals (the API never returns
    one) and enqueue both snapshots. Math runs on the event loop (cheap dict
    ops); the disk writes are handed to the background writer.

    `line` = the agent-line key (same vocabulary as report._line_key: "main"
    for the routed parent line, else the subagent instance's agent-id, role as
    fallback). When present, the same bill ALSO bumps a per-line sub-bucket
    under the session totals ("by_line"), so /_status / /_admin can answer
    "where did this session's money go" per subagent without a disk scan.
    The bucket rides INSIDE _SESSION_TOTALS -> persists in _session.json and
    restores through the existing restore path for free. Whole-session totals
    stay the top-level numbers; by_line is a decomposition, never a second
    count."""
    _bump(_TOTALS, bill, stop)
    sess = _SESSION_TOTALS[session_key]
    _bump(sess, bill, stop)
    if line:
        by = sess.setdefault("by_line", {})
        b = by.get(line)
        if b is None:
            b = by[line] = _new_totals()
        _bump(b, bill, stop)
    snap = dict(_TOTALS)
    writer_mod._enqueue_json(core_mod.LOG_DIR / "_totals.json", snap)
    # deep-copy the session snapshot: by_line nests dicts, and the writer
    # thread serializes AFTER we return — a shallow dict() would let the next
    # turn's bump race the json.dumps (dict-changed-during-iteration).
    writer_mod._enqueue_json(core_mod.LOG_DIR / session_key / "_session.json",
                             json.loads(json.dumps(sess)))
    return snap
