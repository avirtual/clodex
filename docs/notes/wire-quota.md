# docs/notes/wire-quota.md

## note

The SEAT's account label is the key whenever the caller could resolve one. The
`anthropic-organization-id` header is whatever the last response happened to
carry, so keying by it collapses two subscriptions into one flickering number
the moment both are in use. Without a label it keys by org as before — that
fallback is what keeps an unresolvable agent, and the 429 branch, correct.

## snapshotAll

`default` sorts first because it is the account an unconfigured install runs on:
the row an operator with one subscription already sees must not move when a
second one appears beside it.

## quotaCrossings

Thresholds below 100 compare utilization only; 100 is the exhausted flag. A
`rejected` status at 40% is one exhaustion note, not three. Windows with no
utilization never vote: an org with overage disabled publishes `overage` at
`rejected` with a null percentage on every response. The dedupe key includes the
reset epoch, so a window that rolls over and climbs again notifies again. A
window that publishes no reset keys on null and notifies each threshold once.
