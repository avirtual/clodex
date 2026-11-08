# remind-scheduler.js

## renameAgent

No `_rearm` after the rewrite, unlike every other mutator here. Only the `agent`
field changes: every record's `nextFireAt` is untouched, so the single timer
armed for the nearest of them is still correct. Re-arming would be harmless but
would claim, to the next reader, that a fire time can move here.

## fireContextFor

`onctx` records are standing and latched by `armed` (absent reads as true): a
read at or past the threshold delivers only while armed and then sets
`armed:false` (`markArmed`, which also stamps `lastFiredAt`); a read below the
threshold sets it back to true. The latch, not deletion, stops a re-fire on every
ctx read above the threshold. `fireNow` delivers without touching `armed`. Only a
`'gone'` deliver result removes the record.
