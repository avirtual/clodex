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

## Progress

- [x] Phase 1 — mechanism established; reported to clodex, awaiting direction.
- [ ] Phase 2 — fix.
- [ ] Phase 3 — prove by deliberate async failure; check non-zero exit.
- [ ] Phase 4 — full suite, report, close t29.
