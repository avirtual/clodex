# Clodex architecture — module map

Post-refactor layout (2026-07, phases M1–M5 / R1–R4). Two processes:
**main** (Electron main — flat `*.js` at the repo root) and **renderer**
(`renderer/`). `main.js` and `renderer/renderer.js` are thin coordinators;
everything else is a module with an explicit interface.

This file answers "where does code live". The subsystem docs answer "how
does it work and what must I not break":

- [sessions.md](sessions.md) — session lifecycle: create/argv, hooks,
  transcript watching, exit/kill/restore, persistence, workspaces.
- [messaging.md](messaging.md) — intents: grammar, routing, DM delivery,
  injection, parking/resend, federation, memory, protocol text, drains.
- [peering.md](peering.md) — remote server, peer client, tunnels, control
  model, peers UI, deploy wizard, headless nodes.
- [telemetry.md](telemetry.md) — wirescope client/poller/supervisor,
  autocompact, statusline, ctx reminders, updates, ops log.

Conventions the refactor established:

- **Factory + deps object.** Extracted modules export `createX(deps)` /
  `initX(deps)` / `registerX(deps)`. Stable values inject by value; anything
  assigned in `app.whenReady()` (or declared below the init site) crosses as
  a lazy getter (`getX: () => x`); singletons the module writes cross as
  get+set pairs (`getRemoteServer`/`setRemoteServer`).
- **The electron gap.** `session-manager.js` and the M3 infra modules never
  `require('electron')` — electron-touching behavior injects as seam
  functions, which is what makes them unit-testable. The gap was widened in
  the engine-extraction arc: **`engine.js` assembles the entire electron-free
  module graph** and only the host-adapter layer (`main.js`, `app-menus.js`,
  `ipc-handlers.js`, `preload.js`) imports electron.
  `test/electron-boundary.test.js` pins that allowed set — shrinking it is
  welcome, growing it needs a documented ruling. See *Engine and host
  adapters* below.
- **Leak gates.** `test/free-identifier-leaks.test.js` guards both
  directions of every extraction: a module referencing a coordinator-scope
  name that was never injected (forward), and a coordinator referencing a
  name that moved into a module (reverse, `danglingRefs`). New extractions
  MUST be added to `SCANNED_MODULES` / `RENDERER_SCANNED_MODULES`.
- **Template literals are byte-sensitive.** Generated scripts (cli-hooks)
  and injected HTML keep interior columns exactly; re-indenting a moved
  multi-line template is a real bug class (broke every hook script once —
  pinned by test).

## Main process

### Engine and host adapters

The engine-extraction arc (2026-07, phases 1–4) split the main process into a
plain-Node **engine** and thin **host adapters**, so the Electron desktop app
is one frontend among several. There are three hosts today: the **Electron
desktop app** (`main.js`), the **headless node** (`headless-main.js`, plain
Node for Linux/k8s spokes), and — layered on the headless node — the **browser
frontend** (`web-host.js` + the `web-dist/` bundle), whose packaged form is the
Docker image under [`../docker/web/`](../docker/web/).

- **engine.js** — `createEngine({ userDataPath, seams, log })` owns the whole
  electron-free bootstrap: stores → pollers → scheduler → log → wirescope +
  watchdog → remote → peers → cleanup → legacy sweep → restore, in that exact
  order. It constructs the SessionManager and every module above, and returns
  a **flat handle object**: the six primary handles (`manager`, `stores`,
  `syncRemoteServer`, `syncPeerManager`, `restoreSessionsForWorkspace`,
  `shutdown`), the shared infra, the `get{RemoteServer,PeerManager,…}`
  accessors, and the ~80-key helper surface `ipc-handlers.js` / `app-menus.js`
  consume. The return is deliberately **broad, not a lean six-tuple**: the
  adapters need dozens of engine internals (`manager` most of all), and
  constructing `manager` in `main.js` would drag the entire electron-free graph
  back into the adapter. Handing the internals out through the return keeps the
  adapter from reaching into engine internals directly. `engine.js` is in the
  leak-scanner's `SCANNED_MODULES` and never imports electron
  (`test/electron-boundary.test.js`).
- **The seam contract** — the host→engine boundary. Every electron touch the
  engine needs is an optional seam fn on `createEngine`'s `seams`, each
  defaulted to a no-op / sane fallback: `openPath`, `notifyOS`,
  `setAppQuitting`, `appVersion`, `isPackaged`, `refreshAppMenu`,
  `scheduleAppMenuRefresh`, `refreshTrayMenu`, `scheduleTrayRefresh`,
  `restartHost`. A seam nothing reads is a lying contract — an inert
  `getUserDataPath` seam was dropped in Phase 3 (the engine derives
  `userDataPath` from its own param). `userDataPath` is a plain constructor
  arg, not a seam.
- **main.js** (~0.5k lines) — the **desktop adapter**. Its `whenReady`
  resolves `userDataPath` (`app.getPath('userData')`), builds the electron
  seams (`shell.openPath`, `Notification`, `app.relaunch`, the tray/menu
  refreshers), calls `createEngine`, then stacks the desktop-only layer on top:
  windows (`createWindow`, `workspaceOfSender`, `openWirescopeWindow`), tray +
  app menu, `registerIpcHandlers`, update-checker banners, and the shared
  session helpers (`fetchProxyContext/Report/Bust`,
  `fetchSessionFiles/FilePeek/FileDiff`, `restartSession`,
  `waitForSessionExit`, `peerProxyView` — injected into both remote-wiring and
  ipc-handlers; deliberately NOT a module). `before-quit` /
  `window-all-closed` route to `engine.shutdown()`.
- **headless-main.js** — the **headless adapter**, `node headless-main.js`. No
  Electron, no Xvfb, no windows/tray/ipc: `userDataPath` from
  `CLODEX_DATA_DIR` (or the platform default), a pidfile single-instance lock,
  log-only `openPath`/`notifyOS` seams, `restartHost` that shuts down and exits
  64 for a supervisor to relaunch, and SIGTERM/SIGINT → `engine.shutdown()` →
  exit 0. It restores `DEFAULT_WORKSPACE_ID` (or `CLODEX_WORKSPACES`). Also in
  `SCANNED_MODULES`. Deployment: [../peering/README.md](../peering/README.md).
- **web-host.js** — the **browser frontend**, engine-side. Plain Node (HTTP +
  `ws`), started by `headless-main.js` when `CLODEX_WEB_PORT` is set; the
  Electron app never loads it. It drives the SAME `registerIpcHandlers` map and
  event-push surface over a WebSocket that the desktop `window.api` speaks over
  ipcRenderer — the browser client (`renderer/web/`, built by
  `build/build-web.js` into `web-dist/`) rebuilds `window.api` from the shared
  `api-contract.js` table, so the renderer runs unchanged. Optional
  `CLODEX_WEB_TOKEN` gates every route + the WS upgrade + the hello frame;
  absent = localhost trust. NOT in the leak-scanner lists (new code, not a
  move-only extraction) and never imports electron. Packaged as the Docker image
  in [`../docker/web/`](../docker/web/) (a two-stage build of the headless host +
  the web bundle); the peer test-box in `../docker/` is unrelated.

### Coordinator

The module-graph bootstrap that once lived in `main.js`'s `whenReady` is now
`engine.js` (see *Engine and host adapters* above); `main.js` is the desktop
adapter that hosts it. The modules below are what the engine assembles.

### Extracted by the refactor (M1–M5)

- **fs-util.js** — filesystem primitives (ensureDir etc.).
- **intent-scanner.js** — `[agent:…]` intent matching on assistant text
  (port of wb-wrap/scanner.py).
- **argv-merge.js** — CLI argv assembly: prompt-channel merging +
  context-window math.
- **statusline.js** — statusline script generation + proxy-base resolution.
- **transcript.js** — JSONL transcript → markdown/messages rendering.
- **catalogs.js** — static shared constants (CLAUDE_TOOLS, THEME_KEYS,
  AGENT_NAME_RE, DEFAULT_WORKSPACE_ID, …).
- **stores.js** — `initStores(userDataPath, …)` builds all eight persistence
  stores (sessions/workspaces/templates/prompts/agent+skill libraries/
  defaults/ui-settings). Paths derive inside the factory, post-whenReady by
  construction.
- **ipc-prompt.js** — `IPC_PROMPT`, the canonical all-enabled literal that is
  the sole source of truth for the agent-facing IPC protocol text, plus
  `buildIpcPrompt(intentsList)` which assembles the per-seat variant (gating
  grammar lines + the MEMORY section to a session's allowed intents via
  intent-catalog's `intentEnabled`; double byte-pinned back to the literal).
- **agent-transport.js** — per-agent registry (`run/<name>/agent.json`) +
  Unix-socket (`run/<name>/agent.sock`) transport; discovery iterates
  `run/*/agent.json`.
- **clodex-paths.js** — the per-agent runtime path grammar under `~/.clodex`:
  `pathFor(root, name, kind)` / `runDirFor(root, name)` over 18 artifact kinds,
  the single source every mint site routes through. Pure leaf (no I/O, like
  scope-util); NOT in the leak-scanner lists. Shared dirs (`messages/`,
  `pending/`, `agents/`, `skills/`, …) stay at the root and are outside the
  grammar.
- **legacy-sweep.js** — one-time, marker-gated (`run/.migrated`), name-driven
  migration of the OLD flat `{name}-*` artifacts into `run/<name>/`, plus a
  log-only orphan pass. `runLegacySweep` deletes only `{knownName}{knownSuffix}`
  (never filename-parsed, so shared `wire-shadow.jsonl` / `codex-session-hook.sh`
  can't be misattributed); `findOrphans` is pure. Called from the whenReady
  bootstrap.
- **jsonl-watcher.js** — polls the per-agent transcript symlink, extracts
  assistant turns, emits text/sessionId/activity.
- **cli-hooks.js** — generates the per-session hook scripts + settings for
  Claude and Codex (transcript symlink, ack/pending/ctxwarn drains).
  Generated bytes are test-pinned.
- **wirescope-proxy.js** — wirescope client + the ProxyPoller telemetry
  tick.
- **wirescope-supervisor.js** — wirescope process supervision.
- **update-checker.js** — GitHub release poller (data layer only; main.js
  keeps the notify/banner side effects).
- **session-manager.js** (~2.3k lines) — the SessionManager class: PTY
  spawn/kill/restore, per-session state, intent routing, DM delivery/
  parking, inject queue integration. Zero electron; ~80 injected deps.
- **app-menus.js** — tray + application menu builders (11 fns).
- **remote-wiring.js** — RemoteServer construction/reconciliation
  (`syncRemoteServer`).
- **peer-wiring.js** — PeerManager + TunnelManager reconciliation and
  persisted-attachment/control helpers.
- **ipc-handlers.js** (~1.3k lines) — every `ipcMain.handle/on`
  registration, run from whenReady via `registerIpcHandlers(deps)`.

### Pre-refactor modules (already factored before M1)

- **inject-queue.js** — serialized PTY injection with typing quiet-gate and
  park-at-fire divert.
- **pending-store.js** / **peer-outbox.js** — durable delivery parking
  (local layer-3 / federation outbox).
- **memory-store.js** — agent memory units (list/remember/recall/pin).
- **attention.js**, **ctx-reminder.js**, **file-touch.js**,
  **proxy-util.js**, **agents-util.js**, **skills-util.js**,
  **scope-util.js** (skill/agent visibility: `visibleTo` /
  `autoEnabledFor` / `unionEnabled` / `reconcilePartialSelection` — the
  `workspace:`/`sessions:` frontmatter scope predicate + spawn-union +
  scoped-checklist save semantics),
  **wire-intents.js**, **wire-telemetry.js** — pure helper layers.
- **remote.js** — the remote/peer HTTP+SSE server (phone access + peering
  owner side).
- **peer-client.js** — consuming side of the peering protocol (hello loop,
  SSE attach, reconnect).
- **peer-tunnel.js** — managed `ssh -N -L` tunnel supervisor.
- **peer-deploy.js** + **ssh-run.js** — deploy-wizard classification +
  one-shot ssh transport.
- **peer-input-queue.js** — PendingInput buffer behind type-to-take.

## Renderer

### Coordinator

- **renderer/renderer.js** (~2.6k lines) — the regions that share
  coordinating state: sessions Map + activeSession, terminal management
  (createTerminal/switchSession/removeSession/remeasureReadonlyPeer), the
  sidebar render loop + session context menus, PTY data routing, the
  new-session dialog, proxy/ctx telemetry state + `renderProxyBar`,
  `popoverApi` (the local-vs-peer data seam), the peers-SETUP dialog
  (connection config; reads the core peerStatuses/peerTunnels Maps),
  preferences/edit-args dialogs, keyboard shortcuts, restore IIFE, and the
  island init sites.

### Extracted by the refactor (R1–R4)

- **renderer/lib/** — pure-ish leaves: `constants.js`, `format.js`
  (string formatters, unit-tested), `render-html.js` (DOM-string builders),
  `checklists.js` (render/collect checklist pairs; owns five library
  caches behind setters), `session-actions.js` (the type→entries mapping for
  the consolidated `⚙ session ▾` menu, unit-tested).
- **Islands** (own state + DOM, `init*(deps)`): `ipc-log.js`,
  `term-search.js`, `banners.js`, `themes.js`, `library-drawers.js`
  (prompts/agents/skills drawers), `subagent-popover.js`,
  `inbox-drawer.js` (operator inbox for `[agent:notify-user]` notes +
  the sidebar-footer unread badge; self-contained, no core deps).
- **renderer/popovers/** — the popover family behind `popoverApi`:
  `report-panel.js`, `context-popover.js`, `cost-popover.js`,
  `bust-popover.js`, `files-popover.js` (also exports `openFilePeek` +
  `isFilesPopoverForKey` for the peer subsystem), plus two that are NOT on
  the data seam by design: `checklist-popovers.js` (tools/skills/agents/**intents**
  — local config editors, direct `window.api`; tools/agents suppressed for
  peers, but **skills takes an optional peer `source`** so the same popover
  edits a peer session's skills over the wire under the `args` cap; the intents
  popover applies IMMEDIATELY — the fire-time gate re-reads persistence — with an
  optional restart only to refresh the seat's prompt) and
  `session-menus.js` (warm/strip/history dropdowns + the consolidated
  `⚙ session ▾` launcher menu — local action menus).
- **renderer/peers-ui.js** — the peer runtime: sidebar peer rows, peer bar,
  control + type-to-take, the 13 peer event subscriptions, restore sweep,
  visibility/control maps, `PEER_UI_KINDS`, and the peer-select/peer-info
  popovers. Six back-exports to core (`typeToTakeControl`, `renderPeerBar`,
  `forgetControlMirror`, `openPeerSession`, `peerDisplayHost`,
  `peerHideFromList`).

## Tests

Plain `node --test` (480 at the end of the refactor). Notable guards:

- `test/free-identifier-leaks.test.js` — the two-directional extraction
  gate described above; its scanner self-tests pin the lexer classes that
  once hid real leaks (multi-line declarations, template interpolations,
  control-flow heads, nested backticks).
- `test/cli-hooks.test.js` — pins generated hook-script bytes (heredoc
  terminators at column 0, python unindented).
