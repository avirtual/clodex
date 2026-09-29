# Test doctrine

The rules `.claude/CLAUDE.md` states in one line each, with the cases that
produced them. Read this before arguing with one of them.

A test can fail to reach the state it names and still pass every assertion.
Seven instances so far; what made most of them silent was the assertion shape,
not the mistake. The first three rules follow from that; the last two are about
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
