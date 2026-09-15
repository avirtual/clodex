# docs/notes/session-manager.md

## writeBundles

`writeBundlePlugins` and `getPluginBundles` are taken BOTH-or-NEITHER: a partial
deps object (a test, the plugin harness) supplying only the catalog read would
call an absent writer, which throws before any `args.push` and surfaces as a
spurious operator-facing warning about scaffolding. Same asymmetry as `tiersOf`,
and the safe direction is the same — contribute nothing.

## move

`--resume <id>` is NOT confined to the transcript's project directory. Measured
against the real `claude` binary (Claude Code 2.1.261, 2026-09-07): a conversation started in
one directory resumed successfully from an unrelated one, replaying 27,717 cached
tokens, with the transcript left under the ORIGINAL project dir. So a moved seat
keeps its conversation and no transcript is copied. An id that does not exist
anywhere is a different case — the CLI prints "No conversation found with session
ID: <id>" and exits nonzero, which happens AFTER `create()` has returned, so a
move cannot detect a bad resume id and report it.

## _renameDirs

`run/<name>/` is absent from the list on purpose. `cleanupClaudeHook` rm -rf's it
on every exit path, including the kill `rename` performs, and `create()` rebuilds
it under the new name — so moving it would race a delete that is already running.

`library/exec/<name>.json` is absent for the opposite reason, and it is the one a
reader is likeliest to add back: that directory is the exec COMMAND registry,
keyed by command id and shared by every seat, not per-seat state. Moving it on a
rename breaks the command for every seat granted it.

## rename

The open-ticket refusal reads the board directly instead of relying on
`_openTicketsFor` alone. That helper filters on `ticketStarted`, so a QUEUED
ticket — assigned to the seat by name, never started — passes it, and the rename
strands the ticket naming an assignee nothing answers to. The direct read is
unioned with the helper so the role-resolved and started cases it covers are kept.

## reapFromSnapshot

Every discovered pid is signalled INDIVIDUALLY through `sigkillPid`, whose `> 0`
refusal is the whole safety property — never a process group, never a negated pid,
never a command-line match. `process.kill` reads a non-positive pid as a broadcast
(-1 = every process the user may signal, 0 = our own process group), and a reaper
walks a whole tree, so it multiplies that blast radius by every pid it finds. The
guard's own header carries the incident: a fixture's `pid: -1` once SIGKILLed ~277
processes three times over, swallowed by a bare `catch {}`.

Must run BEFORE `pty.kill()`. A descendant is found by its ppid chain back to the
pty, and the kernel reparents the pty's children to init the moment it exits —
where `walkPtyTree` deliberately does not follow. Run after the kill, the snapshot
is empty exactly when there was something to reap.

## psSnapshotSync

Sync, and for `killAll` alone. engine.js's `shutdown()` is synchronous and no
caller awaits it, so on the quit path an `await` yields to an event loop the
process is about to leave: the pty kills would be scheduled and never run.
Blocking the main thread for one `ps` at quit is the cost of the kills happening
at all. `killAll` takes that ONE snapshot before the first pty dies — a per-seat
`ps` would read a table the earlier kills had already emptied.

## reapPtyDescendants

The measured failure: `pty.kill()` signals the pty and nothing under it, so a CLI
that spawned a test runner leaves that runner alive when the seat dies. Two
`node --test` processes were found at ~98% CPU each, reparented to init, an hour
after the run nobody was waiting for. One carried a `timeout 300` wrapper that had
been orphaned too, so its five-minute kill never fired — the wrapper survived, its
enforcement context did not. Both ignored SIGTERM.

SIGKILL with no SIGTERM grace, which is the opposite of the pty's own path. The
pty gets five seconds because a CLI flushes its transcript on SIGTERM and that
write is wanted. A descendant has no such contract: the measured orphans ignored
SIGTERM outright, a grace period would delay every teardown by seconds, and
anything still standing when its seat is torn down is by construction something
nobody is waiting on.

Nothing in this codebase deliberately outlives its seat, which is what makes an
unconditional reap safe. Established by sweeping every `detached: true` in
production source: `wirescope-supervisor.js`, `tunnel-supervisor.js`,
`team-tickets.js`'s merge-gate runner and `scripts/clodex-monitor.js`'s daemon are
all spawned by the ENGINE process, so none is a descendant of any seat's pty.
`clodex-monitor` is the one mechanism designed to survive the thing that asked for
it, and an agent requests it only as a text marker on stdout — `_handleExecIntent`
does the spawning from the engine, and the watcher additionally `setsid`s itself,
so the whole chain is a SIBLING of the seat's pty rather than a child. The things
that genuinely do run under a seat's pty are the CLI's hook and statusline scripts
(`cli-hooks.js`), all synchronous one-shots.

That sweep is also why discovery must stay keyed on pty-descendancy and never on
a process group or session id: the monitor daemon and the wirescope proxy occupy
their own groups deliberately, and a sweep keyed on anything the seat shares with
the engine would reach them.
