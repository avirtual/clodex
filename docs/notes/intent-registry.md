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

Both halves exempt a plugin with NO registered row, and the grants half only
gained that in t655. The case it exists for: a quarantined plugin's rows are
gone (`deactivate` unregisters its source), so it cannot appear in the catalog
snapshot an editor saves; pruning grants against that snapshot revoked them on
the first unrelated Edit-save of a pre-upgrade seat, irreversibly, because the
operator never saw the plugin to re-tick it. This module sees verbs only, so a
loaded plugin that happens to register none is exempted by the same test — that
widens what is RETAINED, never what is revoked, and a grant for a registered
plugin the seat unticked is still dropped.
