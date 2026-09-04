# bash-live

Notes for `bash-live.js`. Facts the code cannot state; everything provable by a
test lives in `test/bash-live.test.js` instead.

## `tasksDirFromScratchpad` / `tasksDirFor`

The tasks dir comes from the payload's `scratchpad_dir` (its sibling), never
from `os.tmpdir()`: on macOS `TMPDIR` is `/var/folders/<hash>/T` while the CLI
writes under `/private/tmp`. It is also realpath'd, because `lsof` reports the
resolved form and `/tmp` is a symlink.

## `psArgvEncode` / `argvNeedle`

`ps` does not print argv raw. Measured byte-exactly with xxd on macOS 15: `\n`
prints as the four characters `\012`, `\t` as `\011`, other bytes below 0x20 as
caret notation, 0x7f as `^?`. Backslash is NOT escaped, so the encoding is not
injective and decoding it is ambiguous -- `a\012b` and a real newline print
identically. Encoding the known command forward is exact, which is why the
needle is built that way round.

Ownership is fd 1: the child shell's stdout IS the `.output` file, verified with
`exec 9>&1; lsof -a -p $$ -d 9 -Fn`. Through a PTY a bare `ps -ax` truncated a
3000-char argv to 72 characters, hence `-axww`.

## `defaultResolveOwners`

`lsof -p <list>` exits 1 when ANY pid in the list has already gone -- the normal
case on an ~800-process box -- and the pids that did resolve are on stdout
regardless. Narrowing on the `ps` output first took 786 pids to 1.

## `assign`

Dedupes on the FILE, not the pid: a subshell that forks without exec'ing keeps
its parent's argv, and both pids then hold fd 1 on the same `.output`.

The argv needle is the command TEXT, so N calls with byte-identical text (what
subagent fan-out produces) share one needle and cannot be told apart by it. They
are separated instead by pairing `startedAt` ascending against file creation
time ascending, and only when the counts match exactly.

Creation time is `birthtimeMs`. Measured on this box (macOS 15, APFS): 200
consecutive pairs of files written back to back were all strictly ordered by
`birthtimeMs`, whose resolution is sub-millisecond (fractional ms). `mtimeMs` is
a FALLBACK only, for a filesystem that reports no birthtime, and it is a worse
discriminator for the reason its name gives -- the CLI keeps writing to the
`.output` file for the whole call, so mtime tracks the last write and its
ordering is the order the calls last PRODUCED output, not the order they
started. On a real run those two orders differ routinely.

Each
probe is ~26ms of SYNCHRONOUS work on the Electron main thread, so
`PROBE_BACKOFF_MS` stops a never-resolving call paying that twice a second
(measured 5.2% -> 0.30% duty cycle over a 5-minute window).
