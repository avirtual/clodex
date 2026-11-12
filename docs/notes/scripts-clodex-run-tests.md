# scripts/clodex-run-tests.js

## wallShow

The duration on the digest line is THIS wrapper's own spawn time, not a figure
read back from `.test-digest.last`: the two agree on a sweep and diverge on
every refusal, and a duration it did not measure is a number the reader cannot
act on.

On the failing arm it sits BEFORE the names, for the same reason the preserved
path does in `scripts/test-digest.sh`: the line is cut at 180 chars, and it is
precisely the run with the most failing names that overruns the cap, so a
trailing duration would be lost on the runs most worth timing.

## preserve

Writes the same two fixed paths `scripts/test-digest.sh` does, under
`${CLODEX_HOME:-~/.clodex}/test-failures/`. The two are alternative front ends
to the same box's suite — this one the SHIPPED grant
(`resources/library/exec/clodex-run-tests.json`, materialized by
`bin-materialize.js`), the `.sh` one the clodex team's own — so a box can have
both, and they share those paths deliberately: one location is read regardless
of which grant produced the failure.

They cannot collide mid-run against the same checkout. `test-digest.sh` takes
`<root>/.test-digest.lock` itself; this bin does not, but the runner it spawns
takes the same dir via `CLODEX_TEST_LOCK_DIR`, so both serialize on one mutex.

NOT serialized is this bin's own write: the lock belongs to the child, gone by
the time `preserve` runs, so two runs finishing together can publish the same
path. That needs the front ends to resolve different lock roots, which they can
— both take it from cwd — so it is rare rather than impossible.

The staging name carries the writer's pid (`${KEEP}.<pid>.tmp` here,
`$keep.$$.tmp` in `test-digest.sh`), so concurrent writers never share a tmp and
each `rename` publishes one run's whole body. Pid alone is enough: a name is
contended only between live processes, and a pid is unique among those, across
both front ends. A reused pid implies its predecessor is gone and each writer
truncates its tmp, so a leaked name is rewritten, not spliced into. A bounded
name space also leaves the no-cleanup SIGKILL path one file per pid.

Last-writer-wins on the published path survives deliberately: the second run's
dump replaces the first before anyone reads it, the same cost the `.sh` header
records and tolerable for the same reason — a real dump is attributable on sight
from its `# tree:`, `# head:` and `# start:` headers.

The failing arm names the path BEFORE the failing names, even though the names
are the more valuable half: the line is cut at 180 and the file holds every
failing row, so a truncated name is recoverable from it and a truncated path
from nothing. The no-TOTALS arm needs the dump most and has no `Failed tests:`
block, hence the raw tail.

## reexecInMeasured

`${CLODEX_BIN}/clodex-run-tests.js` is a copy stamped at app launch by
`bin-materialize.js`, so a branch changing THIS file would be measured by the
copy it replaced; the runner it spawns was always the measured tree's. Bytes are
compared, never spawned — the identical case is every ticket that does not touch
the wrapper and must cost no extra process. Stdin is read once and handed on;
`CLODEX_RUN_TESTS_REEXEC=1` on the child keeps the chain one hop. A measured
tree with no copy runs here, unchanged.

## lockRefusal

A refusal is answered before the preserved files are touched: it measured
nothing, so preserving overwrites the last real failure and retiring destroys it.

## retireKeep

`rename`, not `unlink`, and on the green arm only. A green run does make the
dump older than the verdict just printed — but the ticket loop re-measures a red
on the SAME commit seconds later, so unlinking there destroys the only account
of why. Neither name reaches the green digest line: both describe a run that is
not the one being reported.

## OWN_SCANNERS

Every entry was opened and confirmed to enumerate the REAL working tree — `git
ls-files`, a `readdirSync` rooted at the repo, or a hardcoded list of live repo
modules it then reads — so any one can go red because of a change ANYWHERE,
including in a file the selection rules below would never reach. A test that
only globs inside a `mkdtemp` fixture belongs nowhere near this list: it cannot
be broken by another file. `test/preserve-across-restart.test.js` and
`test/ssh-keepalive.test.js` read as ordinary behaviour tests and are listed
anyway, each also sweeping `git ls-files '*.js'`; `test/release-script.test.js`
likewise reads the real `CHANGELOG.md`.

## LOCK_BOUND

The FIXED-port binders only. `cli/test/attach.test.js` is the file the lock
rationale in `scripts/run-tests.js` names; `cli/test/transport.test.js` re-binds
a port it picked moments earlier, colliding with a concurrent run that picked
the same one; `test/wirescope-env-gate.test.js` walks a hardcoded 47800+ range.
The many files that bind port 0 are deliberately NOT here: the kernel hands each
run a different port, so they are not the collision the mutex prevents, and
listing them would put nearly every scoped run back behind the box-wide lock.

## subjectMatchers

A test is selected for a changed source by any quoted relative `./`/`../` path
it contains — not just a `require()` target, since a `spawnSync` argv names its
subject too — or by the changed file's repo-relative path appearing literally
(how the source-shape tests name `renderer/renderer.js`). Subjects are every
live non-test path, not only `.js`; a non-`.js` one carries no stem, so both
rules match its full `rel` — except a ROOT-LEVEL non-`.js` name, withheld from
the literal rule because every ticket edits `CHANGELOG.md` and that bare name
made five tests a subject of every branch.

That path is resolved against the TEST's own directory, not anchored as a stem
after `(\.\.?/)+`: that holds only one level below the root, and every one of
the 36 files in `cli/test/` reaches its subject as `require('../src/x')` —
`cli/src/x`, containing no `cli/` at all. Under the stem rule a branch touching
any `cli/src` module selected ZERO cli tests, `cli/test/attach.test.js`, the
file `LOCK_BOUND` exists for, among them.

Both rules are textual, so a subject reached only through a path the reader
assembles — `path.join(__dirname, '..', 'scripts', 'x.js')`, a name built from a
variable — is matched by neither, and no pattern work closes that without
executing the test. Hence `OWN_SCANNERS` unconditionally: the repo-wide checks
are the floor under a selection rule that cannot be complete.
