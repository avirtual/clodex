# Tickets

The team ticket board — the tickets opened with `[agent:task add]`, as a
surface you can work in instead of a listing you have to ask an agent for.
Opens from the "Tickets" button in the sidebar footer, the only surface it
adds. Teams on the left with their open counts, the selected team's board on
the right.

Each open ticket shows its id, title, assignee, how long it has been open, how
long it has been quiet, and the `tasks/…` directory its spec lives in.

## What it writes, and what it deliberately does not

Opens, edits a spec, assigns, closes and cancels. There is no `reject`, no
`start` and no `respec` — the loop verbs stay with `[agent:task …]`, because
they move a ticket through a state machine this surface does not drive.

The write half is **desktop-only**, and the mechanism is that it is absent from
`manifest.json`'s `surfaces`: a board reachable from a browser would be a board
a browser can close tickets on. Adding a write verb there is the mistake this
omission prevents.

A write here is the operator's own edit of the board, **not an impersonation of
the intent path**, and that is a capability boundary rather than a taste
judgement: `[agent:task …]` also drains the closed seat's queue, rebuilds the
sidebar's ticket badges, writes `COST.json` and enforces the lead-only gates,
and the host surface exposes no seam a plugin could reach any of them through.
Records carry `viewer` as their opener or `closedBy` so the registry never
misattributes one to an agent.

Spec DELIVERY is the one side effect that IS reachable, and it is done:
`add`-with-an-assignee and `assign` both inject the spec into the live seat and
stamp the ticket started, because an assignment nobody is told about is the one
failure that looks like success.

Both dispatching verbs refuse a ticket whose spec names no `tasks/…` path,
matching core — the review step would have nowhere to write its diff. The
refusal changes nothing on disk and says how to fix it.

`host.library.remove` still refuses tickets, since they are not a `host.library`
kind. That refusal is the design, not a gap to route around.

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
