# team-tickets.js

## _stampSeatCost

Two of its three callers (`ptyProc.onExit`, `kill()`) sit beside
`getPersistence().remove(name)`, and `entrySessionIds` reads the seat's session
history off exactly that record — so the stamp must run BEFORE the drop, the same
ordering `_writeReviewCost` has against the reviewer's kill.

A ticket seat and a reviewer are skipped by `standingSeat`: their spend is
already booked as a `ticket` or `review` row by the close, and booking it again
here would double-count it into the team total.

## _spawnTicketSeat

The mint stamps `ephemeral` and `ticketId` on every mint rather than
conditionally, because `upsert` (stores.js) spread-merges over whatever record
survives under that seat NAME — a field left absent is inherited from the
previous ticket's record, and `mintedForTicket` then reads a seat as minted for a
ticket it never worked.
