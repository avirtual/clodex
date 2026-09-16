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
being empty means no render landed (a non-claude type, a failed catalog fetch,
or the sandbox fill, which draws the container empty), and then the asked-for
list passes through rather than being replaced by the empty collect of an
unpainted container — `resetNewSessionSkillCollector` is what both draw sites
call so the three globals can never describe an earlier render.

Nothing off at all collapses to `[]` only when a TICK put it there: after a
Check All the ticks say "deny nothing", and re-emitting `['*', …every drawn
name]` would still deny whatever the CLI announces later. Two renders reach an
empty collect without the operator touching anything, and both return the asked
list instead — no toggleable row at all (every row read-only), and every
toggleable row already a keep of the asked list, which is exactly what a
t950-upgraded default that keeps everything known draws. Collapsing that second
one would hand the seat an explicit `[]`, which `expandSkillsOff`
short-circuits, so every skill synced afterwards would arrive on in that seat
forever.

The keeps are filtered through the TOGGLEABLE rows, as
`collectPrefsSkillDefaults` does — a read-only row is owned by a lower layer or
policy, and turning it into a `!name` exemption would carry this box's local
`skillOverrides` onto every other box the template travels to, inverted.

## skillDenyForPeer

Directives are a t918 vocabulary, and a pre-t918 `expandSkillsOff` reads `!x` as
a plain skill name — with `*` also present it would write `{"!x":"off"}` and deny
every other skill on the far box. The peer hello carries no cap that says
otherwise (`create2` predates this), so a create routed to a box gets `[]` rather
than a directive list: exactly the pre-t918 behaviour for that path, which sent
no denial at all.

## collectPrefsSkillDefaults

The toggleable filter, as in `newSessionSkillDenyList`, and both collectors also
carry `keptUndrawn`: a `!name` exemption for a skill this cwd does not currently
render has no row to read, and dropping it would silently deny that skill the
next time the dialog was opened anywhere. It is the skills mirror of the
`carried` list the undeferred branch keeps for the same reason.

The only bail out of the deferred arm asks whether anything COULD be ticked, not
whether the operator ticked it: `collectSkillChecklist` skips disabled rows, so
an all-read-only render and a catalog fetch that threw both collect `[]`. Saving
`[]` there would be unrecoverable — `stores.js` reads an explicit `[]` as "deny
nothing" forever — so an empty `toggleable` returns the stored list instead.

Unlike `newSessionSkillDenyList`, an ALL-ticked prefs render saves a deferred
list keeping every drawn row rather than `[]` (t950). The two differ because
their subjects do: a session's list is a one-time choice for a seat that already
exists, while the prefs default is re-applied to every seat created afterwards,
and an explicit `[]` there means the CLI's account-synced skills arrive enabled
forever. The consequence, deliberate: once the stored default is deferred, this
collector never returns `[]` again, so an explicit "deny nothing" default is no
longer reachable from Preferences. The nearest expression is every row ticked,
which keeps every skill known today and denies only the ones synced later.
