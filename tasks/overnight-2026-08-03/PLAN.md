# Overnight introspection — 2026-08-03

Operator asleep. Brief: "look at what clodex does, test assumptions, try to
improve things... if you'd rather avoid complex ones, focus on ui improvements.
for instance the settings page is very busy. but you could set some reminders to
check various aspects of clodex"

Latitude is wide. Constraint that still binds: **measure before and after** — he
reverted three plausible fixes in one day. Nothing lands on plausibility alone.

Starting state: tree clean, `ef75bd7`, six unreleased commits on v4.12.0, suite
3462 pass / 0 fail.

**Final state (08:30):** tree clean, `e16e84b`, 20 unreleased commits, 3472 pass
/ 0 fail, electron-smoke green. Three things shipped, seven measured and
rejected, three handed back. Read "Where this landed" at the bottom first.

## Threads

### A — Settings dialog (his named example)

Inventory dispatched to a subagent. Design must be **structural, not visual**: I
cannot see this render, so grouping and progressive disclosure are in scope, and
restyling is not. A change I can't verify is a change he has to un-review in the
morning.

Verification available to me: `npm test`, `scripts/electron-smoke.js`, and a
DOM-structure test asserting every control that existed still exists and is still
wired. That last one is the real guard against a reorganization dropping a
control on the floor.

Status: waiting on inventory.

### B — One assumption, measured properly

Not a grab bag. Candidates, in order of how well-specified they already are:

1. **Hint cooldown vs same-topic follow-ups.** Already has a live measurement:
   5 consecutive follow-ups on one subject → HINT/silent/HINT/silent/silent. All
   5 match at the retriever; the same unit wins every turn and is suppressed
   after its first offer, with no second candidate for the slot. The design
   assumes the operator moves between topics. Worth deciding because delivery is
   already one-shot, so a re-offer is cheaper than the constant assumes.
2. **Extraction quality.** "Bogdan casts himself as the visionary" — a joke
   turned into a character trait. Retrieval is fixed; what's *in* the units is
   the next suspect. He noticed and laughed but did not assign it.
3. `MIN_COVERAGE = 0.35` — never measured on current store shapes.

Pick ONE. Finish it. A half-measured second thread is worth less than nothing
because it looks like evidence.

### C — Reminders (done)

Set below. Point is recovery and drift-checking, not nagging.

## Rules for tonight

- Probe harness lives in the scratchpad and is READ-ONLY against `~/.clodex`.
  Never write to a user's store, never write into a user's project.
- Comments must name a wrong change they prevent. He has called out
  over-commenting twice; an overnight run with no reviewer is exactly when that
  slips.
- CHANGELOG `## Unreleased` stays current as work lands — it ships verbatim.
- Journal decisions here AT decision time. If I compact, this file is what
  survives.

## Journal

Numbered rather than timestamped: I wrote the first few times from memory
instead of running `date`, and they were wrong by up to an hour. Sequence is
what these entries actually carry.

- Step 1 — Started. Tree clean, inventory dispatched.
- Step 2 — **Thread B candidate 1 (cooldown) CLOSED, not a defect.** Probe
  `cooldown.js`, 20 turns over 4 same-topic runs, production pool (8) vs deep
  (60): hinted 13/20 either way, **0 turns starved by the cooldown, 7 genuinely
  exhausted**. Every silent turn matched NOTHING at the retriever — the gate
  abstained, the cooldown never got a say. This CONTRADICTS my own stored unit
  `mem-1785722824893-cm3p33`, which claimed all 5 follow-ups matched and the
  same winner was suppressed each turn. The stored measurement was wrong, or was
  taken before `b10c977`/`94922c4`. Correct the unit; do not deepen the pool.
- Step 3 — **`selfScore()` OOV inconsistency: real, ships nothing.** It sums
  every query term including df=0 ones that `score()` can never credit, so an
  unachievable maximum deflates coverage. Measured `oov.js`: **0 of 8 OOV drafts
  changed, false arms 11 -> 11.** A true statement about the code that decides
  nothing. NOT SHIPPING — this is the fourth plausible fix measurement has
  killed. Worth a comment only if it ever misleads someone.
- Step 4 — **NEW, and it looks like Bogdan's actual complaint.** Chasing the
  discrepancy between my pooled harness (11/14) and the stored "0 false arms"
  baseline, I ran the 14 work drafts through the REAL composite retriever:
  **12/14 arm, and the units are irrelevant.** Examples, verbatim from
  `falsearm.js`:
  - "bump the dependency to the latest version" -> 3 common units on Terragrunt
    registry modules, ECR tag immutability, Terragrunt hcl layout
  - "can you refactor this function to be smaller" -> 2 units on Bogdan's
    PostgreSQL cluster tool
  - "rename the variable to something clearer" -> file-io MCP server
  - "where is the config file for this project" -> syslog-ng macros through
    Terragrunt
  The stored "0 false hints across 14 work drafts" is a claim about the PERSONAL
  path refusing work drafts. It was never a claim about the LEXICAL path, and
  the CHANGELOG wording invites exactly that misreading. Two different claims,
  and only one was ever measured.
  Observation to test: nearly every bad arm is `[common]`. The common store is
  ~1650 units of operator/infrastructure facts; a work draft collides with them
  on generic dev vocabulary. `ef75bd7` fixed refine REPLACING the lexical result
  — it cannot help when the lexical result is itself junk.
  NEXT: measure the mechanism (df of the hit terms, coverage at the margin)
  before proposing anything. Do not touch MIN_HITS on a hunch.
- Step 5 — **Mechanism named** (`mech.js`). Score, coverage and confidence DO NOT
  separate the two populations: false arms run coverage 0.38-1.00, good arms
  0.38-0.72, fully overlapping. So no threshold on the existing quantities can
  fix this — the same conclusion the code already reached for absolute score.
  The real mechanism: **rarity in an off-topic corpus is ABSENCE, not
  specificity.** A codebase draft hits the 1650-unit operator store on ordinary
  English — rename(df=1), refactor(df=6), regex(df=5), latest(df=5) —
  and `log(1+N/df)` reads df=1 as maximally specific, worth ~7.4 points, so any
  two such words clear the 7.41 floor. The store is not answering; it simply has
  no coverage of the topic, and IDF cannot tell those apart.
- Step 6 — **Size-scaled MIN_HITS: measured, PROMISING, then KILLED.** On the
  common store the separation is clean (`rarity.js`, `minhits.js`): codebase
  noise 14/16 -> 1/16 at mh=3 while operator answers hold 9/10. Subsampling the
  store to a size ladder (`knee.js`) put the knee near N=200: below it mh=3
  costs recall (6/10), above it recall returns to 9/10 with noise 0-1/14.
  Then I ran it against every real store instead of the one it was fitted to
  (`crossstore.js`, 4 stores): **on my own `clodex` store, N=577, mh=3 costs
  7/10 -> 4/10 good** and kills "why did the hint arrive on the wrong turn" —
  a question that store exists to answer. Same size class as common, opposite
  outcome. **Corpus SIZE is the wrong variable.** The real difference is
  topical: an agent's own store IS about the work being discussed, so codebase
  drafts match it legitimately; the common store is about the operator's
  infrastructure and matches the same drafts only by vocabulary collision.
  Fifth plausible fix killed by measurement — and it would have passed review
  had I fitted it to the two stores I started with.
  Consequence: any real fix must key on the RELATION between draft and corpus,
  not on the corpus alone. That is a bigger question than one overnight run and
  it is NOT going in tonight.
- Step 7 — **Topical support: measured, KILLED too** (`support.js`). Hypothesis:
  a corpus that genuinely covers a topic has a REGION about it (several units
  containing >=2 query terms), while a vocabulary collision lands in one unit by
  chance. This IS a draft-corpus relation, so it was the right shape. Result —
  separates beautifully on common (GOOD support 5..526 vs NOISE 1..76) and
  **not at all** on the agent stores: clodex GOOD [1,1,1,2,6,8,9,15] vs NOISE
  [1,1,1,2,3,3,5,16,17,18], interleaved end to end; hand likewise. Sixth fix
  killed.
- **THE PATTERN IS THE FINDING.** Three independent variables — score/coverage,
  corpus size, topical support — each separate the populations cleanly on the
  COMMON store and collapse on the AGENT stores. That is not three coincidences,
  it is one fact: **an agent's own memory store is genuinely about the work the
  operator is typing about, so "irrelevant" is not a property the retriever can
  see.** "run the test suite and report failures" SHOULD match a unit on test
  discipline; it just is not useful right now. Usefulness is not similarity, and
  no reweighting of a bag of words will find it.
  The common store is different in kind: it is about the operator's
  infrastructure, and a codebase draft matching it is a pure collision. So the
  tractable problem is narrower than the symptom — **the common store should
  abstain on drafts about the code**, and mh=3 does exactly that (14/16 -> 1/16,
  operator recall 9/10). What killed the size rule was applying it to agent
  stores as well.
  A per-SOURCE threshold (common stricter than own) is measurable, honest about
  the two stores being different in kind, and does not touch the path Bogdan is
  currently testing. NOT shipping it tonight unmeasured against more probe sets
  — but it is the one candidate that survived the night, and it is the right
  next spec.

### A — Settings dialog: SHIPPED (83f98de)

Found a correctness defect rather than a layout one, which is the better outcome
since I cannot see this render. **Three checkboxes were inert whenever the proxy
was off** — "Bake transcripts on resume", "Arm contextual hints from memory",
"Rank hints with a local embedding model". They saved, persisted across a
relaunch, and did nothing. Verified at source, not inferred:
- `session-manager.js:1322` `_armCtx` passes `base: s.proxyBase || null`
- `hint-arm.js:416` returns immediately on a falsy base
- `engine.js:616-617` the resume bake takes the same route — `resolveProxyBase`
  returns null with the proxy off and the function skips ("null when proxy
  disabled → skip" is the code's own comment)

Fix: `renderer/lib/prefs-gate.js`, a pure leaf returning {disabled, reason} per
control, plumbed by `applyPrefsGate()` in renderer.js. Semantic ranking greys one
level deeper (it only reorders what hints retrieved). Gating is PRESENTATIONAL —
save still reads `.checked`, which a disabled input reports faithfully, so
turning the proxy off preserves the stored preferences and they return intact.
That property is pinned by a test, because the obvious "cleanup" of zeroing
gated values would silently discard the operator's settings.

Verification: 3470 pass / 0 fail (8 new), electron-smoke green, and both halves
mutation-tested — forcing `proxyOn = true` fails 3 tests, deleting one reason
span from the markup fails 1. A test that cannot fail is not evidence.

NOT done on the settings dialog: the actual busy-ness. The prose is very long
(the semantic-hints paragraph is ~8 lines) and grouping could be better, but
that is a judgement about rendered appearance and I would be guessing. Left for
Bogdan.

### Subagents

Dispatched two (settings inventory, cold reviewer). The inventory DID report,
late — after I had already shipped. The cold reviewer never did; I verified its
three deciding questions myself before committing rather than blocking. So 1/2,
not 2/2 as first recorded here. Delivery is late rather than lost, which means
a dispatch is worth a longer wait than I gave it — but not worth blocking a
verifiable change on.

The inventory independently confirmed the shipped defect ("UI does NOT express
this dependency" for semantic-hints) without being told the fix existed, and
found no dead markup — consistent with my finding, which was about controls
that are fully wired but INERT at runtime. Different failure, same dialog.

### Step 8 — Dead-control sweep: the three were the only ones

Swept every remaining Preferences control for the same class of defect (persists,
survives relaunch, never acts). `disableClaudeDesignMcp` is live and in fact acts
HARDER with the proxy off (`strictMcpReason` returns `'unrouted'`, which is a
reason to push `--strict-mcp-config`, not to skip). `discoverOnStartup` is read
at `renderer.js:5231` with no proxy dependency. The statusline components render
into a shell script that never consults the proxy. So the three I shipped were
the whole population — a negative result, recorded so nobody re-runs the sweep.

### Step 9 — Hint dating: SHIPPED (23b13ea)

The one extraction-quality thread that turned out to be measurable. Chasing the
"visionary" unit found the extraction FAITHFUL — the quote genuinely says "i am
the man with the vision", so a useful preference is wrapped in a joke's framing.
Not mechanically detectable, and not the real problem.

The real one, measured: **a delivered hint carried no date.** The store is 26.4%
`evolving` + `confidence: high` + older than a year (`stale.js`). Of 22 units
delivered across 30 personal drafts (`hintage.js`), 15 were >1y old, median 627d.
The extractor sometimes hedges in-body ("As of August 2024...") — but only
sometimes: `dated.js` measured 10/22 carrying a recoverable date in the SHIPPED
text, leaving **7/22 riding as present tense at up to 727 days old**, including a
2-year-old branching strategy asserted flatly as current.

This is not a new policy. `composeDigest` already ages every unit via `fmtAge`
(memory-store.js:273); `unitsAsRecords` simply dropped `learned_at` before it
could reach the hint path. Fix carries the field and appends `learned=YYYY-MM` to
the existing scope/tags label.

Kept off the ranking on purpose: `haystack()` reads text/tags/scope only, so a
date cannot make a unit win for containing a year. **Verified, not assumed** —
`baseline.js` before/after gives byte-identical selection (same 21 ids, same
drafts silent), cost +336 chars over 21 units (~16/unit). Both halves
mutation-tested: dropping the date from the label fails 1 test, leaking
`learned_at` into `haystack` fails 1. 3472 pass / 0 fail, electron-smoke green.

Why this is safe to ship while Bogdan live-tests retrieval: it changes WHAT a
hint says, never WHICH hint arrives. The measurement above is the claim.

Cold review (clodex-reviewer-1): ACCEPT, no must-fix. Six nits taken (`1862bf7`),
one declined as cosmetic (UTC month boundary on a store that stamps UTC itself).
**The reviewer found a hole my own mutation probe could not reach**, and it is
the lesson from this thread: `mkStore` stamps `learned_at = now`, so my
shape-only `assert.match(/learned=\d{4}-\d{2}/)` passed green under a regression
dating every unit from `Date.now()` — i.e. asserting every stale claim is FRESH,
the exact inversion of the change's purpose. Mutation testing only probes
mutations you think of; a fixture whose value equals the wrong answer hides a
whole class. Now pinned with a fixed old stamp, plus an undated-unit guard
(`learned_at: ''` must emit no date, not `learned=Invalid Date`) and a
non-vacuity assert on the parity test (two empty arrays are deepStrictEqual).
Four mutations now caught where two were before.

Also from the review, verified independently: the CHANGELOG claimed the date
sits "next to the tag saying whether it is the kind of fact that changes" — true
only for imported `chat-extract` units, where the importer duplicates
`volatility` into `tags`. **0 of 581 units in my own store carry a volatility
marker.** Clause dropped rather than reworded.

The reviewer's cost answer is worth keeping: the `compose()` "billed uncached"
rule tests whether something could have ridden the CACHED system prompt instead.
A per-unit stamp does not exist until a unit is selected, so it has nowhere
cheaper to live — 16 chars against a 150-1150 char block, ≤48 per armed request.

### Step 10 — Stale doc pointer (dfbed31)

CLAUDE.md named `test/changelog-release-notes.test.js` as pinning the release-
notes extraction. **That file does not exist.** The coverage is real and lives in
`test/release-script.test.js`, running the script's own awk/sed against fixtures.
The doc also claimed it "runs only during a release" — it runs in the normal
suite. Both corrected. Worth the commit because a pointer to a missing test
invites the next agent to conclude the coverage is absent and write it again.
Also removed a stray blank line mid-list in `## Unreleased`, which would have
split the published notes into two lists.

### Observations for Bogdan — NOT acted on, deliberately

1. **Theme and env vars bypass Save/Cancel.** `themes.js:50` persists on
   `change`; `renderer.js:3406` commits on the "Set" button. Everything else in
   the dialog batches into Save, so Cancel does not undo either. Verified, but I
   do not think it is a defect: theme says "applies immediately" in its own
   prose, and env vars are a live list editor that answers "Saved KEY." and
   shows the new row. Making them batch would be a bigger change (delete/edit
   semantics) and is a taste call about rendered appearance. Bogdan's to make.
2. **The actual cause of "busy" is layout, not content.** Nearly every row below
   the statusline sections reinvents `display:flex; align-items:center; gap:8px`
   as an inline `style=` attribute; there is no `.prefs-row` class. A pure
   CSS-consolidation refactor would likely fix the feel — but it is invisible to
   every test in this repo and I cannot see it render, so I am not doing it
   blind. This is the one to hand back with "here is where to look".
3. The dialog is 9 sections / 27 controls. If it gets reorganized, the
   markup-contract test in `test/prefs-gate.test.js` is what stops a
   reorganization silently dropping a gated control.

## Where this landed

### Shipped (3)

1. **Preferences: a toggle that cannot act says so** (`83f98de`, `2024526`,
   `24d136b`, `2d2ad01`). Three checkboxes were inert whenever the proxy was off
   — they saved, survived a relaunch, and did nothing. Cold-reviewed SHIP.
2. **Hints carry the month they were learned** (`23b13ea`, `1862bf7`).
   Cold-reviewed ACCEPT, six nits taken.
3. **Docs point at the test that exists** (`dfbed31`).

### Measured and REJECTED (7)

Every one of these was plausible, and six were about the same symptom. Recorded
so nobody pays to rediscover them:

1. Hint cooldown starving same-topic follow-ups — 0/20 turns starved.
2. `selfScore()` OOV inconsistency — real, but 0/8 drafts changed, false arms
   11 -> 11.
3. Score / coverage / confidence thresholds — populations fully overlap.
4. minDfHit and band rules — 13-14/16 noise survives.
5. Corpus-size-scaled MIN_HITS — excellent on two stores, killed good recall
   7/10 -> 4/10 on a third of the same size class.
6. Topical support (does the corpus have a REGION about this?) — separates
   cleanly on common, interleaves end to end on agent stores.
7. Restyling the settings dialog — declined, not measured: invisible to every
   test here and I cannot see it render.

### The finding worth more than any of the fixes

Three independent variables each separate the good and bad hint populations
cleanly on the COMMON store and collapse on the AGENT stores. That is one fact,
not three coincidences: **an agent's own memory store is genuinely about the
work the operator is typing about, so "irrelevant" is not a property the
retriever can see.** Usefulness is not similarity. The tractable problem is
narrower than the symptom — the common store should abstain on drafts about the
code, where the match is pure vocabulary collision. A per-SOURCE threshold is
the one candidate that survived the night. It is a SPEC, not a patch, and it is
deliberately unshipped because it touches selection, which Bogdan is live-testing.

### Method lessons (both cost me something tonight)

- **A threshold fitted to two corpora is fitted to two points.** Run any
  corpus-derived constant against EVERY store on disk before believing it.
- **Mutation testing only probes mutations you think of.** A fixture whose value
  equals the wrong answer hides a whole class: `mkStore` stamps
  `learned_at = now`, so a shape-only assertion passed green under a regression
  dating every unit from the clock — the exact inversion of the change's point.
  A cold reviewer found it by reading the fixture. Build fixtures whose value
  differs from every plausible wrong source, and assert the value, not the shape.
