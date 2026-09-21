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

One row, `pending/`: the seat kinds moved out to `seat-layout.js` `renameSeat`,
called just above this loop, and `pending/` is permanently exempt from the seat
layout (`docs/notes/seat-layout.md`).

`library/exec/<name>.json` was never in it, and is the entry a reader is likeliest
to add: that dir is the exec COMMAND registry, keyed by command id and shared by
every seat, not per-seat state. Moving it breaks the command for every seat
granted it.

## rename

The open-ticket refusal reads the board directly instead of relying on
`_openTicketsFor` alone. That helper filters on `ticketStarted`, so a QUEUED
ticket — assigned to the seat by name, never started — passes it, and the rename
strands the ticket naming an assignee nothing answers to. The direct read is
unioned with the helper so the role-resolved and started cases it covers are kept.

## reapFromSnapshot

TWO guards, and the ORDER matters: ownership is checked before discovery is even
consulted, because the sign of a pid says nothing about whose it is.

`ptyOwnership` is the primary one: a pty we spawned is always a DIRECT child of
this process, so `ppid === ownerPid` proves it, read from the same snapshot the
walk uses — no second `ps`, no new seam. Only `ours` reaps; `foreign` warns and
reaps nothing; `gone` is silent (an exited pty is the ordinary teardown race).
The sign-only version took the operator's laptop down twice: `pid: 1` is POSITIVE,
passes every `> 0` check, and launchd parents the machine — 542 of 543 processes,
measured, and `killAll` would do it once per seat. `test/term-marks-bash.test.js`
pins the ppid assumption against a real node-pty, because if node-pty ever puts a
helper in between, every reap silently becomes a no-op.

`sigkillPid`'s `> 0` refusal is the second, applied to every discovered pid
individually — never a group, never a negated pid, never a command-line match.

Must run BEFORE `pty.kill()`, and that ordering carries both guards: the kernel
reparents the pty's children to init the moment it exits, where `walkPtyTree`
does not follow, and the pty's own row is what the ownership proof needs.

`ownerPid` defaults to `process.pid`, correct for all three call sites (all in the
engine, which spawns every pty). Safe rather than a trap because it fails CLOSED
both ways: the wrong answer is always `foreign`/`gone` — reap nothing, plus a log
line — never a wider blast radius.

## kill

The 5-second backstop `setTimeout` is armed SYNCHRONOUSLY, before the
`await reapPtyDescendants(...)`, with `ptyPid` hoisted for the same reason.
Fixtures mock `setTimeout`, call `kill()` un-awaited, and end their turn — so a
backstop armed a few microtask hops later races the runner's `mock.reset()`, and
when the reset wins a REAL five-second timer is armed on a fixture pid.

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

## _handleShoutIntent

The DEPLOY OK self-archive sends `session:context-action` `retired` BEFORE `archive()`: archive kills the pty, and the renderer rebuilds a row as archived only for a name already stamped into `archivingSessions`. Sent late or not at all, the row is REMOVED. Precedent: `team-tickets.js` retire.

## refreshPrompt

At a `/clear` the CLI has already minted the new conversation id, and both the new
`<sid>.jsonl` and the repointed `run/<name>/transcript.jsonl` are row-less for the next 2-8 s
(`prompt_snapshot` rows land after the intent — docs/notes/ipc-prompt-cache.md), while the new
session's rows carry the PRIOR session's last block. So the clear site hands `refreshPrompt` the
prior id (`opts.sid`), and `_snapshotBlockFor` reads `<account>/projects/<slug>/<priorSid>.jsonl`.
A `--fork-session` seat reaches the same edge on its first id (its `sessionId` starts as the
parent's), and the parent's transcript is not what the child runs after a `mint`, so `session.forked`
gates that one edge to the child's own id and is cleared there. The account dir comes from
`session.accountDir` (the merged env create() resolved) before the persisted `entry.env`, which
misses a template- or account-sourced `CLAUDE_CONFIG_DIR`.
