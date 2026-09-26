# Web UI parity: every `__CLODEX_WEB__` gate in the renderer

Ruling (Bogdan, 2026-09-26): the web UI and the desktop app may differ only where the browser genuinely cannot do something — no local filesystem paths, no `window.require`, no native dialogs or menus, no host clipboard image. A gate without such a reason is a defect.

One row per gate site, in source order. Symbols, not line numbers; `test/web-parity-note.test.js` holds the rows to the sites.

| file | symbol | what differs on web | verdict |
|---|---|---|---|
| renderer/renderer.js | `updateWindowTitle` | tab title carries the attention count | KEPT: substitute — the desktop window hides its title bar (`titleBarStyle: 'hiddenInset'`), so only a browser tab ever shows the title |
| renderer/renderer.js | `composerEl` | an image paste into the pty composer shows a toast instead of sending Ctrl-V | KEPT: inability — Ctrl-V makes the CLI read the HOST's clipboard, not the browser's; a web path needs an upload (FOLLOW-UP) |
| renderer/renderer.js | `terminalContainer` | dropping files onto the terminal shows a toast instead of pasting paths | KEPT: inability — no `webUtils.getPathForFile`, a browser never exposes a dropped file's path |
| renderer/renderer.js | `webNotifier` | attention raises a browser `Notification` while the tab is unfocused | KEPT: substitute — desktop notifies through the main process `notifyOS`, which cannot reach a browser |
| renderer/renderer.js | `updateWindowTitle` | attention change repaints the tab title badge | KEPT: substitute — same as the first row |
| renderer/renderer.js | `activatePluginRenderer` | asks `renderer.info` for the renderer module's source text | KEPT: inability — no `window.require`, the module is evaluated from source |
| renderer/renderer.js | `requirePluginRenderer` | never falls back to `window.require` | KEPT: inability — no `window.require` |
| renderer/renderer.js | `webNotifier` | mention raises a browser `Notification` while the tab is unfocused | KEPT: substitute — same as the attention row |
| renderer/renderer.js | `altChordAction` | Alt+T/W/1-9 mirror Cmd+T/W/1-9 | KEPT: inability — the browser reserves Cmd+T/W/1-9 for its own tabs |
| renderer/renderer.js | `webNotifier` | asks for Notification permission on the first gesture | KEPT: inability — browser notifications need a permission grant, Electron's do not |
| renderer/renderer.js | `pluginsRegisterBtn` | Register Plugin… is hidden | KEPT: host refuses — `plugins.validateCandidate`/`plugins.register` are in `HOST_DESKTOP_ONLY` (they load code from a caller-named host path); the folder picker itself works on web as a typed-path dialog |
| renderer/renderer.js | `warningText` | install warning says the code runs on the host the browser is connected to | KEPT: wording — the browser need not be on the host |
| renderer/renderer.js | `warningText` | update warning, same wording | KEPT: wording — same as the row above |
| renderer/renderer.js | `showPluginsFolderListing` | Reveal lists the folder in-app instead of opening Finder | KEPT: inability — a browser has no file manager to show a host path in; on web `file:reveal` only toasts |
| renderer/renderer.js | `revealBtn` | the Reveal button is relabelled Show Plugins Folder | KEPT: inability — same as the row above |
| renderer/side-pane.js | `isWeb` | the flag itself | KEPT: declaration of the four rows below |
| renderer/side-pane.js | `paneVisible` | the side pane opens at any viewport width | KEPT: layout — narrow viewports get a sheet instead of hiding the pane |
| renderer/side-pane.js | `renderChrome` | a narrow viewport shows the pane as a sheet | KEPT: layout |
| renderer/side-pane.js | `showOpen` | file tabs hide Open | KEPT: inability — a browser has no default app to open a host path with; on web `file:open` only toasts |
| renderer/side-pane.js | `sidePaneFits` | no "widen the window" toast | KEPT: layout — the sheet row above replaces it |

Counts: 21 sites audited — 19 kept with a named reason (inability, substitute, layout, wording or host refusal), 2 removed.

Removed (the gate is gone, so the rows above no longer carry it):

- renderer/renderer.js, sandbox dialog `sbWorkdirPick` / `sbMountsAdd`: Choose… (working directory) and Add Folder… (mounts) were hidden on web. `selectDirectory` is served on web as a typed-path dialog, checked on the host, as new-session Browse already uses.
- renderer/renderer.js, plugins dialog `linkedFrom`: Unregister was hidden on a linked plugin. `plugins.unregister` takes a plugin id, not a host path, so it left `HOST_DESKTOP_ONLY` (plugin-host-engine.js) and answers the web surface.
