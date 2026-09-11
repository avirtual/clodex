# scripts/clodex-run-tests.js

## wallShow

The duration on the digest line is THIS wrapper's own spawn time, not a figure
read back from `.test-digest.last`: the two agree on a sweep and diverge on
every refusal, and a line reporting a duration it did not measure is a number
the reader cannot act on.

On the failing arm it sits BEFORE the names, for the same reason the preserved
path does in `scripts/test-digest.sh`: the line is cut at 180 chars, and it is
precisely the run with the most failing names that overruns the cap, so a
trailing duration would be lost on exactly the runs most worth timing.
