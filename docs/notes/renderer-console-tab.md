# renderer/console-tab.js

## startPolling

Returns whether it actually STARTED the timer, because `onShow` needs that
answer: a seat switch while the tab is visible calls `startPolling` again, which
early-returns on the live interval, and without an extra pull the new seat's
first blocks are up to `POLL_MS` away. That extra pull is guarded on `!started`
only to skip a redundant IPC — the double-APPEND it originally prevented is now
closed by `pulling`, so this guard is no longer what makes it safe.

## onHide

Releases the interval with no idempotence of its own — the host guarantees
`onShow`/`onHide` are strictly alternating at-most-once edges (drawer-host.js
rule 2), so a second guard would absorb a host regression instead of surfacing
it.

## pull

`lastKeys` is not belt-and-braces over the cursor: the reader re-serves the
cursor's whole timestamp group and is stateless across polls, so only this set
can drop what was already painted. It is REPLACED per batch, safe only because
that batch is the whole group — a reader omitting any member drops it from here
and repaints it next poll. Keyed on the basename, unique by construction through
the rename, where `tool_use_id` is a payload field the record could lack.

`lastSkipped` exists because `skipped` is not an event. With 50+ records in the
top group the cursor cannot advance, so every poll re-reports the SAME backlog,
and a marker per poll fills `MAX_BLOCKS` and scrolls the real blocks out. Keyed
on the count being unchanged, so a backlog that GROWS is still reported.

## blockNode

An auto-backgrounded call reaches the hook with empty output, so without its note
the block cannot be told from a command that genuinely printed nothing. Which is
why the note is NOT shown for an ordinary silent command.
