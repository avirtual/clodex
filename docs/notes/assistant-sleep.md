# assistant-sleep.js

## composeBrief

A null brief (no prose rows) leaves the previous `brief.md` in place: the seat's SessionStart context re-serves it after a compact, so a sleep with nothing new does not erase what the last one wrote.

## briefPathFor

The brief lives in the seat dir, not `run/<name>/`, so it survives the exit that every sleep is; `removeSeat` drops it with the seat.
