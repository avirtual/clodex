# renderer/console-tab.js

## startPolling

Returns whether it actually STARTED the timer, and `onShow` needs that answer.

A seat switch while the tab is already visible re-keys `seat` and calls
`startPolling` again, which early-returns because the interval is still live — so
without an extra pull the new seat's first blocks are up to `POLL_MS` away and the
pane sits empty for a seat that has run plenty.

The extra pull is therefore guarded on `!started`: `startPolling` pulls once when
it does start, and two pulls racing at the same `offset` both read the same bytes
and append every block twice. "Always pull on switch" is the obvious
simplification and it is the duplicating one.

## onHide

Releases the interval with no idempotence of its own — the host guarantees
`onShow`/`onHide` are strictly alternating at-most-once edges (drawer-host.js
rule 2), so a second guard here would absorb a host regression instead of
surfacing it.
