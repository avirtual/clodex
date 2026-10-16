# Reminders

A table of every reminder the seats of this window's workspace have armed with
`[agent:remind …]`. Opens from the "Reminders" button in the sidebar footer.

Columns: seat, kind, spec, next fire (local time with its zone abbreviation),
a 60-character preview of the text (the full text on hover) and the ticket a
`for <id>` binding ties it to. An `oncompact` reminder shows "on compact": it is
event-triggered and has no fire time, not a missing one.

The table starts filtered to the selected seat; "All Seats" shows the whole
workspace. A seat that is saved but not running is listed with its name dimmed:
its reminders stay armed and fire once it is running again.

## Scope

The engine half answers `list` with the rows whose seat belongs to the asked
workspace — running (`host.sessions.listWorkspace`) or saved
(`host.sessions.listSavedWorkspace`). It never reads the global session list,
so another workspace's seats are filtered out before anything reaches the
renderer.

## Reading

The rows come from `<userData>/reminders.json`, read fresh on every open and
after every cancel. Core writes every reminder change straight through to that
file, so it is the live state. The path is derived as two levels above
`host.paths.dataDir` (`<userData>/plugins/<id>/`). A missing file is an empty
list; an unparseable one is reported, not shown as empty.

## Cancelling

Each row's Cancel goes through `host.library.remove('reminder', { agent, id })`,
which core routes to the reminder scheduler's `cancel(agent, id)`. The
scheduler only removes a record owned by the named agent, so a row can only be
cancelled under the seat that armed it.

The toast says "Schedule cancelled", not that a message was recalled: a nudge
that already fired and is queued for delivery may still land. A row that was
already gone (fired for the last time, or cancelled by its agent) refreshes the
table without an error.

There is no add: agents still arm their own reminders.
