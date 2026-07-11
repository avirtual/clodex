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
  functions, which is what makes them unit-testable. `app-menus.js`,
  `ipc-handlers.js`, `remote-wiring.js` require electron directly by design
  (they ARE the electron layer).
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

### Coordinator

- **main.js** (~1.6k lines) — module requires, config consts, the intent
  helpers, the shared session helpers (`fetchProxyContext/Report/Bust`,
  `fetchSessionFiles/FilePeek/FileDiff`, `restartSession`,
  `waitForSessionExit`, `peerProxyView` — injected into both remote-wiring
  and ipc-handlers; deliberately NOT a module), window lifecycle
  (`createWindow`, `workspaceOfSender`, `openWirescopeWindow`), and the
  `app.whenReady()` bootstrap that wires everything below.

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
