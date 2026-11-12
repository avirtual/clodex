# Test doctrine

The test rules this repo follows, with the cases that produced them. Read this
before arguing with one of them.

A test can fail to reach the state it names and still pass every assertion.
Seven instances so far; what made most of them silent was the assertion shape,
not the mistake. The first three rules follow from that; the next two are about
the pins themselves.

## Assert the whole built object

Where a fixture builds a dependency set, assert the whole object. A partial
match reads around a missing seam: an unwired dep arrives as `undefined`, and
`undefined / 60` is legal arithmetic yielding `NaN` that a regex happily matches
around. `deepStrictEqual` on the built object catches it on the first run — that
is the only reason two of the seven failed loudly.

## Assert the interesting row survived a reduction

Where a test reduces before asserting, assert the interesting row survived the
reduction — the `ENTER: …` idiom, used widely across the suite. A reducer sits
between the code and every assertion downstream, so one pattern that drops the
row under test vacuums out an unbounded number of assertions at once, and the
suite stays green over a case nothing exercised. The risk is concentrated where
the downstream assertions are absences or universals (`deepEqual(x, [])`,
`length === 0`, `.every(…)`): all of those are true of an empty set.

## Table rows carry literal values

Where a table drives one assertion across many cases, each row must carry the
value that distinguishes it as a literal. An expectation whose per-row value the
test computes by the rule the code under test uses asserts only that the code
agrees with itself — one expression true of every case, the way a loose regex is
true of every arm of a branch. That leaves the table structurally incapable of
expressing an exception, which is the whole reason to write one.

There was a real exception — `bun test` is a reserved subcommand that shadows
`scripts.test` — and the computed table matched the buggy output on every row:
the suite stayed green and only a reader caught it. Interpolating a shared
sentence around a hardcoded per-row value is fine; re-applying the code's rule
to produce that value is not.

## A comment claiming coverage is not coverage

A comment that says a path is pinned — naming the file that pins it — reads as
verification to the next agent deciding whether that path is safe to change,
and unlike a stale comment about behaviour it cannot be checked by reading the
code it sits next to.

One in `session-manager.test.js` claimed the dirty and unreadable downgrade
directions were "pinned against REAL trees" in a named file; the dirty one was,
the unreadable one was pinned nowhere in 6,433 tests, and the branch it left
unguarded flips the common "tree already removed by hand" case from
retire-and-drop-the-record to archive-and-keep-it. Grep for the claim before
trusting it, and when writing one, grep first: the claim and the test must land
in the same commit or the comment is asserting the author's intention.

## Grep for the pins on a file before adding behaviour

The rule above runs in the other direction too, and the other direction is the
one that bites an author rather than a reader. A source-shape pin asserts a
property of the source that no runtime fixture can prove — "no raw unlink
survives outside the guard", "every process.kill takes a bare identifier" — so
it is invisible from the code you are editing and from the test names you would
think to run. Discovering it by running the suite means discovering it after you
have reasoned your way to a change it forbids.

An unlink was once added to `wirescope-supervisor.js` on the reasoning that a
successor could never own a corrupt record; `wirescope-env-gate.test.js` pinned
that exact shape, and it was right — the record is a snapshot, and a successor
can write between the read and the unlink. The pin caught a flaw in the
reasoning, not a typo.

## Not a quota

None of these is a blanket requirement, and there is no `ENTER:` count to
satisfy — a ratchet on a count measures compliance, not coverage.

## A spawned child always carries a timeout

A test that spawns node, bash or claude and waits on its exit passes a
`timeout` (with `killSignal: 'SIGKILL'`) or arms a kill timer. A wedged child
otherwise hangs the whole suite, not the one test. t1470 gave every hook spawn
in `cli-hooks.test.js` a 30s SIGKILL timeout, so its ARG_MAX drain case now
fails as one ETIMEDOUT test instead of stalling the run.

## A slow test is timed on its own before it fails

A test over six seconds fails the run unless `test/slow-tests.json` lists it; a slow
test is re-timed alone before it fails the run, so a loaded box does not fail a
green branch.

## Scratch directories live under one root

The suite mints its scratch directories under `$TMPDIR/clodex-suite`, through
`mkTmpRoot` in `test/lib/tmp-roots.js`. `scripts/tmp-sweep.sh` removes that
root's stale children by age. A new test needs no registration.

## Do not build scratch on the ambient temp when the code gates on its shape

`tmp-sweep-behavior.test.js` mints under `getconf DARWIN_USER_TEMP_DIR` (`mkTmpRoot(prefix, base)`), because the script refuses a `TMPDIR` outside `/var/folders/…/T` and a runner job's `TMPDIR` is not one.

## Name the branch in a fixture repo

A fixture that later says `master` or `main` runs `git init -b <name>`: Apple's packaged git config sets `init.defaultBranch=main`, so a bare `git init` names a different branch on another machine.

## Never read the developer's home or login

A test that needs a login or config file builds a fixture home and passes it through the seam the code takes (the muse seats in `session-manager.test.js` take `XDG_CONFIG_HOME` from `getEnvScopes`); a runner job's `HOME` is empty.

## Wait on a condition, not a fixed time

A test waiting for async work polls for the state it asserts, with a generous deadline; a fixed window that git fits in here misses on a slower disk. A test asserting something did NOT happen keeps a fixed window, started after the last thing that did.

## Per-file durations of the last full run

A full `scripts/run-tests.js` run writes `.test-durations.last.json` beside `.test-digest.last` (the repo root, or `CLODEX_TEST_LOCK_DIR`'s parent). `node scripts/run-tests.js --durations` prints the 25 slowest files from it without running tests.

## Suite-run ledger

`scripts/run-tests.js` appends two JSONL lines per run to `CLODEX_SUITE_LEDGER` when it is set (nothing when unset or empty), written once the lock is held: `{id, phase:"start", kind, scope, ticket, seat, tree, sha, dirty, pid, where:"local", route, override, queuedAt, startedAt}` and `{id, phase:"end", outcome, pass, fail, tests, endedAt, durationMs}`. `kind`/`ticket`/`seat` come from `CLODEX_SUITE_KIND` (default `manual`), `CLODEX_SUITE_TICKET`, `CLODEX_SUITE_SEAT`; `id` from `CLODEX_SUITE_RUN_ID` or a fresh UUID; `outcome` is `pass`, `fail` or `no-summary`. A killed run leaves a start with no end. Over 5 MB at start the file is renamed to `<name>.1`. `clodex-run-tests.js` sets kind `hand` and the seat from `CLODEX_SEAT`; `_runTicketSuite` sets `verify` or `post-merge`, the ticket id and the run id, and writes the `outcome:"timeout"` end itself when it kills the run. Both write `<clodex home>/logs/suite-runs.jsonl`. The runner scrubs every `CLODEX_SUITE_*` key from the `node --test` env, so fixtures never write the real ledger. `queuedAt` is taken before the lock wait, `startedAt` once the lock is held; `route` and `override` come from `CLODEX_SUITE_ROUTE` / `CLODEX_SUITE_OVERRIDE`, which `clodex-run-tests.js` sets from the host's routing answer (`override:"call"` for `{"local": true}`). A hand run routed to the team's test runner is recorded by `suite-client.js` in the same file: `where` is the runner's peer name (for a pull run, `where` and `runner` are the origin name), the start carries `wire`, `queuedAt` (that attempt's submit), `startedAt`, `jobId`, `attempt`, `treeHash`, `dirty`, `env` and `route`, and the end repeats the identifying fields and `wire` with `outcome` (`pass`, `fail`, `no-summary`, `timeout`, `unknown`), `reason` and the runner's `queueMs`/`setupMs`/`runMs`.

`dirty` differs between the arms and is left that way: locally it is `git status --porcelain --untracked-files=no` (tracked changes only); remotely it is `treeHash !== headTree`, and the snapshot adds untracked, non-ignored files, so a tree whose only change is an untracked file is `dirty:true` on the remote record and `dirty:false` on the local one.

Under `gate:shadow` (docs/teams.md) `suite-client.js` appends one line per verify or post-merge pair to `<clodex home>/logs/suite-compare.jsonl`: `{at, team, kind, ticket, treeHash, sha, envKey, wire, local:{outcome, pass, fail, tests, failing[], slow[], durationMs}, remote:{outcome, reason, pass, fail, tests, failing[], slow[], jobId, queueMs, runMs}, agree}`. Both halves are parsed by the same rules: the last stdout `TOTALS` line, the outcome `pass` on exit 0 and `fail` otherwise (`no-summary` without TOTALS; `timeout`, or `unknown` with `reason` on the remote side), `failing` from the `✖ name (Nms)` rows on stdout only (the slow gate prints the same shape to stderr for tests that passed), `slow` from the slow gate's stdout `SLOW: <n>ms <name>` rows. `agree` is true when both outcomes, the three counts and the failing-name sets match, whatever `slow` holds; a remote `unknown` is always `agree:false`. A pair whose remote job was superseded writes nothing; a write failure is logged and changes nothing else. A pull runner not attached at submit writes a skip row instead, `{at, team, kind, ticket, wire: 'pull', runner, skipped: 'detached', agree: null}` with no halves and no `envKey`, which the tally does not count; a pull runner that detaches mid-job writes the same row plus `midJob: true` and `jobId` (pinned in test/suite-shadow.test.js).
