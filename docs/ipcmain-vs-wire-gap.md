# ipcMain vs. the remote.js wire — a gap audit

Status: AUDIT (mechanical, 2026-07). Answers the residual question in
`docs/engine-as-substrate.md` §"The residual question": *is the `remote.js`
wire expressive enough to be the sole path to the engine, or does the
ipcMain path expose capabilities the wire cannot?* Read-only; no code
changed to produce this.

## 0. Terminology and scope

Three transports touch the engine (`engine.js` / `session-manager.js`,
electron-free) today, not two:

1. **ipcMain** (`main.js` + `preload.js`, Electron desktop) — `window.api`,
   built by looping `api-contract.js` (**226 rows**: 173 `invoke`, 5 `send`,
   48 `on`). Registration lands in `ipc-handlers.js` via injected
   `handle`/`on` seams (confirmed electron-free by grep: no `ipcMain`
   token appears in `ipc-handlers.js`; it is not in
   `test/electron-boundary.test.js`'s `ALLOWED` set, `test/electron-boundary.test.js:32-36`).
2. **web-host.js WS** (`web-host.js`, the browser GUI, started by
   `headless-main.js:187-203` when `CLODEX_WEB_PORT` is set) — calls
   `registerIpcHandlers` **once**, over the identical `api-contract.js`
   table (`renderer/web/api-shim.js:21`), degrading the ten native-GUI
   calls (dialogs/menu/shell) to WS round-trips (`web-host.js:184-262`).
   This surface is **byte-for-byte the same capability set as ipcMain** —
   it is a second transport for the *same* contract, not a second contract.
3. **remote.js HTTP+SSE** (`remote.js`, the peering/phone wire, callbacks
   built in `remote-wiring.js`) — a hand-built, much smaller set of
   `/api/*` routes plus SSE streams, described below.

Because (1) and (2) are provably the same 226-row contract, the real
question collapses to: **api-contract.js (226 endpoints) vs. remote.js's
~19 routes + SSE.** That comparison is what this doc maps.

## 1. The two surfaces, enumerated

### 1a. The ipcMain / api-contract.js surface (226 rows)

Grouped by capability (row counts approximate; every name is a literal
`api-contract.js` `name`/`channel`):

- **Session lifecycle** — `createSession`(session:create) `killSession`
  `archiveSession` `unarchiveSession` `flushPending` `retrySpawnSession`
  `forgetSession` `resizeSession` `setSessionLabel`(`session:setAutoCompact`
  too) `restartSession` `exportSessionMarkdown` `listSessions`
  `reservedSessionNames` `discoverSessions`(`discovery:scan`) `sidebarMeta`
  `getSessionHistory`(`session:history`) `createWorktree` `worktreeInfo`
  `markSessionWorktree` `cwdSuggestions` `noteCwd`. (`api-contract.js:25-80`)
- **Session config editing** — `getSessionArgs`(`session:getArgs`)
  `setSessionArgs` `setSessionTools` `setSessionSkills` `setSessionAgents`
  `setSessionIntents` `getSkillCatalog`(`session:skillCatalog`)
  `getAgentCatalog` `getSkillCatalogFor`/`getToolCatalogFor` (new-session
  dialog pre-create). (`api-contract.js:244-261`)
- **Team management** — `teamCreate` `teamJoin` `teamForCwd` `teamNames`
  `teamRolePrompts` `teamGet` `teamAddRole` `teamSetRole` `teamRemoveRole`
  `teamRenameRole` `teamSetWatchdog`. (`api-contract.js:28-45`)
- **SCM / worktree / file explorer** — `scmStatus` `scmDiff` `scmStage`
  `scmUnstage` `scmDiscard` `scmCommit` `scmBranches` `scmCheckout`
  `scmRemote` `worktreeList` `worktreeRemove` `fsList` `fsRead` `fsWrite`.
  (`api-contract.js:55-68`)
- **Library CRUD** — `listTemplates`/`saveTemplate`/`saveTemplateByName`/
  `removeTemplate`/`exportTemplate`, `listPrompts`/`savePrompt`/
  `removePrompt`/`injectPrompt`, `listAgents`/`getAgent`/`saveAgent`/
  `removeAgent`, `listSkillLib`/`getSkillLib`/`saveSkillLib`/
  `removeSkillLib`, `listExecCommands`/`getExecCommand`/`saveExecCommand`/
  `removeExecCommand`. (`api-contract.js:81-101`)
- **Notifications** — `listNotifications` `markNotificationRead`
  `markAllNotificationsRead` `removeNotification`
  `notificationUnreadCount`. (`api-contract.js:102-106`)
- **Update / diagnostics** — `checkForUpdate` `getUpdateInfo` `getReleases`
  `openUpdate` `onUpdateAvailable`, `getDiagnostics` `toolsCheck`
  `invalidateToolCache`. (`api-contract.js:107-114`)
- **Input/control** — `writeToSession`(send, `pty-input`) `resizeSession`.
  (`api-contract.js:77,117`)
- **Transcript/output (read + push)** — `onPtyData` `onSessionExit`
  `onIpcMessage` `onSessionActivity` `onPendingCount` `sessionFiles`
  `filePeek` `fileDiff` `fileOpen` `onSessionFileView` `onSessionProxy`
  `onSessionCtx` `onSessionTicket` `onSessionAttention` `onSessionMention`
  `potSnapshot`. (`api-contract.js:121-146`)
- **Proxy/telemetry (mutating + read)** — `getProxySnapshot`
  `getProxyContext` `getProxyReport` `getProxyBust`
  `getProxySubagentDetail`, plus the **mutating** `proxyHold` `wireHold`
  `setStripLevel`. (`api-contract.js:137-145`)
- **Workspace** — `listWorkspaces` `currentWorkspace` `setWorkspaceName`
  `newWorkspace` `getSidebarView`/`setSidebarView`. (`api-contract.js:249-265`)
- **Settings** — `getSettings` `setSettings` `setTheme`/`onSetTheme`
  `setDefaultToolDeny` `onZoomNudge`. (`api-contract.js:163-168`)
- **Wirescope** — `openWirescope` `wirescopeStatus` `wirescopeStart`
  `wirescopeStop` `wirescopeRestart` `wirescopePruneInfo`
  `wirescopePrune`. (`api-contract.js:169-175`)
- **Sandbox** — `sandboxDetect/Status/GetConfig/SetConfig/TranslatePath/
  Up/Rebuild/Down/LogsTail/SetToken/ClearToken/ListBoxes/CreateBox/
  DeleteBox`, `onRequestOpenSandboxDialog`. (`api-contract.js:176-191`)
- **Remote-wire self-config** — `remoteStatus` `remoteSetToken`.
  (`api-contract.js:192-193`)
- **Peer management** (managing THIS box's outbound relationships to
  OTHER Clodexes) — `peerProbe` `peerDeploy`/`peerDeployConfig`/
  `peerDeployFix` `peerList` `peerAttach`/`peerDetach`/
  `peerAttachedNames`/`peerForgetAttached` `peerSetDisabled`
  `peerSetRelayAllowed` `peerControlledNames`/`peerForgetControlled`
  `peerVisible`/`peerSetVisible` `peerControl` `peerResize` `peerInput`
  `peerQuery` `peerRestart` `peerCreateSession` `peerCatalogs`
  `peerKillSession` `peerRestartSession` `peerSessionArgs`/
  `peerSetSessionArgs` `peerSkillCatalog`/`peerSetSessionSkills`, plus
  ~13 `onPeer*` push channels. (`api-contract.js:194-243`)
- **Dialogs (native)** — `selectDirectory` `confirmKill`
  `confirmPeerRestart`/`confirmPeerUpdate`/`confirmDeployFix`/
  `confirmPeerKill`/`confirmPeerReload` `showSessionContextMenu`
  `showPeerContextMenu`/`showPeerHeaderMenu`. (`api-contract.js:79,118-119,231-235`)
- **Shell/app-native** — `openExternal`(`app:openExternal`) — note this
  one is engine-adjacent (URL open), separate from the raw `shell.*`
  seams `ipc-handlers.js` takes as injected capabilities.
  (`api-contract.js:136`)
- **UI-navigation broadcast** (menu/tray → renderer) — `onRequestSwitch
  Session` `onRequestOpenNewDialog`/`...Discovery`/`...Workbench`/
  `...BoilingPot`/`...RenameWorkspace`/`...Preferences`/`...PeersDialog`/
  `...PeerSession`/`...AgentsDrawer`/`...SkillsDrawer`/`...ExecDrawer`/
  `...InboxDrawer`/`...PromptsDrawer`/`...TemplatesDrawer`/`...IpcLog`.
  (`api-contract.js:147-162`)

### 1b. The remote.js wire surface

All routes registered in `RemoteServer._route` (`remote.js:400-812`);
callbacks wired in `remote-wiring.js`.

- **Session lifecycle** — `GET /api/sessions` (`remote.js:417-422`),
  `GET /api/transcript/:name` (`remote.js:423-429`), `POST /api/sessions`
  create (`remote.js:611-621`, callback `remote-wiring.js:168-240`),
  `POST /api/kill/:name` (`remote.js:636-644`, `remote-wiring.js:259-268`
  — **hard delete, no archive semantics**), `POST /api/restart-session/:name`
  (`remote.js:651-663`, `remote-wiring.js:276-284`).
- **Session config editing** — `GET`/`POST /api/session-args/:name`
  (`remote.js:669-695`, `remote-wiring.js:292-337`), `GET /api/skill-catalog/:name`
  + `POST /api/session-skills/:name` (`remote.js:702-727`,
  `remote-wiring.js:344-354`), `GET /api/catalogs` session-less pre-create
  read (`remote.js:627-633`, `remote-wiring.js:249-256`).
- **Input/control** — `POST /api/control/:name` acquire/release
  (`remote.js:504-528`), `POST /api/input/:name` (`remote.js:529-542`),
  `POST /api/resize/:name` (`remote.js:543-562`).
- **Transcript/output (read + push)** — `GET /api/attach/:name` per-session
  SSE: `replay`/`telemetry`/`output`/`resize`/`control`/`exit`/`ui` frames
  (`remote.js:470-500`, push fns `pushOutput` `remote.js:222-235`,
  `pushTelemetry` `remote.js:241-248`, `pushUiEvent` `remote.js:260-266`,
  `notifyResize` `remote.js:277-302`, `notifyExit` `remote.js:305-312`).
- **Global SSE** — `GET /api/events`: `activity` (`notifyActivity`,
  `remote.js:195-198`), `sessions` (`notifySessions`, `remote.js:201-210`),
  `dm-mail` (`remote.js:215-217`).
- **Proxy/telemetry (read-only query)** — `POST /api/query/:name`, kind
  ∈ {`ctx`,`report`,`bust`,`files`,`filePeek`,`fileDiff`} (`remote.js:568-580`,
  dispatch `remote-wiring.js:446-463`). No mutating kind exists.
- **Operator messaging** — `POST /api/send` (`remote.js:581-592`).
- **App control** — `POST /api/restart` full relaunch (`remote.js:597-602`).
- **Identity/capability discovery** — `GET /api/peer/hello` (`remote.js:436-465`).
- **DM federation** — `POST /api/dm` (`remote.js:733-755`),
  `POST /api/dm/claim` (`remote.js:760-772`).
- **Hub-relay federation** — `POST /api/peer/roster` (`remote.js:782-810`).

That is the entire route table — **19 distinct `/api/*` paths** (some
GET+POST pairs) plus 2 SSE streams. Every route is gated by an optional
per-route callback (`remote-wiring.js`); an absent callback 501s and the
capability drops out of the `hello` caps list (`remote.js:436-465`).

## 2. The gap table

| Capability class | ipcMain / api-contract coverage | Wire coverage | Verdict |
|---|---|---|---|
| Session create/kill/restart/list/transcript | `session:create/kill/restart/list`, api-contract.js:69-77 | `POST /api/sessions`, `/api/kill/:name`, `/api/restart-session/:name`, `GET /api/sessions`, `/api/transcript/:name` | **Full** |
| Archive/unarchive | `archiveSession`/`unarchiveSession`, ipc-handlers.js:891,896 | none — remote kill is a hard delete only (peering.md:41-43 "no archive over the wire") | **Gap** |
| Retry-failed-spawn / forget | `session:retrySpawn` ipc-handlers.js:1857, `session:forget` ipc-handlers.js:1889 | none | **Gap** |
| Label / autoCompact toggle | `session:setLabel` ipc-handlers.js:415, `session:setAutoCompact` ipc-handlers.js:416 | none (not part of the session-args patch) | **Gap** |
| Export transcript to markdown | `session:exportMarkdown` ipc-handlers.js:1476 | none | **Gap** |
| Session config edit (args/tools/skills/agents/intents) | `session:setArgs/setTools/setSkills/setAgents/setIntents`, ipc-handlers.js:918-1004 | `GET`/`POST /api/session-args/:name`, `/api/skill-catalog`, `/api/session-skills` — same shared core (`readSessionArgs`/`applySessionArgs`, engine.js:1296,1327) | **Full** (except exec grants/privileged intents, deliberately stripped — see §3) |
| Input / control / resize | `pty-input` send, `session:resize` | `/api/input`, `/api/control` (token-gated), `/api/resize` | **Full** |
| Live output / telemetry / resize mirror / exit | `pty-data`, `session-ctx`, `session-proxy`, `onSessionExit` | `/api/attach/:name` SSE: `output`/`telemetry`/`resize`/`exit` | **Full** for attached sessions |
| Proxy/context/report/bust reads | `proxy:context/report/bust`, ipc-handlers.js:621,628,635 | `POST /api/query/:name` kind dispatch, remote-wiring.js:446-463 | **Full** |
| Cache-hold arm/disarm (mutating) | `proxy:hold` ipc-handlers.js:677, `wire:hold` ipc-handlers.js:704 | none — `/api/query` is read-only, no hold verb | **Gap** |
| Team management | `team:*` × 11, ipc-handlers.js:151-263 | none | **Gap** |
| SCM (git status/diff/stage/commit/branch/checkout) | `scm:*` × 9, ipc-handlers.js:316-355 | none | **Gap** |
| Worktree list/create/remove/info | `worktree:*` × 4 | none | **Gap** |
| File explorer (list/read/write repo files) | `fs:list/read/write`, ipc-handlers.js:364-376 | none | **Gap** |
| Library CRUD (templates/prompts/agents/skills/exec) | `templates:*`, `prompts:*`, `agents:*`, `skilllib:*`, `exec:*` — list/save/remove, ipc-handlers.js:470-599 | read-only, bundled: `GET /api/catalogs` (agents/prompts/skills/tools, remote-wiring.js:249-256) and the `agentCatalog` field of `/api/session-args` | **Partial** — read yes, CRUD no |
| Notifications | `notifications:*` × 5, ipc-handlers.js:600-604 | none | **Gap** |
| Update check / info / releases | `update:check/info/releases`, ipc-handlers.js:426-432 | none | **Gap** (data half; `openUpdate` itself is GUI-host, §3) |
| Diagnostics / tool detection | `diagnostics:get`, `tools:check/invalidate`, ipc-handlers.js:439-465 | none | **Gap** |
| Sandbox (Docker box lifecycle) | `sandbox:*` × 13, ipc-handlers.js:1448-1470 | none | **Gap** |
| Workspace management (list/rename/new/sidebar view) | `workspace:*` × 6, ipc-handlers.js:1895-1928 | none — sessions carry a read-only `workspace` label in the `/api/sessions` payload (remote-wiring.js:123) but no CRUD, and remote-created sessions always land in `DEFAULT_WORKSPACE_ID` (remote-wiring.js:203) | **Gap** |
| Boiling pot (file-heat snapshot) | `pot:snapshot`, ipc-handlers.js:910 | none | **Gap** |
| Peer management (probe/deploy/list/attach/detach/visible/control-of-a-peer-session) | `peer:probe/deploy/list/attach/...` × ~25, ipc-handlers.js:1091-1392 | none — remote.js implements only the **owner** (inbound) half of peering; the **consumer** (outbound: "go probe/attach/control peer X") half lives entirely in ipcMain/peer-wiring.js and has no wire equivalent | **Gap** |
| Remote-wire self-config (enable/token) | `remoteStatus`/`remoteSetToken`, ipc-handlers.js:1066,1076 | n/a — structurally self-referential (see §3) | **Structural, not a real gap** |
| Settings (global prefs, theme, tool-deny defaults) | `settings:get/set`, `theme:set`, `defaults:setToolDeny` | none | **Gap** |
| Wirescope process control (start/stop/restart/prune) | `wirescope:status/start/stop/restart/pruneInfo/prune`, ipc-handlers.js:1401-1470 | none | **Gap** |
| Discovery scan (adopt untracked sessions) | `discovery:scan`, ipc-handlers.js:835 | none | **Gap** |
| Sidebar meta (git/PR status, sort/group) | `sidebar:meta`, ipc-handlers.js:858 | none | **Gap** |
| Operator message send | `writeToSession` (interactive typing) vs. `[agent:dm]`-shaped message | `POST /api/send` — same `_deliverMessage` path (remote-wiring.js:144-151) | **Full** (this specific verb) |
| DM federation / hub-relay | n/a (ipcMain doesn't drive federation; it's inter-Clodex) | `POST /api/dm`, `/api/dm/claim`, `/api/peer/roster` | **Wire-only capability** (not a gap in the other direction — noted for completeness) |
| Dialogs (confirm/select-dir/context-menu) | `dialog:*`, `showSessionContextMenu`, `showPeerContextMenu/HeaderMenu` | none | **GUI-host, not applicable** (§3) |
| Shell/native (openExternal/openPath/showItemInFolder/getPath) | `app:openExternal`, `file:open`, injected `shell.*`/`app.getPath` seams | none | **GUI-host, not applicable** (§3) |
| UI-navigation broadcast (menu → open-drawer-X) | 15 `onRequestOpen*` channels | none | **GUI-host, not applicable** (§3) |

## 3. The structural blockers

### 3a. GUI-host concerns — not engine capability, wouldn't cross a wire meaningfully

These are ipcMain-exclusive **by nature**: a remote/wire client either
doesn't need them (its own UI substitutes) or the concept doesn't survive
being remote.

- **`dialog.*`** (`showMessageBox`/`showOpenDialog`/`showSaveDialog`) —
  `main.js:571-574`. Confirms and native pickers are local-host UI; a
  wire client renders its own confirm/picker. Proof this degrades cleanly
  already exists: `web-host.js:184-240` (`popupMenu`/`askDialog`) implements
  the *exact same ten capability seams* over WS with in-page HTML dialogs —
  i.e. the seam contract (`ipc-handlers.js`'s injected `popupMenu`/
  `showMessageBox`/`showSaveDialog`/`showOpenDialog`) was already designed
  to be host-swappable; remote.js simply never implemented that side
  because its clients (phone/peer viewer) don't drive create/edit dialogs
  through native chrome at all — they'd need their own in-page equivalent,
  same as web-host's.
- **`Menu.popup()`** (`popupMenu`, `main.js:570-571`) — same story:
  `showSessionContextMenu`/`showPeerContextMenu`/`showPeerHeaderMenu`.
  Degrades to an in-page menu in web-host (`web-host.js:184-206`); no
  such degradation exists in remote.js because its viewer (`remote.html`)
  doesn't offer those context actions at all.
- **`shell.*`** (`openExternal`/`openPath`/`showItemInFolder`,
  `main.js:575-577`) — local-machine side effects (open a URL in the
  system browser, reveal a file in Finder). Meaningless on a remote box;
  a remote client would open the URL in its OWN browser tab (as
  `web-host.js:246,259-260` does via a `toConn`/synthetic-event
  degradation) rather than ask the box to do it.
- **`app.getPath('desktop')`** (`getDesktopPath`, `main.js:579`) — a
  local filesystem convention (default save-dialog location). Wire
  equivalent is moot; `web-host.js:262` substitutes an `exports/` dir
  under its own userData.
- **BrowserWindow anchoring** (`BrowserWindow.fromWebContents`/
  `getFocusedWindow`, `main.js:476,571-574`) — pure Electron window
  resolution, folded entirely inside the capability seams per
  `docs/web-frontend-plan.md:53-59` ("window resolution FOLDS INTO the
  capability wrappers ... no window-object seam ever crosses"). Never an
  engine concern in the first place.
- **UI-navigation broadcast channels** (`onRequestOpen*` ×15,
  `api-contract.js:147-162`) — these fire from the Electron **tray/app
  menu** (`app-menus.js`) telling an already-open renderer window to pop
  a specific drawer/dialog. There is no engine state behind them; a wire
  client has no tray/menu to originate the request from, and no
  drawer-popping concept to receive it into. Not applicable, not a gap.
- **Update banner mechanics** (`openUpdate` → `shell.openExternal`,
  `onUpdateAvailable` push) — GUI-host half of update-checker.js. (The
  *data* half — `checkForUpdate`/`getUpdateInfo`/`getReleases` — is
  engine-side and IS a real gap, listed in §2 and §4.)

### 3b. Genuine engine-capability gaps — the wire cannot reach these, and a remote client legitimately might want to

Everything in §2 marked **Gap** or **Partial** that is *not* in §3a is a
real capability the engine has and ipcMain can invoke, that no `/api/*`
route or SSE frame reaches. Concretely, grouped by what kind of thing is
missing:

- **Whole subsystems with zero wire surface**: team management
  (`team-manifest.js`), SCM (`git-scm.js`), worktrees (`git-worktree.js`),
  file explorer (`fs-explorer.js`), sandbox/Docker lifecycle
  (`sandbox.js`), wirescope process control, notifications store,
  workspace CRUD, boiling-pot snapshot, discovery scan, sidebar meta,
  global settings/theme. All of these are electron-free engine modules
  (none appear in `test/electron-boundary.test.js`'s `ALLOWED` set) — the
  absence is a wire-omission, not a structural impossibility.
- **Library CRUD** (templates/prompts/agents/skills/exec-commands): the
  wire can *read* a bundled, session-scoped or session-less snapshot
  (`GET /api/catalogs`, the `agentCatalog` field) but has no
  save/remove/create endpoints — an engine capability (curate the
  libraries) with no wire path at all, only a read projection of it.
- **Peer-management-of-peers**: remote.js is exclusively the *owner*
  side of being peered-to. The *consumer* side — telling this box to
  probe/deploy-to/attach-to/detach-from/control another Clodex
  (`peer:probe/deploy/list/attach/detach/setDisabled/setRelayAllowed/
  control/...`) — has no wire representation whatsoever. A remote client
  cannot make box A peer with box B through box A's wire.
- **Mutating proxy actions**: `/api/query` is read-only by construction
  (`remote.js:568` comment: "Un-gated like the transcript read... the
  kind whitelist lives in the injected callback" — all five kinds are
  reads). `proxyHold`/`wireHold` (arm a cache-keep-warm hold) are
  mutations with no wire kind.
- **Session lifecycle edges**: archive (vs. hard-delete kill), retry a
  failed restore, forget a persisted entry, export-to-markdown,
  label/autoCompact — small but real, and archive-vs-delete is
  semantically significant (peering.md is explicit that remote kill has
  no resume).

### 3c. A structurally self-referential case

`remoteStatus`/`remoteSetToken` (configuring the wire's own on/off state
and auth token) can't sensibly be *added to* the wire it configures in
the general case — a client using the wire to turn the wire off, or to
rotate the very token authenticating its own request, is a bootstrapping
hazard, not a missing feature. Not counted as a gap in §4's tally.

## 4. Verdict

**(b) — a bounded, enumerable set of engine capabilities is missing from
the wire.** The wire is not a structural fork of the engine's contract
(everything it does implement shares the exact same underlying functions
as ipcMain — `readSessionArgs`/`applySessionArgs` (engine.js:1296,1327),
`manager.create`/`manager.kill`/`restartSession`, `_deliverMessage`,
`fetchProxy*` — so what it covers, it covers with full fidelity, not a
lossy re-implementation). But the coverage is narrow: remote.js was built
for one job (attach/control a session, plus the peering/federation
protocol) and never grew to cover the rest of the engine's surface the
way ipcMain (and, provably, web-host.js's WS transport of the *same*
`api-contract.js` table) already does.

Convergence work, if ever undertaken, is enumerable rather than open-ended:

1. Session-lifecycle edges — archive/unarchive, retry-failed-spawn,
   forget, export-markdown, label/autoCompact toggle.
2. Team management (11 endpoints).
3. SCM + worktree + file-explorer (14 endpoints).
4. Library CRUD save/remove (templates/prompts/agents/skills/exec —
   currently read-only via `/api/catalogs`).
5. Notifications (5 endpoints).
6. Update-check data half (3 endpoints; the banner/open half is
   correctly GUI-host and stays out).
7. Diagnostics/tool-detection (3 endpoints).
8. Sandbox/Docker box lifecycle (13 endpoints).
9. Workspace CRUD + sidebar view/meta (8 endpoints).
10. Global settings/theme/tool-deny defaults (4 endpoints).
11. Wirescope process control (6 endpoints).
12. Boiling-pot snapshot, discovery scan (2 endpoints).
13. Mutating proxy actions — cache hold arm/disarm (2 endpoints).
14. Peer-management-of-peers — the entire consumer-side peer surface
    (~25 endpoints) has no wire representation; this is the single
    largest bloc in the gap.

Everything else the ipcMain surface has that the wire lacks (§3a) is
correctly absent: dialogs, native menus, shell/file-system-reveal calls,
window anchoring, and the tray-menu-driven UI-navigation broadcasts are
GUI-host concerns a remote client would handle in its own UI layer (as
`web-host.js` already proves is a clean, mechanical degradation, not a
redesign) — they are not engine capability at all and would not belong
on the wire even in a fully converged design.
