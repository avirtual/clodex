# checklist-popovers notes

## openPluginsPopover

Writes `session:setPlugins` and nothing else. The handler prunes intents and
grants against the list it is handed, so a `setSessionIntents` or
`setSessionPluginGrants` call added here — from a dialog that displayed neither
— would fight that prune with stale state and restore what the operator just
removed. Pinned in `test/plugins-popover.test.js`.

Its `plugins === null` bail is the empty-catalog case (kill switch, or every
plugin globally disabled): the checklist draws no rows, so collecting the ticks
returns `[]`, which would persist as "this seat has no plugins" and strip a seat
that still has them. The Intents Apply carries the same rule for the same reason.

## seatFor

Returns null for a PEER row, so no bundle rows draw there: the catalog is this
box's, and the seat's plugins are its own. `seatPluginsOf` reads `sidebarMeta`,
the same per-row source `pluginReachesSession` uses — neither `session:agentCatalog`
nor `session:skillCatalog` carries the seat's plugin list.
