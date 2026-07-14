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

- **web-host.js** (or web-wiring.js): plain-Node HTTP+WS server, engine-
  side. Serves the renderer bundle; WS speaks a small framed protocol:
  request/response mapping the 165 window.api invoke endpoints onto the
  SAME registerIpcHandlers handler map (via the Phase-1 seam), plus
  server→client event frames from the Phase-2 emitter.
- **window.api WS shim**: a browser script implementing the preload
  contract over the WS (invoke → request/await, on → event subscription).
  The renderer must not know which transport it's on.
- **Workspace handshake** replaces workspaceOfSender: a browser tab
  declares its workspaceId on WS connect (default workspace by default);
  the connection object carries it thereafter — same role a
  BrowserWindow played.
- **esbuild bundle** of renderer/ (xterm + lib + islands + popovers + the
  7 pure leaves). The Electron renderer keeps loading raw files via
  nodeIntegration — the bundle is FOR THE BROWSER ONLY.
- **Web degradations, explicit and graceful** (v1): native file dialogs
  (cwd pickers) → text input or a minimal server-side directory browser;
  shell.openExternal → window.open; [agent:file view/open] → view renders
  in-browser, open degrades to view; drag-drop of local files → absent.
  Anything else discovered during the endpoint audit gets listed here.
- PTY streams ride the same WS (base64 frames) — xterm feeds identically
  to the Electron path.

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
