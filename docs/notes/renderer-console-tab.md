# renderer/console-tab.js

## startPolling

Returns whether it actually STARTED the timer, and `onShow` needs that answer.

A seat switch while the tab is already visible re-keys `seat` and calls
`startPolling` again, which early-returns because the interval is still live — so
without an extra pull the new seat's first blocks are up to `POLL_MS` away and the
pane sits empty for a seat that has run plenty.

The extra pull is guarded on `!started` only to skip a pointless second IPC when
`startPolling` already pulled. The double-APPEND it originally prevented is now
closed by `pulling` below, so this guard is no longer what makes it safe.

## onHide

Releases the interval with no idempotence of its own — the host guarantees
`onShow`/`onHide` are strictly alternating at-most-once edges (drawer-host.js
rule 2), so a second guard here would absorb a host regression instead of
surfacing it.

## pull

`lastKeys` is not belt-and-braces over the cursor — the cursor cannot do this job
alone. A record's filename is `<ns>-<pid>.json`, and on a `date` without `%N` the
whole seconds-worth of records shares one `<ns>`, so ordering inside that group is
by pid and a strict `f > cursor` scan drops every tie that lands after the one the
cursor named. The reader therefore re-serves the cursor's entire timestamp group
(`stampOf(f) >= stampOf(cursor)`) and this set drops what was already painted.
Keyed on the basename because the atomic rename makes it unique by construction,
where `tool_use_id` is a payload field the record could lack.

`pulling` closes the interval-tick and slow-IPC paths: an IPC round trip slower
than `POLL_MS` would otherwise put two pulls on the same cursor, which is the
double-append above by a different door.
