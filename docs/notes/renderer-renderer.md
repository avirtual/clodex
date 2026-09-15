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

## newSessionPluginsRendered

The catalog ids each session dialog's plugin checklist was DRAWN from, snapshotted
at draw (`argsPluginsRendered` is the args-dialog twin). The collect sites feed the
snapshot to `pluginsForUnlistedPlugins` rather than re-reading the shared cache:
`onPluginEvent`'s enable arm refills that cache while a dialog is open, so a
carried-forward plugin would become "listed and unticked" between draw and save and
be dropped. The args guard reads the snapshot's length for the same reason.

`intentsPluginsRendered` and `popoverPluginsRendered` in
`renderer/popovers/checklist-popovers.js` are the same pair for the Intents… and
Plugins… popovers, which stay open across that refill too; both guards read the
snapshot's length. All four fills are position-pinned by
`test/plugin-dialog-snapshot.test.js`.

## newSessionSkillDenyList

The New Session / template dialog's skill collector. It does NOT simply return
the unticked rows: when the drawn deny set was DEFERRED (`*`), it re-emits a
deferred list naming the rows still TICKED, so a hand edit in Advanced — which
flips the mode selector to `custom` — narrows the keep list instead of
collapsing deferral into a snapshot of today's catalog. `newSessionSkillsDrawn`
being empty means no render landed (a non-claude type, a failed catalog fetch),
and then the asked-for list passes through rather than being replaced by the
empty collect of an unpainted container.

## collectPrefsSkillDefaults

Same rule for the Preferences default, plus `keptUndrawn`: a `!name` exemption
for a skill this cwd does not currently render has no row to read, and dropping
it would silently deny that skill the next time Preferences was opened
anywhere. It is the skills mirror of the `carried` list the undeferred branch
keeps for the same reason.
