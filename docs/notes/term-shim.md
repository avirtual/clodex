# term-shim

## REMOTE_INSTALL_LINE

MEASURED CAP, and it shapes the whole line. A pty in canonical mode accepts at
most 1024 bytes per line (MAX_CANON, the BSD/macOS value; Linux allows 4096), and
a longer typed line is silently TRUNCATED. Measured against a real `/bin/dash`
over node-pty: 1019 bytes round-tripped intact, 1029 produced no answer at all.
`REMOTE_LINE_MAX` pins 1019, the measured-good figure rather than 1024, so the
untested 1020–1028 band cannot be grown into. A faithful transcription of the
design came out at 1268 bytes: cut mid-body on every real host, reaching no final
`printf`, so the refusal would degrade to "no answer".

That budget is why the three helpers (`_cxp`, `_cxb`, `_cxq`) are hoisted to the
top level and shared by both eval bodies, and why the names are short. It is also
why they use `command printf` rather than the `builtin printf` the design
specified: `builtin` is not POSIX and the top level must parse in a far dash. In
zsh `command` forces an EXTERNAL printf, so each far mark costs a fork — accepted
for the bytes, worth revisiting if far-side latency matters.

The top level is POSIX sh so a far dash, ash or ksh PARSES the line and reaches
`_cxp D "$_cxr"` to answer `2`, which is what lets the refusal name the far shell
instead of timing out. Shell-specific constructs live inside single-quoted `eval`
strings, seen as one word — a bare `precmd_functions=(…)` at the top level is a
dash parse error that rejects the line, D and all. A far dash does keep the three
helpers defined; what it installs is no HOOKS, so no further marks are emitted.

`\033`/`\007` only: POSIX printf guarantees the octal form and dash prints `\e`
literally. The one `\e` is in bash's static PS0, which bash's prompt decoder
interprets rather than printf. No `!` outside single quotes — interactive bash and
zsh history-expand it even inside double quotes.

## REMOTE_MARK_TAG

Every far mark carries it. Bytes alone cannot tell a nested shell's marks from
the outer's close: the far shell's first precmd emits `D;0 A` exactly like the
local shell's precmd when ssh exits. Untagged marks keep today's meaning.

## BASH_BODY

The history rule is the conservative simplification of `BASH_HOOK_SNIPPET`'s: it
names a command only when history is on and both `HISTCONTROL` and `HISTIGNORE`
are empty, so it names strictly fewer commands and never a wrong one. An unnamed
record is still answered through `assumed`.

## remoteUnsupportedReason

THE FAR-SHIM POSTURE, and why there is no file to point at. The far shim is two
functions and two hook arrays in the far shell's MEMORY, typed in the clear as
one line and gone when the session ends. Nothing is written on any box — not the
operator's, not a third party's — which is the whole reason the design needs no
helper script: per-session in-memory hooks answer the exit code and the output
completely. The local shim already does the same to the local shell through
ZDOTDIR; this is that intrusion one hop away, and `exit` reverses it.

What each far shell answers the line with, measured in
test/term-remote-shell.test.js against real ones rather than derived here:

- zsh (any) and bash 4.4+ — `D;0`, hooks installed; the session is drivable.
- bash below 4.4, `/bin/sh` on macOS — `D;3`: no PS0, so no preexec.
- dash, ash, ksh, busybox — `D;2`: the POSIX top level parses and answers, which
  is what lets the refusal NAME the shell instead of timing out.
- fish, PowerShell, cmd, a REPL, a shell not at its prompt — no answer at all,
  refused on `INSTALL_TIMEOUT_MS`.
- anything else, or a payload that did not parse — the status is quoted back and
  nothing is claimed about what is on the far end.

The gate above all of it is `terminalRemote === 'on'` AND reporting not `off`
(engine.js `remoteAllowed`): remote mode hands the agent a session the operator
authenticated to, so it is its own consent and no upgrade or other pref grants
it. Reporting `off` bars it because the LOCAL shell is then unshimmed and there
are no marks to nest under.
