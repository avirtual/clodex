# bash-console.js

Measured against claude 2.1.260; re-probe before trusting a number here.

## normalizeRecord

Two vendor shapes; built for only the first, a console omits every failure —
`PostToolUse` has `tool_response`, whose `.stdout` already holds stdout and
stderr MERGED chronologically (`echo OUT1; echo ERR1 >&2` → `"OUT1\nERR1"`) with
`.stderr` empty, appended only against a version splitting them.
`PostToolUseFailure` fires INSTEAD for any nonzero exit, with NO `tool_response`:
output is a top-level `error`, `"Exit code 1\ncat: …"`.

A `tool_response` with `backgroundTaskId` has EMPTY `stdout`/`stderr` (7 here on
2.1.260, 7 empty; 23 on 2.1.259): the CLI auto-backgrounds under parallel load,
that never reaches the hook, and PostToolUseFailure does not fire for one — so
output AND exit code both come from the task file. `stdout` otherwise caps at
30000 chars, past which come `persistedOutputPath`/`Size` (`seq 1 20000`: 30000
vs 108894); NOT read, being unlinked at completion where the background file is
the opposite case and persists.

## bgOutputPath

The task output is a SIBLING of `scratchpad_dir`, `<proj>/<session>/tasks/<id>.output`,
7/7 here. The id is the only interpolated segment; all 993 here are 9 chars of
`[a-z0-9]`, checked 1-32. `readBgOutput` strips the `[exited with code N]` trailer
as framing, taking its code when PRESENT. Absence proves nothing — a killed or
truncated task writes none either (`bkan8wpac.output`: 49KB, finished, no
trailer) — so `bgExitSeen` is named for what was seen, not liveness. Tail, not
head. A 0-byte read from a non-empty stat is a shrink under that offset,
reported absent, not as silence.

## readBashConsole

"Newer than" is NOT a plain `>`. Where `date` has no `%N` the writer falls back
to whole seconds, so a second's records share one stamp ordered only by pid and
`f > cursor` drops every tie below it. The scan re-serves that whole group
INCLUDING the cursor's own record (A-B-A measured, 3 dupes in 48 records).
`RECORD_NAME_RE` is exported because `ipc-handlers.js` validates an incoming
cursor with it — two literals could drift into rejecting every cursor written.
