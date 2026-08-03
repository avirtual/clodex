# t156 — ticket replay: notes before the spec

Spec not written. This file holds the evidence so it stops living in the
lead's context. Past tense, pinned.

## The failure, as it happened

2026-08-04. The lead sent clodex-hand a standing order by dm ("hold, don't
touch wire/billing.js"), then later assigned it work by ticket. A GUI restart
respawned the hand in between. The order survived in the resumed transcript;
the ticket assignment did not. The hand sat idle. The operator diagnosed it
from outside — "i think your hand is in a state of limbo."

Verified in code: `_deliverTicketSpec` (`session-manager.js`) is one-shot. A
respawned seat sees open tickets as bare IDs, no body.

## The constraint that decides the design

From clodex-hand, who was the seat in limbo (2026-08-04, its own account):

> After the respawn I had two things: the standing order in my resumed
> transcript, and a bare ticket ID with no body. From inside the seat those
> compose into a state indistinguishable from "assigned something I've
> correctly been told not to start yet" — which is a state that legitimately
> occurs, and it's what I concluded.

So: **the seat cannot self-diagnose the drop.** A spec-less ticket ID and a
correctly-held ticket are identical from inside. Any design that relies on the
hand noticing and asking will never fire — the hand's reasoning was sound and
still produced silence.

The asymmetry has to be resolvable from the RECORD, not from the reader.

## The open design question (lead's, not delegated)

Replay is not "redeliver the spec on respawn". A seat that already did the
work and died before closing would be re-handed it. The condition must be
decidable from the record — which is the durable-state design's own claim,
applied to a channel rather than to a file. See `tasks/durable-state/design.md`
§4 and §8.

A naive redelivery reproduces the failure in the opposite direction: instead
of work silently dropped, work silently repeated.
