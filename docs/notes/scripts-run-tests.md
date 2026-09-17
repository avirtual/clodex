# scripts/run-tests.js

## LAST

`.test-digest.last` holds the last COMPLETED sweep's wall time as one decimal
line of milliseconds, and `scripts/test-digest.sh` reads and writes the same
file in the same format — the two entry points share one mutex, so they share
one answer to how long a run here takes. Derived from `LOCK`, not from `ROOT`,
so the `CLODEX_TEST_LOCK_DIR` override moves both together.

Absent, zero or unparsable all mean UNKNOWN. A recorded 0 would be
indistinguishable from no recording, which is why `recordRunMs` floors at 1.

## napAdvice

Rounds up and adds a spare minute: waking early costs the caller another full
refusal at the price of its whole context, waking late costs idle time. With no
recording the suite length is left out of the refusal entirely rather than
guessed — a stated estimate is acted on exactly as if it were measured.

## recordRunMs

Called only for a SWEEP that reached a summary. A named-file run is a fraction
of the suite and this repo's own tests spawn dozens of them, so recording those
would collapse the estimate to seconds within one suite run.

## acquireLock

The refusal's `running <M:SS>` comes from the pid file's mtime: every entry
point writes that file at acquisition, so it dates a holder this process never
launched just as well as one it did.

The line is ~330 chars and is NOT delivered whole: the exec dispatcher hands
back only the LAST stderr line sliced to 200 (`session-manager.js`,
`_handleExecIntent`). Only the half up to `END YOUR TURN.` is guaranteed —
`scripts/clodex-run-tests.js` cuts there and `clodex-run-tests-bin.test.js`
pins that under 200. So the `[agent:remind in <K>m]` fragment must stay before
that boundary, and the `kill … && rm -rf` remediation — for a human at a
terminal, not a seat — after it.

## sweeping

`CLODEX_TEST_LOCK=1` forces the same acquisition a sweep takes, for a run that
NAMES files and still reaches the port-binding tests — the scoped path in
`scripts/clodex-run-tests.js` sets it when its selected set intersects that
wrapper's `LOCK_BOUND`. It is scrubbed from `childEnv` beside the other two lock
variables: a nested runner is by contract a different run, and one that
inherited the declaration would block on the lock its parent already holds.

## SLOW_MS

The per-test duration gate. A test point over `SLOW_MS` (6000; `CLODEX_TEST_SLOW_MS`
overrides it, for the gate's own pins) fails the run unless `test/slow-tests.json`
names it, and an allowlist entry matching no point in the run is stale and fails
too — the stale check runs only on a sweeping run, because a named-file run cannot
see every test.

FILE-level TAP points are discounted before the threshold, by the same
`fs.existsSync(path.resolve(ROOT, name))` rule the filter block uses: node
flattens a test file away and reports it as a point of its own only when it
contributed no executed test, and then it is named by its path. Without that
discount every file whose tests sum past six seconds reads as one slow test.

Offenders print twice, and both spellings are load-bearing: the `SLOW:` block on
stdout is what a human reads, and the ` ✖ <name> (<ms>ms)` lines on stderr are
what `scripts/clodex-run-tests.js` parses with its `NAME_RE` to put the offender
into its one-line digest — that wrapper reads only `TOTALS:` and `✖` names.

Files that spawn sweeping runners of their own against throwaway roots, and so
must not inherit this process's lock variables: `test/test-digest-lock.test.js`,
`test/run-tests-args.test.js`, `test/run-tests-slow-gate.test.js`. The comment
above `childEnv` in the source names the first two; the list lives here because
the suite's comment ratchet refuses new comment lines.
