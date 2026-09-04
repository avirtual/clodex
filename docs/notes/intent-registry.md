# intent-registry notes

## rowVisibleTo

Keys on the seat's `plugins` list via `seatHasPlugin`, with NO `scope` short
circuit. That short circuit ("a global row is visible everywhere") was removed
in t654 and must not come back: it would make a global plugin unhideable from a
seat, which is the operator ask the field exists for.

## intentEnabledForSeat

Takes the whole persistence entry rather than `(intents, plugins)` so a caller
cannot pass one and not the other. `session-manager._handleIntent` is the only
production caller; `intentEnabledFor` beside it is the intents-only predicate
and stays that way.

## pruneForPlugins

Does not mutate its input. Returns `{ intents, pluginGrants }` where a
non-array input yields `null` — a null allowlist needs no prune because a
plugin row is enabled only by explicit inclusion, never by the all-enabled
default.
