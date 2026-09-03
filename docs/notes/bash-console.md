# bash-console.js

Measured against claude 2.1.259; re-probe before trusting a number here.

## normalizeRecord

The two events this reads carry DIFFERENT shapes, which is why one normalizer
serves both:

- `PostToolUse` — has `tool_response`; `.stdout` already holds stdout and stderr
  MERGED in chronological order (`echo OUT1; echo ERR1 >&2` arrives as
  `"OUT1\nERR1"`), `.stderr` empty. `.stderr` is appended only in case a future
  version splits them.
- `PostToolUseFailure` — fires INSTEAD, for any command with a nonzero exit. It
  has NO `tool_response` key at all: the output is a top-level `error` string of
  the form `"Exit code 1\ncat: /nope: No such file or directory"`, exit code and
  output concatenated. Both events carry the same `tool_use_id`.

A console on `PostToolUse` alone omits the failing commands entirely.

## splitFailure

Parses that concatenated form. A missing `Exit code N` prefix yields
`exitCode: null` with the whole string as output rather than dropping bytes: the
prefix is the CLI's wording, not a guarantee.

## readBashConsole

Reads a DIRECTORY of one-file-per-record (`docs/notes/cli-hooks.md` says why that
shape, not an append). The cursor is the last basename read, not a byte offset:
the writer's fixed-width timestamp makes lexicographic order chronological, so
"newer than" is a string compare. A cursor naming a record the prune deleted
reports `reset` — that reader has a gap it cannot fill.

`tool_response.stdout` is capped at exactly 30000 characters. Past that the payload
gains `persistedOutputPath` (`~/.claude/projects/<slug>/<session>/tool-results/`,
which exists and is retained) and `persistedOutputSize`: `seq 1 20000` gave stdout
of exactly 30000 and a persisted file of 108894 bytes. `truncated` + `fullBytes`
report that honestly. That file is deliberately NOT read: opening an absolute path
out of a payload to render a nicety is a channel this does not need.
