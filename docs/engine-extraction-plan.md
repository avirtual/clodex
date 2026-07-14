# Engine extraction — one engine, N frontends

Goal (Bogdan, 2026-07-14): Clodex everywhere. The Electron app stays exactly
as it is on the Mac, but becomes ONE consumer of a plain-Node engine instead
of the only possible host. First new consumer: a true headless entrypoint
(no Electron, no Xvfb) for the Linux spokes / future k8s. A web frontend
(WS transport for the window.api contract + bundled renderer) is a LATER
phase, not this plan.

Ground truth from the 07-14 investigation (verified against code):

- 43 of 49 root modules are already electron-free; the engine exists, it
  just has no formal boundary. main.js is both the Electron adapter and the
  engine bootstrap, tangled.
- session-manager takes exactly 4 electron seams: getUserDataPath, openPath,
  notifyOS, setAppQuitting (session-manager.js:154, header 17-25).
- remote.js (peer wire) is plain Node http+SSE, zero electron. UI fan-out
  (`_sendToSession`/`_broadcast`) already degrades correctly with zero
  windows — the detached-workspace path.
- The three REAL changes, everything else is bootstrap plumbing:
  1. wirescope-supervisor.js calls app.getPath('userData')/app.isPackaged
     directly at 4 sites (58, 71, 104, 276) — the one module that skipped
     the seam pattern.
  2. remote-wiring.js requires electron for app.getVersion() +
     app.isPackaged (line ~307 srcDir) only.
  3. Session restore-on-launch exists ONLY as the renderer-invoked
     `app:restore-sessions` handler (ipc-handlers.js:1323). No non-IPC path.

## Discipline (applies to every phase)

- Move-only + parameterization, M1-M5 style. No behavior changes to the
  Electron app. The desktop app after each phase is byte-for-byte
  functionally identical.
- Every new/changed module goes into test/free-identifier-leaks.test.js
  SCANNED_MODULES (both directions).
- New rule, enforced by a new test: **no `require('electron')` outside the
  adapter set** (main.js, app-menus.js, ipc-handlers.js, preload.js,
  renderer/). Phase 1 shrinks the violator list to exactly that set; the
  test pins it so the boundary can't erode.
- Tests via `[agent:exec run-tests]`. Each phase lands green before the
  next starts. clodex-hand implements, never commits; clodex reviews the
  full diff and integrates.

## Phase 1 — de-electronify the two stragglers  (small, shippable alone)

**1a. wirescope-supervisor.js**: createWirescopeSupervisor(deps) already
takes a deps object — add `getUserDataPath` and `isPackaged` to it (getter
fns, whenReady-lazy, same pattern as session-manager). Replace the 4 direct
app.* call sites. main.js supplies `() => app.getPath('userData')` and
`() => app.isPackaged`. Drop the `require('electron')` line.

**1b. remote-wiring.js**: add `appVersion` + `srcDir` (or `isPackaged`) to
createRemoteWiring's deps. appVersion = require('./package.json').version
works for BOTH hosts (Electron's getVersion() reads the same field) — main.js
can pass it by value. Drop the electron require.

**Verify**: full suite green; `npm start` smoke (wirescope autostart still
finds its venv dir; peer hello still reports version/srcDir).

## Phase 2 — lift restore-sessions out of the IPC handler

Extract the body of `app:restore-sessions` (ipc-handlers.js:1323) into a
plain async fn `restoreSessionsForWorkspace(workspaceId)`. RULING
(07-14, resolved during implementation): the original "define it in
main.js like restartSession" conflicted with the unit-test requirement —
nothing in test/ can import main.js (it requires electron). So the core
lands in a new electron-free leaf **session-restore.js** (in
SCANNED_MODULES), taking { workspaceId, persistence, manager, proxyPoller,
maybeCompactBeforeResume, readCtxFor, log }; main.js keeps only a thin
closure over its module globals (the seam engine.js inherits in Phase 3);
readCtxFor relocates from ipc-handlers to main.js (single-consumer, deps
already there). The IPC handler becomes a one-liner:
`(e) => restoreSessionsForWorkspace(workspaceOfSender(e))`.

Return shape, failure semantics (`failed: true` entries kept in
persistence — the retry/forget UI contract, see CLAUDE.md gotcha) must be
IDENTICAL. Add a behavioral test driving the extracted fn with a fake
manager/persistence: restores missing, skips running, keeps failed entries.

## Phase 3 — engine.js + headless-main.js

**engine.js** (new, plain Node, goes in SCANNED_MODULES): a
`createEngine({ userDataPath, seams, log })` factory that owns the
electron-free bootstrap currently inline in main.js whenReady:

- initStores(userDataPath, ...)
- SessionManager construction (the deps object main.js builds at ~974 —
  move the electron-free deps in, keep electron seams injected)
- agent-transport registry + cleanup, message cleanup interval,
  legacy sweep
- remindScheduler construction + start
- remote-wiring syncRemoteServer + peer-wiring syncPeerManager
- wirescope supervisor + watchdog (the setInterval block in whenReady)
- proxyPoller + manager.startPendingPoll
- restoreSessionsForWorkspace (from Phase 2)
- returns { manager, stores, syncRemoteServer, syncPeerManager,
  restoreSessionsForWorkspace, shutdown() → killAll + timers cleared }

main.js whenReady becomes: resolve userDataPath, build the electron seams
(shell.openPath, Notification, tray/menus/windows as today), call
createEngine, then the window/menu/ipc layer on top. This is the risky
phase — it restructures main.js's initialization order. Preserve the
EXACT current ordering (stores → pollers → scheduler → log → wirescope →
remote → peers → cleanup → sweep → windows/restore); the whenReady-getter
convention means most cross-references already tolerate the move.

**headless-main.js** (new entrypoint, `node headless-main.js`):
- userDataPath: `CLODEX_DATA_DIR` env or the platform default that
  app.getPath('userData') resolves to (~/.config/clodex on Linux,
  ~/Library/Application Support/Clodex on macOS) so an existing Xvfb
  deployment's sessions.json is picked up unchanged.
- pidfile single-instance lock (userDataPath/headless.pid, stale-pid
  detection via kill(pid, 0)).
- seams: openPath/notifyOS no-ops (log-only), setAppQuitting real closure.
- fixPathFromLoginShell equivalent: always run (cheap, idempotent).
- SIGTERM/SIGINT → engine.shutdown() → process.exit(0). This replaces
  before-quit; node-pty teardown must be confirmed on this path.
- After engine up: `restoreSessionsForWorkspace(DEFAULT_WORKSPACE_ID)`
  (headless nodes are single-workspace by convention, peering/README.md).
  Optional CLODEX_WORKSPACES env (comma-sep ids) for the general case.
- NO update-checker, NO app-menus, NO ipc-handlers, NO windows.

**node-pty ABI caveat for verification**: the dev checkout's node-pty is
built against Electron's ABI — `node headless-main.js` in this tree will
fail to load it. Unit tests are fine (fake PTYs). For a live smoke, use a
scratch clone with `npm rebuild` (Node ABI), or smoke on a spoke. Do NOT
rebuild node_modules in the working checkout (it breaks `npm start`).

**Verify**: suite green; `npm start` full smoke on the Mac (windows, tray,
sessions, peers); headless smoke = spawn a session, DM round-trip over the
peer wire, SIGTERM teardown leaves no orphan PTYs.

## Phase 4 — boundary test + docs (closes the arc)

- New test: walk root *.js, assert `require('electron')` appears only in
  {main.js, app-menus.js, ipc-handlers.js, preload.js}.
- docs/architecture.md: engine vs adapters section. peering/README.md:
  headless-main path as the new deployment (Xvfb path kept documented
  until the spokes migrate).

## Out of scope (explicitly)

- Web frontend / WS transport for window.api / renderer bundling — next
  arc, needs the auth design first.
- Any change to the peer wire protocol, injection timing, or park logic.
- Migrating the actual spoke deployments (operational, after release).
