# remind-scheduler.js

## renameAgent

No `_rearm` after the rewrite, unlike every other mutator here. Only the `agent`
field changes: every record's `nextFireAt` is untouched, so the single timer
armed for the nearest of them is still correct. Re-arming would be harmless but
would claim, to the next reader, that a fire time can move here.
