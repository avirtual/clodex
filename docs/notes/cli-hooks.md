# cli-hooks.js

## setupClaudeHook

The Bash-console hook writes ONE FILE PER RECORD, claimed by atomic rename, and
that shape is load-bearing rather than tidy.

The CLI fires Bash hooks CONCURRENTLY — measured, two hook pids overlapped for
their entire 13ms execution window. The first version of this hook appended to a
shared JSONL in two writes (body, then newline) and lost records: four concurrent
writers left 1/20 parseable at 400-BYTE payloads, so it is not a large-output edge
case and the CLI's own 30000-char cap does not bound it. Bodies concatenate into
one unparseable line, and the loss is SILENT because the reader skips a line that
fails `JSON.parse`.

`printf '%s\n' "$(cat)"` as a single write is the obvious fix and is NOT
sufficient: 12/40 intact, because a ~35KB append is not atomic on APFS either.
Spool-plus-rename measured 10/10 trials with everything recoverable.

The prune is a record COUNT, not a byte cap. A byte cap needs a rotation, and a
rotated generation is write-only unless the reader spans both — which the first
version did not, so half the retained data was unreachable. Bash expands the glob
in sorted order and the timestamps are fixed-width, so the oldest sort first and
no `sort`/`head` subprocess runs on the hot path. Every path stays quoted: an
unquoted `rm $(...)` word-splits on a space in the path.

Hooks are FAIL-OPEN: one pointing at a nonexistent script leaves the Bash call
working and the model still gets its output. `CLAUDE_CODE_SHELL_PREFIX` is the
opposite, measured FATAL — a missing prefix script failed every Bash call in the
session AND killed the SessionEnd hook. Never add one.
