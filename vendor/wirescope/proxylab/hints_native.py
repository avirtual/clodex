"""Proxy-native tail hints — facts the PROXY measures, rendered on demand.

WHY THESE ARE NOT PUSHED (clodex's single-sourcing rule): for anything the proxy
observes directly — upstream health, context pressure, real cost — the proxy is
the only correct authority. A value a consumer POSTed would be its GUESS about
proxy state wearing the same authoritative `<system-reminder>` wrapper, and two
writers for one fact means no way to tell which is stale. So a consumer enables
these BY NAME (`POST /_hints?session=&native=upstream_health`) and never writes
the body; the proxy owns the text and its freshness.

This is the class where tail delivery genuinely beats writing it in CLAUDE.md:
the fact does not exist at prompt-assembly time. The motivating case is real —
during a 529 storm a consumer agent reasoned about a worker-seat fault and set a
fallback to respawn a fresh worker (a cold spawn being the LARGEST request in the
system, which would have failed identically), because the proxy could see
upstream shedding requests and the model could not.

A provider returns None when it has nothing worth saying. That decline is load
bearing: a hint that ships every turn saying "everything is normal" trains the
model to skip the block, which would quietly disable the channel for the turn
that matters.
"""
import os
import time
from collections import deque

# ---- upstream health -------------------------------------------------------
# Rolling window of recent upstream outcomes: (ts, status_code). Bounded; the
# proxy appends from the response path (receipts), so this is real observed
# behavior, not a probe.
#
# DELIBERATELY PROCESS-GLOBAL, NOT PER-SESSION. A tail hint can only ride a
# request that gets a RESPONSE, so a session drowning at 100% shed structurally
# cannot receive this fact — the hint's real audience is the OBSERVER making
# decisions about the victim (a teammate agent), not the victim itself. Measured
# on the real 2026-07-10 storm, worst 120s window: globally 5/5 requests shed
# (fires), but each individual route had n=1 in that window — so a per-session
# measurement would not have met MIN_N and would have fired for NOBODY, on
# either the drowning seat or the healthy observer. Global is the only scope that
# sees a storm at all. (Whole-corpus per-route rates are wildly asymmetric —
# degen 54/54 shed, contrarian 0/5294 — but that asymmetry is cold-start
# correlation, not per-route weather: the high-shed routes are all low-volume
# agents whose few requests were large cold spawns during bad weather.)
_OUTCOMES = deque(maxlen=400)
# Statuses that mean "upstream shed this request" rather than "your request was
# bad": 429 rate-limit, 529 overloaded, 5xx server-side.
_SHED = {429, 500, 502, 503, 504, 529}

# Window and threshold for calling it a storm. Deliberately conservative: a
# single 529 is normal weather and the CLI retries it invisibly. We speak only
# when the rate is high enough that an agent's DIAGNOSIS would go wrong.
UPSTREAM_WINDOW_S = float(os.environ.get("HINTS_UPSTREAM_WINDOW_S", "120"))
UPSTREAM_MIN_N = int(os.environ.get("HINTS_UPSTREAM_MIN_N", "4"))
UPSTREAM_MIN_RATE = float(os.environ.get("HINTS_UPSTREAM_MIN_RATE", "0.25"))


def note_outcome(status_code):
    """Record an upstream outcome. Called from the response path for every
    forwarded request (cheap: one deque append)."""
    try:
        _OUTCOMES.append((time.time(), int(status_code)))
    except Exception:
        pass


def _upstream_health(session=None, obj=None):
    now = time.time()
    recent = [(t, s) for t, s in _OUTCOMES if now - t <= UPSTREAM_WINDOW_S]
    if len(recent) < UPSTREAM_MIN_N:
        return None                       # too little evidence to assert weather
    shed = [s for _, s in recent if s in _SHED]
    rate = len(shed) / len(recent)
    if rate < UPSTREAM_MIN_RATE:
        return None                       # normal weather -> stay silent
    codes = sorted(set(shed))
    return (f"Upstream (api.anthropic.com) is currently shedding requests: "
            f"{len(shed)} of the last {len(recent)} requests across ALL sessions on "
            f"this proxy returned {codes} in the past {int(UPSTREAM_WINDOW_S)}s. "
            f"Your own turns may be landing fine while other sessions are failing "
            f"entirely — a session failing every request cannot be told this, so if "
            f"you are deciding anything on another agent's behalf, assume its "
            f"failures are upstream capacity and NOT a fault in its worker, seat, or "
            f"configuration. Do not respawn workers or rebuild state to work around "
            f"it: a cold start is the largest request in the system and will fail the "
            f"same way. Retry, or wait it out.")


# ---- context pressure ------------------------------------------------------
# Real number from the last receipt, not an estimate. The lever the model can
# actually pull is /compact, so name it.
CONTEXT_WARN_FRAC = float(os.environ.get("HINTS_CONTEXT_WARN_FRAC", "0.75"))


def _context_pressure(session=None, obj=None):
    if not session:
        return None
    try:
        from . import meta as meta_mod
    except Exception:
        return None
    # ONE definition of "context size" — meta._input_token_total, the same helper
    # /_status and /_session read, so a hint can never disagree with the dashboard.
    inp = meta_mod._input_token_total(meta_mod._LAST_USAGE.get(session))
    if not inp:
        return None
    # window size from the request itself when we can see it (betas move it)
    limit = 200_000
    for b in (obj or {}).get("system") or []:
        if isinstance(b, dict) and "context-1m" in str(b.get("text") or ""):
            limit = 1_000_000
            break
    frac = inp / limit
    if frac < CONTEXT_WARN_FRAC:
        return None
    return (f"Context window is {frac*100:.0f}% full ({inp:,} of {limit:,} tokens "
            f"as of the last turn). Carriage is re-billed every turn at this size. "
            f"If the remaining work does not need the earlier history, /compact now "
            f"rather than at the limit.")


# name -> (renderer, ttl_s). The TTL is the proxy's own freshness promise: a
# rendered native fact is re-evaluated every request anyway (render() runs per
# request), so the ttl here exists only so a stale value can never ride a
# response path that failed to re-render.
PROVIDERS = {
    "upstream_health": (_upstream_health, 60.0),
    "context_pressure": (_context_pressure, 300.0),
}


def render(name, session=None, obj=None):
    """Render one native hint, or None if the provider has nothing to say.
    Never raises into the transform chain — a broken provider stays silent."""
    entry = PROVIDERS.get(name)
    if not entry:
        return None
    fn, ttl = entry
    try:
        text = fn(session=session, obj=obj)
    except Exception as e:
        print(f"[hints] native provider {name} failed: {e}", flush=True)
        return None
    if not text:
        return None
    return {"id": name, "text": text, "set_at": time.time(),
            "ttl_s": ttl, "source": f"native:{name}"}
