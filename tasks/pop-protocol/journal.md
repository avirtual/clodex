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
**register a trivial standing hint alongside the first pop as a positive
control.** If the standing hint arrives and the pop does not, the delivery path
is live and the fault is in the one-shot half; if neither arrives, the fault is
upstream of both and nothing about pops has been tested. Without the control, a
silent failure is indistinguishable from a proxy that never saw the
registration.

Boring is the wanted outcome. Send wirescope the record either way — a
confirming record is worth more to it than silence, since its corpus cannot
produce one.
