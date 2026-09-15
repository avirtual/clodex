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

## preserve

Writes the same two fixed paths `scripts/test-digest.sh` does, under
`${CLODEX_HOME:-~/.clodex}/test-failures/`. The two scripts are alternative
front ends to the same box's suite — this one is the SHIPPED grant
(`resources/library/exec/clodex-run-tests.json`, materialized by
`bin-materialize.js`), the `.sh` one is what the clodex team's own grant runs —
so a box can have both, and they share those paths deliberately: an agent reads
one location regardless of which grant produced the failure.

They cannot collide mid-run against the same checkout. `test-digest.sh` takes
`<root>/.test-digest.lock` itself; this bin does not, but the runner it spawns
takes the same dir via `CLODEX_TEST_LOCK_DIR`, so both serialize on one mutex.

What is NOT serialized is this bin's own write: the lock belongs to the child,
which has exited by the time `preserve` runs, so two runs finishing together can
publish the same path. That needs the two front ends to resolve different lock
roots, which they can — both take it from cwd — so it is rare rather than
impossible.

The staging name carries the writer's pid (`${KEEP}.<pid>.tmp` here,
`$keep.$$.tmp` in `test-digest.sh`), so concurrent writers never share a tmp and
what each `rename` publishes is one run's whole body. Pid alone is enough:
a name is only contended between processes that are alive at the same time, and
a pid is unique among those — across both front ends, which draw from the same
OS namespace. A reused pid implies its predecessor is gone, and each writer
truncates its tmp and writes it whole, so a successor inheriting a leaked name
rewrites it rather than splicing into it. A bounded name space also means the
SIGKILL path, which runs no cleanup, leaves at most one file per pid rather than
littering the directory the way a random suffix would.

What survives deliberately is last-writer-wins on the published path: the second
run's dump replaces the first before anyone reads it. That is the same accepted
cost the `.sh` header records for a second tree's failure clobbering the first,
and it is tolerable for the same reason — a whole dump from a real run is
attributable on sight, because its `# tree:`, `# head:` and `# start:` headers
name the run that produced it.

The failing arm names the path BEFORE the failing names, even though the names
are the more valuable half: the line is cut at 180, the file holds every failing
row itself so a truncated name is still recoverable from it, and a truncated
path is recoverable from nothing. The no-TOTALS arm carries the least
information of the three and so most needs the dump; it has no `Failed tests:`
block to section, hence the raw tail.

## lockRefusal

A refusal is answered before anything touches the preserved files, because it
measured nothing: preserving there would overwrite the last real failure with
the text of a run that never started, and retiring would destroy it outright.

## retireKeep

`rename`, not `unlink`, and on the green arm only. A green run does make the
dump older than the verdict just printed — but the ticket loop re-measures a red
on the SAME commit seconds later, so unlinking there destroys the only account
of why the re-measure happened. Neither name reaches the green digest line: both
describe a run that is not the one being reported.
