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
