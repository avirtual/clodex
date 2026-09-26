# Web UI parity: every `__CLODEX_WEB__` gate in the renderer

Ruling (Bogdan, 2026-09-26): the web UI and the desktop app may differ only where the browser genuinely cannot do something — no local filesystem paths, no `window.require`, no native dialogs or menus, no host clipboard image. A gate without such a reason is a defect.

One row per gate site, in source order. Symbols, not line numbers; `test/web-parity-note.test.js` holds the rows to the sites.

| file | symbol | what differs on web | verdict |
|---|---|---|---|
| renderer/renderer.js | `updateWindowTitle` | tab title carries the attention count | KEPT: substitute — a browser has no dock badge, the title is the only badge a tab has |
| renderer/renderer.js | `terminalContainer` | dropping files onto the terminal shows a toast instead of pasting paths | KEPT: inability — no `webUtils.getPathForFile`, a browser never exposes a dropped file's path |
| renderer/renderer.js | `webNotifier` | attention raises a browser `Notification` while the tab is unfocused | KEPT: substitute — desktop notifies through the main process `notifyOS`, which cannot reach a browser |
| renderer/renderer.js | `updateWindowTitle` | attention change repaints the tab title badge | KEPT: substitute — same as the first row |
| renderer/renderer.js | `activatePluginRenderer` | asks `renderer.info` for the renderer module's source text | KEPT: inability — no `window.require`, the module is evaluated from source |
| renderer/renderer.js | `requirePluginRenderer` | never falls back to `window.require` | KEPT: inability — no `window.require` |
| renderer/renderer.js | `webNotifier` | mention raises a browser `Notification` while the tab is unfocused | KEPT: substitute — same as the attention row |
| renderer/renderer.js | `altChordAction` | Alt+T/W/1-9 mirror Cmd+T/W/1-9 | KEPT: inability — the browser reserves Cmd+T/W/1-9 for its own tabs |
| renderer/renderer.js | `webNotifier` | asks for Notification permission on the first gesture | KEPT: inability — browser notifications need a permission grant, Electron's do not |
| renderer/renderer.js | `linkedFrom` | plugins dialog hides Unregister on a linked plugin | KEPT pending FOLLOW-UP: the button's only call, `_host` `plugins.unregister`, is in `HOST_DESKTOP_ONLY` (plugin-host-engine.js) and answers the web surface `not on this surface`; un-gating needs a security ruling to drop `plugins.unregister` from that set (it takes a plugin id, not a host path) |
| renderer/renderer.js | `pluginsRegisterBtn` | Register Plugin… is hidden | KEPT: inability — native folder picker (`selectDirectory`); `plugins.register` is also in `HOST_DESKTOP_ONLY`, so a typed-path form would still be refused |
| renderer/renderer.js | `warningText` | install warning says the code runs on the host the browser is connected to | KEPT: wording — the code really runs on another machine than the browser's |
| renderer/renderer.js | `warningText` | update warning, same wording | KEPT: wording — same as the row above |
| renderer/renderer.js | `showPluginsFolderListing` | Reveal lists the folder in-app instead of opening Finder | KEPT: inability — `fileReveal` is `shell.showItemInFolder` on the host, not the browser's machine |
| renderer/renderer.js | `revealBtn` | the Reveal button is relabelled Show Plugins Folder | KEPT: inability — same as the row above |
| renderer/renderer.js | `sbWorkdirPick` | sandbox workdir Pick… and mounts Add… are hidden | KEPT: inability — native folder picker (`selectDirectory`); the workdir stays typeable. FOLLOW-UP: a typed-path input for mounts |
| renderer/side-pane.js | `isWeb` | the flag itself | KEPT: declaration of the four rows below |
| renderer/side-pane.js | `paneVisible` | the side pane opens at any viewport width | KEPT: layout — narrow viewports get a sheet instead of hiding the pane |
| renderer/side-pane.js | `renderChrome` | a narrow viewport shows the pane as a sheet | KEPT: layout |
| renderer/side-pane.js | `showOpen` | file tabs hide Open | KEPT: inability — Open launches the host's default app via `file:open`, on the host, not the browser's machine |
| renderer/side-pane.js | `sidePaneFits` | no "widen the window" toast | KEPT: layout — the sheet row above replaces it |

Counts: 21 rows — 20 kept with a named reason (inability, substitute, layout or wording), 0 removed, 1 kept pending FOLLOW-UP (Unregister), 1 further FOLLOW-UP noted (mounts typed path).
