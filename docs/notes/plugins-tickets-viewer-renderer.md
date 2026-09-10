# plugins/tickets-viewer/renderer.js

## money

Every figure it prints is a FLOOR, which is what the `~` its callers prepend
says: wire-totals.json keeps only the newest 500 sessions, so an old seat's
earliest spend is genuinely gone rather than zero.

## costText

A ticket with no cost record renders nothing — most tickets predate the ledger,
and a marker on each would be noise. A record whose figure is null renders
`cost unknown`, never `$0`: that ticket burned real money nobody could
attribute, and the two must not look alike.

## teamCostText

Empty when there is no team, no ledger, or nothing booked yet. The board is the
deliverable and this line is a garnish on it.
