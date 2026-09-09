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

## _armBootNudge

The defect it repairs, measured twice on 2026-09-09 (13:19 and 14:50 reboots):
the reboot notice parked for the `clodex` seat was drained at boot and sat in
the composer with its Enter rendered as a newline. On a `--resume` replaying a
large transcript the readline loop comes up AFTER BOOT_DRAIN_SETTLE_MS, so the
whole write is read as one paste chunk and the trailing `\r` lands as content.
`inject-queue.js` names this race for a virgin seat; a resumed seat is the
common case, and nothing downstream detects it — the operator pressed Enter by
hand.

Armed from the inject queue's WRITE, not from `_drainPendingAtBootReady`'s
enqueue. That is what makes ONE timer cover both boot writers: the drain and
the `_replayTicketsOnce` that follows it in the same deferred callback go
through this one queue, and a producer that claimed nothing writes nothing —
so "something reached the pane" is the exact condition, with no second hook in
`team-tickets.js`. `_bootNudgeArmed` makes it one-shot per boot per seat,
whichever wrote first.

`_bootDrainAt` bounds it to the boot window: past `INJECT_BOOT_MAXWAIT` an
ordinary dm is being written into a seat whose input loop has long been up, and
its Enter needs no help.

The fire path writes the raw pty rather than `enqueue`, because the queue's
quiet gate would defer this write for up to `INJECT_QUIET_MAXWAIT` — which is
the one thing it must not do. Pty output inside `BOOT_NUDGE_QUIET_MS` means the
resume render is still painting and an Enter into that is the same race one
layer on, so it re-arms instead, capped from the write so a seat that never
goes quiet gives up silently. On an empty composer a bare `\r` is a no-op in
Claude Code, so an over-fire (the unit DID submit and its turn already ended)
costs nothing; the log line is what lets the rate be measured.

Not gated on `--resume`: a virgin seat gets the same cover and there is no
second branch.
