# cli-hooks.js

## setupClaudeHook

The Bash-console hook writes ONE FILE PER RECORD, claimed by atomic rename, and
that shape is load-bearing rather than tidy.
The CLI fires Bash hooks CONCURRENTLY — two hook pids overlapped for their entire
13ms window. The first version appended to a shared JSONL in two writes (body,
then newline) and lost records: four concurrent writers left 1/20 parseable at
400-BYTE payloads, so the CLI's 30000-char cap does not bound it. Bodies
concatenate into one unparseable line, and the loss is SILENT because the reader
skips a line failing `JSON.parse`. `printf '%s\n' "$(cat)"` as a single write is
the obvious fix and is NOT sufficient (12/40 intact — a ~35KB append is not atomic
on APFS either); spool-plus-rename measured 10/10 trials fully recoverable.

`date +%s%N` is a GNU / FreeBSD-14.1 extension, NOT POSIX: an older `date` echoes
`%N` literally, the name becomes `<secs>N-<pid>.json`, the reader's grammar
rejects it, the cursor never advances, and the pane repaints the same few calls
forever. The guard is a builtin `case` on non-digits falling back to whole seconds
padded to 19 — no interpreter, no second subprocess. It is invisible on any box
this was built on: the README floor is macOS 12 and `%N` works on every macOS
here.

The `.tmp.<pid>` sweep must be `kill -0`-GUARDED. A bare `rm -f "$D"/.tmp.*`
deletes the spool a CONCURRENT writer is still filling, between its `cat >` and
its `mv -f`: through this generated script, 12 writers x 10 trials, the bare sweep
lost 44 of 120 records and the guarded one 0 of 120 — the shared-append defect
above, reintroduced by the cleanup for it.

The prune is a record COUNT, not a byte cap: a byte cap needs a rotation, and a
rotated generation is write-only unless the reader spans both — which the first
version did not, so half the retained data was unreachable. Bash expands the glob
in sorted order and the stamps are fixed-width, so the oldest sort first and no
`sort`/`head` subprocess runs on the hot path. Paths stay quoted: an unquoted
`rm $(...)` word-splits on a space in the path.

Hooks are FAIL-OPEN: one pointing at a nonexistent script leaves the Bash call
working and the model still gets its output. `CLAUDE_CODE_SHELL_PREFIX` is the
opposite, measured FATAL — a missing prefix script failed every Bash call in the
session AND killed the SessionEnd hook. Never add one.
