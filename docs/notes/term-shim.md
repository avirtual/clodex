# term-shim

## REMOTE_INSTALL_LINE

MEASURED CAP, and it is the constraint that shapes the whole line. A pty in
canonical mode accepts at most 1024 bytes per line (MAX_CANON); a longer typed
line is silently TRUNCATED, not wrapped. Measured on this machine against a real
`/bin/dash` over node-pty: 1019 bytes typed round-tripped intact, 1029 produced
no answer at all. The line plus its sacrificial leading space is pinned under
`REMOTE_LINE_MAX` for that reason — the design's first transcription came out at
1268 bytes and would have been cut mid-body on every real host, reaching no
final `printf` and so answering "no answer" instead of a named refusal.

That budget is why the three far helpers (`_cxp`, `_cxb`, `_cxq`) are hoisted to
the top level and shared by both eval bodies rather than written once per body,
and why the names are short. `_cxp` takes the mark letter as `$1`, which is what
lets one function emit both the C and the D.

The top level is POSIX sh so a far dash, busybox ash or ksh PARSES the whole line
and reaches the final `_cxp D "$_cxr"` to answer `2`. That answer is the point:
it lets the refusal say "the remote shell is neither bash 4.4+ nor zsh" rather
than time out. Every shell-specific construct lives inside a single-quoted
`eval` string, which a POSIX shell sees as one word — a bare `precmd_functions=(…)`
at the top level is a dash parse error that rejects the line, D and all.

`\033` and `\007` only, never `\e`/`\a`: POSIX printf guarantees the octal form
and dash prints `\e` literally. The one `\e` is inside bash's static PS0 string,
which bash's prompt decoder interprets rather than printf.

No `!` outside single quotes — interactive bash and zsh history-expand it at
accept time even inside double quotes.

## REMOTE_MARK_TAG

Every far mark carries it. Bytes alone cannot tell a nested shell's marks from
the outer shell's close: the far shell's first precmd emits `D;0 A` exactly like
the local shell's precmd when ssh exits. Untagged marks keep today's meaning
bit-for-bit.

## BASH_BODY

The history rule is the conservative simplification of `BASH_HOOK_SNIPPET`'s:
it names a command only when history is on and both `HISTCONTROL` and
`HISTIGNORE` are empty, so it names strictly fewer commands and never a wrong
one. An unnamed record is still answered through `assumed`.

`command history` rather than `builtin history`: `builtin` is not POSIX, and the
top level must stay parseable by a shell that lacks it.
