# Tickets

The team ticket board — the tickets opened with `[agent:task add]`, as a
surface you can look at instead of a listing you have to ask an agent for.
Opens from the "Tickets" button in the sidebar footer, the only surface it
adds. Teams on the left with their open counts, the selected team's board on
the right.

Each open ticket shows its id, title, assignee, how long it has been open, how
long it has been quiet, and the `tasks/…` directory its spec lives in.

## Read-only, on purpose

There is no close button, no assign, no reject and no cancel. Not an
unfinished version of a board that will have them: `[agent:task …]` does more
than edit `tickets.json` — it delivers the spec to the assignee, tells the old
seat when a ticket moves, hands a seat its next ticket when it closes one, and
resets the stall clock. A button here that wrote the file would skip all of
that and leave the registry disagreeing with the seats.

Tickets are also not a `host.library` kind, so the one mutation the plugin API
offers (`host.library.remove`) refuses them. That refusal is the design, not a
gap to route around.

## Stalled work

Open tickets are sorted **quietest first**. The number that decides "quiet" is
the team's own stall threshold — `watchdogMs` from its `team.json`, or Clodex's
30-minute default — the same one the ticket watchdog uses to nudge a silent
seat, so the board never disagrees with a nudge the lead has already seen. A
ticket that has already been nudged says so, because "nobody has chased this"
and "it was chased and is still quiet" are different problems.

A ticket whose timestamps are unreadable sorts to the **top**, not the bottom.
An age that cannot be computed is itself worth looking at.

## The artifact path

Shown for every ticket, and its absence is shown too — a ticket whose spec's
first line carried no `tasks/…` path says "no task directory in the spec"
rather than leaving the line blank. The path is how a fresh seat picks up a
dead worker's task, so "there is nothing on disk" is the actionable half of
that answer.

## Recently closed

Below the open list, dimmer: tickets closed as **done** in the last 24 hours,
newest first, capped at 10 with a `+N more` marker. Cancelled tickets are
deliberately not in that section — they are counted in the trailer instead. The
window, the cap and the done-only rule are core's, mirrored from
`[agent:task list]` so the two do not define "recently closed" differently.

## Empty is not broken

A team with no open tickets and a team whose `tickets.json` could not be read
render differently, always — the second says what failed, in red. The same
holds for the teams list itself: no `~/.clodex/teams` directory means "no teams
yet", while a directory that exists and cannot be read is an error.

The board itself is the PROJECT's, not the team's:
`~/.clodex/projects/<leaf>-<hash8>/tickets.json`, located through the `root` in
the team's `team.json`. A manifest that names no usable root is therefore a read
FAILURE here rather than an empty board — with no project there is nowhere the
tickets could be, and "no tickets" would be a false green.

This is why the plugin reads `tickets.json` itself rather than through core's
`tickets-store.load()`. That loader answers `[]` for a missing file, an
unreadable one, invalid JSON and a non-array alike, which is correct for a
writer that must not crash a session over a corrupt registry and wrong for a
viewer, where it would paint a broken team as an idle one. Records inside an
otherwise-valid array that are not objects are counted in the trailer rather
than silently dropped.

## Freshness

Nothing notifies a plugin when a ticket changes, so the board is read on
demand: every open re-reads from disk, and nothing is read before then. What
you see is as of the moment you opened it. There is no poll and no badge.

## Settings

None.
