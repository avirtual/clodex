# registry unification — audit journal

Branch `registry-audit`, off master `261b0ab`. Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-audit`, mine alone. AUDIT ONLY — the
only deliverable is `audit.md` in this directory. No code, no tests, no doc
edits elsewhere.

Journal convention matches every other `tasks/*` dir (each has a `journal.md`);
the dispatch asked for journaling into this directory as I go, so this file
exists alongside the single permitted `audit.md`.

## Dispatch, as received

Question: **does a quiescent window exist for the agent registry, on the real
call graph?** Evidenced at FILE:LINE. The tempting precedent is
`legacy-sweep.js` (one-shot migration behind a `run/.migrated` marker); the
dispatch already carries the correction that what makes legacy-sweep safe is
single-process quiescence by construction, NOT the marker.

## Reading order taken

`docs/architecture.md` → `clodex-paths.js` → `agent-transport.js` →
`legacy-sweep.js` → call sites. `clodex-paths.js` was the right start: it is the
whole path grammar in 128 lines and it names the 19 per-agent artifact kinds,
which bounds the search.

## Facts established (reading only)

### The record, precisely

`clodex-paths.js:56` — the registry entry is kind `registry` = `agent.json`,
inside the per-agent dir `run/<name>/` (`clodex-paths.js:104-106`). The socket
is a SEPARATE object, kind `socket` = `agent.sock`, same dir. Both are needed
for an agent to be visible: `listPeers` requires `agent.json` parseable AND
`fs.existsSync(info.socket)` AND `isAlive(info.pid)`
(`agent-transport.js:74-78`).

So "a registry record" has two readings and they give different counts:

- **narrow** — `agent.json` only. 7 call sites.
- **wide** — the whole `run/<name>/` per-agent record dir, which is what a
  unification actually migrates. 23 sites.

Neither is sixteen. Recorded both in `audit.md` §1 rather than picking one.

### `register()` is create-only, not overwrite

`agent-transport.js:58` uses `fs.linkSync(tmp, regPath)`. `link(2)` fails
`EEXIST` when the target exists — it never replaces. Both catch branches rethrow
(`agent-transport.js:61-62`), so a second registration under a live name is an
exception, not a last-writer-wins overwrite. The header comment calls this
"atomic hardlink" which is true but easy to misread as atomic *replace*.

The EEXIST recovery lives at the CALLER (`session-manager.js:1233-1250`), not in
the primitive — it reads the blocking entry, decides staleness via
`isStaleRegistration`, then unregister + unlink socket + re-register.

### `regEntries()` comment is stale

`agent-transport.js:35-36` says "skipping half-written tmp files". It does not
skip anything of the sort — it iterates `readdirSync(RUN_DIR)`, which yields
per-agent DIR names, and the tmp files (`agent.json.tmp.<pid>`,
`agent-transport.js:55`) live one level deeper inside those dirs and are never
enumerated. Harmless (tmp names carry the writer's pid so two registrants never
collide) but the comment describes a guard that isn't there. Not a defect;
noted in audit.md §4 so it isn't inherited as a safety property.

### Three process classes touch `run/<name>/`, not two

The dispatch says two (Electron main + standalone clodex-team/CLI). On the real
call graph:

1. **The engine host** — `main.js:92` (Electron) or `headless-main.js:52` (plain
   Node). Same `createEngine`, same `REGISTRY_DIR`. This is the only registry
   WRITER class.
2. **Hook scripts** — bash, spawned by the Claude/Codex CLI, not by the app.
   They write into `run/<name>/` on CLI-driven triggers. This class is missing
   from the dispatch's framing and it is the one that matters.
3. **Standalone readers** — `scripts/clodex-team.js`, `scripts/clodex-monitor.js`.

### The CLI is not a registry writer — premise correction

`scripts/clodex-team.js` has **zero** write calls (grep for
writeFileSync|unlinkSync|rmSync|mkdirSync|appendFileSync returns 0). It reads
`run/<agent>/agent.json` at `:49` and `readdirSync(run)` at `:134`.
`scripts/clodex-monitor.js` reads the registry at `:49` and writes only under
`~/.clodex/monitors/<agent>/` (`:37-45`) — a different subtree.

`cli/` (clodexctl) never touches `~/.clodex/run` at all; it speaks HTTP to the
web host and persists only `~/.clodex/cli/contexts.json`.

So the "two processes that read and write" premise is half right: the second
process class reads and does not write. That does NOT rescue the quiescent
window — see below — but it changes which failure to worry about.

### Nothing locks `~/.clodex`

- `main.js:491` `app.requestSingleInstanceLock()` — Electron-only, keyed on the
  Electron app identity/userData. Excludes a second **Electron** Clodex.
- `headless-main.js:119-134` — a pidfile under **userDataPath**, with stale-pid
  takeover.

Two different mechanisms, both keyed on userData, neither keyed on
`~/.clodex`. An Electron app and a headless host on one machine share
`~/.clodex` and exclude each other by nothing.

The codebase already knows this: `session-manager.js:184` says "a genuinely-other
Clodex sharing `~/.clodex`" — the multi-host configuration is contemplated in
the very comment that reasons about registration staleness.

### The decisive evidence: an accepted cross-process race already exists

`cli-hooks.js:113-115`, verbatim:

> Read+truncate isn't atomic against a concurrent append — an ack landing in
> that window is lost, which the channel tolerates (success acks are
> bookkeeping).

The main process appends to `run/<name>/acks` (`session-manager.js:3723`); the
generated `acks.sh` truncates it (`cli-hooks.js:126`) from a hook process on
UserPromptSubmit. That is a documented, accepted, unlocked cross-process
read-modify-write inside the record dir, on an EXTERNAL trigger, today. The
quiescent-window question is therefore already answered in the negative by
existing code — I did not have to construct a hypothetical.

### Why legacy-sweep is actually safe — the stronger reason

The dispatch's correction (safety = single-process quiescence, not the marker)
is right but understates it. legacy-sweep's target set is the OLD FLAT grammar
(`clodex-paths.js:81-101`), and **no current writer writes those paths at all**.
The sweep is safe because its target set is write-dead, on top of running at
bootstrap. Registry unification has neither property: its target set is the live
record. Recorded in audit.md §3 — the precedent is weaker than it looks in a way
that cuts AGAINST reusing it.

## Verdict reached

No quiescent window. Details, mechanism-by-mechanism, in `audit.md` §3.

## Live defects found (audit.md §5)

1. **pid-recycle ghost** — single-process reachable, no concurrency needed.
   `isAlive` (`agent-transport.js:25-27`) is bare `kill(pid,0)`. After an unclean
   shutdown `agent.sock` survives (only `Transport.stop` unlinks it,
   `agent-transport.js:140`) and the pid can be recycled by an unrelated process.
   Then bootstrap `registry.cleanup()` (`engine.js:1724`) KEEPS the entry
   (`agent-transport.js:93` — socket exists, pid "alive"), `listPeers` reports the
   dead agent as live, `[agent:who]` lists it (`session-manager.js:3019`), and a dm
   resolves to a stale socket (`session-manager.js:2905`) that refuses the
   connection. Worse: `isStaleRegistration` returns false, so
   `session-manager.js:1247-1249` refuses to start the real session — "already
   running elsewhere (pid N)" — wedged until someone deletes the file by hand.
   No recorded token distinguishes the registering process from the pid squatter.

2. **cleanup TOCTOU** — cross-process. `registry.cleanup()` reads the entry
   (`agent-transport.js:92`) then unlinks it (`:94`) and its socket (`:95`), with
   no re-validation. A concurrent re-registration between read and unlink is
   deleted, and the LIVE socket is unlinked — the server keeps listening on an
   unlinked inode, so the agent is silently unreachable rather than visibly dead.
   Same shape at `session-manager.js:1242-1243` on the stale-recovery path.

3. **`isStaleRegistration` same-pid clause is a shared-volume landmine** —
   `session-manager.js:186-188` treats `existingPid === ownPid` as stale.
   Deliberate, for deterministic Docker pids. Checked whether two boxes can share
   one `~/.clodex`: they cannot on the shipped shape — `sandbox.js:73-75` gives
   each box its own `clodex-dot` named volume, per-box-keyed (`sandbox.js:198`).
   So NOT reachable today. Latent, and the guard rests on a volume-layout fact
   that lives in a different file from the clause that depends on it.

## Checked and cleared (not defects)

- **kill()+create() respawn race.** `kill()` only signals
  (`session-manager.js:1740-1743`); `_cleanup` runs from `onExit`
  (`session-manager.js:1598`), looks the session up by NAME not identity
  (`:2172`), and rmSyncs the whole run dir (`cli-hooks.js:402`). If a respawn
  landed first, teardown would delete the NEW record and drop the new session
  from the map. It cannot: all three kill+create pairs
  (`engine.js:1264-1265`, `engine.js:1416-1418`, and `ipc-handlers.js:346`) go
  through `waitForSessionExit` (`engine.js:1230-1236`), which spins until the map
  slot frees — and `sessions.delete` is the LAST thing `_cleanup` does (`:2200`),
  after the rmSync. Closed by construction, and `engine.js:1225-1229` records
  that a fixed 300ms sleep here was a real bug once.
- **Teardown ordering fails closed.** `_cleanup` unregisters (`:2197`) before the
  async socket unlink lands, so the window shows "no entry" rather than "entry
  pointing at a live socket". Same at spawn: socket binds (`:1227`) before
  register (`:1230`), so the window shows "no entry", not "entry, no socket".
- **`ctxwarn.sh` is read-only** (`cli-hooks.js:238-243`) — never consumes the
  file. Not a writer.
- **`pending.sh` does not write `run/<name>/`** — the script relocates into the
  run dir but its body targets the SHARED `~/.clodex/pending/<name>`
  (`cli-hooks.js:142-144`, claim at `:207`).
- **`.migrated` marker cannot be mistaken for an agent** — it is a file at
  `run/.migrated`, so `pathFor` yields `run/.migrated/agent.json`, which never
  exists, and `regEntries` skips it (`agent-transport.js:42`).

## Not read, deliberately

Per "read for the question, not for completeness": renderer, plugin host,
peering/, wire/, deploy/undeploy, tunnel supervisor. Confirmed none can write
`run/<name>/` via the `pathFor`/`runDirFor` call-site sweep — those are the only
two path constructors, and every non-test caller is enumerated in audit.md §1.
`tasks/peer-registry/journal.md` (t32) is a DIFFERENT registry axis (GUI peers
vs `cli/contexts.json`) and does not bear on this question.

There is no `t40` audit anywhere in `tasks/` — the "sixteen" figure could not be
traced to a source, which is why §1 recounts from the call graph.
