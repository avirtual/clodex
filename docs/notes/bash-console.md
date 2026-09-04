# bash-console.js

Measured against claude 2.1.259; re-probe before trusting a number here.

## normalizeRecord

Two vendor shapes; built for only the first, a console omits every failure:
- `PostToolUse` — has `tool_response`; `.stdout` already holds stdout and stderr
  MERGED chronologically (`echo OUT1; echo ERR1 >&2` arrives as `"OUT1\nERR1"`)
  and `.stderr` is empty, appended only against a future version splitting them.
- `PostToolUseFailure` — fires INSTEAD for any nonzero exit, with NO
  `tool_response`: output is a top-level `error` string like
  `"Exit code 1\ncat: /nope: No such file or directory"`. Same `tool_use_id`.

A `tool_response` with `backgroundTaskId` has EMPTY `stdout`/`stderr`: the CLI
auto-backgrounds under parallel load and that output never reaches the hook (23
such responses across every transcript here, 23 empty). `backgrounded` says so.

`stdout` caps at exactly 30000 chars; past it the payload gains
`persistedOutputPath`/`persistedOutputSize` (`seq 1 20000`: 30000 vs 108894
bytes). It is NOT read — opening an absolute path out of a payload is unneeded.

## splitFailure

A missing `Exit code N` prefix yields `exitCode: null` and keeps the whole
string: the prefix is the CLI's wording, not a guarantee.

## readBashConsole

"Newer than" is NOT a plain `>`. Where `date` has no `%N` the writer falls back
to whole seconds, so a second's records share one stamp ordered only by pid and
`f > cursor` drops every tie below it. The scan re-serves that whole group
INCLUDING the cursor's own record — excluding it is what "incremental" means, and
it REPAINTS, since the tenant's dedupe set is replaced per batch (A-B-A measured;
3 duplicates in 48 records).

`RECORD_NAME_RE` is exported because `ipc-handlers.js` validates an incoming
cursor with it — two literals could drift into rejecting every cursor written.
`skipped` exists because the cursor advances past a backlog the pull could not
carry, unreported a console missing the commands it exists for.
