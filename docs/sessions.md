# Session lifecycle

How a session comes to exist, observes its agent, dies, and comes back.
Companion to [architecture.md](architecture.md) (module map); see
[messaging.md](messaging.md) for what happens to the text a session emits,
and [telemetry.md](telemetry.md) for the proxy/ctx side-channels.

Reading guide for a change: **spawn/argv** → `SessionManager.create` +
argv-merge.js · **hooks** → cli-hooks.js · **transcript watching** →
jsonl-watcher.js / wire-intents.js · **exit/restore** → `ptyProc.onExit`,
`restartSession` (engine.js), `app:restore-sessions` · **persistence** →
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
  TWO `--plugin-dir`s, each a session-only scaffold under its own root — the
  agent library (`agent-plugins/`, manifest `clodex-agents`) and the injected
  skills (`skill-plugins/`, manifest `clodex-skills`). The manifest names must
  stay distinct: two dirs sharing one collide silently, last wins. Agents moved
  off `--agents` (t403) to keep the definitions out of `ps`; the cost is that
  the CLI namespaces them, so a library agent dispatches ONLY as
  `clodex-agents:<name>` — there is no bare-name alias — and the plugin loader
  ignores `permissionMode`/`initialPrompt`/`hooks`/`mcpServers` (a spawn warns
  when an enabled agent sets one). A user-passed `--plugin-dir` stands the
  skills scaffold down but NOT the agents, which it cannot express;
  `--resume <id>` (+`--fork-session`) when resuming.
  The agent/skill enabled set is UNIONED at spawn with any `sessions:`-scoped
  library items assigned to this session (`scope-util.unionEnabled`) —
  assignment is intent, computed each spawn and NEVER written back to the
  persisted record.
  Before the spawn, `preseedClaudeOnboarding` merges into `~/.claude.json` both
  the onboarding flags and `projects[<seat cwd>].hasTrustDialogAccepted`, so a
  seat never sits at the wizard or the "trust this folder?" prompt inside a PTY
  nobody is watching. Marking the cwd trusted is sound because that cwd was
  chosen either by the operator in the dialog or by a seat holding the gateable
  spawn intent — the same trust the prompt asks for.
- **codex** — `mergeCodexInstructions` merges system + the per-seat IPC prompt
  (`buildIpcPrompt(intents)`) + appends
  into `{name}-instructions.md` (`model_instructions_file`); shared
  `codex-session-hook.sh` routed by `WB_WRAP_NAME`; resume/fork is a
  *subcommand* placed after top-level flags (clap). Proxy rides
  `openai_base_url`. Selected skills arrive as a `# Clodex skills` catalog
  appended to the merged instructions, above the team block.

**Skill delivery is per provider (skill-delivery.js, t747).** One
provider-keyed module owns both halves: `deliver(provider, name, records)`
returns `{ args, instructions }` or null, `cleanup(provider, name)` reaps the
seat dir on teardown, `providers()` is the list with an adapter. The claude
adapter is the `--plugin-dir` scaffold described above. The codex adapter
materializes each SKILL.md under the seat's own `skill-plugins/<name>/skills/`
and lists name, description and absolute path in the instructions — Codex
0.153.4 has no per-process skill root to point at (`-c skills.config` only
re-toggles skills it already knows, `<cwd>/.agents/skills` writes into the
user's repo and leaks between seats sharing a cwd, and a private `CODEX_HOME`
needs auth.json copied), so an instruction-layer catalog read on demand is the
delivery. A third CLI is one more adapter entry, not another spawn block.
Records are `[{ name, content }]`: library skills for claude (its plugin
bundles ride their own `--plugin-dir` each), library plus `bundle:skill`
records for codex, which has no plugin dir to ride.
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
New Session dialog; over the wire, `clodexctl spawn --env KEY=VALUE`. The
per-session env is also EDITABLE after create via the Edit Session dialog's
Environment variables section (T46b): the textarea prefills from the entry's
persisted env, an empty box clears it, and the change rides the existing
args-edit path (`session:setArgs` → `applySessionArgs` → `resolveSessionArgsPatch`
sanitizes the map + the deny-list bites server-side → `persistence.setEnv`).
Like exec grants, session env is LOCAL-only — never rendered, collected, sent, or
returned over the peer wire (values may be creds and there's no secret masking for
session env), so a remote Edit-Session view omits the section and the wire strips
`env` in both directions. It applies at the next spawn; ticking "Restart session
now" applies it immediately (`applySessionArgs` threads the edited env into the
respawn's `create()`).
**Accounts (accounts.js).** A registered Claude subscription is a label plus the
`CLAUDE_CONFIG_DIR` a seat on it spawns with. The registry is
`~/.clodex/accounts.json` (`0600`, `{ accounts: [{ label, email, configDir, plan,
addedAt }] }`); labels match `[a-z0-9][a-z0-9-]{0,31}` and are unique. The
`default` account is IMPLICIT — label `default`, configDir `~/.claude`, never
written to the file, always first in `list()` — so an unconfigured seat is the
absence of the var, not a stored row. Adding an account with no `configDir`
MINTS one at `~/.clodex/accounts/<label>/`: mode 0700, a fresh minimal
`.claude.json` (`hasCompletedOnboarding`, the theme from `~/.claude.json`, empty
`projects` — never a copy of the real 700KB file), symlinks for `projects`,
`plugins`, `skills`, `agents` and `commands` into `~/.claude` so transcripts and
the roster are shared, and a copy of `settings.json` (re-copied on demand by
`accounts:resync`). Minting is idempotent, so the login a dir accumulates
survives; `accounts:remove` drops the registry row and never the dir.
Selection is per SEAT through the ordinary session env, so a move is an env edit
plus a restart: `accounts:move-by-model` does that in bulk for every live claude
seat whose `--model` selects the given model (`fable` matches any
`claude-fable-*` id and back), one at a time and awaited, skipping — with a
literal reason — a seat that is not claude, is on another model, is already on
that account, or is MID-TURN. Every `session:list` row carries `account`, read
off the persisted entry's env (a dir outside the registry shows as its basename,
so a hand-typed `~/sub-2` still reads `sub-2`). `create()` refuses to spawn when
the merged env names a `CLAUDE_CONFIG_DIR` that is not a directory — the CLI
would otherwise mint an empty config there and loop on onboarding silently. Like
session env and exec grants the whole family is LOCAL-only, and by the
registration-is-the-capability rule: the `accounts:*` handlers register only
under `enableAccounts`, which web-host.js declines.

Clodex SHIPS a set of default vars for wrapped seats in `resources/env-defaults.json`
(`{ KEY: { value, note } }`), seeded into the GLOBAL scope at `initStores` — once per
key ever, recorded on a `seeded` list in `env-scopes.json`. They are ordinary global
entries afterwards, so precedence is unchanged and the operator may edit or delete
them: a deleted default stays deleted across launches (the key is on the `seeded`
list, so the seeder does not write it again), and "Restore shipped defaults" in
Preferences ▸ Env clears the shipped keys off that list so the seeder brings back the
absent ones while leaving edited values alone. `CLAUDE_STREAM_IDLE_TIMEOUT_MS` moved
here from a baked constant in session-manager.js (t676), so it now sits ABOVE
`process.env` rather than below it, and a seat spawned through create()'s
scope-store-unreachable degrade path does not carry it.

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
`acks`, `pending.sh`, `ctx`, `ctxwarn`, `append-prompt.md`, `bash-console/`,
… — the keys of
`KINDS` in `clodex-paths.js`).
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
for disabled skills — a `"*"` entry in `disabledSkills` is the sentinel for
"every skill this box knows", expanded against the live catalog at spawn
(injected skills excepted) while the persisted entry keeps the raw `*` so a
restart re-expands), plus the attention/statusline/acks/pending/ctxwarn scripts
and the two Bash-console ones — `bash-console.sh` (PostToolUse/PostToolUseFailure,
the settled record) and `bash-live.sh` (PreToolUse, the in-flight observer)
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
  Codex has written its replies in two shapes across builds and `transcript.js`
  reads both: the older `event_msg` `agent_message`/`user_message`, and the
  current `response_item` `{type:'message', role:'assistant'|'user'}` whose
  `content` blocks carry the text. Current builds write only the second, and
  repeat each reply as an `event_msg` `item_completed` `AgentMessage` — read
  deliberately as nothing, since the twin would deliver every intent twice.

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
`_archived` or `_moving` bash shell keeps it) → `_cleanup`. Both questions are
answered by one leaf, `exitDisposition`: `expected` folds in `_archived` and
`_moving` alongside `_userKilled`/`_shuttingDown` (so neither an archive nor a
move exit raises a crash toast), and the record-drop is its exact complement for
a bash row — `dropRecord === !agentType && !expected`. They are computed together
because a flag added to one and not the other makes an expected exit also drop
the record.

`_cleanup` runs on every exit path; the parked-DM dir is removed **only on
explicit user-kill** (`_userKilled`) — unconditional removal would eat
parked mail on restart/quit. Archive keeps `_userKilled` false so it doesn't.

**✕ / Cmd+W = archive, not delete** (reshaped v0.15.x, PR #1). Both stop the
PTY but **keep** the record, stamped `archivedAt` (`manager.archive` →
`persistence.setArchived`). The session-exit lands with the row queued in the
renderer's `archivingSessions` map, so `onSessionExit` tears the live tab down
and rebuilds it in place as a **dimmed archived row** (`.session-item.archived`,
"archived — click to resume") — no app restart. Clicking it unarchives
(`setArchived(false)`) then resume-spawns; its ✕ forgets the entry
(`forgetSession` → `persistence.remove`) — a DIFFERENT control from the live
row's ✕, which archives. Archived rows surface via the sidebar status filter
(Active/Archived/All).

The record-droppers reachable from the sidebar are three, not one: the ARCHIVED
row's ✕ and the FAILED ghost row's ✕ (both `forgetSession` → `persistence.remove`,
renderer.js), and right-click Delete Session…. Only the last kills a session
process; the two ✕ routes act on a record whose session is already gone.

**Real delete of a LIVE session = right-click "Delete Session…"** + native
confirm. It routes through `manager.destroy` (`ipc-handlers.js` `session:kill`)
— see that method's own comment for what it does and in what order. A
worktree-removal failure is toasted by the renderer while the row goes.

| Event | sessions.json | Process | UI |
|---|---|---|---|
| Archive (✕ / Cmd+W) | kept, `archivedAt` stamped | killed (SIGKILL fallback 5s) | live tab → dimmed archived row |
| Delete (right-click "Delete Session…") | removed (+ worktree; see `destroy()`) | killed (SIGKILL fallback 5s) | tab removed |
| Natural exit (agent) | kept → `--resume` next open | dead | tab removed |
| Natural exit (bash) | removed (unless `_archived`) | dead | tab removed |
| App quit | kept | all killed (`killAll`, `_shuttingDown`) | windows closed |
| Restore failure | kept, returned `{failed:true}` | never spawned | failed ghost tab (retry / forget) |
| Restore (archived) | kept | never spawned | dimmed archived row (click = resume) |
| Move (right-click "Move Session…") | kept, `cwd` rewritten (archive stamp cleared) | killed + respawned (`--resume`) | tab rebuilt under the new folder; failed ghost row if the respawn throws |

**Move Session…** (right-click, agent rows only) changes a seat's cwd. A move is
"same record, new cwd, restart": `manager.move(name, newCwd)` refuses an unknown
name, a relative or missing or non-directory destination, an unchanged cwd, and a
seat living in a ticket worktree. It sets `_moving` on the live session (read by
`exitDisposition`, so the exit is *expected*), kills the pty with the usual 5s
SIGKILL fallback, waits for the map slot to free, rewrites `cwd`
(`persistence.setCwd`) and re-creates from the surviving record in the same
workspace with `--resume`. It does NOT route through `kill()`, which drops the
persistence record unconditionally — the record is exactly what a move must keep,
and it is what carries everything the respawn is not given. Moving across
workspaces is not offered.

An archived record is un-stamped (`setArchived(name, false)`), and the `create()`
catch arm clears it a SECOND time: that arm re-upserts the snapshot read at the
top of `move()`, which still carries `archivedAt`, and `upsert` spread-merges — so
the stamp comes back unless it is cleared after. The snapshot there must stay an
inline `{ ...entry }` literal: the t491 scanner in
`test/preserve-across-restart.test.js` finds every restart catch arm by that shape,
and hoisting it into a variable makes the arm invisible to it.

A second `move()` while one is in flight is refused off `manager._movingNames`, a
Set of names held for the whole call. Not the live session's `_moving` flag: that
exists only while a session object does, so on a not-live record both callers
passed it, and the loser's catch arm then upserts ITS destination over a seat
running in the winner's.

Team membership is re-derived from the new cwd by `create()`'s own `resolveTeam`.
After a successful respawn `move()` calls `_notifyComposition` twice — `'moved out'` against the old cwd, `'moved in'` against the new — skipped when the team name is the same on both sides; neither failure arm sends one, so a move that fails and is later retried never tells either lead.

Both failure arms — the exit that outlasts `_waitForExit`, and a `create()` that
throws — return `{ ok:false, kept:true, error, type, cwd, team }`, and the renderer
turns that into the same **failed ghost row** the restore path builds
(`addFailedSessionToSidebar`, whose click calls `session:retrySpawn`). On the
create-throws arm the pty is already dead and `session-exit` removed the live tab,
so the ghost is drawn at once. On the exit-timeout arm the pty may still be alive
and its row is still up, so the row identity is stashed in `movingFailed` and the
ghost is drawn from `onSessionExit` instead — like `archivingSessions`. Drawing it
immediately would put two rows under one `data-name`, and drawing it nowhere loses
the seat to the late `session-exit`, whose `removeSession` has no `failed` guard.
The `cwd` the result carries is the one the record actually holds — the destination
when the record was rewritten, the origin when the move never got that far.

`restartSession` (engine.js) — shared by the local IPC handler and the peer
restart endpoint. `opts.fresh` drops the resumeId (required for skill roster
changes, which are frozen on resume).

Restore (`app:restore-sessions`) has three branches: an entry with `archivedAt`
comes back `{archived:true}` and is **never spawned** (rendered as a dimmed
archived row); already-running sessions flush their `pendingOutput` as replay
(no respawn); cold entries spawn with `--resume`. Failures do **not** remove
persistence — the entry comes back `{failed:true}` for the renderer's ghost-tab
retry/forget UI (silently wiping it caused the pre-v0.5.3 "upgrade kills my
agents" reports).

## 5. Persistence (stores.js)

`initStores(userDataPath, {log, registryDir})` builds every store in
`app.whenReady()` — paths derive inside the factory, so nothing can read
them too early; the `initStores` return is the list. JSON stores under
userData, derived by
`grep -n "path.join(userDataPath, '" stores.js`: sessions, workspaces,
agent-defaults, ui-settings, reminders, notifications, env-scopes, plus
migration-only prompts.json and templates.json. Three markdown libraries
under `~/.clodex/` (prompt/agent/skill libraries — `execLibrary` is the
fourth library object but is JSON, not markdown).

sessions.json entries carry the full respawn recipe (type/cwd/extraArgs/
sessionId/workspaceId/prompt refs/proxy tri-state/agents/deny/tools/skills)
plus setter-added `sessionIds[]` history, label, stripLevel, `createdAt`,
`worktree` provenance (`setWorktree`, removed with the record on delete),
`archivedAt` (`setArchived`, present only while archived), and `autoCompact`
(stored only as `false` to opt out). `.bak` is a LAUNCH SNAPSHOT, not a mirror:
the first `_save` of a process copies the on-disk file to `.bak` and no later
save touches it, so it holds the pre-launch state for the whole session — which
is what survives an upgrade or a bug in the running build. It is only written
from content that parses, and a missing or unparseable file writes nothing and
leaves any existing `.bak` alone. Load falls back to it only when
sessions.json itself does not parse.

A ticket seat's `cwd` IS its worktree, and its record carries `worktree.main` —
the shared checkout the tree was cut from. A `worktree` pointer naming a tree
that no longer exists is EXPECTED and is not swept: team-retire with discard
removes the tree, an operator can remove one by hand, team-retire with archive on
a dirty or uninspectable tree keeps a record whose pointer outlives the checkout,
and so does the merge gate's not-merged arm followed by a later accept. Every
respawn-from-record path that can meet one (retrySpawn, restore-on-launch,
`restartSession`, `applySessionArgs`, the `[agent:context reload]` intent)
resolves its cwd through the ONE helper
`SessionManager.resumeCwdOf(entry)`: the `cwd` when it is on disk, else
`worktree.main` when THAT is on disk — logging one line and REWRITING the record
to `{cwd: main}` with the now-unusable `worktree` pointer dropped — else the `cwd`
unchanged, which is a pre-t752 record with nowhere better to go and lands in the
failed-tab retry/forget UI. `rename` is the sixth respawn site and deliberately
does NOT go through it: it refuses any record carrying a `worktree.path` outright,
so it can never meet a stale one. Both halves are pinned by
`test/resume-cwd-tree-fallback.test.js` (a source-shape pin that every site asks
the helper, and a runtime pin of what it answers), whose row set is kept in step
with `test/create-mint-census.test.js`.

The fallback is WRITTEN to the record, not merely returned, and that is the
load-bearing half. `retrySpawn` and restore-on-launch do not route through
`kill()`, so the record survives a `create()` throw: a decision held only in the
return value dies with the throw, and every retry afterwards resolves the vanished
tree again — a permanent ENOENT behind the retry button. Persisted, the record is
already repaired whether or not the spawn lands, and the next call takes the
healthy-record arm instead of falling back a second time.

Nothing else reads the pointer in a way a missing tree breaks:
`_ticketTreeHolder` only scans live sessions; the ticket-dispatch mint's
`claimTree` (team-tickets.js) clears any other record naming a path it mints —
the other two `setWorktree` call sites (`session:markWorktree`, the spawn-intent
mint) do NOT scan, so that self-healing covers the ticket path only; and
`destroy()` has a failure return that KEEPS the record — see its own comment
for when.

The Delete Session… confirm sentence and the `Worktree removal failed: …` toast
both concern a tree that is already gone.

Do not add a sweep keyed on the path being missing: a missing path is not
evidence a session is dead (an unmounted volume or a moved repo reads
identically), and dropping records on it is the pre-v0.5.3 "upgrade kills my
agents" bug. Clearing only `worktree` while keeping the row is WORSE, not a
compromise — see ALWAYS_PRESERVE in session-manager.js for why absent is the
dangerous state. `resumeCwdOf` is not an exception to that: it drops the pointer
only where it has a `main` to put in `cwd` at the same moment, so the record it
leaves names a checkout that exists rather than nothing at all — and it acts on
one record being resumed, never as a sweep over the store.

The New Session dialog opens on Name / Type / Working directory / **Mode**;
everything else lives in the collapsed **Advanced** section. Mode is a preset
over the Advanced fields, not a per-session stored key — `Clodex optimized`
writes the default tool denylist and `stripLevel: 2`, `Standard` writes neither,
and any edit inside Advanced flips the selector to `Custom`, which applies
nothing. Which of the two a create-mode open starts on is the
`defaultSessionMode` preference (Settings ▸ Sessions, shipped `optimized`), read
per open so a change applies to the next dialog. A template, an adopt prefill or the template editor opens as
`Custom` with Advanced expanded, so `collectFormConfig` and template round-trips
are unchanged.

Which Advanced rows a type shows — in this dialog and in Edit Session — comes
from one per-CLI capability table, `renderer/lib/provider-caps.js`: `capsFor(type)`
answers a whole-object row and an unlisted type reads as all-false. Codex is
`injectSkills` + `plugins` (both its spawn arm consumes); the roster, subagent,
tool, strip, auto-compact and wire-off rows are Claude `--settings` mechanisms
with no Codex target and stay hidden. A third CLI is a row, not a new gate — and
the offered-skills column may not exceed `createSkillDelivery().providers()`,
which `test/provider-caps.test.js` pins across the two files.

First launch asks for that preference once, in a **Welcome to Clodex** dialog:
the two modes as radio cards, plus a Skip that leaves the shipped `optimized`.
Either button writes `~/.clodex/setup.json` (registry root, so it outlives the
per-agent run dirs), and `setup:complete` writes the marker and the preference in
ONE handler — a box that never asks again but never applied the answer is the
state that split would allow. The dialog is gated on `document.hasFocus()` like
startup discovery, and the launch that shows it skips discovery, so a first run
raises one modal rather than two. **Run setup again…** (Settings ▸ Sessions)
reopens it over Preferences at any time, rewriting the marker.

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
carry `workspaceId`; `session:list` is sender-scoped. The tray lists across
workspaces by calling `getManager().list()` in-process (app-menus.js) — no
IPC channel exposes an unscoped listing.
Closing a window detaches its sessions: `pty-data` buffers
into `session.pendingOutput` (2MB cap, oldest dropped) and replays on
reopen; exit/activity events while detached are dropped and recomputed.
**Delete Workspace…** (Window menu) removes a whole workspace record: confirm →
kill its sessions → remove the record → close the window. (For a single LIVE
session, right-click **Delete Session…** is the record-dropper; ✕ / Cmd+W on a
live row archives instead. An archived or failed row's ✕ drops its record —
see §4.)

## Invariants (do not break)

- `onExit` order is load-bearing: `_dead` first, `_sendToSession` before
  `_cleanup`, persistence decision before cleanup.
- JsonlWatcher starts reading at EOF on every symlink repoint.
- Restore/respawn failure keeps the persisted entry (`{failed:true}`).
- A restart that throws re-upserts the entry — a session must never vanish
  because a respawn threw. A different arm from the bullet above: that one
  is restore-on-launch's `failed:true` row, this one writes the record back
  and returns `{ok:false}`.
- ✕ / Cmd+W on a LIVE row archives (keep the record, stamp `archivedAt`). The
  ARCHIVED row's ✕ and the FAILED ghost row's ✕ are different controls
  (`forgetSession`) and DO drop the record, as do right-click Delete Session…
  and Delete Workspace…. "✕ archives" is true only of a live row.
- Parked-DM dir removal is gated on `_userKilled` — archive leaves it false.
- Strip level is not a spawn arg — every kill+create path must re-assert it.
- The append-prompt channel is static per protocol (see messaging.md §6);
  hook script bytes are test-pinned.
- Stores don't exist before whenReady by construction — don't hoist them.
