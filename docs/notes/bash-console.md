# bash-console.js

Measured against claude 2.1.259; re-probe before trusting a number here.

## normalizeRecord


One normalizer, two vendor shapes:
- `PostToolUse` — has `tool_response`; `.stdout` already holds stdout and stderr
  MERGED chronologically (`echo OUT1; echo ERR1 >&2` arrives as `"OUT1\nERR1"`)
  and `.stderr` is empty, appended only against a future version splitting them.
- `PostToolUseFailure` — fires INSTEAD for any nonzero exit, with NO
  `tool_response`: output is a top-level `error` string like
  `"Exit code 1\ncat: /nope: No such file or directory"`. Same `tool_use_id`.

A console on `PostToolUse` alone omits every failing command.

## splitFailure

A missing `Exit code N` prefix yields `exitCode: null` and keeps the whole
string — the prefix is the CLI's wording, not a guarantee.

## readBashConsole

"Newer than" is NOT a plain `>` on the basename. Where `date` has no `%N` the
writer falls back to whole seconds, so a second's records share one stamp ordered
only by pid, and `f > cursor` silently drops every tie sorting below the cursor.
The scan is `stampOf(f) >= stampOf(cursor)` excluding the cursor itself, re-serving
its timestamp group; each record carries its basename as `key` so the tenant drops
what it already drew, and the cursor never regresses or that group repeats forever.

`RECORD_NAME_RE` is exported because `ipc-handlers.js` validates an incoming
cursor with it — two literals could drift into rejecting every cursor written.
`skipped` exists because the cursor advances past a backlog the pull could not
carry; unreported, that is a console silently missing the commands it is for.

`tool_response.stdout` caps at exactly 30000 chars; past it the payload gains
`persistedOutputPath` and `persistedOutputSize` (`seq 1 20000`: stdout 30000,
persisted file 108894 bytes). That file is deliberately NOT read: opening an
absolute path out of a payload for a nicety is a channel this does not need.
