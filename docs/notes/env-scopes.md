# docs/notes/env-scopes.md

## withUtf8Charset

A GUI process launched from Finder/Dock inherits launchd's environment, which
carries no `LANG`, `LC_ALL` or `LC_CTYPE`. macOS `pbcopy` with no charset in its
env transcodes stdin as the legacy Mac encoding for the SYSTEM language before
writing the pasteboard: measured, `printf 'te\xc5\xbc' | env -i pbcopy` puts
`≈º` (mac_roman) on an English Mac and `Ňľ` (mac_latin2) on a Polish one, while
`env -i LC_CTYPE=UTF-8 pbcopy` writes the bytes unchanged (gh #10).

`LC_CTYPE=UTF-8` and not `LANG`: it is what Terminal.app sets, it is a valid
locale name on every macOS, and it fixes pbcopy on its own without guessing a
language. Any operator-set charset wins, including a deliberate non-UTF-8 one
(`LC_ALL=C`) — that choice is theirs, so the helper returns the env untouched
when ANY of the three keys is present rather than only when LC_CTYPE is.

## DENY_KEYS
CLAUDE_CODE_RESUME_INTERRUPTED_TURN is denied so no scope can make every seat auto-continue a turn; session-manager.js sets it itself only on the crash-resume of an exitedAt-stamped claude entry (measured on claude 2.1.286, tasks/resume-interrupted-measure/MEASURE.md).
