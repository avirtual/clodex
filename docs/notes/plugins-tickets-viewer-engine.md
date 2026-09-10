# plugins/tickets-viewer/engine.js

## ticketCost

`null` is the normal answer and renders nothing. A record found whose `usd` is
null is the other case and renders `cost unknown`: a ticket whose seat could not
be resolved still burned real money, and a `$0` there is exactly the false zero
COST.json exists to refuse. A `seat-lifetime` attribution reports null for the
same reason — that number is the seat's whole life, not this ticket's cost.

## teamCost

A project with no team has no ledger, and that answers `ok` with a null total
rather than an error: the board is the deliverable, and a missing cost line must
never fail it.

## readTeamLedger

This, `rollupTeam` and `parseTeamLedger` are copies of team-cost.js's, under the
plugin-api §4 rule that a plugin may not require core. Compared against core in
test/tickets-viewer-path-parity.test.js.
