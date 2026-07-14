# Web frontend — Clodex in Docker, GUI in a browser

Goal (Bogdan, 2026-07-14): the OPTION to run a Clodex docker image and access
the GUI through a published port in a browser. **The Electron desktop app
stays exactly as it is** — local engine, ipcMain transport, nodeIntegration
renderer, no thin-client mode, no behavior change. The browser is a NEW
frontend for the engine (engine.js, v2.22.0), not a replacement for any
existing one. Peering is NOT the mechanism here — peers are federation
between sovereign Clodexes; this is one Clodex's own GUI over a port.

Ground truth (verified 07-14):

- preload.js window.api = 165 invoke/send/on endpoints — THE contract a
  browser client must speak.
- ipc-handlers.js post-engine-extraction touches electron via: ipcMain
  (handle ×118, on ×5 — registration), and 17 direct GUI calls — dialog ×8
  (6 showMessageBox confirms, showOpenDialog, showSaveDialog),
  Menu.buildFromTemplate().popup() ×3, shell ×4 (openExternal ×2, openPath,
  showItemInFolder), app ×2 (getVersion, getPath('desktop')), with window
  anchoring via BrowserWindow.fromWebContents ×3 + getFocusedWindow ×7.
  (CORRECTED 07-14 from clodex-hand's line-by-line audit; the original
  "only ipcMain + 28 fromWebContents" claim was wrong — carried over
  unverified from a coarse inventory.) Workspace resolution is ALREADY
  fully seamed via injected workspaceOfSender(e) — the Phase 3 handshake
  replaces that seam's implementation, nothing in ipc-handlers.
- Renderer is bundlable: requires = xterm npm pkgs (browser-native),
  renderer/lib + islands + popovers, and 7 pure root leaves (proxy-util,
  peer-input-queue, peer-deploy, skills-util, scope-util, intent-catalog,
  os). No fs/electron anywhere under renderer/.
- Event push flows through session-manager's _sendToSession/_broadcast
  (workspaceId→window map) — the interception point already exists.

## Discipline (same as the engine arc)

- Electron path stays byte-identical in behavior; where code is shared,
  parameterization only. Suite green per phase via [agent:exec run-tests];
  clodex-hand implements + never commits; clodex reviews full diff,
  integrates, releases. New modules → leak-scanner lists. The
  electron-boundary ALLOWED set may only SHRINK.
- Genuine spec tensions: stop and get a ruling, don't guess (this worked
  twice in the engine arc — the leaf ruling and the data-dir catch).

## Phase 1 — transport seam in ipc-handlers

Make registration transport-agnostic without moving a single handler body:

- registerIpcHandlers gains injected `handle(channel, fn)` + `on(channel,
  fn)` and uses them everywhere it now calls ipcMain.handle/ipcMain.on.
  main.js passes wrappers over ipcMain. Drop the ipcMain require.
- Seam the 17 GUI calls as TEN capability fns (RULED 07-14): popupMenu
  (template, e), showMessageBox(opts), showSaveDialog(opts),
  showOpenDialog(opts), openExternal(url), openPath(p),
  showItemInFolder(p), getAppVersion(), getDesktopPath(). Window
  resolution FOLDS INTO the capability wrappers in main.js
  (fromWebContents/getFocusedWindow live inside them) — no
  window-object seam ever crosses into ipc-handlers, and the IPC event
  rides through as an opaque sender token so a Phase-3 WS connection can
  occupy the same slot. Names mirror electron deliberately (the wrappers'
  semantics ARE electron's; Phase 3 implementing them degraded is honest).
- End state: ipc-handlers.js has NO electron require → remove it from the
  boundary-test ALLOWED set (the test's "shrinking welcome" case).
- Electron behavior byte-identical; this phase is shippable alone.

## Phase 2 — event-push enumeration + emitter seam

Enumerate every channel the main process pushes to renderers (grep
webContents.send + _sendToSession/_broadcast callers; expect: pty-data,
session-exit, session-activity, session-ctx, ipc-message, update banners,
peer events, …). Ensure every one flows through a single injectable
emitter surface on the engine/host boundary (most already do via
_sendToSession/_broadcast). Document the channel list in the plan or a
doc — it is the other half of the browser contract. No behavior change.

## Phase 3 — web host: WS transport + bundled renderer (the big one)

Detailed spec (2026-07-14, post-P1/P2). Two milestones, EACH delivered,
reviewed, and committed separately: **P3a** (server side, headlessly
testable) then **P3b** (browser client + bundle). Companion contracts:
the 165-endpoint request half lives in preload.js; the 45-channel push
half in docs/renderer-events.md.

### P3a — web-host.js: WS server + engine wiring

**Module + entrypoint.** New `web-host.js` (plain Node, NOT in the
electron-boundary ALLOWED set): `createWebHost({ engine, log, port,
token })` → `{ close }`. Started ONLY by headless-main.js when
`CLODEX_WEB_PORT` is set — the Electron app never loads it. Dependency:
add `ws` (zero-dep) to production dependencies; plain `http` for the
rest (same stance as remote.js).

**Wire protocol** — JSON text frames (JSON.stringify round-trips any JS
string including lone surrogates, so pty-data rides as the already-
decoded string; NO base64 layer — this supersedes the earlier base64
note):
- client→server: `{t:'hello', workspaceId?, token?}` (first frame;
  workspaceId defaults to 'default'), `{t:'invoke', id, channel, args}`,
  `{t:'send', channel, args}` (the 5 ipcMain.on channels: pty-input,
  peer:input, session:context-menu, peer:context-menu,
  peer:header-menu), `{t:'menu-pick', menuId, itemId|null}`,
  `{t:'dialog-reply', dialogId, value}`.
- server→client: `{t:'welcome', workspaceId, appVersion}`, `{t:'reply',
  id, ok, value?|error?}`, `{t:'event', channel, args}` (the push half),
  `{t:'menu-show', menuId, items}`, `{t:'dialog-show', dialogId, kind,
  opts}`.
Frames before a valid hello (or with a bad token when `token` is set)
close the socket. Non-JSON-serializable handler return values: audit
during implementation; if any Buffer/Date surfaces, normalize at the
dispatcher (flag it in the handoff, don't silently coerce).

**Handler map.** The web host calls registerIpcHandlers ONCE at startup
with a deps object mirroring main.js:473's assembly: `{...engine,
...engine.stores}` + its own transport (`handle`/`on` populate a plain
Map<channel, fn>) + the degraded capabilities below + stubs for the
host-only tail — createWindow (no-op: browser tabs self-navigate; the
workspace record work already happens in the handlers),
openWirescopeWindow (log-only), setUiTheme / refreshAppMenu /
refreshTrayMenu (no-ops), checkForUpdate/UPDATE_REPO/getUpdateInfo/
getReleasesCache (inert: update-available is a designated desktop-only
channel), `workspaceOfSender(e)` reads the connection behind the sender
token. An invoke frame dispatches `map.get(channel)(e, ...args)` with
`e = {sender: {send: (ch, ...a) => conn.pushEvent(ch, a)}}` — the same
opaque-token shape Phase 1 established (§C channels flow free).

**Sender context for token-less capabilities.** showMessageBox /
showSaveDialog take only (opts) — under Electron the window resolution
is folded inside main.js's wrappers. The web host threads the requesting
connection via AsyncLocalStorage: the invoke dispatcher runs each
handler inside `als.run(conn, …)` and the capability impls read
`als.getStore()`. No Phase-1 signature changes.

**Degraded capabilities (v1, per the P1 handoff ruling: dialogs and
menus belong to the requesting connection):**
- `popupMenu(template, e)` — click closures STAY server-side: assign
  item ids, send `menu-show` (labels/enabled/separators; drop
  accelerators/submenus if none are actually used — audit), await
  `menu-pick`, invoke the matching `template[i].click()`. Dismiss →
  no-op.
- `showMessageBox(opts)` — `dialog-show(kind:'message')` to the ALS
  connection, await `dialog-reply`, resolve `{response}` (electron
  shape). Timeout/disconnect → resolve as cancel (the last button /
  cancelId).
- `showSaveDialog(opts)` — `dialog-show(kind:'save')` prompts for a
  filename; resolve `{canceled, filePath}` where filePath lands under
  `<userDataPath>/exports/` (sanitized basename). Serve `GET
  /exports/<file>` (token-gated) so the tab can offer a download.
- `showOpenDialog(opts)` — `dialog-show(kind:'open')` free-text path
  input; server validates fs.stat().isDirectory(); resolve `{canceled,
  filePaths}`.
- `openExternal(url)` → event to the ALS/sender connection; client
  window.open. `openPath(p)` → degrade to the in-browser file view
  where one exists, else log. `showItemInFolder(p)` → event; client
  shows the path (toast/copy). `getAppVersion()` → package.json.
  `getDesktopPath()` → the exports dir.

**Connection-backed window handles (the P2 contract).** Per workspace
with ≥1 tab, the host registers ONE multiplexing handle in
`manager.registerWindow(workspaceId, handle)` implementing exactly the
five methods: `webContents.send(ch, ...args)` fans an event frame to
every tab on that workspace; `isDestroyed()` = no tabs left;
`isFocused()` = any tab visible (client sends visibility hints;
default true); `show()`/`focus()` = a `focus-hint` event (serves
session-file-view). First tab registers, last disconnect unregisters —
so the engine's pendingOutput buffering (2MB) resumes exactly as for a
closed Electron window, and a reconnecting tab gets the replay through
the SAME path the desktop uses: the renderer's restore flow invoking
`app:restore-sessions` (session-restore.js returns `replay`).
Additionally the host keeps its OWN per-session scrollback ring (same
2MB cap) of pty-data it forwarded, replayed to a LATE-JOINING tab whose
workspace was already attached (the one case the engine buffer can't
cover — it only fills while detached). Zero engine change. Multi-tab
resize: last-writer-wins, accepted for v1.

**Auth v1 structure.** Optional `CLODEX_WEB_TOKEN`: bearer/`?token=`
check on every HTTP route + the WS upgrade + the hello frame. Absent →
localhost-trust stance (Phase 4 documents it). Structured so a real
auth layer replaces one predicate later.

**Tests (P3a is headlessly testable):** protocol framing + hello/token
gating; invoke→fake-handler round-trip incl. sender-token §C push; ALS
threading into a fake showMessageBox; the five-method handle contract
+ register/unregister timing; scrollback-ring replay; menu round-trip
(click closure fires on pick, not on show). electron-boundary: web-host
must NOT require electron (ALLOWED set unchanged). Leak-scanner lists:
not applicable (new module, not an extraction) — state so in the
handoff.

### P3b — browser client: api-contract table + shim + esbuild bundle

- **api-contract.js** (pure leaf): the single table `[{name, kind:
  'invoke'|'send'|'on', channel, argmap?}]` for all 165 window.api
  endpoints (argmap for the few non-passthrough wrappers, e.g.
  showSessionContextMenu's `{name, cwd}` object). **preload.js becomes
  a loop over the table** — window.api's surface and behavior byte-
  identical (this is the "where code is shared, parameterization only"
  clause; preload stays in the boundary ALLOWED set). Test: table
  well-formed, no dup names/channels, every `invoke` channel has a
  registered handler (capture-seam cross-check), and the generated
  window.api key set matches the pre-refactor 165.
- **renderer/web/api-shim.js**: builds window.api from the SAME table
  over the WS (invoke → id'd request/await-reply; send → send frame;
  on → event subscription). Connect + hello happen at boot; invoke
  callers transparently await socket-open. Also handles menu-show /
  dialog-show / focus-hint frames with minimal in-page UI (menu = the
  existing context-menu look if trivially reusable, else a plain
  positioned list; dialogs = simple modal). Reconnect on drop with a
  banner; after reconnect re-run the restore flow (that's what replays
  buffered output).
- **renderer/web/index.html + boot**: sets `window.api` via the shim
  (before renderer.js executes — preload-order equivalent), applies
  shims for the two node touches under renderer/ (`os.homedir()` —
  server passes home in `welcome`; `process` define for esbuild), then
  loads the renderer bundle. Workspace via `?workspace=` (default
  'default').
- **esbuild** as devDependency; `npm run build:web` → `web-dist/`
  (gitignored). Bundles renderer.js + lib + islands + popovers + xterm
  npm pkgs + the 7 pure root leaves; alias `os` to the shim. The
  Electron renderer keeps loading raw files via nodeIntegration — the
  bundle is for the browser only. web-host serves `web-dist/` +
  index.html.
- **v1 degradations surfaced honestly in the UI** (not silently
  broken): native-menu-driven `request-*` drawers → the in-page menu
  bar/buttons open them directly (channel-D designation); set-theme /
  zoom-nudge / update-available → absent; drag-drop of local files →
  absent; `[agent:file open]` → degrades to view.

Genuine spec tensions in either milestone: stop and get a ruling (the
standing rule). Expected friction worth pre-flagging: handlers whose
return values aren't JSON-cloneable, menu templates using more than
label/enabled/separator, renderer code paths assuming synchronous
window.api availability at parse time.

## Phase 4 — Docker image + auth v1 + docs

- Dockerfile (node:20-slim + git + build toolchain + claude/codex CLIs) +
  compose file: engine + web host, port published to 127.0.0.1 by
  default; volumes for CLODEX_DATA_DIR, ~/.clodex, ~/.claude (OAuth from
  a logged-in host), project mounts. restart: always (exit-64 contract).
- Auth v1: the published-to-localhost port IS the boundary (same trust
  stance as remote.js v1); optional CLODEX_WEB_TOKEN env → bearer check
  on HTTP + WS upgrade for anything wider. Real login/TLS is a LATER arc;
  the web host must be structured so it can be added without surgery.
- docs: architecture.md third-host section; a docker/README with the
  paranoia rationale (agents' blast radius = the container + mounts;
  agents' world becomes Linux — mac-native workloads like this repo's
  DMG builds stay host-side).

## Out of scope (explicit)

- ANY change to the Electron app's transport or workflow (it never speaks
  WS; it keeps ipcMain + nodeIntegration).
- Real multi-user auth/TLS (structured-for, not built).
- Peering changes; migrating existing spokes; k8s manifests (the image is
  the k8s enabler, manifests are operational).
