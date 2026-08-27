# Clodex architecture — module map

Two processes: **main** (Electron main — flat `*.js` at the repo root) and
**renderer** (`renderer/`). `main.js` and `renderer/renderer.js` are thin
coordinators; everything else is a module with an explicit interface.

This file answers "where does code live", one line per module naming what it
OWNS. The subsystem docs answer "how does it work and what must I not break":

- [sessions.md](sessions.md) — session lifecycle: create/argv, hooks,
  transcript watching, exit/kill/restore, persistence, workspaces.
- [messaging.md](messaging.md) — intents: grammar, routing, DM delivery,
  injection, parking/resend, federation, memory, protocol text, drains.
- [peering.md](peering.md) — remote server, peer client, tunnels, control
  model, peers UI, deploy wizard, headless nodes.
- [telemetry.md](telemetry.md) — wirescope client/poller/supervisor,
  autocompact, statusline, ctx reminders, updates, ops log.
- [exec-tools.md](exec-tools.md) — the `[agent:exec]` registry and its
  payload validation.
- [teams.md](teams.md) — operator guide: standing a team up on a project that
  is not this one, and the four things such a project must supply.
- [renderer-events.md](renderer-events.md) — the renderer's event surface.

`test/architecture-map-complete.test.js` is the ratchet: every module in the
tree is either named here or carries an `EXEMPT` reason there.

Conventions:

- **Factory + deps object.** Extracted modules export `createX(deps)` /
  `initX(deps)` / `registerX(deps)`. Stable values inject by value; anything
  assigned in `app.whenReady()` (or declared below the init site) crosses as
  a lazy getter (`getX: () => x`); singletons the module writes cross as
  get+set pairs (`getRemoteServer`/`setRemoteServer`).
- **The electron gap.** `session-manager.js` and the infra modules around it
  never `require('electron')` — electron-touching behavior injects as seam
  functions, which is what makes them unit-testable. **`engine.js` assembles
  the entire electron-free module graph** and only the host-adapter layer
  (`main.js`, `app-menus.js`, `ipc-handlers.js`, `preload.js`) imports
  electron. `test/electron-boundary.test.js` pins that allowed set — shrinking
  it is welcome, growing it needs a documented ruling. See *Engine and host
  adapters* below.
- **Leak gates.** `test/free-identifier-leaks.test.js` guards both
  directions of every extraction: a module referencing a coordinator-scope
  name that was never injected (forward), and a coordinator referencing a
  name that moved into a module (reverse, `danglingRefs`). New extractions
  MUST be added to `SCANNED_MODULES` / `RENDERER_SCANNED_MODULES`.
- **Template literals are byte-sensitive.** Generated scripts (cli-hooks,
  term-shim) and injected HTML keep interior columns exactly; re-indenting a
  moved multi-line template is a real bug class (broke every hook script once
  — pinned by test).

## Main process

### Engine and host adapters

The main process is a plain-Node **engine** plus thin **host adapters**, so the
Electron desktop app is one frontend among several. There are three hosts
today: the **Electron desktop app** (`main.js`), the **headless node**
(`headless-main.js`, plain Node for Linux/k8s spokes), and — layered on the
headless node — the **browser frontend** (`web-host.js` + the `web-dist/`
bundle), whose packaged form is the Docker image under
[`../docker/web/`](../docker/web/).

- **engine.js** — `createEngine({ userDataPath, seams, log })` owns the whole
  electron-free bootstrap: stores → pollers → scheduler → log → wirescope +
  watchdog → remote → peers → cleanup → legacy sweep → restore, in that exact
  order. It constructs the SessionManager and every module above, and returns
  a **flat handle object**: the six primary handles (`manager`, `stores`,
  `syncRemoteServer`, `syncPeerManager`, `restoreSessionsForWorkspace`,
  `shutdown`), the shared infra, the `get{RemoteServer,PeerManager,…}`
  accessors, and the helper surface `ipc-handlers.js` / `app-menus.js`
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
  `getUserDataPath` seam was dropped (the engine derives `userDataPath` from
  its own param). `userDataPath` is a plain constructor arg, not a seam.
- **main.js** — the **desktop adapter**. Its `whenReady`
  resolves `userDataPath` (`app.getPath('userData')`), builds the electron
  seams (`shell.openPath`, `Notification`, `app.relaunch`, the tray/menu
  refreshers), calls `createEngine`, then stacks the desktop-only layer on top:
  windows (`createWindow`, `workspaceOfSender`, `openWirescopeWindow`), tray +
  app menu, `registerIpcHandlers`, update-checker banners, and the shared
  session helpers (`fetchProxyContext/Report/Bust`,
  `fetchSessionFiles/FilePeek/FileDiff`, `restartSession` — defined in
  engine.js and injected; deliberately NOT a module).
  `before-quit` / `window-all-closed` route to `engine.shutdown()`.
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
  ipcRenderer. Optional `CLODEX_WEB_TOKEN` gates every route + the WS upgrade +
  the hello frame; absent = localhost trust. NOT in the leak-scanner lists (new
  code, not a move-only extraction) and never imports electron. Packaged as the
  Docker image in [`../docker/web/`](../docker/web/) (a two-stage build of the
  headless host + the web bundle); the peer test-box in `../docker/` is
  unrelated.
- **api-contract.js** — the shared table of `window.api` methods and events.
  The browser client (`renderer/web/`, built by `build/build-web.js` into
  `web-dist/`) rebuilds `window.api` from it, so the renderer runs unchanged
  under either host.
- **preload.js** — the desktop side of the same contract: wraps
  invoke/send/event-listener IPC as `window.api`.
- **ipc-handlers.js** — every `ipcMain.handle/on` registration, run from
  whenReady via `registerIpcHandlers(deps)`.
- **app-menus.js** — tray + application menu builders (the `createAppMenus`
  return is the list).

### Host lifecycle and upgrade

- **host-stamp.js** — is the RUNNING main process older than the code on disk?
  Merging a fix implies no restart, so every intent-handling fix is inert for
  the running host until the operator restarts; this is what says so.
- **restart-waiter.js** — the countable/waitable logic behind the "Restart
  Clodex" dialog: sustained-idle detection with clock, timers, session
  snapshot and actions all injected, so it is testable with a fake clock.
  main.js is the thin shell that wires the real dialog onto it.
- **update-checker.js** — GitHub release poller (data layer only; main.js
  keeps the notify/banner side effects).
- **bin-materialize.js** — stamps the exec helper scripts into `~/.clodex/bin/`
  at every launch. Overwrite-always: the packaged sources live sealed inside
  `app.asar`, which an external `node` cannot require across, so the bin copy
  is the stable path — and re-stamping kills version drift.
- **dev-reload.js** — DEV-ONLY hot reload, wired from main.js only under
  `CLODEX_DEV`. Two granularities: `renderer/**` reloads live windows in place;
  a main-process `*.js` change relaunches the app.

### Sessions and PTY

- **session-manager.js** — the SessionManager class and the largest module in
  the engine (`wc -l session-manager.js`): PTY spawn/kill/restore, per-session
  state, intent routing, DM delivery/parking, inject queue integration. Zero
  electron — verifiably so (`grep -c "^[^/]*require('electron')"` → 0, the
  `^[^/]*` skipping the header's own prohibition of it); it reaches
  renderers through opaque handles, and the file's own WINDOW BRIDGE header
  states that contract. Its collaborators all arrive through the
  `createSessionManager(deps)` destructure, which is the list.
  It also owns the **dm-delivery latch** — `_armDmConfirm`,
  `_armDmConfirmTimer`, `_checkDmConfirm`, `_clearDmConfirm`,
  `_overflowDmEntry`, `_dmLatchEvidence` — which makes a swallowed plain dm
  visible to its sender instead of silently lost.
  `SPEC_CONFIRM_MS` lives here, at the core/deps seam, and is lent BACK to the
  tickets half through `createTicketMethods`'s second bag: one deadline serves
  both the dm latch and the ticket spec-confirm latch, and splitting it would
  let the two drift.
- **session-args.js** — the pure field-resolution core of Edit Session:
  `resolveSessionArgsPatch(patch, prev)` and the "undefined means untouched"
  rule (an explicit `[]` or `null` DOES overwrite).
- **session-restore.js** — the electron-free restore-on-launch leaf behind
  `app:restore-sessions`: iterates persisted entries → archived (never spawned,
  `{archived:true}`) / already-running (replay `pendingOutput`) / cold
  (`--resume`) / failed (`{failed:true}`, entry kept). Injected deps, unit-pinned.
- **session-discovery.js** — scans for adoptable external agent processes
  (opt-in startup discovery), excluding Clodex's own `livePids`; in
  SCANNED_MODULES.
- **session-meta.js** — `createSessionMeta({REGISTRY_DIR})`: cheap `fs.stat`
  last-activity timestamps + TTL-cached `gh pr view` PR status for the sidebar
  organizer (group/sort/filter). Electron-free; in SCANNED_MODULES.
- **meta-tiers.js** — the shared vocabulary for sidebar-meta refreshes: which
  keys belong to which cost tier, and how a refresh merges into what the
  renderer already holds. Pure leaf, required by BOTH `session-meta.js`
  (producer) and `renderer/renderer.js` (consumer) — it lives apart precisely
  because session-meta pulls in fs + child_process, which the renderer must not
  drag into the web bundle.
- **session-info.js** — `createSessionInfo({fs,readline,homedir,pathFor,…})`:
  the sidebar ⓘ panel's data layer, gathered on demand (`session:info`). Sums
  `wire-totals.json` across a name's whole `sessionIds` history for the
  monotonic per-agent total, and STREAMS the transcript for compact boundaries
  (70MB/157ms — a sync read is ~10x that and copies the file into memory).
  Never merges the cost scopes (`session-info.js` names them and says why they
  are not interchangeable). Electron-free; in SCANNED_MODULES.
- **jsonl-watcher.js** — polls the per-agent transcript symlink, extracts
  assistant turns, emits text/sessionId/activity.
- **cli-hooks.js** — generates the per-session hook scripts + settings for
  Claude and Codex (transcript symlink, ack/pending/ctxwarn drains).
  Generated bytes are test-pinned.
- **argv-merge.js** — CLI argv assembly: prompt-channel merging +
  context-window math.
- **inject-queue.js** — serialized PTY injection with typing quiet-gate and
  park-at-fire divert.
- **ipc-prompt.js** — `IPC_PROMPT`, the canonical all-enabled literal that is
  the sole source of truth for the agent-facing IPC protocol text, plus
  `buildIpcPrompt(intentsList)` which assembles the per-seat variant (gating
  grammar lines + the MEMORY section to a session's allowed intents via
  intent-catalog's `intentEnabled`; double byte-pinned back to the literal).
- **ipc-prompt-cache.js** — freezes a session's system prompt at spawn and
  delivers later changes as a DIFF, so shipping an `ipc-prompt.js` edit does
  not rewrite the system prompt underneath every `--resume`d conversation.
- **notice-queue.js** — per-session one-off advisories, drained into the next
  prompt by the UserPromptSubmit hook (`~/.clodex/notices/<name>/`). Carries
  what the frozen prompt cannot: AT-MOST-ONCE (claim by rename, consume on
  read), and **must not be merged with the prompt delta**, which is
  at-least-once.
- **claude-env.js** — a Claude session's EFFECTIVE process environment, merging
  `process.env` with the settings layers the CLI loads (user < project < local),
  and classifying whether that env routes the CLI to a TEE-BLIND backend
  (Bedrock / Vertex) the wire tee cannot see.
- **voice-settings.js** — the box-wide voice-input mode the Claude CLI persists
  in `~/.claude/settings.json` (`voice.mode` / `voice.enabled`), behind the
  Preferences voice selector. READ-ONLY: the mode is changed by injecting
  `/voice <mode>`, since a running CLI holds its mode in memory and would not
  pick up an edited file. The legacy `voiceEnabled` sibling is reported and
  never merged.
- **env-scopes.js** — merges the GUI-managed environment scopes over the base
  process env for a wrapper PTY, and is the single source for the canonical
  precedence. Pure fs/path, no electron.
- **env-file.js** — atomic 0600 `KEY=value` env-file primitives. The shape both
  the sandbox's `auth.env` and the host's `remote.env` use: values that reach a
  process env yet never enter a config store, log or IPC result. Multi-key by
  design — setting one key never disturbs another.
- **git-worktree.js** — stdlib-only git worktree ops (create/remove/repoInfo/
  defaultBranch) behind the New-Session worktree option, `[agent:spawn
  worktree:<branch>]`, and the delete flow's awaited `removeWorktree`.
  `execFile`, never a shell; in SCANNED_MODULES. Its ticket-seat consumers are
  under *Teams and tickets*.
- **transcript.js** — JSONL transcript → markdown/messages rendering.
- **statusline.js** — statusline script generation + proxy-base resolution.
- **ctx-reminder.js** — context-pressure reminders on the session's own tail.
- **attention.js** — which sessions are asking for the operator's attention.

### Intents and messaging

- **intent-scanner.js** — `[agent:…]` intent matching on assistant text
  (ANSI/decorator stripping, the `\[agent:…]` escape).
- **body-preview.js** — one-line preview of a stored intent body, for the four
  readouts that show one (remind list, memory list, the memory digest index,
  notify-user). Picks the first NON-EMPTY line: a greedy body written on the
  lines following its intent line is stored with a leading newline, so
  `split('\n')[0]` renders intact data as blank.
- **intent-registry.js** — the single verb table three consumers read (the
  scanner's parse chain, intent extraction in session-manager, and the
  handler's routing switch). Do not reintroduce a parallel verb list in any
  of them.
- **intent-catalog.js** — the single source of truth for the GATEABLE intent
  set: which verbs a session may be allowed or denied, in IPC-prompt order.
  Three consumers across two processes read it (the fire-time gate in
  `_handleIntent`, the renderer checklist, and `buildIpcPrompt`).
- **exec-schema.js** — the payload validator for `[agent:exec <cmd>] {json}`.
  Deliberately tiny (type/required/maxLength/enum + the `filename` token guard
  + a raw-body size cap) so it stays auditable; a full ajv would not be.
- **agent-transport.js** — per-agent registry (`run/<name>/agent.json`) +
  Unix-socket (`run/<name>/agent.sock`) transport; discovery iterates
  `run/*/agent.json`.
- **pending-store.js** / **peer-outbox.js** — durable delivery parking
  (local layer-3 / federation outbox).
- **relay-protocol.js** — the bytes-on-the-wire commitments for hub-relay DM
  federation: the relay ENVELOPE and the `POST /api/peer/roster` payload.
  Dependency-free pure functions, so the main-process router and the wire layer
  (`remote.js` / `peer-client.js`) agree by construction. Prose:
  [messaging.md](messaging.md) §4.
- **memory-store.js** — agent memory units (list/remember/recall/pin).
- **remind-schedule.js** — the pure parse/timing leaf for `[agent:remind …]`:
  a spec string → a normalized schedule, and the next fire time against an
  injected `now`.
- **remind-scheduler.js** — the durable-schedule ENGINE that ties that math to
  the `reminders` store and drives delivery. The only piece with timers; clock
  and timer primitives are injected.
- **wire-intents.js** — intent helpers shared with the wire layer.

### Teams and tickets

The ticket cluster is five modules and a mixin, and the split is by lifetime,
not by size:

- **tickets-store.js** — the PROJECT ticket registry
  (`projects/<leaf>-<hash8>/tickets.json`, moved off the team in t301). Owns the
  record shape and the pure projections over it: `nextTicketId`, `ticketTitle`,
  `extractTaskDir`, `extractMustFix`, `countMustFix`, `ticketStarted`,
  `ticketInFlight`, `branchSlug`. Tickets FORMALIZE lead→member work as tracked
  envelopes; they do not replace lifecycle-by-dm.
- **tickets-migrate.js** — the one-time migration of each TEAM's board into the
  PROJECT board it is rooted at. Modelled on `legacy-sweep.js`: pure leaf, one
  exported function, called from `engine.js` inside a catch-and-log so a failure
  degrades to a log line. COPY then mark — the source file is left in place.
- **ticket-review-scope.js** — the reviewer's scope, built from the ticket
  record, git, and a caller-resolved `taskDir`/`taskDirRule` — no lead prose
  (`buildReviewScope`, `VERDICT_GRAMMAR`). Zero lead prose is the whole point:
  the measured defect it closes is every verdict costing two round trips through
  a lead whose own verification had already happened. There is deliberately NO
  fallback to `ticket.taskDir`: that field is the raw spec string and the
  reviewer's cwd is the repo, which carries a stale `tasks/` whose names collide
  with the artifact dir's — restoring the fallback sends a reviewer into a real
  but wrong tree, silently, and does it precisely when resolution was REFUSED.
- **stall-evidence.js** — the evidence a stall alarm carries, so a lead can tell
  a seat that is WRITING from a seat that is WEDGED without probing by hand. The
  failure it prevents is measured: a watchdog fired "hand quiet 30m", the lead
  checked the worktree was dirty with real work and dismissed it — the seat had
  been SIGKILLed and the dirt was its corpse.
- **team-cost.js** — per-ticket cost attribution. Pure leaf: no fs, no git, no
  electron; callers pass the already-read inputs and every function is a
  projection of them.
- **team-tickets.js** — the teams/tickets half of the SessionManager class:
  board verbs, seat shaping/spawn, spec delivery, review/verdict/auto-merge, the
  ticket loop + suite, watchdog/stall sweep, team role editing, retire. It
  returns METHODS, not an API: `createSessionManager` grafts them onto
  `SessionManager.prototype`, so they run with `this` = the manager and ticket
  state stays on the instance. **A file split, NOT a decoupling** — every
  cross-boundary call is still `this.<name>()`, so the coupling graph is
  unchanged and `free-identifier-leaks.test.js` structurally cannot see the
  seam (it scans module-scope names; a prototype lookup is not one).
  `ticket-mixin-surface.test.js` is what guards it, and its `this.*` inventory
  is the starting spec if the boundary is ever made real.
- **team-manifest.js** — the team roster and its membership predicate.
  Team membership is a REPO, not a path: `cwdInProject`
  accepts a worktree of the root as a member, so seats in sibling worktrees stay
  on the roster and stay ticket-addressable. It reads the worktree's `.git` FILE
  rather than shelling out to git — `resolveTeam` runs on every roster render and
  ticket resolution, and a subprocess there would make membership a latency
  problem.
- **team-measure.js** — what can be PROVEN about a project directory, as five
  findings (suite, packageManager, vcs, worktreeSupport, generatedPaths), each
  `{ id, claim, status, evidence }`. The measured half of the team helper; the
  generative half that turns these into a prompt cannot be pinned by a test,
  which is why this half carries the load. Pure leaf over injected
  fs/path/childProcess — no requires — so the table is assertable against a
  fixture directory. NEVER GUESSES: an `absent` finding is a first-class result
  with its own claim sentence, never an omission and never a default, and all
  five ids come back on every call. Two lockfiles is `absent` naming the
  ambiguity rather than a pick. The JS suite claim is COMPOSED with the measured
  lockfile (`pnpm test`, not `npm test`, in a pnpm repo — npm would run against a
  dependency graph it never installed); an ambiguous lockfile set falls back to
  `npm` rather than picking a contender. `vcs` falls back to `git rev-parse
  --git-dir` before declaring absence, so a monorepo package inside a checkout is
  not told it has no version control. It reads the suite command and never RUNS
  it — `childProcess` is for `git rev-parse` and nothing else, because executing
  an unknown repo's scripts as a side effect of describing it is not this
  module's business. Sync subprocesses: not a render path.
- **team-preflight.js** — "does this team's manifest name anything that resolves
  to nothing?", as findings rather than as N scattered warns. One resolver, and
  every surface (roles popover, Create Team…, the spawn/dispatch replies) is a
  caller relaying the same findings on its own channel. Pure leaf over injected
  probes — no fs, no requires — which is what makes the whole findings table
  assertable with no library installed. Findings are PROBLEMS ONLY: absence of a
  finding for a role is resolution. Not a hot path (it stats files and parses
  template/exec JSON), so it belongs to a popover open or a team create, never to
  `resolveTeam`.
- **team-root-expand.js** — the `${TEAM_ROOT}` token for a TEMPLATE's `cwd`,
  read by the spawn intent (team-tickets.js) and the New Session dialog's
  template dropdown (renderer.js). Pure leaf. An unresolved root REFUSES rather
  than expanding to empty — a seat booted in the wrong project reports success,
  so a missing spawn is the cheaper failure. The exec registry keeps its own
  substitution (session-manager.js `expandVars`): it spans three tokens over
  argv and cwd against a live session, and merging the two token sets would
  couple the spawn path to the exec path's vocabulary.
- **prompt-rails.js** — rail classification for library system prompts: the
  prompt library mixes a full replace-class system prompt with an APPEND delta
  that composes onto the append rail, and the team join path must not confuse
  them. Pure leaf — the caller supplies `{ name, body }` rows.

Branch per ticket: a role with `dispatch: "worktree"` in team.json gets a branch, a
worktree and a fresh seat per ticket. `dispatch: "spawn"` is the same one-shot
seat WITHOUT the branch and tree — it works in the shared checkout, so it is
the mode a team whose root is not a git repo can use; `_ticketDispatchMode` is
the single resolver both read, and it fails closed to `standing` on anything
else. BOTH dispatch paths mint — `_taskAdd`
and `_taskAssign` (releasing a parked ticket), each via `_spawnTicketSeat`;
minting in only one silently opts the role out on the other. The
ticket is re-pinned from the ROLE to that seat name, which is what keeps the
seat one-shot — `_ticketAssigneeSeat` resolves a role to the first live seat
holding it, so a role-pinned ticket would route the next one into the previous
ticket's checkout. Everything below is the worktree mode's; a spawn ticket has
no `worktree` key at all, and a dispatch to a spawn role CLEARS one it inherited
(a worktree ticket reassigned to a spawn role) so the tree-reading paths —
`WORK IN:`, the verify/review loop gate, the accept teardown — cannot disagree
with the mode.
A ticket that already HAS a tree never mints a second one: the seat name derives
from the ticket id, so `_mintTicketSeat` returns `taken` with that name.
`_taskAssign` splits three readings of taken, on LIVENESS not on the record —
the ticket's own live seat means re-send the spec to it (un-pinning would hand
this ticket's tree to another ticket's hand); a record with no live seat
(archive, natural exit, non-ephemeral retire) is a dead end that stays pinned and
names its recovery, since respawning would bypass `nameConflict` and split the
name across two rows; only a fully released name respawns onto the tree, which
`_existingTicketTree` re-verifies against `git worktree list` before reuse. The
check that matters there is `prunable`: a tree deleted outside git keeps its
admin entry and is listed like a live one, so path+branch alone would hand the
seat a `WORK IN:` path with nothing at the end of it (`locked` is excluded too —
an operator's explicit hands-off). `createWorktree` prunes first for the other
half of the same fact: the stale entry otherwise makes git refuse the branch
forever. `_ticketTreeHolder` is the occupancy gate git used to provide by
refusing one branch two checkouts: moving a ticket to a DIFFERENT worktree role
keeps the tree while changing the derived name, so reuse would otherwise spawn a
second seat into a checkout the first is still editing. That gate keys off the
TICKET's tree, not the destination's role — a plain role, a name-addressed seat,
lead and reviewer all receive the ticket's `WORK IN:` line just the same — and it
runs with the taken-but-not-live refusal ABOVE the reassign notice and above every
field `_taskAssign` writes: below them a refusal has already told the holder its
ticket moved, cleared `parked`, and pushed `lastActivityAt` past the watchdog's
one nudge, while replying that nothing changed. A spawn also MOVES the record's
worktree pointer off any other record naming that path (canonically — a record
written elsewhere can reach the same tree through a symlinked prefix):
`session:kill` reads the tree off whatever
record it deletes, so two records naming one path means deleting either force-
removes a live seat's checkout. That scan is NOT gated on reuse — deleting a
tree's directory by hand makes `createWorktree` prune and recompute the identical
default path, so a FRESH tree lands where an archived seat's record still points.
A reused tree is never
rolled back on a failed spawn (it holds the previous seat's commits) and the
ticket is not un-pinned there either — a role-assigned ticket carrying a live
`WORK IN:` pointer replays into every seat filling that role. The same holds when
`create()` succeeded and a later step threw: the tree is kept because a live seat
is in it, so the un-pin is skipped for that case too — as it is on the
`createWorktree`-failure exit, which is reached with the ticket still naming the
tree `_existingTicketTree` rejected — and that exit tests the ticket's tree
itself rather than `!reused && !live`, which coincides with it only on the paths
a CAUGHT throw takes today, and only while `clearTicketTree()` runs on exactly
that path. Both failure replies branch on the predicate rather than asserting the
un-pin: it is skipped in more states than the un-pin used to be. A live seat's record must NAME its
tree or `_ticketTreeHolder` cannot see the occupancy and `session:kill` orphans
the checkout, so the claim runs straight after `create()` and again in the catch
— `create()` can seat the session and then throw. Both go through one
`claimTree()`: the write and the move-off-other-records scan are ONE operation,
and splitting them is worse than either half — writing this seat's pointer alone
on the reuse path leaves two records naming one tree, which is the collision the
scan exists to close.
The ticket seat's cwd is the REPO, not its worktree: it is TOLD the path by the
`WORK IN:` line `_deliverTicketSpec` prepends, and cd's there itself. Booting it
in the tree would bind its transcript, project root and team block to a checkout
that is deleted with the session. The path is stored on the TICKET
(`ticket.worktree`) so a replay can re-tell a respawned seat. The
`[agent:spawn worktree:]` path is the other shape — there the seat's cwd IS the
worktree, which is why membership is by repo.

### Peering and remote

- **remote.js** — the remote/peer HTTP+SSE server (phone access + peering
  owner side).
- **remote-wiring.js** — RemoteServer construction/reconciliation
  (`syncRemoteServer`). Peer terminal sharing is ONE box-wide capability:
  `wtermCallbacks` returns nulls when it is off, so an ungranted box 501s and
  omits the cap from hello.
- **remote-token.js** — the operator's remote-wire token, GUI-managed and
  persisted in `<userData>/remote.env` (0600, single key), so the peer-wire gate
  survives restarts without an env var the operator has to remember.
  DELIBERATELY separate from the sandbox's `auth.env`.
- **auth-token.js** — the single operator-token predicate shared by BOTH HTTP
  hosts (`web-host.js` and `remote.js`), so the two wires cannot drift on "does
  this request carry the configured secret". Pure leaf: a token string in, a
  `{ check, fromReq }` pair out.
- **peer-client.js** — consuming side of the peering protocol (hello loop,
  SSE attach, reconnect).
- **peer-wiring.js** — PeerManager + TunnelManager reconciliation and
  persisted-attachment/control helpers.
- **tunnel-supervisor.js** — ONE supervised local port forward (`ssh -N -L` or
  a vendor CLI's own), under three consumer-decided parameters: retry, port
  stability, readiness. Both tunnel managers below are built on it.
- **peer-tunnel.js** — `TunnelManager`: reconciles the peer settings list into
  a set of supervised tunnels (supervision OF supervision lives here, not in
  the supervisor).
- **web-tunnel.js** — on-demand port forwards to a PEER'S WEB FRONTEND, so
  "look at that box's GUI" is a click. Same supervisor as `peer-tunnel.js` under
  different policy; the file says only what makes a web-view forward different,
  and each difference is a parameter rather than a fork.
- **peer-deploy.js** + **ssh-run.js** — deploy-wizard classification +
  one-shot ssh transport.
- **peer-input-queue.js** — PendingInput buffer behind type-to-take.
- **peer-import.js** — seeds Clodex PEERS from clodexctl's contexts file, the
  mirror of `cli/src/import.js`. Read-only on the CLI's file. IMPORT IS A COPY,
  NOT A LINK: an imported peer keeps no back-reference to its context.
- **peer-shell.js** — the decisions behind a terminal tab pointed at a PEER box:
  whether the serving side offers one, what crosses the wire as a seat, and what
  a refusal reads like on the consumer.

### Plugins

- **plugin-api.js** — the pure leaf both plugin-host halves share: constants,
  id rules, the kill switch, and the invoke error envelope, so the engine host,
  the renderer host, the loader and the tests agree by construction rather than
  by three copies of a string.
- **plugin-loader.js** — manifest discovery + validation
  (`validateManifest`, `isNewerVersion`). An unrecognized `scope` is REFUSED,
  never defaulted: `scopeOf` resolves anything unknown to `global`, so a typo on
  a plugin meant to be invisible would silently load it everywhere.
- **plugin-host-engine.js** — the main-process host. No unqualified `list()`:
  `listAll()` is global, `listWorkspace(id)` is what per-window surfaces want,
  and `fsScope` refuses PEERS rather than foreign workspaces — so nothing
  downstream catches a global list handed to one window.

### Hints, memory and vectors

- **hint-arm.js** — automatic contextual hint arming: accumulate the draft as
  the operator types, pre-arm on a typing pause, re-arm on Enter. THE ARM MUST
  PRECEDE ENTER — a hint is `turn_start_only` + `once`, Enter reaches the CLI in
  ~0ms and a rank takes 190–320ms, so arming ON Enter always lands a turn late.
- **hint-retrieve.js** — the lexical retriever behind the injector: rank records
  against a draft and pick the ones worth spending tail budget on. The
  `retrieve(draft, {agent, limit}) -> [record]` interface is deliberately not
  memory-specific.
- **hint-embed.js** — semantic re-ranking over a local embedding model; its
  header carries the measured split (28 paraphrase queries against the curated
  `tags` ground truth) that justifies using it over the lexical pass alone.
- **vector-store.js** — an append-only vector store: fixed-width float32 rows in
  a binary blob plus a JSON sidecar mapping row → record. Not the JSON cache in
  `hint-embed.js`, which holds the whole map in memory and rewrites on flush —
  right for 184 curated units, wrong for a corpus that grows daily.
- **basket-retrieve.js** — the retriever over the operator BASKET (things the
  operator actually said, plus the reply that answered each). Same interface as
  the memory retriever so the arming side never learns there are two sources;
  a separate module because two measured properties of that corpus break the
  memory retriever's assumptions.
- **memory-load.js** — which memory units are LIVE in an agent's context right
  now, as a fold over transitions Clodex already observes (digest delivery,
  recall, /clear, compaction) — not an inference about what the model retained.
  The injector asks it before spending tail budget re-stating a loaded unit.
- **selection-hint.js** — the operator's drawer SELECTION as tail-hint TEXT, in
  two tiers that differ by intent, not size: a PEEK (selecting while reading) is
  a weak signal and rides one request; an explicit send is not.
- **selection-arm.js** — WHICH CHANNEL carries that text and when it comes off.
  Selecting (peek) goes to the wirescope tail, one-shot and short-TTL; the
  explicit gesture takes the durable channel. The two-gestures/two-channels
  split is the design.

### Sandbox and external tools

- **sandbox.js** — container-backed session placement. Electron-free and
  deps-injected so the unit suite drives it with spawn/docker mocked;
  `<userData>/<subdir>/compose.yaml` is regenerated from config on every Start
  and is never the source of truth.
- **tool-doctor.js** — external-tool presence detection: probe a list of tool
  specs via an INJECTED `whichBin`, return a presence report plus pure UI copy.
  The app warns or gates on this BEFORE a user spawns a session whose CLI is
  missing.
- **detect-cache.js** — a generic TTL + in-flight-dedupe cache around an async
  probe, lifted out of `sandbox.js` so `tool-doctor.js` can share it without a
  lean leaf pulling in compose generation, net and crypto.

### Telemetry

- **wirescope-proxy.js** — wirescope client + the ProxyPoller telemetry tick.
- **wirescope-supervisor.js** — wirescope process supervision.
- **wire-telemetry.js** — the pure telemetry projections over wire records.
- **subagent-ring.js** — the per-session ring of subagent turns: `createSubagentStore`
  (one store per session, hung off the Session), `noteSubagentTurn` on the wire
  tee's write side, `feedSince` behind `proxy:subagentFeed`. Owns all five bounds
  (`FEED_CAP`/`SUB_CAP`/`TEXT_CAP`/`TOOLS_CAP`/`THINKING_CAP`) rather than trusting callers — a
  feed lives as long as its session, so nothing upstream is positioned to
  remember. `seq` is monotonic per SESSION, not per feed, which is what lets one
  cursor order every subagent's turns and answer a single feed without gaps; the
  reply's `seq` is the store HEAD, so a quiet feed still advances. `key` is the
  `x-claude-code-agent-id` header verbatim (role-name fallback), byte-identical to
  wirescope's — the chip strip stays wirescope-driven and the feed is looked up BY
  the chip's key, so a divergence shows an empty feed instead of failing. Pure leaf
  (no I/O, no electron, like file-touch.js); NOT in the leak-scanner lists.
- **proxy-util.js** — proxy address/base helpers shared by the telemetry layers.

### Workbench drawer (main side)

- **drawer-pty.js** — the drawer's terminal tab, main side. A workbench terminal
  is a NEW OBJECT, not a session, and the distinction is the whole design: no
  entry in `sessions`, no `~/.clodex/run/<name>` registry file, no transcript.
- **drawer-avail.js** — which drawer tabs a given seat can be SERVED, and what a
  seat may type into one (`termAvailableFor`, `termBackendFor`,
  `vetTermCommand`, `TERM_EXEC_MAX`). A pure leaf rather than lines inside
  `term-tab.js`, which is DOM-bound.
- **term-marks.js** — OSC 133 semantic prompt marks: the parser, and the prose
  that describes a finished command back to the agent. A terminal is a screen,
  not a stream of results, which is why the marks exist at all.
- **term-shim.js** — the generated shell startup that emits those marks. THIS
  REACHES INTO THE OPERATOR'S SHELL STARTUP, the most intrusive thing Clodex
  does to a surface it does not own; its header is the constraint list.
  Template-literal bytes matter here for the same reason as `cli-hooks.js`.
- **ctl-service.js** — an in-process clodexctl REPL for the drawer's `ctl` tab.
  MAIN-PROCESS, and that is a security property, not a layering preference:
  `~/.clodex/cli/contexts.json` holds TOKENS, and a renderer-side client would
  pull them into the renderer.

### Persistence, paths and stores

- **stores.js** — `initStores(userDataPath, …)` builds every persistence store
  (sessions/workspaces/templates/prompts/agent+skill libraries/defaults/
  ui-settings/reminders). Paths derive inside the factory, post-whenReady by
  construction; the return object is the list.
- **clodex-paths.js** — the per-agent runtime path grammar under `~/.clodex`:
  `pathFor(root, name, kind)` / `runDirFor(root, name)` over the artifact kinds
  in `KINDS` (`clodex-paths.js`; count them with
  `node -e "console.log(Object.keys(require('./clodex-paths').KINDS).length)"`),
  the single source every mint site routes through, plus `projectDirFor` for the
  project board. Pure leaf (no I/O, like scope-util); NOT in the leak-scanner
  lists. Shared dirs (`messages/`, `pending/`, `agents/`, `skills/`, …) stay at
  the root and are outside the grammar — its header is the authority on which,
  because a dir is there precisely because it must OUTLIVE `run/<name>/`.
- **legacy-sweep.js** — one-time, marker-gated (`run/.migrated`), name-driven
  migration of the OLD flat `{name}-*` artifacts into `run/<name>/`, plus a
  log-only orphan pass. `runLegacySweep` deletes only `{knownName}{knownSuffix}`
  (never filename-parsed, so shared `wire-shadow.jsonl` / `codex-session-hook.sh`
  can't be misattributed); `findOrphans` is pure.
- **project-root.js** — the git-repository root for a cwd, for keying a PROJECT
  ticket board when no team owns that cwd. Pure leaf; `fs` injectable.
- **path-confine.js** — one caller-supplied name, one path segment, POSITIVELY
  confined to a directory Clodex owns. Positive because a charset regex is not
  containment: `.` and `..` pass `/^[a-zA-Z0-9._-]{1,64}$/`. Pure leaf, no I/O.
- **fs-util.js** — filesystem primitives (ensureDir etc.).
- **file-touch.js** — recently-touched-file tracking. Pure leaf.
- **file-edit.js** — the write-side policy for the file-peek Edit tab. The peek
  is the only read surface that takes a bare absolute path, because reading
  bytes into a modal is not an authority — writing them is, so the policy is
  here, pure, with fs injected.
- **file-resolve.js** — turn a path as it was DISPLAYED into a path that exists.
  Every path a user clicks was written for a human (relative to the repo, to the
  file it appears in, or shortened to fit a terminal); resolving it against the
  MAIN PROCESS's cwd is the bug this closes. Pure leaf, fs injected.

### Shared pure leaves

- **catalogs.js** — static shared constants (CLAUDE_TOOLS, THEME_KEYS,
  AGENT_NAME_RE, DEFAULT_WORKSPACE_ID, …).
- **scope-util.js** — skill/agent visibility: `visibleTo` / `autoEnabledFor` /
  `unionEnabled` / `reconcilePartialSelection` — the `workspace:`/`sessions:`
  frontmatter scope predicate + spawn-union + scoped-checklist save semantics.
- **agents-util.js**, **skills-util.js** — the agent and skill library layers.
- **skill-roster.js** — `classifySkillRoster`: splits a transcript's
  `skill_listing` attachments into the session's roster (`isInitial: true`,
  last one wins) and the DIRECTORY-SCOPED sets (`isInitial: false`, keyed by
  source dir) that load only under their own directory. Engine keeps the
  realpath+read and passes lines in. The opposite direction from skills-util,
  which writes clodex's own library OUT to a plugin scaffold.
- **external-link.js** — the scheme filter for "open this URL in the user's
  browser", shared by BOTH hosts (main's window-open/will-navigate guards and
  the renderer's WebLinksAddon). True ONLY for http/https — the sole schemes
  handed to `shell.openExternal`.
- **sidebar-width.js** — the clamp/reset decision for the resizable sidebar.
  Pure leaf shared by both hosts: `stores.js` clamps on read AND write through
  it, and the renderer clamps every drag frame and the pre-paint localStorage
  mirror through the same fn.

## CLI infra assets

- **cli/deploy/** — the packaged infra catalog: one reviewable deployment
  asset per `clodexctl deploy` flavor (`clodex-fargate.yaml` for the AWS
  Fargate CloudFormation stack, `helm/clodex/` for the Kubernetes chart,
  `clodex-deploy.sh` for the ssh/SSM installer). Shipped in the `clodexctl`
  npm package and resolved `__dirname`-relative by the deploy verbs. Full
  catalog + review posture: `cli/deploy/README.md`. The container image build
  (`docker/web/Dockerfile`) is separate — it produces the image these assets
  run, not a deploy asset itself.

## Renderer

### Coordinator

- **renderer/renderer.js** — the regions that share
  coordinating state: sessions Map + activeSession, terminal management
  (createTerminal/switchSession/removeSession/remeasureReadonlyPeer), the
  sidebar render loop + session context menus, PTY data routing, the
  new-session dialog, proxy/ctx telemetry state + `renderProxyBar`,
  `popoverApi` (the local-vs-peer data seam), the peers-SETUP dialog
  (connection config; reads the core peerStatuses/peerTunnels Maps),
  preferences/edit-args dialogs, keyboard shortcuts, restore IIFE, and the
  island init sites.

### Islands

Own state + DOM, `init*(deps)`:

- **drawer-host.js** — the bottom drawer as a TAB HOST: owns collapsed state,
  the tab strip, badges, the `#main` layout contract and pane swapping; tenants
  register with `{id, label, available, mount, onShow, onHide, onResize}` and get
  a `notify(level)` back. Tab ids are frozen: `log`, `activity`, `ctl`, `term`.
  Its header comment carries the numbered rules a tenant author must not
  re-derive.
- **ipc-log.js** — the `log` tenant: rows + export only.
- **activity-tab.js** — the `activity` tenant, and the seam between the two owners:
  the CHIPS are wirescope's, off the free 5s `session-proxy` payload, and the FEED
  is ours, ONE `proxy:subagentFeed` read of subagent-ring.js for the SELECTED
  subagent only. A feed with no chip is not shown — one roster. Polling starts in
  `onShow` and stops in `onHide` with no idempotence of its own (the host
  guarantees alternating edges), so a hidden or collapsed tab costs nothing.
- **ctl-tab.js** — the `ctl` tenant: a clodexctl REPL against one warm context
  held in the MAIN process (`ctl-service.js`). The renderer sends a command
  string and receives a rendered block; it never sees a token, a contexts file
  or a transport, and it must not grow a client of its own.
- **term-tab.js** — the `term` tenant: a REAL PTY in the workbench, not a
  command runner. `vim`, `less` and interactive prompts must work, which is why
  it is an xterm bound to a shell rather than a block list like the ctl tab. It
  is NOT a session, and nothing here should make it look like one.
- **term-search.js**, **banners.js**, **themes.js**, **library-drawers.js**
  (prompts/agents/skills drawers).
- **intent-highlight.js** — marks the emitted `[agent:…]` TOKEN in a terminal
  and ticks its row in the scrollbar lane (one decoration does both: span-scoped
  on screen, line-granular in the ruler). RECONCILES against the buffer per pass
  rather than appending: decorations are push-based, and the CLI repaints its
  live tail. Skips the pass while the ALTERNATE buffer is active (it reads
  empty, so a pass there would dispose every real mark), and re-reads
  `marker.line` instead of trusting a stored index, which scrollback trim
  shifts. Maps the token's string offset to a buffer COLUMN by walking cell
  widths — a wide char is two cells and one index, so `indexOf` as a column
  misplaces the span. Disposed BEFORE its terminal.
- **inbox-drawer.js** — operator inbox for `[agent:notify-user]` notes +
  the sidebar-footer unread badge; no core state, but takes `openFilePeek`
  and `showToast` by injection so a link in a note lands in the same peek
  modal and toasts the same miss a path click in the terminal does.
- **voice-control.js** — the voice-mode state machine (off · tap · hold),
  reading `voice-settings.js` over `getVoiceMode` and writing by INJECTING
  `/voice <mode>` into a live Claude session. `createVoiceCore` owns all of it —
  state, the pending affordance, the inject target, the poll and the row
  observer — and publishes snapshots; `createVoiceControl` (the Preferences row)
  and `popovers/voice-popover.js` (the session bar's 🎤 button) are surfaces over
  it that own only their own painting. The setting is box-wide, so both surfaces
  show the same value; the split exists because that reconciliation must have
  exactly one copy. `start`/`stop` are REFCOUNTED: the bar holds for the
  window's life, Preferences only while its dialog is open. The Preferences row
  is never hidden, only disabled when there is no session to inject into (a row
  that vanishes from a settings dialog reads as a missing feature); the bar
  button is absent outright for a non-Claude seat, since Codex has no `/voice`.
- **plugin-host.js** — the renderer-side plugin host. Plugins hand it data or
  callbacks, NEVER HTML: everything user-supplied is escaped here, and every
  registered id becomes `"<pluginId>:<id>"` before it reaches the DOM, so a
  `data-act` carrying a colon is by construction a plugin's and never core's.
- **session-hovercard.js** — the custom hover card for sidebar rows, replacing
  the native `title` tooltip (macOS-rendered: slow, unstylable). One shared
  fixed-position node reused across rows, `pointer-events:none` so it can never
  intercept interaction, killed on any mousedown/scroll/keydown.
- **tooltip.js** — one shared attr-driven tooltip for the sidebar chrome, same
  bg/border/radius as the hovercard family so the sidebar reads as one system
  rather than a mix of custom cards and OS tips.

### Popovers

`renderer/popovers/` — the popover family behind `popoverApi`:
`report-panel.js`, `context-popover.js`, `cost-popover.js`,
`bust-popover.js`, `files-popover.js` (also exports `openFilePeek` +
`isFilesPopoverForKey` for the peer subsystem), plus `session-info-popover.js`
(the sidebar row's ⓘ — anchored to the ROW, so it opens for a session that
isn't active, and off `window.api.sessionInfo` rather than the data seam
since it reads local persistence; peer rows build their own markup and
deliberately have no ⓘ), plus the ones that are NOT on the data seam by
design — grep the directory for `popoverApi` and the misses are the list:
`checklist-popovers.js` (tools/skills/agents/**intents**
— local config editors, direct `window.api`; tools/agents suppressed for
peers, but **skills takes an optional peer `source`** so the same popover
edits a peer session's skills over the wire under the `args` cap; the intents
popover applies IMMEDIATELY — the fire-time gate re-reads persistence — with an
optional restart only to refresh the seat's prompt),
`session-menus.js` (warm/strip/history dropdowns + the consolidated
`⚙ session ▾` launcher menu — local action menus), and
`team-roles-popover.js` (the team manifest is a file, not session state, so
it goes direct rather than through the local-vs-peer seam).
`selection-popover.js` also lives here but is the drawer's 📋 inspector on
`window.api.drawerInspectSelection`, a different subsystem, not a seam bypass.
`voice-popover.js` is likewise off the seam by design: it is the session bar's
🎤 button and its three-mode picker, and it holds no state of its own — every
value comes from voice-control.js's shared core, which reads a box-wide file
rather than session state, so there is nothing for the local-vs-peer seam to
answer differently.

### Peer runtime

- **renderer/peers-ui.js** — the peer runtime: sidebar peer rows, peer bar,
  control + type-to-take, the peer event subscriptions
  (`grep -cE "api\.on[A-Za-z]+\(" renderer/peers-ui.js`), restore sweep,
  visibility/control maps, `PEER_UI_KINDS`, and the peer-select/peer-info
  popovers. Back-exports to core — the `initPeersUi` return, which is the list:
  `typeToTakeControl`, `renderPeerBar`, `forgetControlMirror`,
  `openPeerSession`, `peerDisplayHost`, `peerHideFromList`,
  `ensurePeerSessionVisible`, `openPeerArgs`.

### renderer/lib — pure leaves

DOM-free and unit-tested; peers-ui and the popovers are imperative and are not,
which is why the judgement worth testing is pushed down here.

- **constants.js**, **format.js** (string formatters), **render-html.js**
  (DOM-string builders).
- **checklists.js** — render/collect checklist pairs; owns the library caches
  behind setters.
- **session-actions.js** — the type→entries mapping for the consolidated
  `⚙ session ▾` menu.
- **session-info-view.js** — the ⓘ panel's rows as data, so the cost scopes and
  their labels are unit-testable; the three-scopes ruling is pinned there.
- **subagent-policy.js** — `classifySubagent`: live/done/drop is POLICY, there
  is no wire signal for it, and the sidebar child rows and the drawer's Activity
  chips share this one copy so they cannot disagree.
- **subagent-feed.js** — the accumulating turn feed as pure state, folding
  `proxy:subagentFeed` replies into what the operator has seen. The cursor IS
  the dedup, and the feed owns no running/done opinion of its own.
- **activity-badge.js** — the badge state machine: which subagents did something
  while the operator was NOT looking, so the away-period is the unit and
  wirescope's `requests` is an advanced/not-advanced edge that never reaches
  the screen.
- **turn-stat.js** — which turn number is shown, shared by the statusbar and the
  sidebar hovercard so the two can never disagree.
- **cost-by-line.js** — the cost popover's per-line attribution model. Owns the
  scope pick (`costRun || cost`) that keeps the section rendering identically
  with the W2 overlay on and off; distinct from turn-stat.js's `costScopes`,
  which deliberately returns BOTH scopes for the bar to label.
- **meta/session dialog leaves**: **args-model.js** (the Model field as a VIEW
  onto the `--model` token inside extraArgs — no separate persisted field),
  **env-edit.js** (the `KEY=value`-per-line textarea → the flat object `create()`
  persists), **name-suggest.js** (`session-<counter>` minted before the global
  reserved-name set is prefetched, so it must resolve collisions),
  **tool-gate.js** (whether Create is allowed given the tools:check report, the
  inline notice, and the missing-CLI overlay plan), **placement.js** (the "Run
  in" selector: `'host'` or a sandbox BOX ID), **prefs-gate.js** (which
  Preferences controls are inert given dialog state, plus the reason line).
- **focus-policy.js** — whether a session that was just CREATED may take the
  keyboard. An open draft in the focused session vetoes it whatever spawned the
  new one; otherwise provenance decides, so agent-spawned seats stay in the
  background and manual creates focus as before. The draft answer arrives by
  injection from main (`session:draftOpen` → proxy-util's `isDraftOpen`) — the
  predicate the inject queue already gates on, never a renderer-local guess at
  who is typing.
- **intent-marks.js** — classify rendered terminal rows as a `fire` intent, an
  `inert` one (intent-shaped, will not fire), or unmarked (escaped/fenced).
  Uses intent-scanner's own grammar, never a private regex: a mark is believed,
  so one promising a turn that never happens is worse than no mark.
- **path-scan.js** — find path-like tokens (with an optional `:line`) in a line
  of plain text, as offsets. Answers "what LOOKS like a path here" and nothing
  about existence — resolution is main-side (`file-resolve.js`), because only
  main can stat.
- **gutter-scan.js** — recognize the line-number gutter the CLI prints under a
  file-editing tool call, so those numbers become clickable. Offsets only.
- **drop-paths.js** — the string typed at the prompt when files are dropped on a
  session: each path shell-quoted, space-joined, one trailing space.
- **ipc-export.js** — one grep-friendly line per message for the IPC log's
  Export button, plus the download filename.
- **mcp-group.js** — fold a wirescope tool roster into per-MCP-server groups.
  MCP servers are the single biggest per-turn context carriage, which is why the
  grouping is a leaf and not a rendering detail.
- **sandbox-view.js** — the Sandbox dialog's presentation decisions
  (`detectNotice`, `sandboxActionGate`, `boxRowStartGated`, …); a leaf so the
  copy-selection logic, which is the part with real branches, is unit-tested.
- **selection-view.js** — what the drawer's selection inspector SAYS given
  main's `inspect()` answer.
- **popover-drag.js** — make a `position:fixed` popover draggable by its title
  bar; openers call `resetDrag()` so a fresh open re-anchors instead of
  inheriting the last drag offset.
- **peer-collapse.js** — per-workspace fold state for peer headers. The state
  lives outside the DOM because `renderPeers()` rebuilds every row. The
  persisted set names the peers the operator EXPANDED, never the folded ones.
- **peer-visibility.js** — a peer's "visible sessions" selection: either
  UNMATERIALIZED (no explicit array ⇒ every known session shows) or an explicit
  whitelist.
- **peer-web-view.js** — the pure decision behind the peer web-view (↗)
  affordance: given a peer's live hello state and its web-tunnel state, does the
  button render, what does it say, is a click a "close".
- **served-banner.js** — the pure decision behind the sidebar notice that a peer
  has a shell open on this machine: given the seats being watched, is the notice
  shown and what does it say.
- **team-roles.js** — the team-management popover's row model from a manifest,
  plus the client-side validation worth a unit test.
- **web-notify.js** — browser-frontend OS notifications. The desktop raises
  them through main's `notifyOS` seam; a browser tab has no such channel.
- **web-shortcuts.js** — the pure map from a keydown to a browser Alt-chord
  action. A tab reserves Cmd+T/W/1-9 for its own chrome, so the desktop Cmd
  shortcuts silently fail in-tab.

## Tests

Plain `node --test` (`ls test/*.test.js | wc -l` for the file count; the runner
prints the assertion total). Notable guards:

- `test/architecture-map-complete.test.js` — the completeness ratchet on THIS
  file: every module in the tree is named here or `EXEMPT` with a reason.
- `test/free-identifier-leaks.test.js` — the two-directional extraction
  gate described above; its scanner self-tests pin the lexer classes that
  once hid real leaks (multi-line declarations, template interpolations,
  control-flow heads, nested backticks).
- `test/cli-hooks.test.js` — pins generated hook-script bytes (heredoc
  terminators at column 0, interpreter body first line at column 0). The
  drains shell out to the app's own Electron-as-node
  (`ELECTRON_RUN_AS_NODE=1 "<nodeInterp>"`, baked absolute at generation), not
  an ambient `python3` — so a Finder-launched packaged `.app` on launchd's
  stripped PATH still drains transcripts/intents/parked-DMs.
