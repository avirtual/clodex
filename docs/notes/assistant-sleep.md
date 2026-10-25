# assistant-sleep.js

## composeBrief

A null brief (no prose rows) leaves the previous `brief.md` in place: the seat's SessionStart context re-serves it after a compact, so a sleep with nothing new does not erase what the last one wrote.

## briefPathFor

The brief lives in the seat dir, not `run/<name>/`, so it survives the exit that every sleep is; `removeSeat` drops it with the seat.

## pickMaxAwakeVictim

The cap is per template (`sleep.maxAwake` on the record at wake, on the template at a wire create); a busy row is never a victim. `null` at the cap answers `503 { error: 'at capacity', retryAfterMs: 30000 }`, a constant the game may ignore. The evicted seat sleeps with `sleepReason: 'evicted'`, beside `idle`, `operator` and the client's own reasons.
