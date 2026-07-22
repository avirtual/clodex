# Session lifecycle

How a session comes to exist, observes its agent, dies, and comes back.
Companion to [architecture.md](architecture.md) (module map); see
[messaging.md](messaging.md) for what happens to the text a session emits,
and [telemetry.md](telemetry.md) for the proxy/ctx side-channels.

Reading guide for a change: **spawn/argv** → `SessionManager.create` +
argv-merge.js · **hooks** → cli-hooks.js · **transcript watching** →
jsonl-watcher.js / wire-intents.js · **exit/restore** → `ptyProc.onExit`,
`restartSession` (main.js), `app:restore-sessions` · **persistence** →
stores.js · **workspaces** → workspaces store + `SessionManager.windows`.

## 1. Create

Renderer new-session dialog → `session:create` (ipc-handlers.js) →
`SessionManager.create()`. The IPC handler infers `workspaceId` from the
sender window and applies the global default tool-deny floor when the caller
didn't pass an explicit `disabledTools` (explicit `[]` wins). Strip level is
persisted separately after create — it's a proxy-side override, **not a spawn
arg** (which is why restart paths must re-assert it; kill drops the entry).

`create()` builds argv per type:

- **claude** — `mergeClaudeSystemPrompt` (argv-merge.js) merges the append
  channel in order: the per-seat IPC prompt (`buildIpcPrompt(intents)`) →
  library append bodies → legacy inline →
  any user-passed append flags; the blob is written to
  `{name}-append-prompt.md` and rides `--append-system-prompt-file`
  (SETTLED: the IPC protocol always travels this channel). A library system
  prompt is pointed at directly via `--system-prompt-file`, never merged.
  Wire registration happens BEFORE the pty spawn (`_ensureWire`); failure
  falls back silently to the jsonl path. `setupClaudeHook` →
  `--settings {name}-hook.json`; `--add-dir` for the messages dir;
  `--agents` JSON from the agent library; `--plugin-dir` for injected
  skills; `--resume <id>` (+`--fork-session`) when resuming.
  The agent/skill enabled set is UNIONED at spawn with any `sessions:`-scoped
  library items assigned to this session (`scope-util.unionEnabled`) —
  assignment is intent, computed each spawn and NEVER written back to the
  persisted record.
- **codex** — `mergeCodexInstructions` merges system + the per-seat IPC prompt
  (`buildIpcPrompt(intents)`) + appends
  into `{name}-instructions.md` (`model_instructions_file`); shared
  `codex-session-hook.sh` routed by `WB_WRAP_NAME`; resume/fork is a
  *subcommand* placed after top-level flags (clap). Proxy rides
  `openai_base_url`.
- **bash** — `$SHELL` with extraArgs verbatim; no hooks, no transport,
  private (invisible to `[agent:who]`, not DM-able — but peer-visible for
  attach/control).

**Scoped env vars (env-scopes.js).** The PTY's environment is built by
`mergeSessionEnv` (pure leaf) with precedence `process.env < global <
workspace < session < node-local override file`, then the app-owned keys
(`TERM`, and `WB_WRAP_NAME` for codex) are applied last so they always win.
`process.env` is pre-scrubbed of inherited CLAUDE_* markers at startup; the
merge does NOT re-scrub, so scope-set CLAUDE_* values are deliberate config
and survive. Global + per-workspace scopes live in `<userData>/env-scopes.json`
(`0600`); a value marked `secret` is write-only — the `envScopes:get` IPC
returns `{ key, secret:true, hasValue:true }`, never the bytes, so a secret
never reaches the renderer, a log, an ack, or an error string. `CLODEX_REMOTE_TOKEN`
is deny-listed in every scope (the wire gate must not be clobberable through the
surface it gates); keys must match `[A-Za-z_][A-Za-z0-9_]*` and values carry no
newlines. The per-session map is passed to `create()` and persisted flat on the
sessions.json entry so `--resume` respawns identically. A box operator's
`<userData>/env-override.env` (env-file format, read at spawn) has the final say.
With no scope vars set anywhere the merge reduces to exactly `{ ...process.env,
TERM }` — byte-identical to the historical spawn (pinned). GUI: Preferences ▸
Environment variables (global/workspace editor) + a per-session section in the
New Session dialog; over the wire, `clodexctl spawn --env KEY=VALUE`.

**Library scoping (skills + agents).** The `~/.clodex/{skills,agents}/*.md`
libraries stay FLAT; two OPTIONAL frontmatter keys scope a file:
`workspace: <name>` (visible only in that workspace — matched on its DISPLAY
name) and `sessions: a, b` (personal — visible only to the named sessions,
globally-unique). Neither key = GLOBAL (every pre-scope file unchanged, zero
migration); both = union. The scope only affects the OFFER surfaces (the
Skills/Agents popovers + the Edit Session agents catalog filter via
`library.listFor(ctx)` — `scope-util.visibleTo`); the library DRAWER still
lists everything. `workspace:` scope only offers; `sessions:` scope also
AUTO-INCLUDES its files at spawn (union above, never persisted — the scoped
checklists render those rows checked+disabled `· auto` and `reconcilePartial-
Selection` keeps Save from dropping out-of-scope selections or persisting the
auto ones). Renaming a workspace rewrites matching `workspace:` lines across
both libraries in the same motion (`renameWorkspaceScope`), so scoped files
don't orphan. Nothing is ever written into a project's `.claude/`.

Agent sessions then get their transport: `run/<name>/agent.sock` Unix socket +
`run/<name>/agent.json` registry entry (agent-transport.js). A stale
registry entry from a dead pid is force-cleaned; a live one throws
"already running elsewhere". `persistence.upsert` records everything needed
to respawn the session later (bash included — restored as a fresh shell).

## 2. Hook generation (cli-hooks.js)

**Per-agent runtime dir.** Everything one agent generates lives under
`~/.clodex/run/<name>/` with UNSUFFIXED names (`hook.sh`, `hook.json`,
`transcript.jsonl`, `agent.json`, `agent.sock`, `statusline.sh`, `attn.jsonl`,
`acks`, `pending.sh`, `ctx`, `ctxwarn`, `append-prompt.md`, … — 18 kinds).
`clodex-paths.js` (`pathFor` / `runDirFor`) is the single source of that
grammar; every mint site routes through it, and cleanup drops the whole
`run/<name>/` dir. SHARED state stays at the `~/.clodex` root and never moves:
`messages/`, `pending/<name>/` (parked DMs — only the drain SCRIPT relocates,
its body still targets the shared dir), `agents/`, `skills/`, `library/`,
`skill-plugins/<name>/`, `clodex.log`, `wire-shadow.jsonl`, and the one shared
`codex-session-hook.sh`. Two generated scripts resolve the name at runtime and
so mirror the grammar in bash (the Codex hook's `run/$NAME/…` paths; the
statusline is JS-interpolated and uses `pathFor` directly) — the byte-pinned
`cli-hooks.test.js` enforces the mirror. Upgrading from the old flat `{name}-*`
layout triggers a one-time, marker-gated (`run/.migrated`), name-driven sweep at
launch (legacy-sweep.js) that deletes only exact `{knownName}{knownSuffix}`
files — shared files can't be misattributed — plus a log-only orphan pass.

Per Claude session: `run/<name>/hook.sh` (SessionStart — atomically repoints the
`run/<name>/transcript.jsonl` symlink; emits the memory digest only for
conversations being born), `run/<name>/hook.json` (the `--settings` payload:
statusline, hooks, `ANTHROPIC_BASE_URL` routing — wire base wins over proxy
base —, `permissions.deny` from denyBuiltins ∪ disabledTools, `skillOverrides`
for disabled skills), plus the attention/statusline/acks/pending/ctxwarn scripts
(see [messaging.md](messaging.md) §7 for the drain semantics).

Codex gets the shared SessionStart script plus a per-cwd `.codex/hooks.json`
(existing file backed up once, restored on cleanup).

`cleanupClaudeHook`/`cleanupCodexHook` unlink everything on exit.
**Generated bytes are test-pinned** — the templates are byte-sensitive
(a 2-space re-indent once broke every heredoc terminator).

## 3. Observing the agent (two mutually exclusive paths)

- **wire** (Claude, wire-registered): turns arrive from the in-process wire
  tee; a `TranscriptSentinel` keeps only the transcript-side jobs (symlink
  identity → `onSessionId`, compact rendezvous, recovery replay). No
  steady-state jsonl parsing.
- **jsonl** (Codex, wire-failed Claude): `JsonlWatcher` polls the
  `{name}.jsonl` symlink every `POLL_INTERVAL` (250ms). On target change it
  reopens and **starts at EOF** — replaying history would re-fire past
  intents. It buffers assistant text by requestId and flushes on a new
  requestId / non-assistant entry / `TURN_COMPLETE_TIMEOUT` (1s) silence.
  `/clear` = new transcript + new sessionId; `/compact` = same transcript,
  same id, plus an `isCompactSummary` entry (→ compact-continuation firing).

Callbacks: `onText` → intent scan · `onSessionId` →
`persistence.setSessionId` (+ sessionIds history) · `onActivity` → UI dot ·
`onCompactSummary` → `_fireCompactContinuation` · `onFileTouches` → 📄
telemetry. Claude side-channels ride `fs.watch` on the registry dir:
`{name}-ctx` (statusline-written context numbers → `session-ctx` + ctxwarn
reminder file) and `{name}-attn.jsonl` (Notification hook → attention state).

## 4. Exit, kill, restore

`ptyProc.onExit` runs a **fixed order** (each step depends on the previous
state): mark `session._dead` (later pty ops on a dead handle throw a native
error that takes the process down) → `_sendToSession('session-exit')`
**before** `_cleanup` (cleanup removes the session from the map that window
resolution needs; the reverse order strands a dead sidebar tab) → remote
notify → persistence (only a *bash natural exit* removes the entry — an
`_archived` bash shell keeps it) → `_cleanup`. The `expected` flag on the
exit event folds in `_archived` alongside `_userKilled`/`_shuttingDown`, so
an archive exit stays silent (no crash toast).

`_cleanup` runs on every exit path; the parked-DM dir is removed **only on
explicit user-kill** (`_userKilled`) — unconditional removal would eat
parked mail on restart/quit. Archive keeps `_userKilled` false so it doesn't.

**✕ / Cmd+W = archive, not delete** (reshaped v0.15.x, PR #1). Both stop the
PTY but **keep** the record, stamped `archivedAt` (`manager.archive` →
`persistence.setArchived`). The session-exit lands with the row queued in the
renderer's `archivingSessions` map, so `onSessionExit` tears the live tab down
and rebuilds it in place as a **dimmed archived row** (`.session-item.archived`,
"archived — click to resume") — no app restart. Clicking it unarchives
(`setArchived(false)`) then resume-spawns; its ✕ forgets the entry. Archived
rows surface via the sidebar status filter (Active/Archived/All).

**Real delete = right-click "Delete Session…"** + native confirm (the only
record-dropper besides Delete Workspace). It routes through `manager.kill`
(`_userKilled` → `persistence.remove`); the `session:kill` handler additionally
grabs worktree provenance *before* the kill, `await`s `waitForSessionExit`, then
`await`s `gitWorktree.removeWorktree` — **awaited, toasted on failure**, not the
old fire-and-forget `setTimeout`. The session is deleted regardless; a
worktree-removal failure returns `{ok:true, worktreeRemoved:false, error}` so
the renderer toasts it while the row still goes.

| Event | sessions.json | Process | UI |
|---|---|---|---|
| Archive (✕ / Cmd+W) | kept, `archivedAt` stamped | killed (SIGKILL fallback 5s) | live tab → dimmed archived row |
| Delete (right-click "Delete Session…") | removed (+ worktree removed, awaited) | killed (SIGKILL fallback 5s) | tab removed |
| Natural exit (agent) | kept → `--resume` next open | dead | tab removed |
| Natural exit (bash) | removed (unless `_archived`) | dead | tab removed |
| App quit | kept | all killed (`killAll`, `_shuttingDown`) | windows closed |
| Restore failure | kept, returned `{failed:true}` | never spawned | failed ghost tab (retry / forget) |
| Restore (archived) | kept | never spawned | dimmed archived row (click = resume) |

`restartSession(name, opts)` (main.js — shared by the local IPC handler and
the peer restart endpoint): kill → `waitForSessionExit` (polls the map;
removal is async up to the SIGKILL fallback — a fixed sleep caused
"already exists") → `manager.create` from the persisted entry →
re-assert stripLevel + label. On failure it **upserts the entry back**
(kill had removed it) — a session must never vanish because a respawn threw.
`opts.fresh` drops the resumeId (required for skill roster changes, which
are frozen on resume).

Restore (`app:restore-sessions`) has three branches: an entry with `archivedAt`
comes back `{archived:true}` and is **never spawned** (rendered as a dimmed
archived row); already-running sessions flush their `pendingOutput` as replay
(no respawn); cold entries spawn with `--resume`. Failures do **not** remove
persistence — the entry comes back `{failed:true}` for the renderer's ghost-tab
retry/forget UI (silently wiping it caused the pre-v0.5.3 "upgrade kills my
agents" reports).

## 5. Persistence (stores.js)

`initStores(userDataPath, {log, registryDir})` builds all eight stores in
`app.whenReady()` — paths derive inside the factory, so nothing can read
them too early. Six JSON stores under userData (sessions, templates,
workspaces, agent-defaults, ui-settings + migration-only prompts.json);
three markdown libraries under `~/.clodex/` (prompt/agent/skill libraries).

sessions.json entries carry the full respawn recipe (type/cwd/extraArgs/
sessionId/workspaceId/prompt refs/proxy tri-state/agents/deny/tools/skills)
plus setter-added `sessionIds[]` history, label, stripLevel, `createdAt`,
`worktree` provenance (`setWorktree`, cleared on delete's worktree removal),
`archivedAt` (`setArchived`, present only while archived), and `autoCompact`
(stored only as `false` to opt out). Writes validate before backing up to
`.bak`; load falls back to the backup.

**templates.json** stores reusable session configs. Base fields
(`id/name/type/cwd/extraArgs`) plus the config subset snapshotted by the
session context menu's **Export as Template…** (agent sessions only):
`proxy/agents/denyBuiltins/disabledTools/disabledSkills/injectSkills` and the
opt-out fields `stripLevel/autoCompact` (present only when non-default). The
store is schemaless (whole object saved verbatim), so the fields are additive
— an old `{id,name,type,cwd,extraArgs}` template loads fine (missing config =
clodex defaults at spawn). A template carries NO per-session identity
(`proxyAgent`, minted fresh per spawn) and NO prompt refs (clodex defaults).
Model isn't a field — it rides `extraArgs` (`--model X`), captured verbatim.
Spawn a matching session via `[agent:spawn name:X template:Y]`
(`_handleSpawnIntent`) or by selecting it in the New Session dialog, which
applies the full config to the form so Create threads it through
`session:create` verbatim. `Y` resolves TWO ways off one apply seam: a bare
token is a **library name** (case-insensitive exact; ambiguous/missing →
error), while a `Y` containing `/` or starting with `~`/`.` is a **JSON file
path** (expanded, resolved against the spawner's cwd, read + parsed; ENOENT /
bad-JSON / non-object / missing-`type` → error, never a half-configured
spawn). A file template may omit `id`/`name`; reading it is same-trust (the
spawner can already read files with its own tools). cwd precedence is
unchanged (intent > template > error). stripLevel/autoCompact aren't create()
params — they're applied post-create onto the entry (poller re-asserts strip
on relink; autoCompact read from persistence), mirroring the ipc-handlers
`session:create` seed.

## 6. Workspaces

One BrowserWindow per workspace (`SessionManager.windows` map); sessions
carry `workspaceId`; `session:list` is sender-scoped, `session:listAll`
feeds the tray. Closing a window detaches its sessions: `pty-data` buffers
into `session.pendingOutput` (2MB cap, oldest dropped) and replays on
reopen; exit/activity events while detached are dropped and recomputed.
**Delete Workspace…** (Window menu) removes a whole workspace record: confirm →
kill its sessions → remove the record → close the window. (For a single session,
right-click **Delete Session…** is the per-session record-dropper; ✕ / Cmd+W
archive instead — see §4.)

## Invariants (do not break)

- `onExit` order is load-bearing: `_dead` first, `_sendToSession` before
  `_cleanup`, persistence decision before cleanup.
- JsonlWatcher starts reading at EOF on every symlink repoint.
- Restore/respawn failure keeps the persisted entry (`{failed:true}`).
- ✕ / Cmd+W archive (keep the record, stamp `archivedAt`); only right-click
  Delete Session… and Delete Workspace… drop a session record.
- Parked-DM dir removal is gated on `_userKilled` — archive leaves it false.
- Strip level is not a spawn arg — every kill+create path must re-assert it.
- The append-prompt channel is static per protocol (see messaging.md §6);
  hook script bytes are test-pinned.
- Stores don't exist before whenReady by construction — don't hoist them.
