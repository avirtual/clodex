# bash-live

Notes for `bash-live.js`: facts the code cannot state. Provable ones are tests instead.

## `tasksDirFromScratchpad` / `tasksDirFor`

The tasks dir comes from the payload's `scratchpad_dir` (its sibling), never from
`os.tmpdir()`: on macOS `TMPDIR` is `/var/folders/<hash>/T` while the CLI writes under
`/private/tmp`. Realpath'd too: `lsof` reports the resolved form, `/tmp` is a symlink.

## `psArgvEncode` / `argvNeedle`

`ps` does not print argv raw. Measured byte-exactly with xxd on macOS 15: `\n` prints
as the four characters `\012`, `\t` as `\011`, other bytes below 0x20 as caret
notation, 0x7f as `^?`. Backslash is NOT escaped, so the encoding is not injective and
decoding it is ambiguous -- `a\012b` and a real newline print identically. Encoding the
known command forward is exact, which is why the needle is built that way round.
Ownership is fd 1: the child shell's stdout IS the `.output` file, verified with
`exec 9>&1; lsof -a -p $$ -d 9 -Fn`. Through a PTY a bare `ps -ax` truncated a 3000-char
argv to 72 characters, hence `-axww`.

## `defaultResolveOwners`

`lsof -p <list>` exits 1 when ANY pid in the list has already gone -- the normal case on
an ~800-process box -- and the pids that did resolve are on stdout regardless. Narrowing
on the `ps` output first took 786 pids to 1.

## `assign`

Dedupes on the FILE, not the pid: a subshell that forks without exec'ing keeps its
parent's argv, and both pids then hold fd 1 on the same `.output`. Calls with identical
command text share one needle and are paired to files by start order instead. Creation
time is `birthtimeMs`, strictly ordered across 200 back-to-back pairs measured here
(macOS 15 APFS, sub-ms resolution). `mtimeMs` is a fallback for a filesystem with no
birthtime, and a worse key: the CLI writes for the whole call, so mtime orders calls by
their last output, not their start.

Each probe is ~26ms of SYNCHRONOUS work on the Electron main thread, so
`PROBE_BACKOFF_MS` stops a never-resolving call paying that twice a second (5.2% ->
0.30% duty cycle measured over 5 minutes).
