# test/clodex-run-tests-bin.test.js

## mkBranchRepo

The subject `scope own: a root-level policy file is no subject` puts both halves
of the rule in ONE repo, and that is what makes the exclusion DISCRIMINATING: a
root-level non-`.js` edit and a nested one land on the same branch, so a
selector that dropped the bare-name rule and one that dropped literal-path
selection entirely are told apart by a single run. The two-repo version it
replaced proved only an absence in the first and only a presence in the second.

It is also what keeps the subject under `scripts/run-tests.js`'s 6 s bar. The
fixture's wall time is real-git and real-node subprocess work — 5 `git` spawns
and 1 bin spawn per repo, measured at 5.1 s of git against 0.3 s of bin under a
concurrent suite — so two repos put it at 7.3 s loaded against 0.4 s alone.
Halving the repos halves the only term that scales with box load; nothing here
was ever waiting on a clock.

Neither `core.fsync=none` nor an empty `--template=` moved the loaded number
measurably (4.1 s vs 4.3 s for the same work): under contention the cost is
process startup and scheduler queueing, not git's own durability writes.
