# renderer/renderer.js notes

## loadPluginRenderers

Its `setPluginCatalogCache` call is the only fill on the BOOT path — every other
one hangs off a dialog opening. `pluginReachesSession` reads a plugin's origin
from that cache, and an empty cache answers "custom" for everything, so dropping
the fill hides every shipped plugin's footer button until the operator happens to
open a session dialog. Pinned by `test/plugin-scope.test.js`.

## pluginReachesSession

Answers off `sidebarMeta`'s per-row `plugins` list plus the catalog's `shipped`,
through the shared `seatHasPlugin` leaf — the sidebar paints every row at once,
so this cannot key on the active session.
