# Registry unification — quiescent-window audit

**Branch** `registry-audit`, off master `261b0ab`. **Audit only** — no code
changed, no implementation spec proposed.

**The question:** does a quiescent window exist for the agent registry, on the
real call graph?

**The answer: no.** Not "no, unless we add a lock" — no, and one of the writers
that kills it is a bash script the app does not spawn, fired by the Claude CLI
on a cadence the app cannot serialize. A stop-the-world sweep behind a marker
file would be a race, and the marker would not be the thing that failed.

Three corrections to the dispatch's premises are load-bearing and appear in §1,
§2 and §3 respectively: the count is not sixteen, the second process is a reader
and not a writer, and the third process class — the one that actually kills the
window — is missing from the framing.

---

## 1. Write-site inventory

### 1a. What "the registry record" is

`clodex-paths.js:56` — the registry entry is kind `registry` = **`agent.json`**,
inside the per-agent dir `run/<name>/` (`clodex-paths.js:104-106`). The socket
`agent.sock` (`clodex-paths.js:57`) is a **separate filesystem object** in the
same dir, and an agent is visible only if *both* resolve plus its pid is alive
(`agent-transport.js:74-78`).

The count depends on which of these you mean, so both are given. **Neither is
sixteen**, and there is no `t40` audit anywhere in `tasks/` to reconcile against
— the figure could not be traced, so this is a recount from the call graph, not
an inheritance.

### 1b. Narrow reading — sites that create or delete `agent.json`

**7 call sites**, through 4 primitives. All in the engine host process.

| # | Site | Operation | Primitive |
|---|---|---|---|
| 1 | `session-manager.js:1230` | create | `registry.register` |
| 2 | `session-manager.js:1242` | delete | `registry.unregister` |
| 3 | `session-manager.js:1244` | create (retry after force-clean) | `registry.register` |
| 4 | `session-manager.js:2197` | delete (teardown) | `registry.unregister` |
| 5 | `cli-hooks.js:402` | delete, recursive | `rmSync(runDirFor(...))` |
| 6 | `cli-hooks.js:406` | delete, recursive | `rmSync(runDirFor(...))` |
| 7 | `engine.js:1724` | delete, N entries | `registry.cleanup` |

Sites 5 and 6 are worth naming explicitly: `cleanupClaudeHook` and
`cleanupCodexHook` delete the registry record **without going through the
registry API at all** — they `rmSync` the whole `run/<name>/` dir recursively.
`cli-hooks.js:395-400` documents this as deliberate and idempotent against
`registry.unregister`. Any unification that swaps the registry's storage while
leaving these two `rmSync` calls pointed at a directory will silently keep
deleting the old thing and stop deleting the new one.

Underlying filesystem mutations inside those primitives:
`agent-transport.js:56` (tmp write), `:58` (`linkSync` → `agent.json`), `:60`
and `:64` (tmp unlink), `:68` (unlink), `:94` (unlink).

### 1c. Wide reading — every writer of anything under `run/<name>/`

This is what a unification actually migrates. **38 sites across 2 process
classes.**

**Engine host** — `main.js:92` (Electron) or `headless-main.js:52` (plain Node).
Same `createEngine`, same `REGISTRY_DIR`; either can be the host, and §3 shows
nothing stops both from being it at once.

| # | Site | Writes |
|---|---|---|
| 1 | `agent-transport.js:49` | `ensureDir run/<name>/` |
| 2 | `agent-transport.js:56` | `agent.json.tmp.<pid>` |
| 3 | `agent-transport.js:58` | `agent.json` (link) |
| 4-5 | `agent-transport.js:60`, `:64` | tmp unlink |
| 6 | `agent-transport.js:68` | `agent.json` unlink |
| 7-8 | `agent-transport.js:94`, `:95` | `agent.json` + `agent.sock` unlink |
| 9 | `agent-transport.js:113` | `agent.sock` unlink (pre-bind) |
| 10-11 | `agent-transport.js:128`, `:129` | `agent.sock` bind + chmod |
| 12 | `agent-transport.js:140` | `agent.sock` unlink (stop) |
| 13 | `session-manager.js:1222` | `ensureDir` |
| 14 | `session-manager.js:1243` | socket unlink (stale force-clean) |
| 15-16 | `session-manager.js:1441`, `:1442` | `ctxwarn` write / remove |
| 17 | `session-manager.js:2256` | `file-heat.json` |
| 18 | `session-manager.js:3723` | `acks` append |
| 19 | `cli-hooks.js:37` | `ensureDir` |
| 20 | `cli-hooks.js:42` | `hook-digest.json` (atomic) |
| 21 | `cli-hooks.js:49` | `ensureDir` |
| 22 | `cli-hooks.js:70` | `hook-output.json` |
| 23 | `cli-hooks.js:95` | `hook.sh` |
| 24 | `cli-hooks.js:97` | `statusline.sh` |
| 25-26 | `cli-hooks.js:106`, `:107` | `attn.jsonl` truncate + `attn.sh` |
| 27 | `cli-hooks.js:120` | `acks.sh` |
| 28 | `cli-hooks.js:154` | `pending.sh` |
| 29 | `cli-hooks.js:235` | `ctxwarn.sh` |
| 30 | `cli-hooks.js:331` | `ensureDir` (codex) |
| 31 | `cli-hooks.js:348` | `hook-output.json` (codex) |
| 32-33 | `cli-hooks.js:402`, `:406` | `rmSync run/<name>/` recursive |
| 34 | `engine.js:523` | `statusline.sh` rebuild, all live sessions |

**Hook-script processes** — bash, spawned by the **Claude/Codex CLI**, not by
the app. The app authors these scripts; it does not invoke them and cannot
serialize them.

| # | Site (script body) | Writes | Fired by |
|---|---|---|---|
| 35 | `cli-hooks.js:86-87` | `transcript.jsonl` **relink** (`ln -sf` + `mv -f`) | SessionStart |
| 36 | `cli-hooks.js:109` | `attn.jsonl` append | Notification hook |
| 37 | `cli-hooks.js:126` | `acks` truncate | UserPromptSubmit |
| 38 | `statusline.js:79` | `ctx` write | statusline refresh |

Site 35 is the "relinks" case in the dispatch's phrasing, and it is done
correctly — `ln -sf` to a tmp name then `mv -f` is an atomic rename. It is also
done **from a process the app did not start**.

### 1d. Not writers — checked and cleared

- `scripts/clodex-team.js` — **zero** write calls. Reads `run/<agent>/agent.json`
  at `:49`, `readdirSync(run)` at `:134`. Pure reader.
- `scripts/clodex-monitor.js` — reads the registry at `:49`; writes only under
  `~/.clodex/monitors/<agent>/` (`:37-45`). Different subtree.
- `cli/` (clodexctl) — never touches `~/.clodex/run`. Speaks HTTP to the web
  host; persists only `~/.clodex/cli/contexts.json`.
- `pot-cli.js:37-39` — reads `run/*/file-heat.json`. Reader.
- `ctxwarn.sh` (`cli-hooks.js:238-243`) — reads, never consumes.
- `pending.sh` — the *script* lives in `run/<name>/`, its *body* targets the
  shared `~/.clodex/pending/<name>` (`cli-hooks.js:142-144`, claim at `:207`).
- Renderer, plugin host, `peering/`, `wire/`, deploy/undeploy, tunnel
  supervisor — none construct a `run/<name>/` path. `pathFor` and `runDirFor`
  are the only two constructors and every non-test caller is above.

---

## 2. Triggers, and which are under app control

The column that decides the question is the last one.

| Site(s) | Trigger | Control |
|---|---|---|
| 1-3, 13, 19-31 (spawn path) | session create / restore | **App** — serialized by `manager.create` |
| 6, 12, 32-33 (teardown) | PTY `onExit` (`session-manager.js:1598`) | **App** — but see §5.2 |
| 7-8 (`registry.cleanup`) | engine bootstrap, `engine.js:1724` | **App**, once per host start |
| 14 (stale force-clean) | EEXIST on register, `session-manager.js:1233` | **App** |
| 15-16 (`ctxwarn`) | ctx tick, driven by `fs.watch` on the run dir (`session-manager.js:1472`) | **External** — see below |
| 17-18 (`file-heat`, `acks`) | agent tool use / memory mutation | **External** — agent-driven |
| 34 (statusline rebuild) | user saves preferences | **External** — user action, hits every live session |
| **35 (transcript relink)** | **Claude CLI SessionStart** | **External** |
| **36 (attn append)** | **Claude CLI Notification hook** — a permission dialog opening | **External** |
| **37 (acks truncate)** | **Claude CLI UserPromptSubmit** | **External** |
| **38 (ctx write)** | **Claude CLI statusline refresh** | **External** |

Sites 35-38 are external in the strongest sense available: the app does not
spawn the process, does not know when it will run, and has no channel to defer
it. The Claude CLI decides. A statusline refresh (38) fires continuously while
an agent works.

Site 15-16 deserves its own note, because it shows the two classes are not even
separable. The app's ctxwarn write is triggered by `fs.watch` on
`runDirFor(REGISTRY_DIR, name)` (`session-manager.js:1472`), watching for the
`ctx` file that a **hook process** wrote (site 38). So: hook process writes into
the record dir → the app wakes on the inotify/FSEvents edge → the app writes
back into the record dir. There is a cross-process feedback loop inside
`run/<name>/`, running continuously, on a cadence set outside the app.

**Any one of 35-38 is sufficient to answer the question.** They are not
edge-triggered rarities; they are the normal operation of a working agent.

---

## 3. THE VERDICT

### A quiescent window does not exist.

Stated as the disqualifier: **stop-the-world behind a marker file is dead as an
option.** Not because the marker is weak — because there is no moment at which
the writer set is empty, so there is nothing for a marker to mark.

Read-both / write-new is the only honest shape, despite its cost.

Four independent reasons, any one of which is fatal:

**(1) Nothing locks `~/.clodex`.** `main.js:491` is
`app.requestSingleInstanceLock()` — Electron-only, keyed on the Electron app
identity / userData. `headless-main.js:119-134` is a pidfile under
**userDataPath**, with stale-pid takeover. Two different mechanisms, both keyed
on userData, **neither keyed on `~/.clodex`**. An Electron app and a headless
host on one machine share `~/.clodex` and exclude each other by nothing.

The codebase already knows this. `session-manager.js:184`, reasoning about
registration staleness, says: *"a genuinely-other Clodex sharing `~/.clodex`"*.
The multi-host configuration is contemplated in the very comment that depends on
it.

**(2) The hook processes are not the app's to quiesce.** Sites 35-38. Even if
you froze every engine host on the machine, the Claude CLI keeps running and its
hooks keep writing into `run/<name>/`. There is no handle to hold.

**(3) An unlocked cross-process read-modify-write is already accepted here
today.** `cli-hooks.js:113-115`, verbatim:

> Read+truncate isn't atomic against a concurrent append — an ack landing in
> that window is lost, which the channel tolerates (success acks are
> bookkeeping).

The main process appends to `run/<name>/acks` (`session-manager.js:3723`); the
generated `acks.sh` truncates it (`cli-hooks.js:126`) from a hook process. This
is a documented, deliberate, unlocked cross-process race inside the record dir,
shipping now. The question "can a write fire while a sweep runs" is not
hypothetical for this directory — the answer is already written down in a
comment, and it is yes.

**(4) The `legacy-sweep` precedent is weaker than the dispatch allows, in a way
that cuts against reuse.** The correction received — that legacy-sweep is safe
by single-process quiescence, not by the marker — is right, but it understates
the real reason. legacy-sweep's target set is the **old flat grammar**
(`clodex-paths.js:81-101`), and **no current writer writes those paths at all.**
Its safety is: the target set is *write-dead*, and *additionally* it runs at
bootstrap. That is two properties, and the load-bearing one is the first.

Registry unification has **neither**. Its target set is the live record, written
by 38 sites across 2 process classes, 4 of them on triggers the app does not
own. Leaning on legacy-sweep means inheriting a safety argument whose actual
premise does not transfer.

### If someone later claims the window exists

The claim would have to name a mechanism. The only candidates in the tree are
the two locks in reason (1), and both are keyed on userData rather than on
`~/.clodex`. **Changing either lock to key on `~/.clodex` would still not
create the window**, because reasons (2) and (3) are about processes those locks
were never able to reach. That is the argument to reach for if the question
comes back: the missing lock is not the binding constraint.

---

## 4. What atomicity the current layout already gives

`agent-transport.js:56-64` writes `agent.json.tmp.<pid>` then `fs.linkSync` to
the final path.

**What this protects against:** a reader never observes a partially-written
`agent.json`. `link(2)` publishes the fully-written inode under its final name
in one step, so `listPeers`' `JSON.parse` (`agent-transport.js:75`) cannot see a
truncated object. The tmp name carries the writer's pid, so two concurrent
registrants cannot collide on the staging file.

**What it does not protect against — five things, and the migration needs all
five stated:**

1. **It is create-only, not replace.** `link(2)` fails `EEXIST` when the target
   exists and never overwrites; both catch branches rethrow
   (`agent-transport.js:61-62`). So `register` is not "last writer wins" — it is
   "second writer throws". The recovery lives entirely in the **caller**
   (`session-manager.js:1233-1250`), not the primitive. A unification that
   reimplements `register` with a plain atomic *replace* silently changes the
   concurrency semantics from "refuse" to "clobber", and the caller's
   `isStaleRegistration` gate becomes dead code that no longer guards anything.

2. **No consistent multi-file view.** `listPeers` (`agent-transport.js:71-82`)
   loops over `regEntries()` reading one file at a time. There is no snapshot.
   A reader in another process — `clodex-team.js:134` does exactly this — can
   observe agent A present and agent B absent when both were live throughout.
   **A per-file atomic write is not a consistent multi-file view**, and this
   layout has exactly the former.

3. **No atomicity between `agent.json` and `agent.sock`.** Two separate objects,
   created and destroyed by separate calls, and *both* are required for
   visibility (`agent-transport.js:76`). Every transition passes through a state
   where one exists and the other does not. Ordering makes those windows fail
   *closed* — socket binds at `session-manager.js:1227` before register at
   `:1230`; unregister at `:2197` runs before the un-awaited async socket unlink
   at `:2196` — so a reader sees "not there yet" rather than "there but broken".
   That is a property of the **call ordering**, not of the atomic write, and it
   is not enforced anywhere. Reordering those two lines during a migration would
   be invisible in review and would flip both windows to fail-open.

4. **No protection against a concurrent unlink.** Nothing coordinates
   `regEntries()`' `readdirSync` with a `cleanup` or `rmSync` running elsewhere.
   `listPeers` swallows the resulting `ENOENT` in a bare `catch {}`
   (`agent-transport.js:79`) — the entry silently vanishes from the result.

5. **The `regEntries` comment overstates the guard.** `agent-transport.js:35-36`
   says it skips "half-written tmp files". It does not: it iterates
   `readdirSync(RUN_DIR)`, which yields per-agent *directory* names, while the
   tmp files live one level deeper and are never enumerated. Harmless today —
   but it reads as a documented safety property, and a migration that flattens
   the layout so tmp files *do* land in the scanned namespace would "preserve"
   a guard that was never implemented.

---

## 5. Already broken today under concurrency

Three findings. The first needs no concurrency at all, which is why it leads.

### 5.1 — pid-recycle ghost: a dead agent reads as live, and wedges its own name

**Single-process reachable. No second writer required.**

`isAlive` is a bare `process.kill(pid, 0)` (`agent-transport.js:25-27`). The
registry records `pid` (`agent-transport.js:54`) and nothing else identifying —
no start time, no boot id, no token.

After an unclean shutdown (crash, SIGKILL, power loss), `agent.sock` **survives**
— it is only ever unlinked by `Transport.stop` (`agent-transport.js:140`),
`cleanup` (`:95`), or the pre-bind unlink (`:113`), none of which ran. So the
record is left naming a dead pid, with its socket file still on disk.

The OS then recycles that pid. On macOS pids wrap around ~99999, so this is
ordinary within one laptop uptime, not an exotic case.

Consequences, all following from the same two lines:

- **Bootstrap cleanup keeps it.** `engine.js:1724` → `agent-transport.js:93`
  tests `!fs.existsSync(info.socket) || !isAlive(info.pid)`. Socket exists, pid
  "alive" → entry retained. The one mechanism that exists to reap stale entries
  is precisely blind to this one.
- **The ghost is advertised as a live peer.** `listPeers` returns it
  (`agent-transport.js:76`), so it appears in `[agent:who]`
  (`session-manager.js:3019`).
- **DMs to it fail silently.** `getPeer` resolves (`session-manager.js:2905`) to
  a stale socket path; `Transport.send` gets ECONNREFUSED and resolves `false`
  (`agent-transport.js:157`) rather than raising.
- **The name is wedged.** Starting the real session hits EEXIST;
  `isStaleRegistration(existingPid, ownPid, isAlive)`
  (`session-manager.js:186-188`) returns `false` — the pid is alive and is not
  ours — so `session-manager.js:1247-1249` throws *"Session X is already running
  elsewhere (pid N)"*. There is no recovery path in the app. The user must
  delete `run/<name>/agent.json` by hand, and nothing tells them that.

The root cause is that the record has no way to distinguish the process that
registered from a later squatter on the same pid.

### 5.2 — `cleanup` TOCTOU deletes live entries and unlinks live sockets

**Cross-process.** `registry.cleanup` (`agent-transport.js:88-101`) reads the
entry at `:92`, then unlinks `agent.json` at `:94` and `info.socket` at `:95`,
with **no re-validation between read and unlink**.

Given the socket path is derived from the name and is therefore stable across
re-registration: if host B re-registers `<name>` with a live pid after host A's
`cleanup` read the old entry but before it unlinks, then A deletes **B's live
registry entry** and unlinks **B's live socket**.

The failure mode is the bad one. B's `net.Server` is still listening on the
unlinked inode, so B has no error, no event, no way to notice. Its agent is
simply unreachable forever — dials get ECONNREFUSED against a path with nothing
bound. Silent unreachability, not visible death.

The same shape exists on the stale-recovery path at
`session-manager.js:1242-1243`: read at `:1236`, decide at `:1241`, then
`unregister` + `unlinkSync(existing.socket)` — with an `await`-free but
still-interleavable gap against another host.

This is exactly the race a stop-the-world sweep would introduce at scale, and it
is instructive that the codebase already contains it in miniature.

### 5.3 — `isStaleRegistration`'s same-pid clause is a shared-volume landmine

**Not reachable today. Recorded because it is one config change from live.**

`session-manager.js:186-188` treats `existingPid === ownPid` as stale. This is
deliberate and correct for its stated purpose — `session-manager.js:179-183`
explains that Docker gives the engine the same pid every boot, so a surviving
`agent.json` always names the new engine itself and a bare `isAlive` check would
wedge restore forever.

But the clause is unconditional. Two engines that share one `~/.clodex` *and*
have equal pids would each read the other's **live** registration as stale and
force-clean it — `unregister` + `unlinkSync(existing.socket)` at
`session-manager.js:1242-1243`, against a running agent.

I checked whether the shipped Docker shape allows it: **it does not.**
`sandbox.js:73-75` gives each box its own `clodex-dot` named volume, and
`sandbox.js:198` keys volume/network/container namespaces off the box id, so two
boxes never share a `~/.clodex`. `/home/clodex/.clodex` is additionally a
reserved mount target (`sandbox.js:57`) that a user bind mount may not shadow.

So this is latent, not live. It is recorded because the guard's safety rests on
a volume-layout fact asserted in `sandbox.js` while the clause that depends on
it lives in `session-manager.js`, with no cross-reference in either direction —
and a unification is exactly the kind of change that would touch one and not the
other. The desktop half of the reasoning
(`session-manager.js:183-184`: *"Desktop is unaffected — a genuinely-other
Clodex sharing ~/.clodex never has our pid"*) is sound and stays sound.

### Checked, and not a defect

**The `kill()` + `create()` respawn race is closed.** Worth recording because it
looks open. `kill()` only signals (`session-manager.js:1740-1743`); `_cleanup`
runs from `onExit` (`:1598`), looks the session up **by name, not identity**
(`:2172`), and `rmSync`s the whole run dir (`cli-hooks.js:402`). If a respawn
landed before that teardown, `_cleanup` would tear down the **new** record and
drop the new session from the map at `:2200`.

It cannot happen: all three `kill`+`create` pairs — `engine.js:1264-1265`,
`engine.js:1416-1418`, `ipc-handlers.js:346` — go through `waitForSessionExit`
(`engine.js:1230-1236`), which spins until the map slot frees, and
`sessions.delete` is the **last** statement in `_cleanup` (`:2200`), after the
`rmSync`. The ordering is load-bearing and undocumented at `:2200`.
`engine.js:1225-1229` records that a fixed 300 ms sleep here was a real bug that
"lost the session entirely" — so this is a fix someone already paid for.

**A migration that reorders `_cleanup`, or adds a fourth `kill`+`create` caller
without `waitForSessionExit`, reopens it.** That is the single most fragile
invariant found in this audit, and it is protected by nothing but call-site
discipline.
