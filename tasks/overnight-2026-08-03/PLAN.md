# Overnight introspection — 2026-08-03

Operator asleep. Brief: "look at what clodex does, test assumptions, try to
improve things... if you'd rather avoid complex ones, focus on ui improvements.
for instance the settings page is very busy. but you could set some reminders to
check various aspects of clodex"

Latitude is wide. Constraint that still binds: **measure before and after** — he
reverted three plausible fixes in one day. Nothing lands on plausibility alone.

Starting state: tree clean, `ef75bd7`, six unreleased commits on v4.12.0, suite
3462 pass / 0 fail.

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

- 05:45 — Started. Tree clean, inventory dispatched.
- 06:0x — **Thread B candidate 1 (cooldown) CLOSED, not a defect.** Probe
  `cooldown.js`, 20 turns over 4 same-topic runs, production pool (8) vs deep
  (60): hinted 13/20 either way, **0 turns starved by the cooldown, 7 genuinely
  exhausted**. Every silent turn matched NOTHING at the retriever — the gate
  abstained, the cooldown never got a say. This CONTRADICTS my own stored unit
  `mem-1785722824893-cm3p33`, which claimed all 5 follow-ups matched and the
  same winner was suppressed each turn. The stored measurement was wrong, or was
  taken before `b10c977`/`94922c4`. Correct the unit; do not deepen the pool.
- 06:1x — **`selfScore()` OOV inconsistency: real, ships nothing.** It sums
  every query term including df=0 ones that `score()` can never credit, so an
  unachievable maximum deflates coverage. Measured `oov.js`: **0 of 8 OOV drafts
  changed, false arms 11 -> 11.** A true statement about the code that decides
  nothing. NOT SHIPPING — this is the fourth plausible fix measurement has
  killed. Worth a comment only if it ever misleads someone.
- 06:2x — **NEW, and it looks like Bogdan's actual complaint.** Chasing the
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
- 06:4x — **Mechanism named** (`mech.js`). Score, coverage and confidence DO NOT
  separate the two populations: false arms run coverage 0.38-1.00, good arms
  0.38-0.72, fully overlapping. So no threshold on the existing quantities can
  fix this — the same conclusion the code already reached for absolute score.
  The real mechanism: **rarity in an off-topic corpus is ABSENCE, not
  specificity.** A codebase draft hits the 1650-unit operator store on ordinary
  English — rename(df=1), refactor(df=6), regex(df=5), latest(df=5) —
  and `log(1+N/df)` reads df=1 as maximally specific, worth ~7.4 points, so any
  two such words clear the 7.41 floor. The store is not answering; it simply has
  no coverage of the topic, and IDF cannot tell those apart.
- 06:5x — **Size-scaled MIN_HITS: measured, PROMISING, then KILLED.** On the
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
- 07:0x — **Topical support: measured, KILLED too** (`support.js`). Hypothesis:
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
