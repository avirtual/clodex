# team-tickets.js

## REVIEWER_SHELL_DENY

Measured against CLI 2.1.261. `permissions.deny` refuses; `permissions.allow`
does NOT — it names what runs without a prompt, so a command absent from an
allowlist still runs. Hence a denylist, not an allowlist.

Deny survives `--dangerously-skip-permissions`, which is what lets the shell arm
inherit the lead's posture like every other seat. Verified by hand under bypass:
`touch`, `rm -rf` and `git commit` were refused and the disk confirmed
untouched, while `git status` and `node --test` ran.

Matching is prefix-on-argv, so each spelling needs its own rule — `sed -i` and
`sed --in-place` are two entries. It cannot see shell syntax: `echo x > f`
writes under a full deny list (measured), so redirection is owned by the
reviewer-shell prompt and no addition here closes it.

## REVIEWER_TOOL_CAP

The cap is an intersection for every tool except `Bash`, which
`REVIEWER_SHELL_DENY` admits beside it on a template's opt-in — so a template
listing Bash gets the full cap plus Bash even when it named fewer read tools.
`beyondCap` deliberately omits Bash: reporting it would print the "requires
operator approval" warning about a grant this arm just made on purpose.

## _seatLedger

The model is taken on the session-ID gate alone, outside the cost check beside
it. That check exists to avoid overlaying an unobserved spend onto a recorded
one, which says nothing about which model billed. This is also the only moment
the model is legible: wire-totals.json rows carry no model field, and the seat
is reaped seconds later. (Named `_reviewLedger` until t805 gave it a second
caller; the reaping is still the review path's.)

## _taskStart

`ticket.reviewerTemplate` is written above BOTH save arms — the one-shot arm
returns before the second save, so a write below it survives only on the standing-seat path.

## _seatMintPending

`createdAt` is the discriminator because `create()` writes it unconditionally
while `_spawnTicketSeat`'s synchronous reservation stub does not — so the record
answers "has a session ever existed under this name" with no second field to keep
in sync. `ephemeral` alone cannot: a one-shot seat that genuinely died keeps its
ephemeral record, and reading that as pending would freeze the degraded-pin
inheritance `_ticketAssigneeSeat` depends on.

A quit or crash between the synchronous stub and `create()`'s `createdAt` write
leaves a stub that suppresses the degrade for good, where the ticket used to be
inherited. Bounded: `task start` on such a ticket refuses and names Delete
Session…, which drops the record and restores the degrade.

## _stampRoundFile

Stores the BASENAME only. The directory is the record's own `taskDir`, resolved
through `_ticketDiffDest` at read time, so an absolute path here goes stale when
the artifact root moves and names a file the confinement no longer reaches.

Runs after the write succeeded, so a failed write leaves the field null rather
than claiming an artifact that is not on disk. Silent when the round has no
entry: that is a stamp for a write no close filed.

`headSha` is the one field it stores that is not a basename — it names no file,
and the helper has never inspected the value it is given.

## _writeTicketDiff

`headSha` is the commit the diff was taken AT. It is what makes the NEXT round's
delta possible: nothing else on the record remembers where a round stopped once
the branch moves on. Stamped on every round, because which round is the last one
is not knowable here.

`prevHeadSha` is read off the previous round BEFORE this round's stamp, and is
returned rather than acted on: the delta is a git subprocess and this method is
synchronous.

## _writeTicketDelta

Measured 2026-09-18 over 16 cold reviewer rounds: a round 2 cumulative diff is
~97% identical to round 1's, and the round 2 reviewer re-reads about a third of
round 1's targets because nothing marks which hunks are new.

Every failure writes nothing and is silent — no previous head sha (a ticket in
flight across the upgrade), an unresolvable sha (the branch was rebased under the
loop), a git error, an empty range. `buildReviewScope` prints the DELTA line only
when handed a path, so writing nothing is what keeps the scope from naming a file
that is not there. An escalation would be worse than useless: the cumulative diff
is whole and the review proceeds on it alone.

## _landVerdictOnTicket

The `rounds` entry is found by its `round` value, never by index — a second
verdict on one close bumps `reviewRound` past anything `task done` filed, and
there would be no entry at that index. A missing entry is appended with null
report fields instead.

Measured 2026-09-17: the board holds 869 closed tickets predating `rounds`, 229
of them with 2+ review rounds. No pass rewrites them — `tickets.json` is 7.6MB
and every write rewrites the whole board. Only a ticket a verdict or a close
actually touches gains the field; the rest are derived from the task dir on read.
