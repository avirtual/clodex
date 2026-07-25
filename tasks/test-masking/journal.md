# t29 — close the async test-masking hole in the suite

Spec: `~/.clodex/messages/clodex-hand/msg-93431-9.txt` (from clodex, 00:33).

## The problem

The suite can UNDER-REPORT failures. A test that fails on an async path surfaces
as `uncaughtException` and is NOT counted in the pass/fail totals.

Found during t25: two tests in `test/app-menus-plugins.test.js` were fixed for
`app.setAboutPanelOptions is not a function`, and reverting the fix surfaced two
MORE hitting the same error through an async menu-rebuild path. Four broken, not
two — and the totals said two.

clodex: "a green run is only evidence if every failure is counted. We have
shipped two releases resting on green runs since." This OUTRANKS feature work.

## Instructions, verbatim on the load-bearing points

1. **INVESTIGATE FIRST and report the MECHANISM before changing anything.**
   Specifically: is this confined to `app-menus-plugins.test.js`, or does ANY
   test in the suite that rejects inside an async callback escape the counters
   the same way? "Those are very different findings and the second one is the
   one I actually care about. Do not assume it is the narrow case because that
   is where we found it."
2. Then fix so a rejection on an async path fails its OWN test rather than
   escaping to the process handler.
3. Prove it the usual way: introduce a deliberate async failure, confirm the
   counters catch it, remove it.
4. Also check: can `node --test` be made to exit NON-ZERO on an escaped
   exception even when it cannot be attributed to a specific test? "Attribution
   is better, but a suite that goes red without attribution still beats one that
   goes green while broken."

## Constraints

- New branch off master, now at `e5b577d` (v4.1.0, released AND pushed).
- Do not push. Do not touch master.
- Standing: `.claude/CLAUDE.md` and `.claude/memory.md` are never edited;
  `git reset -q node_modules` before staging, explicit path lists never
  `git add -A`; suite only via the `clodex-test-green` skill (the exec command
  is worktree-blind); `npm run build:web` if bundled sources change.
- t28 trigger, still in force: **`git checkout --` is not undo.** Commit the fix
  before proving it by reverting, or undo with `git stash`.

## State at pickup

- Branch to create: off `e5b577d`.
- Sibling branches, both unmerged and awaiting Bogdan's hands-on run:
  `workbench-features` (t26, at `199dc5a`) and `web-plugin-parity` (t28, at
  `e57d3a7`, suite 2547/2547).

## Phase 1 — the mechanism (branch `test-masking` off `e5b577d`)

Reproduced from first principles in a scratch dir, then confirmed against the
real file by reverting `3427056`.

### It is NOT confined to `app-menus-plugins.test.js`

It is a property of `node --test` itself (v25.8.1) and applies to EVERY test in
the suite. Any error thrown on an async continuation that outlives the test's
own promise escapes the per-test counters. Both escape shapes behave the same:

- unhandled rejection — `(async () => { throw })()` not awaited;
- uncaught exception — `setImmediate(() => { throw })`.

Node's own diagnostic states the rule outright:

> Test "X" ... generated asynchronous activity after the test ended. This
> activity created the error "..." and **would have caused the test to fail,
> but instead triggered an unhandledRejection event.**

### What actually happens to the counters

The test is counted **PASS**. A synthetic FAILURE is attributed to the **FILE**:

    ✔ 2 fire-and-forget async throw     ← the broken test, green
    ✖ a.test.js                          ← 'test failed', no message
    ℹ tests 4 / pass 3 / fail 1

So the file-level `✖` is a real counter entry (`tests` counts N+1 for N tests),
and **`node --test` DOES already exit non-zero** — verified `EXIT=1` on every
escape shape, including one firing 300ms after the last test finished, and
including a file that installs its own swallowing `process.on('uncaughtException')`
(main.js:65's shape — the runner's handler wins).

So instruction 4 is already satisfied by the runner: the suite goes red without
attribution. That is not where the hole is.

### Where the hole actually is: OUR reporting pipeline absorbs it

The masking is in how the run is READ, in two compounding ways.

1. **The escape hides behind any real failure in the same file.** Node emits
   the file-level `✖` only when the file has no other failure to report. With a
   real sync failure in the same file, the escape produces NO counter entry at
   all — the run is `X.` with one failing test named, and the escaping test is
   still green. This is exactly t25: two tests failed by name, two more were
   equally broken, and the totals said two.
2. **The `test-runner` agent's pipeline drops the diagnostic.** The digest is
   produced by (`~/.clodex/agents/test-runner.md`):

       node --test --test-reporter=dot 2>&1 | awk '/^Failed tests:/{f=1} …'

   The dot reporter prints the `ℹ Error: … generated asynchronous activity …`
   line NOWHERE — that line exists only in the default (spec) reporter. Under
   dot, an escape is a bare `X` whose only detail is `✖ file.test.js  'test
   failed'` with no message. And the agent is instructed to report per-failure
   name + message + stack; for this shape there is none, so the one signal that
   would identify it is gone before I ever see it.
   Worse: with a real failure alongside it, dot emits neither — see (1).

Net: `node --test` exit code is honest; the failure COUNT is not (escaping test
counted pass, at most one synthetic file-level fail regardless of how many
escaped); and our digest path deletes the diagnostic that names it.

### Current exposure: NONE live

Full suite scanned for the diagnostic on `e5b577d`: **2560/2560, zero escapes**.
So the two releases rest on runs that were in fact clean — the hole is latent,
not currently hiding anything. It cost us four-broken-reported-as-two once.

### The diagnostic DOES name the test — attribution is recoverable

`Test "H2 escaping async" at h.test.js:4:1 generated asynchronous activity …`
names the test, the file and the line. That is full attribution, and it is
present in the SPEC reporter and absent from DOT. Node accepts repeated
`--test-reporter` / `--test-reporter-destination` pairs, so both can run at
once — verified:

    node --test --test-reporter=dot --test-reporter-destination=stdout \
                --test-reporter=spec --test-reporter-destination=/tmp/spec.txt

stdout stays the one-line dot digest; `/tmp/spec.txt` carries the diagnostic,
greppable by the fixed string `generated asynchronous activity`. Confirmed it
survives the hard case too (escape alongside a real failure in the same file,
where the file-level `✖` is absorbed).

### Consequence for the fix

The fix is therefore NOT "make node exit non-zero" (it already does, verified on
every shape). It is:
(a) surface the escape with attribution — the data exists, our pipeline drops it;
(b) make the count honest, since the escaping test is counted PASS by the runner
    and nothing we do to the reporter changes that.

Note (a) is a change to `~/.clodex/agents/test-runner.md`, which is OUTSIDE the
repo and outside the ticket's stated scope — flagged to clodex, not taken.

## clodex's ruling (msg-93431-11)

Both corrections accepted; the ticket was wrong on the mechanism. The finding
that matters most is the one he did not ask for: **the dot reporter deletes the
diagnostic — our verification path was blind by configuration, not by Node's
design.**

- **(a) Both in scope.** Wrapper AND `~/.clodex/agents/test-runner.md`. Editing
  a file outside the repo is authorised **specifically and only for that agent
  definition**. Keep it minimal, say exactly what changed. "A repo-only fix that
  leaves our actual verification path blind is not a fix — it is the same defect
  with a new place to not look."
- **(b) Named and red with attribution is acceptable. Do NOT wrap every
  `test()`.** "Wrapping the suite to move one integer is a large change against
  a small gain, and it would put a layer of our own code between us and the
  runner's accounting." State the residual plainly in the journal.
- Print the **attribution**, not just a count. "A wrapper that says '1 escape'
  and makes me go hunting has recreated the problem."
- **The absorbed case is the one that matters.** Prove it by reconstructing it.
- **Do not let the wrapper swallow anything** — post-processing throwing or a
  missing spec file must fail loudly, never report green.

## RESIDUAL, stated plainly per (b)

An escaped async failure is now **reported, attributed and red** — but the
runner's **pass counter still counts that test as passed**. That is the
runner's own accounting and moving it would mean wrapping every `test()` call
in the suite. Deliberately not done. So `TOTALS: N pass` can include a test that
did not pass; the `ESCAPES:` block below it is the correction, and the exit code
is non-zero either way.

## DATED FINDING — exposure at the time of the fix

**2026-07-26, master `e5b577d` (v4.1.0): full suite 2560/2560 with ZERO live
escapes.** Scanned by grepping the whole run for the diagnostic. So v4.0.0 and
v4.1.0 rest on genuinely clean runs — the hole was latent, and the only time it
is known to have hidden anything is t25 (four broken, two reported).

## Phase 2 — the fix

- `scripts/test-escapes.js` (new, pure, dependency-free): `parseEscapes(text)` →
  `[{test,file,line,error,event,raw}]`, `formatEscapes()` → the report. Anchors
  on the one stable substring `generated asynchronous activity after the test
  ended`, present in tap/spec/junit and absent from dot. Undecorates the three
  reporter prefixes (`# `, `ℹ `, `<!-- -->`). Attribution is null for the
  ownerless shape (an escape firing after every test in the file has finished);
  reported as such rather than given an invented owner.
- `scripts/run-tests.js` (new): `npm test`. Runs `node --test` with TWO
  reporters — the caller's on stdout, tap into a temp file — then scans the tap
  stream. Prints `TOTALS:` + the escape block, exits non-zero if anything
  escaped. `--reporter=X` selects the stdout reporter; the rest passes through
  to `node --test` so single-file runs still work.
- Fails LOUDLY, never green, on: spawn error, missing/empty tap file, no
  summary in the output, or a throw inside the escape analysis.
- `package.json`: `"test": "node scripts/run-tests.js"` (was `node --test`).

### The absorbed case, reconstructed (clodex's required proof)

One real sync failure + one async escape in the SAME file — t25's exact shape.

BEFORE, through the old digest pipeline: `TOTALS: 1 pass, 1 fail`, one test
named, **the escape produced no counter entry at all**.

AFTER, same file through the wrapper:

    TOTALS: 1 pass, 1 fail, 2 tests
    ESCAPES: 1 — counted PASS by the runner, listed here because they are not:
      ✖ ESCAPED "t25 B — equally broken, counted PASS (the two we did not see)"
          at …/t25.test.js:8
          Error: app.setAboutPanelOptions is not a function (unhandledRejection)

Both named. `EXIT=1`. The ownerless shape also verified separately.

## Phase 3 — tests (16 in `test/test-escapes.test.js`)

Parser half runs on reporter text captured VERBATIM from node 25.8.1, not
hand-written, so a wording change in Node's diagnostic fails these rather than
silently returning `[]`. Wrapper half spawns `run-tests.js` against scratch
files that really escape.

### A test that proved nothing, caught by proving it

`a suite that cannot run at all fails LOUDLY` originally asserted only
`code !== 0`. Reverting the guard left it GREEN — because `node --test` already
exits non-zero on a missing file, a load-time throw and every escape shape. The
assertion was proving Node works, not that my wrapper refuses to report on a run
it cannot read. Same trap as the impossible-fixture trigger, in a new shape:
**an exit-code assertion in a wrapper test is almost always riding the wrapped
tool's behaviour.**

Split and re-anchored on what ONLY the wrapper produces (commit `b491535`):
- missing tap → asserts the message AND `doesNotMatch(/ESCAPES:/)` — the point
  is that a run it could not read gets NO verdict, green or otherwise;
- explodes-at-load → asserts it is reported as an ordinary failure (`ESCAPES: 0`),
  not mistaken for the escape shape.

### Proofs (all by REVERTING and failing BY MESSAGE, fix committed first)

1. ownerless variant (`which triggered` vs `and would have caused`) removed from
   the error regex → actual = the whole diagnostic line, expected
   `'Error: BOOM ownerless'`.
2. tap→dot for the analysed stream → 5 tests fail, incl. "THE t25 CASE: escape
   not reported". This is the bug itself, reproduced on demand.
3. missing-tap `die()` → swallow → "did not match /run-tests: the tap stream is
   missing/".
4. `package.json` back to `node --test` → "did not match /scripts\/run-tests\.js/".

**Not proved, stated honestly:** `if (escapes.length) process.exit(...)` in
run-tests.js is NOT covered — reverting it changes nothing, because Node already
exits non-zero on every escape shape I could construct. It is belt-and-braces
against a future Node that stops doing so, not live behaviour.

## Phase 4 — `~/.clodex/agents/test-runner.md` (outside the repo, authorised)

Exactly what changed, minimal:
- command `node --test --test-reporter=dot …` → `npm test --silent --
  --reporter=dot …`, awk extended to pass the `TOTALS:`/`ESCAPES:` block
  through (it previously only opened on `Failed tests:`);
- an explicit "do NOT run `node --test` directly" with the reason — its dot
  reporter drops the diagnostic, which is the bug t29 fixed;
- report step gains: quote the `ESCAPES:` block verbatim whenever non-zero,
  because escapes are counted PASS and will never show in the fail count;
- report format gains: `N/N green` requires `ESCAPES: 0` too. "Never report
  green with a non-zero ESCAPES count, however many tests passed."

Verified end-to-end through the agent's exact pipeline against the t25
reconstruction — output ends:

    TOTALS: 1 pass, 1 fail, 2 tests
    ESCAPES: 1 — counted PASS by the runner, listed here because they are not:
      ✖ ESCAPED "t25 B — equally broken, counted PASS (the two we did not see)"

## Result

Branch `test-masking` off master `e5b577d`. **Suite 2577/2577, ESCAPES: 0**
(baseline 2560, +17 — 16 new tests plus the file-level entry the runner adds).
Verified through the NEW pipeline, i.e. the fix verifying itself is also the
first run this suite has had that could have reported an escape.

Commits: `81e7240` (phase-1 journal), `7730032` (wrapper + parser + package.json),
`eb36b0a` (tests), `b491535` (the weak test, re-anchored). Plus this journal.
Not pushed. Master untouched. Sibling branches untouched.

Out-of-repo change, authorised: `~/.clodex/agents/test-runner.md` (not a repo
file, so not in any commit — listed above in phase 4).

## Progress

- [x] Phase 1 — mechanism established; reported to clodex, ruling received.
- [x] Phase 2 — wrapper + parser built; absorbed case reconstructed and proved.
- [x] Phase 3 — 16 tests; four proofs by reverting; one weak test caught and fixed.
- [x] Phase 4 — `test-runner.md` updated and verified end to end.
