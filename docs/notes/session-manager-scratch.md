# docs/notes/session-manager-scratch.md

The `[agent:scratch]` half of session-manager.js — split out of
`docs/notes/session-manager.md`, which is at its 120-line cap. Same module.

## _scratchBegin

The mark's `sizeAtBegin` is the first byte of the reply that carried `begin`
(`beginCutAt`: the last assistant message, all of its records when the CLI
split it), so the begin reply, its `turn_duration` and the ack are the first
records dropped and the kept leaf is the user record that reply answered. The
ack's first line must keep starting with `ACK_PREFIX`: the validator proves the
episode opened by finding `ACK_PREFIX + nonce` past `sizeAtBegin`, so a
re-worded first line makes every re-opened episode refuse `ack-missing`. The
re-open note goes on line 2.

The boundary test reads the file, not the record the scanner fired on. Claude
Code 2.1.278 writes one text+tool_use API message as TWO `assistant` records
sharing a `message.id`, and the scanner sees the FIRST — whose `stop_reason` is
already `tool_use` — so "the record I was called for" can never be the test.

## _scratchDeferBegin

On the wire junction the intent fires from the proxy's end-of-message event,
BEFORE the CLI has appended the reply's `end_turn` record: the tail then ends
on the previous prompt or tool_result and `boundaryAt` answers about the wrong
turn. A `behind` tail waits on `fs.watch` of the transcript (the CLI's own
append is the wake), bounded by `SCRATCH_CLOSE_TIMEOUT`, and re-validates. The
CLI writes `turn_duration` a few ms AFTER `end_turn`; a bare `end_turn` also
waits for it while `_flushTurnEnd` is true.

## _scratchRecycle

Move's shape, not `kill()` and not reload. `kill()` removes the persistence
record, fires `_notifyComposition(s, 'retired')` — peers would be told the lead
retired — and stamps a `kill` cost; `exitDisposition({ moving: true })` marks
the exit expected and the renderer keeps the tab. Measured span kill→boot is
about 5 s, which is the number `recycleMs` records per episode.

Measured 21:49:20 → 21:49:34: a MERGED notice parked mid-turn was claimed by
the idle-edge drain's producer at the same turn end that fired the cut, the
seat exited 14 s later, and the text was in neither the cut backup nor the
live transcript — hence `_quiesceInjects` before the kill.

`--resume <id>` is not confined to the transcript's project dir (see the `move`
note), so the respawn reaches the same conversation with `entry.sessionId`
unchanged and the watcher's `onSessionId` takes the adopt branch, never the
clear branch that voids marks.

## _quiesceInjects
Marks the seat `_recycling` (read by the queue's `isDead`, by the idle,
boot-ready and forced drains' guards and producers, and by `_maybeParkDelivery`
as busy), awaits `InjectQueue.settled()`, then parks the hold queue. On the
respawned seat the boot-ready drain (`_bootReadySeen` edge + `BOOT_DRAIN_SETTLE_MS`)
and the briefing (`_injectAfterBoot`: transcript symlink + `RELOAD_CONTINUATION_DELAY`)
share one queue, so enqueue order decides; the drain enqueues first unless the
symlink lands more than 1.75 s before the mode-2004 edge, so the re-parked
delivery normally precedes the briefing, not the other way round.

## _parkHeldInjects

Runs BEFORE the kill, because the in-memory `_injectQueue` is what the kill
loses. Producer entries (`typeof e.produce === 'function'`) are left in place —
they claim from disk already, and parking them would deliver twice. A park that
throws keeps its entry in memory rather than dropping it.

## _runScratchCut

Registered in `this._movingNames` across the whole kill→create span. Without
it an operator Move or Rename during the ≤8 s exit wait plus boot races two
`create()`s under one name, and the loser's `_scratchRestore` copies the full
pre-cut file over a transcript the winner has just resumed from the cut
version. `end` bounces up front when the name is already in that set.

Validation runs TWICE against the same `opts`: once on the live file before
anything is killed, once on the quiet file after. The window the second one
covers is real — the exiting CLI writes `cost-state`, sidecars and, when the
operator compacted at the wrong moment, an `isCompactSummary` record.

The briefing goes through `_injectAfterBoot` with `snapshot: false`: the
`State at resume` block is for a reload, whose seat has no memory; a cut seat
still holds everything up to the mark.

The measurement row is written from a `finally`, so every arm produces one:
refused, failed and cut alike; `_scratchCancel` writes its own. A file holding only successes cannot answer the
question it exists for, which is how often a seat opens an episode it cannot
close.

## _replayScratchArrivals

Fires only after `_injectAfterBoot` returns true. An arrival re-delivered into
a seat that never received its summary reads as a live message with no episode
behind it — the double-action hazard the explicit `replay` modifier exists to
prevent — so a dropped summary means a dropped replay, and the transcript's
`.bak` is what recovers the arrivals in that case (row: `summary-not-injected`,
`replayed` null). Arrivals bypass `_handoffText`: an 800-byte-plus arrival routed
through it arrived as a second `Continue from your handoff` pointer.

## _voidScratchMark

The tombstone is written on the session object, so on any arm that RESPAWNS the
seat it must be copied to the fresh one: `create()` replaces the object, and a
post-reload `end` would otherwise get the bare "no episode is open", which
asserts the seat never opened one.

## _scratchCarryMarks

A named mark survives a cut to L only if its own `ACK_PREFIX + nonce` user
record sits below `cutOffset`: a parked or late ack that landed above it would
leave a mark that can never validate (`ack-missing`), so it is dropped and
logged instead of carried.

## _scratchValidate

A CARRIED older mark sits under the briefing Clodex wrote for the cut that
carried it (`Scratch … result · mark`, or the `Continue from your handoff`
pointer `_handoffText` spills it into), at `offset > a.sizeAtBegin`, and
`classifyUserRecord` calls a plain-string user record that does not start with
`[agent:` an `arrival`. Untreated, the first `rewind a` refuses `arrivals` and
`replay` pastes the dead briefing back as a peer message. The validator is
T-E's and stays untouched, so the wrapper re-validates with `replay: true` when
EVERY arrival is one of `SCRATCH_CUT_TEXT_PREFIXES`, per call (v1 and v2 each
decide for themselves — a real dm that lands in the recycle window must still
abandon), and `_replayScratchArrivals` and the refusal line drop those texts.

## _scratchReArm

The re-arm ack is its own `_injectText` AFTER `_injectAfterBoot` has landed the
briefing: the briefing spills over `SPILL_MIN_BYTES` into a pointer record, so
an ack folded into it would not start with `ACK_PREFIX`. The briefing is the
first record written on the cut file, at `offset === cutOffset` exactly, and
the validator's arrival filter is `offset > cutOffset` — that is what keeps a
second rewind to the re-armed mark from refusing `arrivals` on its own briefing.
