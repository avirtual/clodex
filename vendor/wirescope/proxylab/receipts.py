"""Turn receipts: the ONE place a finished upstream response becomes facts.

Both wires' streaming handlers buffer response bytes and, from their
`finally:` blocks, hand the finished blob here. This module derives and
distributes everything downstream of "the response ended": usage parsing +
billing, the durable capture (.response.json), the in-memory session state
the views read (meta._LAST_RESPONSE / _LAST_USAGE), the title harvest, the
warmth-ledger stamp, the subscriber turn.completed receipt, and the console
line. server.py owns routing and bytes; receipts owns derived facts — a new
consumer of "a turn happened" is added HERE, not in two streaming closures.
(Extracted from server.py 2026-06-12, after the same fix had to be applied
to both copies of this logic in one morning.)

MAIN-LINE rule: session-scoped view state and turn counting belong to the
session's own conversation — title side-calls and subagent traffic must not
clobber the parent's. The anthropic wire infers main-line from role +
title_call; the openai wire has no side-calls or subagents (sessions are
header-scoped), so session_id alone suffices there.
"""
import json
import time

from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import meta as meta_mod
from proxylab import subs as subs_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod


def _stash_view_state(session_id, *, text, truncated, stop_reason, bill):
    """The /_session page's in-memory receipts: last answer text + last turn's
    token receipts. Caller has already applied its wire's main-line rule."""
    if text:
        meta_mod._LAST_RESPONSE[session_id] = {
            "text": text, "truncated": truncated,
            "stop_reason": stop_reason, "ts": time.time()}
    meta_mod._LAST_USAGE[session_id] = {
        **(bill.get("tokens") or {}),
        "est_usd": bill.get("est_usd"), "ts": time.time()}


def anthropic(blob, *, n, ts, agent, role, model, session_id, session_key,
              obj, title_call, is_messages, routed, out_dir, stem,
              status_code, resp_headers, tee_text=None, response_injection=None,
              side_call=None, agent_header_id=None):
    """Finalize an anthropic-wire response (messages OR count_tokens).
    `routed` = /agent/<name>/ traffic (the only kind subscribers receive);
    `tee_text` = the subscriber tee's full reassembled turn text, when one ran
    (meta's own text is capped); `resp_headers` = upstream response headers
    (lowercased keys), never the request's. `side_call` = title OR probe (the
    transient non-agent class); `title_call` is the title generator alone (its
    answer is the session title). side_call gates view-state/turn-count; only
    title_call harvests a title — a probe's 1-token answer must never become one.
    `agent_header_id` = the request's x-claude-code-agent-id (present iff a
    subagent instance); with `role` it derives the per-line cost bucket key
    (same vocabulary as report._line_key)."""
    # back-compat: callers that pass only title_call get the old behavior
    side_call = title_call if side_call is None else side_call
    if is_messages:
        usage = billing_mod._parse_usage_from_sse(blob)
        meta = billing_mod._parse_response_meta(blob)
        # the title side-call's answer IS the session title — keep it
        if title_call and session_id and meta_mod._title_from_text(meta.get("text")):
            writer_mod._enqueue_meta(session_id,
                          title=meta_mod._title_from_text(meta.get("text"))[:200])
        bill = billing_mod._billing("messages",
                        model_resolved=meta.get("resolved_model") or model,
                        usage_final=meta.get("usage_final"),
                        usage_start=meta.get("usage_start"))
        if session_id and not side_call and role in ("parent", "unknown"):
            _stash_view_state(
                session_id, text=meta.get("text"),
                truncated=len(meta.get("text") or "") >= billing_mod._META_TEXT_CAP,
                stop_reason=meta.get("stop_reason"), bill=bill)
        # Refresh the prefix-warmth ledger off-thread (hash the prefix this
        # response cached + stamp now/ttl). obj is the forwarded
        # (post-transform) body = exactly what the backend addressed.
        if warmth_mod.WARMTH_LEDGER and isinstance(obj, dict):
            # is_main gates the session-head advance + real-bust classification to
            # the routed main line (subagents share the parent's session_id and
            # would otherwise clobber the head / manufacture false busts).
            writer_mod._enqueue_ledger(
                (out_dir / f"{stem}.warmth.json") if warmth_mod.WARMTH_LOG_FILE else None,
                obj, usage, is_main=(not side_call and role in ("parent", "unknown")))
    else:  # count_tokens — plain JSON, not SSE
        try:
            ct = json.loads(blob.decode("utf-8", "replace"))
        except Exception:
            ct = {"parse_error": blob.decode("utf-8", "replace")[:500]}
        usage = {}
        meta = {"count_tokens_result": ct}
        bill = billing_mod._billing("count_tokens", model_resolved=model, count_tokens=ct)
    stop = {"stop_reason": meta.get("stop_reason"),
            "stop_details": meta.get("stop_details"),
            "request_id": resp_headers.get("request-id"),
            # one terminal response = one completed user turn
            # (refusal/max_tokens still END a turn; tool_use is a
            # mid-turn hop). Side-calls + subagents don't count.
            "is_turn": bool(
                is_messages and not side_call
                and role in ("parent", "unknown")
                and meta.get("stop_reason") not in (None, "tool_use"))}
    # per-line cost decomposition key — mirror report._line_key so the live
    # by_line buckets and the disk report agree: main line (parent/unknown)
    # collapses to "main" (title/probe side-calls ride the main line too),
    # a subagent buckets by its instance agent-id (role as fallback).
    line = ("main" if role in ("parent", "unknown", None)
            else (agent_header_id or role))
    cum = billing_mod._accumulate(bill, session_key, stop, line=line)
    writer_mod._enqueue_json(out_dir / f"{stem}.response.json",
        {"seq": n, "agent": agent, "role": role, "model": model,
         "session_id": session_id,
         "endpoint": "messages" if is_messages else "count_tokens",
         "status_code": status_code,
         # full headers Anthropic returned — request-id,
         # anthropic-ratelimit-*, billing/tier hints, etc.
         "response_headers": resp_headers,
         "billing": bill,        # formatted per-request billing
         "cumulative": cum,      # process-lifetime running total
         "usage": usage,         # flat back-compat view (messages only)
         "meta": meta,           # full usage objects + ids + shape
         "response_injection": response_injection})
    if is_messages and routed:
        # turn.completed receipt for subscribers: the tee's text is the FULL
        # turn (meta["text"] is capped); _SESSION_TOTALS key exists —
        # _accumulate just ran for this request.
        subs_mod.emit_turn_completed_anthropic(
            agent, session_id, f"{n}-{ts}",
            meta=meta, bill=bill, stop=stop,
            status_code=status_code,
            text=(tee_text if tee_text is not None else meta.get("text")),
            role=role, title_call=side_call,
            session_totals=billing_mod._SESSION_TOTALS.get(session_key),
            context=(meta_mod._CONTEXT_STATS.get(session_id)
                     if session_id else None))
    if is_messages:
        t = bill.get("tokens") or {}
        if stop.get("stop_reason") == "refusal":
            # server-side classifier block — model never ran; the CLI
            # flattens this to a generic toast, so the wire must shout
            print(f"[dump] #{n} *** REFUSAL *** "
                  f"category={(stop.get('stop_details') or {}).get('category')} "
                  f"reqid={stop.get('request_id')} "
                  f"(session refusals={billing_mod._SESSION_TOTALS[session_key].get('refusals')})",
                  flush=True)
        print(f"[dump] #{n} {agent}/{role} {bill.get('model') or model} "
              f"-> {status_code} in={t.get('input_tokens')} "
              f"out={t.get('output_tokens')} "
              f"cache_r={t.get('cache_read_input_tokens')} "
              f"cw5m={t.get('cache_write_5m_tokens')} cw1h={t.get('cache_write_1h_tokens')} "
              f"think={t.get('thinking_tokens')} tier={t.get('service_tier')} "
              f"${bill.get('est_usd')}{' UNPRICED' if bill.get('unpriced') else ''} "
              f"| cum ${cum.get('est_usd')}"
              f"{' (+' + str(cum.get('unpriced_requests')) + ' unpriced)' if cum.get('unpriced_requests') else ''} "
              f"reqid={resp_headers.get('request-id')}", flush=True)
    else:
        print(f"[count] #{n} {agent} -> {status_code} "
              f"counted_in={(meta['count_tokens_result'] or {}).get('input_tokens')} "
              f"(not billed) | cum reqs={cum.get('requests')} "
              f"ct_reqs={cum.get('count_tokens_requests')} "
              f"reqid={resp_headers.get('request-id')}", flush=True)


def openai(blob, *, n, ts, agent, model, session_id, session_key,
           out_dir, stem, status_code, resp_headers, tee_text=None):
    """Finalize a codex/openai-wire /responses receipt. Same convergence as
    anthropic(): stats, view state, API-equivalent pricing (PRICES_OPENAI;
    plan traffic is never dollar-billed) into the same global/session ledger,
    capture, subscriber receipt, console line. Turn heuristic: a completed
    response WITH text ends a turn; tool-loop hops come back text-less
    (reasoning+calls only)."""
    meta = codex_mod._parse_openai_response(blob)
    u = meta.get("usage") or {}
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
    reason = (u.get("output_tokens_details") or {}).get("reasoning_tokens", 0)
    codex_mod._CODEX_STATS["responses"] += 1
    codex_mod._CODEX_STATS["input_tokens"] += u.get("input_tokens") or 0
    codex_mod._CODEX_STATS["cached_tokens"] += cached or 0
    codex_mod._CODEX_STATS["output_tokens"] += u.get("output_tokens") or 0
    codex_mod._CODEX_STATS["reasoning_tokens"] += reason or 0
    if status_code >= 400 or meta.get("error"):
        codex_mod._CODEX_STATS["errors"] += 1
    bill = billing_mod._billing_openai(meta.get("resolved_model") or model, u)
    if session_id:
        _stash_view_state(
            session_id, text=meta.get("text"),
            truncated=len(meta.get("text") or "") >= billing_mod._META_TEXT_CAP,
            stop_reason=meta.get("status"), bill=bill)
    stop = {"stop_reason": meta.get("status"),
            "is_turn": (meta.get("status") == "completed"
                        and bool(meta.get("text")))}
    cum = billing_mod._accumulate(bill, session_key, stop)
    writer_mod._enqueue_json(out_dir / f"{stem}.response.json",
        {"seq": n, "agent": agent, "provider": "openai",
         "model": model, "session_id": session_id,
         "endpoint": "responses", "status_code": status_code,
         "response_headers": resp_headers,
         "billing": bill, "cumulative": cum,
         "usage": u, "meta": meta})
    subs_mod.emit_turn_completed_openai(
        agent, session_id, f"{n}-{ts}", meta=meta,
        status_code=status_code,
        text=(tee_text if tee_text is not None else meta.get("text")),
        bill=bill,
        session_totals=billing_mod._SESSION_TOTALS.get(session_key))
    print(f"[codex] #{n} {agent} {meta.get('resolved_model') or model} "
          f"-> {status_code} in={u.get('input_tokens')} "
          f"cached={cached} out={u.get('output_tokens')} "
          f"think={reason} status={meta.get('status')}"
          f"{' ERROR' if meta.get('error') else ''} "
          f"sid={(session_id or '-')[:12]}", flush=True)
