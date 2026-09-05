# renderer/renderer.js notes

## loadPluginRenderers

`pluginReachesSession` reads a plugin's origin from the catalog cache, and a
cache with no row for it answers "custom", withholding it from every seat that
has no plugin list. Two fills exist for that reason and neither is redundant:
this one covers BOOT, and the `plugin-state` enable arm covers a plugin enabled
mid-run from Manage Plugins. Every other fill hangs off a dialog opening, so
dropping either leaves a shipped plugin invisible — no footer button, no row
badge, an overlay that toasts a false refusal — until the operator happens to
open a session dialog. Both pinned by `test/plugin-scope.test.js`.

## onPluginEvent (the `plugin-state` enable arm)

Refills the catalog cache BEFORE `activatePluginRenderer`, not after: the
activation paints the plugin's chrome, and a paint that runs first reads an
origin the cache cannot answer yet.

## pluginReachesSession

Answers off `sidebarMeta`'s per-row `plugins` list plus the catalog's `shipped`,
through the shared `seatHasPlugin` leaf — the sidebar paints every row at once,
so this cannot key on the active session.
