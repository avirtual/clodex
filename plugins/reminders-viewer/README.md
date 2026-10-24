# Reminders

A table of every reminder armed for the seats of this window's workspace, by
the seat's own `[agent:remind …]` or by the operator from this panel. Opens from the "Reminders" button in the sidebar footer.

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

## Adding

The "+ reminder" form above the table picks a seat of this workspace (running
seats first, then saved ones), a schedule (`every 1h`, `in 45m`, `at 14:30`,
`cron 0 9 * * *`) and the text. The engine half's `add` takes the window's
workspace id, refuses a seat outside that workspace (the same `list` scope) and
calls `host.library.add('reminder', { agent }, { spec, body })`; core arms it
through the scheduler with `by: 'operator'`. A bad schedule, an unknown seat or a
`for <id>` ticket binding comes back as the inline error.

An operator-set reminder fires whether or not the seat holds the remind intent,
and arrives as a dm from `reminder`:
`[<id> every 1h, set by your operator] <text>`. The text is exactly what the seat
receives, so to have a seat reset its context write the intent line it should
emit (`[agent:context clear] Fresh start: …`) or plain prose. The seat sees the
row in `[agent:remind list]` marked `(operator)` but cannot cancel it; its row
here carries an `operator` chip.

## Cancelling

Each row's Cancel goes through `host.library.remove('reminder', { agent, id })`,
which core routes to the reminder scheduler's `cancel(agent, id, { force: true })`:
the panel cancels any row, including operator-set ones.

The toast says "Schedule cancelled", not that a message was recalled: a nudge
that already fired and is queued for delivery may still land. A row that was
already gone (fired for the last time, or cancelled by its agent) refreshes the
table without an error.
