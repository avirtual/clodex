# remind-scheduler.js

## renameAgent

No `_rearm` after the rewrite, unlike every other mutator here. Only the `agent`
field changes: every record's `nextFireAt` is untouched, so the single timer
armed for the nearest of them is still correct. Re-arming would be harmless but
would claim, to the next reader, that a fire time can move here.

## fireContextFor

`onctx` records are removed after delivery, never re-armed: a seat that compacts
drops under the threshold and climbs past it again, and a standing record would
re-fire on every ctx read above it. Re-arming is the agent's job (a fresh
`[agent:remind on context …]`). `fireNow` removes them for the same reason.
