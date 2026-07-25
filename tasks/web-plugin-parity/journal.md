# t28 — plugin management at parity on the web frontend

Branch `web-plugin-parity` off master `5efa7da` (v4.0.0). Do not push, do not
touch master. `workbench-features` (at `199dc5a`) is a SIBLING branch, not a
base — deliberately not merged.

## Phase 1 — investigation (clodex asked for findings on (1) and (3) first)

### (1) Top-level Plugins menu on web — POSSIBLE, hypothesis needs one correction

`renderer/web/menubar.js:95-101`'s comment says the bar "cannot mirror" the
desktop menu because "its top-level labels are a fixed sync array". The array
IS sync (`buildMenus(ctx)` returns five literals, `mount()` at :336 loops them
into `.clx-top` divs) — but that is a property of the current code, not a
constraint of the medium:

- Top elements are appended IMPERATIVELY into `bar` (a plain div) at :336-344.
  Nothing stops appending a sixth later, or `insertBefore`-ing it to land
  between View and Window where the desktop puts it (`app-menus.js:609-611`).
- Menu CONTENTS are already async: `items: async () => {…}` (Agents at :108,
  Skills at :128, Window at :164). Only the LABEL is sync.

So the conditional-presence property survives: mount the five, then await the
plugin status once and insert the Plugins top element only if there is
something to show. The desktop's null rule (`app-menus.js:342-352`: no host, or
zero plugins AND zero problems → return null → splice nothing) is reproducible
verbatim. No faked structure, and no top-level Plugins showing when empty.

Data is already on the wire: `_host` `plugins.status` (`plugin-host-engine.js:511`)
rides `pluginInvoke`, one of the five frozen plugin transport rows
(`api-contract.js:284-287`), which the browser inherits free. Toggling uses
`pluginSetEnabled` (:286), same row the desktop dialog's checkbox uses.

### (2) appVersion — confirmed exactly as described

`web-host.js:308` sends it in the welcome frame; `api-shim.js:115` stores the
frame in module-local `welcomeInfo`; nothing reads `.appVersion` anywhere.
`welcomeInfo` is NOT exported — a reader needs a getter on the shim (or to take
it from the `ready` promise's resolved frame, `api-shim.js:38/118`). Display
only, no new transport.

### (3) Open Plugins Folder on web — clodex's description is right, with one
consequence he pre-authorised

`renderer/renderer.js:5286-5294` → `window.api.fileReveal(r.dir)` →
`api-shim.js:102` toast. Path itself already crosses correctly: `_host`
`plugins.userRoot` (`plugin-host-engine.js:530`) returns the ENGINE's dir.

The listing does NOT come free from workbench's `fs.list`. That row is the
workbench plugin's own (`plugins/workbench/engine.js:86`), scoped through
`scoped()` → `host.sessions.fsScope(name)` → a SESSION's cwd. The plugins
folder is `~/.clodex/plugins` on the engine box, which is no session's cwd, and
reaching it would mean widening a confinement wrapper t26 just tightened. So
the PATTERN transfers (list remote dirs, render in the dialog); the ROW does
not.

That means one new `_host` method (read-only listing of the user plugin root).
The ticket pre-authorises this shape explicitly — "`_host` is where new host
plumbing rides" — and it is not a `hostApi` change: `hostApi` stays "1", the
five `plugin:*` transport rows stay five. Proceeding on that basis; flagging it
rather than treating it as invisible.

READ-ONLY bound acknowledged: no upload/write path, at all.

## clodex's ruling (msg-93431-3)

(3) authorised, bounded EXACTLY: **one read-only method, listing the user plugin
root and nothing else. No path argument, no traversal into subdirectories, no
recursion, no writes.** "If a caller can pass a path, you have built a remote
file browser." Also: pin the null rule on (1); shim getter for (2), do not export
`welcomeInfo` wholesale; the displayed version must be the RUNNING app's from the
welcome frame, never re-derived client-side (`web-dist/index.html` is tracked, so
a `git pull` ships a new bundle and this string is how an operator confirms it).

## Phase 2 — (1) and (2) built

**(1)** `menubar.js`: `buildPluginsMenu(status, ctx)` — a PURE function of an
already-fetched status, so the null rule walks in tests with no transport.
Reproduces `app-menus.js:342-352` verbatim (no host/unreadable → null; zero
plugins AND zero problems → null). `mount()` gained `makeTop()` (extracted from
the old loop) and `refreshPluginsTop()`, which re-evaluates the rule on EVERY
run and removes the element when it turns null — a rescan that drops the last
plugin takes the menu with it. Inserted before the Window top to match
`app-menus.js:609`, appended if that anchor is ever missing. Re-runs on the
`_host`/`plugin-state` broadcast, the same signal core's renderer teardown uses.
Menu CONTENTS re-fetch on every open, so a checkbox cannot go stale.
Enablement shows as ●/○ (this bar has no checkbox row type); quarantine goes in
the label, desktop's reasoning.

Kept `File → Plugins…`, deliberately, with the reason in the comment: at zero
plugins the top-level menu is absent BY DESIGN, and that is exactly the state a
fresh install is in — removing the File item would leave no route to the dialog
whose "Open Plugins Folder" button is how you install your first plugin. (The
desktop has that hole; a packaged build masks it by shipping `plugins/workbench`.)

**(2)** `api-shim.js`: `appVersion()` getter, one field, not `welcomeInfo`.
`boot.js`: `mountVersion()` appends `#sidebar-version` to the sidebar footer.
`styles.css`: web-only rule (Electron never creates the element). Silent when the
frame carried no version rather than guessing.

## clodex's addition on (2) (msg-93431-4)

Precedent: the desktop peer-info dialog (`peers-ui.js:1410`) already answers this
question about a remote box as `Clodex v<version>`. Follow that vocabulary; DROP
the comparison half — `(you run vX)`, `versionSeverity`, `updateApplies` exist
because two Clodexes are being compared, and a browser is a client, not a Clodex.
Applied: label is now `Clodex v<version>`, no severity, no invented client
version (which would be the same self-confirming number the design already
rejects).

## Phase 3 — (3) built

- `plugin-loader.js`: `listUserRoot()` — `ensureUserRoot()` for the path, ONE
  `readdirSync` (`withFileTypes`, sorted), `{ dir, entries:[{name,isDir}] }`. No
  path argument, no recursion, no writes. Read failure returns
  `{ dir, entries:null, error }` so the panel can still print where plugins go.
  Deliberately does NOT peek inside entries to judge plugin-ness — `status()`
  already has that; the dialog cross-references instead. Exported.
- `plugin-host-engine.js`: `_host` `plugins.listUserRoot`. `hostApi` untouched
  at "1"; the five `plugin:*` transport rows untouched.
- `index.html`: `#plugins-folder` panel, `class="hidden"`.
- `renderer.js`: `showPluginsFolderListing()`; the reveal button branches on
  `window.__CLODEX_WEB__` — desktop path is byte-identical to before. On web the
  button is relabelled "Show Plugins Folder" (a Finder label on a frontend that
  cannot do it is the actual defect) and the panel says "Plugins folder on the
  Clodex host: <path>" — naming whose machine, since a bare path invites copying
  it into a local Finder that will never contain anything.
- `styles.css`: `#plugins-folder` + `#plugins-folder.hidden { display:none }`
  (the t26 lesson: a class-toggled element with no hidden rule ships visible).

## Next

Phase 4 — tests (menubar null rule + insert/remove; appVersion getter; the
listUserRoot bound: no path argument reachable), `npm run build:web`, commit
regenerated `web-dist/`, full suite via clodex-test-green, report.
