# Pop protocol — Clodex side

Implement against `proxy-lab/hints_contract.md` ("One-shot payloads — the pop
protocol (once)" and "Caps"), NOT against the DM thread. The doc is the
contract; the DMs are how it got there.

## Status at open

Nothing written. Vendored `wirescope v0.6.43` (`f194fff`) carries the proxy
half; `capabilities.hints.pop` is the feature gate.

## First-run attribution — decide BEFORE the first live catalogue

The first live pop exercises two never-exercised things at once: wirescope's
`system_tail` delivery path (0 real bodies across 43,111 captures, covered
synthetically only) and this side's first registration. A failure therefore
does not attribute itself — `declined: marker_downstream` is consistent with
either half, and "we'll look at it when it happens" means looking at a single
failed request with no way to split it.

Capture on the first attempt, whatever the outcome:

- The POST as sent (id, `once`, `main_line_only`, `ttl_s`, `expect_session`)
  and the proxy's response to the registration itself, separately from what
  happens to the next request. A registration that was never accepted and a
  catalogue that was never delivered look identical downstream.
- `/_identity` at the moment of registration, to prove the gate was true then
  rather than at some earlier probe.
- `tail_hint_pops` off the response record: `popped`, `rolled_back`,
  `status_code`, `delivered_session`. `delivered_session` is reported whether
  or not a session was asserted, so it distinguishes "delivered to the wrong
  conversation" from "not delivered".
- The `sessionId` this side believed it was targeting, so `delivered_session`
  has something to disagree with.

Cheapest disambiguator, and the reason to decide now rather than mid-incident:
**`GET /_hints?session=<id>` immediately after the POST, before any request
goes out.** `armed:true` (with `armed_age_s`, derived at read time so it cannot
go stale) means the registration was accepted and the payload is sitting there.

- **armed true, nothing delivered** — registration is fine; the fault is
  placement or delivery. `declined:"marker_downstream"` then carries
  `deepest_marker`, `insert_at` and `fallback_available`; the last says
  directly whether `SYSTEM_TAIL_FALLBACK` would have served it.
- **armed absent** — the proxy never accepted it, and the POST response plus
  `/_identity` are what matter.

Also pull explicitly: `declined:"pop_ineligible"`, whose per-hint reason map
(`subagent` / `session_mismatch`) is what explains a `main_line_only` or
`expect_session` rejection — the guard firing and nothing happening are already
distinct upstream. And `pop_reserved` alongside `tail_hint_pops`: reserved with
no commit is the shed-storm case, where the payload correctly stays armed for
the retry. That is the two-phase design working, not a fault.

A standing hint registered alongside as a positive control does NOT work here,
and the reason generalises. Placement runs once per request, after resolution:
if a `cache_control` marker sits at or after the insert point the whole
injection declines before anything is written. So `marker_downstream` — the
named suspect — kills the standing control and the pop identically, and
"neither arrived" would read as "fault is upstream of both" when delivery and
both halves are in fact fine. **The control shares a failure mode with its
subject, so under the suspect hypothesis it cannot separate them.** Same error
as asserting a proxy that is entailed by the subject's own precondition.

Boring is the wanted outcome. Send wirescope the record either way — a
confirming record is worth more to it than silence, since its corpus cannot
produce one.
