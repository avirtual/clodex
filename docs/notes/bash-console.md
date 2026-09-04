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
The scan is `stampOf(f) >= stampOf(cursor)`, re-serving the cursor's whole
timestamp group INCLUDING the cursor's own record; each record carries its
basename as `key` so the tenant drops what it already drew, and the cursor never
regresses or that group repeats forever.

Excluding the cursor file from that re-serve is what a reader written for
"incremental" naturally does, and it repaints. The tenant REPLACES its `lastKeys`
from each raw batch rather than accumulating, so a file left out of the batch
falls out of the dedupe set and is redrawn by the next poll that re-serves its
group — measured A-B-A over four polls on one shared stamp, and 3 duplicates in
48 records through the real hook under a `%N`-less `date`.

`RECORD_NAME_RE` is exported because `ipc-handlers.js` validates an incoming
cursor with it — two literals could drift into rejecting every cursor written.
`skipped` exists because the cursor advances past a backlog the pull could not
carry; unreported, that is a console silently missing the commands it is for.

A `tool_response` carrying `backgroundTaskId` has EMPTY `stdout` and `stderr`:
the CLI auto-backgrounds Bash calls under parallel load and their output never
reaches the hook at all (23 such responses across every transcript on the
author's box, 23 empty). Unrecoverable here — `backgrounded` exists so the pane
can say so rather than draw a block that read as "this printed nothing".

`tool_response.stdout` caps at exactly 30000 chars; past it the payload gains
`persistedOutputPath` and `persistedOutputSize` (`seq 1 20000`: stdout 30000,
persisted file 108894 bytes). That file is deliberately NOT read: opening an
absolute path out of a payload for a nicety is a channel this does not need.
