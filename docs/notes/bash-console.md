# bash-console.js

Measured against claude 2.1.260; re-probe before trusting a number here.

## normalizeRecord

Two vendor shapes; built for only the first, a console omits every failure:
- `PostToolUse` — has `tool_response`; `.stdout` already holds stdout and stderr
  MERGED chronologically (`echo OUT1; echo ERR1 >&2` → `"OUT1\nERR1"`), `.stderr`
  empty, appended only against a version splitting them.
- `PostToolUseFailure` — fires INSTEAD for any nonzero exit, with NO
  `tool_response`: output is a top-level `error`, `"Exit code 1\ncat: …"`.

A `tool_response` with `backgroundTaskId` has EMPTY `stdout`/`stderr` (7 here on
2.1.260, 7 empty; 23 on 2.1.259): the CLI auto-backgrounds under parallel load
and that never reaches the hook, nor does PostToolUseFailure fire for one — so
its output AND its exit code both come from the task file.

`stdout` caps at 30000 chars; past it come `persistedOutputPath`/`Size` (`seq 1
20000`: 30000 vs 108894). NOT read: unlinked once the call completes, where the
background task's file is the opposite case and persists.

## bgOutputPath

`scratchpad_dir` is `<base>/<proj>/<session>/scratchpad`; the task output is its
SIBLING `<base>/<proj>/<session>/tasks/<id>.output`, resolved 7/7 here. The id is
the only caller-influenced segment: all 993 distinct ids here are 9 chars of
`[a-z0-9]`, and the check is a wider 1-32.

The `[exited with code N]` trailer `readBgOutput` strips is framing, not output;
its ABSENCE tells a running task from a finished one (120 files here, 56 carried
it). Tail, not head: the end holds the trailer and the newest output. Unreadable
reports absent, never throws — inside `console:read` a throw loses the batch.

## readBashConsole

"Newer than" is NOT a plain `>`. Where `date` has no `%N` the writer falls back
to whole seconds, so a second's records share one stamp ordered only by pid and
`f > cursor` drops every tie below it. The scan re-serves that whole group
INCLUDING the cursor's own record (A-B-A measured, 3 dupes in 48 records).
