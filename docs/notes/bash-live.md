# bash-live

Notes for `bash-live.js`. Facts the code cannot state; everything provable by a
test lives in `test/bash-live.test.js` instead.

## `tasksDirFromScratchpad` / `tasksDirFor`

The CLI's tasks dir comes from the hook payload's `scratchpad_dir` (its sibling),
never from `os.tmpdir()`. On macOS the two disagree: `TMPDIR` is
`/var/folders/<hash>/T` while the CLI writes tasks under `/private/tmp`.
Deriving it shipped a watcher pointed at a directory that did not exist, through
three cold reviews and a green suite. `tasksDirFor` survives only as a fallback
for a payload with no `scratchpad_dir`.

## `psArgvEncode` / `argvNeedle`

`ps` does not print argv raw. Measured byte-exactly with xxd on macOS 15: `\n`
prints as the four characters `\012`, `\t` as `\011`, other bytes below 0x20 as
caret notation, 0x7f as `^?`. Backslash is NOT escaped, so the encoding is not
injective and decoding it is ambiguous -- `a\012b` and a real newline print
identically. Encoding the known command forward is exact, which is why the
needle is built that way round; normalising whitespace on both sides instead
cannot match any multi-line command.

Ownership is fd 1: the child shell's stdout IS the `.output` file, verified with
`exec 9>&1; lsof -a -p $$ -d 9 -Fn`.

## `defaultResolveOwners`

`lsof -p <list>` exits 1 when ANY pid in the list has already gone -- the normal
case on an ~800-process box, since short calls come and go between the `ps` and
the `lsof`. Treating that status as failure discards every read and the feature
produces nothing; the pids that did resolve are on stdout regardless. Narrowing
on the `ps` output first took 786 pids to 1 and the probe to ~67ms, against
~160ms for a single `lsof <file>`.
