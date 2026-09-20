# docs/notes/session-manager-scratch.md

The `[agent:scratch]` half of session-manager.js — split out of
`docs/notes/session-manager.md`, which is at its 120-line cap. Same module.

## _scratchBegin

The mark's `sizeAtBegin` is captured BEFORE the ack is enqueued, and the ack's
first line must keep starting with `ACK_PREFIX`: the validator finds the cut
point by searching for `ACK_PREFIX + nonce`, so a re-worded first line makes
every re-opened episode refuse `ack-missing`. The re-open note goes on line 2.

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
CLI writes `turn_duration` a few ms AFTER `end_turn`; a mark taken between the
two leaves the `turn_duration` past `sizeAtBegin`, so the cut's kept-set leaf
is not `mark.leafUuid` and every end refuses `leaf-mismatch` — hence a bare
`end_turn` also waits while `_flushTurnEnd` is true.

## _scratchRecycle

Move's shape, not `kill()` and not reload. `kill()` removes the persistence
record, fires `_notifyComposition(s, 'retired')` — peers would be told the lead
retired — and stamps a `kill` cost; `exitDisposition({ moving: true })` marks
the exit expected and the renderer keeps the tab. Measured span kill→boot is
about 5 s, which is the number `recycleMs` records per episode.

`--resume <id>` is not confined to the transcript's project dir (see the `move`
note), so the respawn reaches the same conversation with `entry.sessionId`
unchanged and the watcher's `onSessionId` takes the adopt branch, never the
clear branch that voids marks.

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
