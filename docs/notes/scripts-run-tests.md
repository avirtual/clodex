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

Its length is capped by the exec dispatcher, which delivers only the LAST
stderr line sliced to 200 chars (`session-manager.js`, `_handleExecIntent`).
Every branch is pinned under that in `test/test-digest-lock.test.js`; the
`[agent:remind in <K>m]` fragment is the half that must survive a cut.
