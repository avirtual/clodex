# drawer-host.js

## restoreDeck

Restores through `select()`/`toggle()` rather than by flipping classes, so rule
2's onShow/onHide edges fire exactly as they would for the operator's own
gesture. The `restoring` flag is load-bearing: `recordDeck` sits in those same
paths, so without it a restore writes itself back and the arriving seat's deck
overwrites the one the operator is leaving.

Ordering is fixed — it runs before `syncSeatAvailability()` in
`onSessionChanged`, so a tab the new seat cannot serve is still moved off by the
existing availability fallback rather than left selected.

## recordDeck

`tall` is deliberately not recorded: it is a size preference for the window, not
a property of a seat, and it keeps its own `TALL_KEY` persistence.

Nothing persists across a reload. The map is renderer memory, so a fresh window
boots every seat collapsed, which is what the drawer did before any of this.
