# wire/hold.js

## holdDecision

A hold only buys anything when one ping covers more than one margin window; with
`ttl_s <= margin` every tick is due and each ping re-stamps a TTL that is due
again at the next tick, so the skip on that condition is what stops a perpetual
hold pinging forever. A `warmthQ` with no `ttl_s` (older ledger rows) is left on
the previous behaviour.
