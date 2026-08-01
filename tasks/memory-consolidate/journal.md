# t129 — consolidation pass: archive superseded and expired memories

## CRITICAL PROPERTY — CONFIRMED, empirically, on both enumerators

The design rests on `<agent>/superseded/` being invisible to every consumer
with no filter code anywhere. **It holds.** Verified by moving a real unit into
the subdirectory and driving each consumer, not by reading the filters:

| consumer | before | after |
|---|---|---|
| `list()` | 2 units, 2 pinned | 1 unit, 1 pinned |
| `recall()` by body text | found | not found |
| `recall()` by id | found | not found (accepted consequence) |
| `composeDigest` | — | archived id absent; header says `1 unit(s)` |
| `build-corpus.js --all` | — | `1 of 1 units` |
| `census()` | — | `[]` |
| memory-viewer plugin `units` | — | 1 unit |
| memory-viewer plugin `agents` | — | `count: 1, pinned: 1` |

Mechanism: `readdir` DOES return `superseded` (verified: `["mem-….md",
"superseded"]`), and every enumerator drops it on an `.endsWith('.md')` filter.

`confine()` does not fight it. `_dir()` confines the AGENT name against the
root; `superseded/` is created underneath the already-confined agent dir, so no
containment check sees it. `confine(agentDir, 'superseded')` also passes on its
own terms (a direct child), though archive.js does not need it to.

### FINDING — a SECOND enumerator the spec did not name

Clodex asked what else enumerates units. Besides `memory-store.js:81`, there is
**`plugins/memory-viewer/engine.js:105`** (`readUnits`) plus `:77`
(`listAgentDirs`). It is an independent implementation — its own `readdirSync`,
its own parser, its own `pinned` count at `:146`.

It happens to be safe, for the same reason core is: `:111` filters `.md`. But
it is safe by coincidence of a shared idiom, not because anything enforces it.
It also means the answer to "is the digest's pin count computed from list()"
is: core's is (`composeDigest` filters `units` from `list()`), and the
plugin computes its OWN `pinned` count from its OWN readdir — two independent
counters that agree today and would diverge if either changed its filter.

Not a defect and out of this ticket's fence (`scripts/memory-tag/` + `test/`).
Recorded because the design's guarantee is "no consumer needs filter code", and
the honest version is "no consumer needs filter code *as long as every one of
the two independent enumerators keeps filtering `.md`*".

### What would need to know about the archive

Nothing, by design. Enumerated and confirmed empty: no consumer reads
`archived_at`/`superseded_by`/`expired`; the forensics path is reading the
folder directly. `engine.js:1262` `removeMemoryUnit` deletes by id through the
store, so it cannot reach an archived unit — consistent with `recall <id>`.

## Delivered

- `archive.js` — sole mover. Write-then-unlink (a crash leaves the unit in BOTH
  places, which a human can see; the reverse order can leave it in neither).
  `--restore`, `--dry-run`, `--drift`.
- `build-buckets.js` — per-tag corpora, oldest first, uncapped bodies.
- `consolidate-prompt.md`, `consolidate.sh`.
- `test/memory-consolidate.test.js` (13 cases).

Rejections beyond the spec's list: a unit superseding ITSELF, and `superseded`
with no id. Both are shapes a model produces and neither was named.

## Verification

Full suite **3234/3234, ESCAPES: 0** (3221 + 13).

End-to-end against a temp fixture with a stubbed `claude`: 6 units, one bucket
eligible (team-delegation, 4) → `1 archived (1 superseded, 0 expired), 2 kept,
1 rejected`, exit 1, drift detector naming the two singletons. Archived file
read back standalone and it explains itself: `superseded_by`, `archived_at`,
`archive_reason`, with `tags`/`pinned`/body intact. `--restore` round-tripped
it back to active with all four archive keys gone.

**Live store untouched** — 193 units, no `superseded/` directory.

| # | mutant | result |
|---|---|---|
| (a) | ghost-superseder check removed | 2 fail |
| (b) | archive copies but never unlinks | 4 fail — `the unit did not leave the active dir` |
| (c) | restore leaves archive keys | 1 fail — `restore left archived_at behind` |
| (d) | the move drops unknown keys | 2 fail — `the move dropped an unknown frontmatter key` |
| (e) | dry-run archives anyway | 1 fail — `dry-run moved the unit out of the active dir` |
| (f) | `keep` falls through and archives | 3 fail |
| (g) | buckets newest-first | 1 fail — `buckets must be oldest first` |
| (h) | bucket bodies capped at 1200 | 1 fail — `a truncated claim reads as agreement` |

Product restored byte-identical after each.

### A fixture that was passing by luck — found by mutant (e)

Mutant (e) failed the BUCKETS test, which it has nothing to do with. Not
leakage (tree was pristine, baseline green): `remember()` stamps `learned_at`
from `Date.now()`, so fixture units built in the same millisecond TIE, and the
oldest-first assertion was resolving on sort stability rather than on the code.
Removing an unrelated `return` shifted the timing enough to flip it.

The fixture now restamps `learned_at` one day apart, ascending with creation
order. Mutant (g) re-run against the fixed fixture still reddens, so the
assertion is real — it just had no fixture to be real against before.

This is THE ENTER QUESTION applied to a fixture: the test named an ordering
property but its inputs could not distinguish the orderings.

### And (e) itself failed by crash first

`--dry-run` asserted with `readFileSync` on a path the mutant had moved, so it
died on ENOENT rather than saying what broke. An `existsSync` check with a
message now precedes the byte compare. Third instance of this shape for me;
the rule generalises to any assertion whose subject the mutant can DELETE, not
just ones returning null.

---

# t134 — pre-pass: follow self-declared supersession pointers

## Corpus measurement, before designing (read-only, live store)

194 units; **29** contain supersession-family language on the ticket's starting
patterns. So this is not a two-unit special case.

### The ticket's resolution ladder does not resolve the pair the ticket names

Measured, not reasoned:

| rung | on l7u6nx <- 5c0ues | why |
|---|---|---|
| explicit mem-id | MISS | 5c0ues cites prose, no id |
| date reference `07-10` vs `learned_at` | MISS | l7u6nx `learned_at` is **2026-07-08**; 10 units share that date |
| exact quoted phrase | MISS | the quote is a PARAPHRASE |

l7u6nx's body says "rev 2026-07-10" and "RETIRED as of 2026-07-10": the 07-10
in 5c0ues points at **text inside the body**, not at the timestamp. And 5c0ues
writes `"contrarian retired, never consult"` where l7u6nx says "is RETIRED as
of 2026-07-10 — it no longer exists; do NOT propose consulting it" — same
claim, different words.

What DOES discriminate: distinctive-term overlap (`contrarian`, `retired`,
`consult`) plus the descriptor "the boot pin", and l7u6nx opens "Boot protocol"
and is pinned.

**Amendment to the spec, flagged not silent:** the ladder becomes
id -> distinctive-term overlap (dates as a filter, not a rung) -> unresolved.
Date alone is demoted because it is BOTH too weak (10-way ties) and looking in
the wrong place (body text, not frontmatter). A date literal found in the match
context is used to narrow the candidate set when that narrowing is non-empty.

## Design

`find-pointers.js`, read-only, no writer:

- Emits a POINTER BUCKET through build-buckets' own `render()` — same format,
  same prompt, same archive.js flow, no new writer and no second renderer to
  drift.
- Emits a separate human-readable CANDIDATES report (match text, rung used,
  unresolved reasons). Annotation cannot ride in the bucket without changing
  the bucket reader, so it rides beside it.
- **Direction is not decided here.** "X supersedes Y", "this is superseded by
  Y" and "RETRACTED" put a different unit on the chopping block; the pointer
  pass only CO-LOCATES the pair so the model reads them side by side and the
  existing prompt makes the call. Deciding direction here would be a judgement
  nobody asked this pass to make, from weaker evidence than the model has.
- A cited id that is not an active unit resolves to UNRESOLVED with that
  reason. Never a crash, never a substitute guess.

## Built, measured against a COPY of the live store (194 units, never the store)

53 candidates, 18 resolved by ladder, 77 units in the bucket, 118KB.

### The flagship pair failed the first build — and the fix was not a threshold

l7u6nx scored 7 against the declaration, but `mem-1785527290407-z3leb7` scored
6: clodex's own meta-unit written TODAY about this very contradiction, which
quotes both units. It genuinely ties. Loosening MIN_MARGIN to admit a 1-point
lead would have "fixed" the case by making the pass willing to guess — the
exact failure the ticket forbids.

Instead: a near-tie now emits UNRESOLVED **and puts the whole shortlist
(cap 3) in the bucket**. Co-locating is not guessing — nothing is archived
without a model verdict, and the model reads the units side by side, which is
all this pass was ever for. Dropping the target is what loses the pair.

### OPEN CONCERN for clodex — bucket size

77 units / 118KB in ONE model call, vs a tag bucket's <=24. Every unit that
merely CONTAINS the word "replace" pulls itself and up to 3 shortlisted units
in. It will work, but judgement quality over 77 units read at once is not the
same as over 12, and it is the opposite of the design principle the tag
buckets rest on. Options if you want it smaller: drop the weakest patterns
(`replaces`/`refines`/`no longer` are the noisy third), or split the pointer
bucket into chunks of ~20 declaring units plus their targets. **Not doing
either without your call** — both trade recall for judgement quality and that
is your axis, not mine.

`override` was deliberately left OUT of the pattern list: in this corpus it is
a domain term (per-agent hint override) and fires on units declaring nothing.

## Tests — `test/memory-pointers.test.js`, 9 cases

| # | mutant | result |
|---|---|---|
| (a) | dead cited id falls through to term matching | 2 fail — `resolved a dead pointer` |
| (b) | near-tie picks the top candidate anyway | 1 fail — `named X outright when two units are indistinguishable` |
| (c) | shortlist not added to the bucket | **SURVIVED at first** |
| (d) | clause merging removed | 1 fail — `one clause produced 3 candidates` |
| (e) | bucket newest-first | 1 fail — `must be oldest first` |
| (f) | MIN_SCORE lowered to 1 | **SURVIVED at first** |

### Two escapes, both the same shape, both now closed

**(c)** — the shortlist-to-bucket step IS the fix for the flagship pair, and no
case covered it. My "reaches its target" assertion is a disjunction (`target ===
t || shortlist.includes(t)`) and the FIXTURE resolves outright, so it always
passed on the easy branch while the live store takes the other one. Fixed by
asserting bucket membership in the near-tie case, where the shortlist branch is
the only one available.

**(f)** — the unresolved fixture had NOTHING sharing vocabulary with the
declaration, so it is unresolvable at any threshold and could not tell a
careful pass from one that grabs the nearest unit. Added a lookalike sharing a
term or two; the case now discriminates.

Both are the degenerate-value trap from t126: an assertion whose fixture cannot
reach the branch it claims to guard. Third and fourth instances. The tell in
both was a SURVIVING mutant on the code I had just written specifically to fix
a live defect — if a mutant on the fix survives, the fix is untested however
green the file is.

Product restored byte-identical after every mutant (`diff` against a pristine
copy). All 9 green on the restored file.

## The omnibus class — proposal only, NOT built (clodex's call)

The problem restated: l7u6nx is a dozen standing rules in one unit, one clause
false. `keep` serves a false clause with pin authority; `superseded`/`expired`
destroys eleven live rules. The unit is the wrong SIZE, and the prompt forces a
verdict that is a lie either way.

### Recommendation: a fourth verdict `partial <clause>`, not `split`

Both were on the table; `split` is the wrong one and the reason is the design
rule this whole pipeline already follows — **the model never writes a memory
unit**. `split` means producing two new bodies, which is authoring, and it
would make the model a writer for the first time, with no way for archive.js to
verify the split preserved anything. `partial` archives nothing, writes
nothing, and names the rotten clause for a human:

    mem-1783524813485-l7u6nx: partial "contrarian is RETIRED as of 2026-07-10" # reversed by mem-1784506828448-5c0ues

Properties that make it cheap and safe:

- **archive.js changes are small and additive**: a fourth verdict that moves no
  file. It joins `kept` in the counts as its own bucket, and appears in the
  run summary so it is not silently swallowed.
- **It cannot lose knowledge.** The failure mode of every other verdict is
  destroying something live; `partial`'s failure mode is a human reads a report
  line and disagrees. Asymmetric in exactly the direction the prompt already
  argues for under uncertainty.
- **The quoted clause is the deliverable.** Without it a human gets "something
  in this 400-word pin is stale" and has to re-find it; the model has already
  done that work in the same read.

Where it should NOT go: any automatic rewrite, and any `partial` that also
archives. Both re-import the risk the verdict exists to avoid.

### One caution I'd want you to weigh

`partial` is the easiest verdict to over-use — it is the honest escape hatch,
and a model under uncertainty will reach for it the way it reaches for `keep`.
If it becomes the majority verdict the pass has produced a to-do list rather
than a curated store. Worth capping in the prompt ("a unit with one rotten
clause among many, not a unit you merely have doubts about — doubt is `keep`")
and worth watching on the first live run.

### Sizing

Prompt change + archive.js verdict + tests is roughly a third of t129's size.
It is separable from t134 and I did not build it. My read: **separate ticket**,
because it touches archive.js (the sole mover) and the prompt, and t134 touches
neither — keeping them apart keeps this ticket's diff read-only.

---

# t135 — chunk the pointer bucket, add the `partial` verdict

## Part 1 — chunking (find-pointers.js)

`chunkBucket()` groups by DECLARER, not by slicing a flat unit list, because
the invariant is per-declarer: a declaring unit and every companion it named
must land in the SAME chunk. `CHUNK_DECLARERS = 20`, companions pulled in
whole, so a chunk lands above 20 units.

Several candidates from one unit (one per clause) are merged in
`companionsByDeclarer` — the unit appears in exactly ONE chunk carrying every
companion any of its clauses named. Chunk files are `bucket.pointers.N.md`
through the same `render()`; stdout is the name list, as build-buckets does.

**Measured on the store copy:** 3 chunks of 45 / 43 / 11 units (73KB / 78KB /
18KB) from 53 candidates. **Split pairs: 0**, checked by walking every
candidate's companions against a unit→chunk map. 20 units legitimately appear
in more than one chunk (deliberately not deduplicated: dedup would drop a unit
out of a pair it belongs to).

## Part 2 — `partial` (archive.js + consolidate-prompt.md)

`partial "<clause>" # reason`. Parsed with a quoted-clause requirement (a
`partial` with no quotable clause REJECTS — the clause is the deliverable).
Collected into its own `partial` array, **moves nothing, writes nothing**, and
prints in its own section of the run report.

Over-use guarded by MEASUREMENT as specced: `partialRate()` +
`PARTIAL_ALARM = 0.25`, printed as `rate: n/total (N%)` with an explicit
`OVER 25%, the prompt's cap is not holding` when it trips.

Prompt: fourth verdict, the cap in the words from my t134 proposal ("one rotten
clause among many, NOT mere doubt; doubt is `keep`" plus "if you cannot quote
the specific sentence, you have a `keep`"), and the asymmetry stated.

## Tests written — pointers 9 -> 13, consolidate 13 -> 18

New: same-chunk invariant (by name), one-chunk-per-declarer, legitimate
duplication across chunks, declarer budget; partial-is-inert, clauseless
partial rejects, quoted clause with a hash, rate alarm both sides, and
**double-archive DRIVEN** (two separate runs, second rejects `no active unit`,
archived bytes unchanged).

### A REAL PARSER DEFECT the tests caught

`partial 'the #4 rule about retries' # stale` was REJECTED as clauseless: the
reason was split at the first `#` before the quoted clause was extracted, so a
hash inside the clause truncated the deliverable to nothing. Clauses are quoted
VERBATIM FROM UNIT BODIES, and this corpus writes things like "#4". Fixed in
`parseVerdict` — the reason now splits at the first hash OUTSIDE the quoted
clause. Test kept, product fixed; the test was right.

### Fixtures I had to strengthen to reach the branch (the t135 brief)

1. **Chunk fixtures resolved 0 pairs.** 25 near-identical declarations make
   their own shared words exceed COMMON_DF, leaving 2 nonce terms — below
   MIN_SCORE. Every chunk assertion would have looped over an empty list. Both
   vacuity guards I had written FIRED, which is what caught it. Gave each pair
   4 nonce terms.
2. **The split-invariant case could pass on a flat slice.** Pairs within
   CHUNK_DECLARERS of each other in age order are never separated by ANY
   implementation, so the case needs a pair further apart than a chunk is wide.
   Added `farPairs > 0`, which fails with "a flat slice would pass this
   fixture".
3. **The duplication case resolved nothing** for the same COMMON_DF reason —
   22 identical declarations. Switched to citing BY ID, and asserted
   `> CHUNK_DECLARERS` declarers actually resolved to the shared target before
   asserting the duplication.

## Mutants — 8, all reddening by message

| # | mutant | result |
|---|---|---|
| (a) | flat slice of the age-sorted bucket | 2 fail — `X and its companion Y never share a chunk` |
| (b) | companions not pulled into the chunk | 2 fail — same, companion in no chunk |
| (c) | chunking ignored (one giant chunk) | 3 fail — `a chunk carries 43 declarers, over the 20 budget` |
| (d) | partial counted as a keep | 2 fail — `hiding it from the report` |
| (e) | partial moves the unit | 1 fail — `partial moved the unit out of the active dir` |
| (f) | clauseless partial accepted | 1 fail — `a clauseless partial was accepted` |
| (g) | rate over partials only | 1 fail — `must be over every verdict` |
| (h) | double-archive allowed | 1 fail — reason text changes |

Both products restored byte-identical (`diff`) after every mutant; 31/31 on the
restored files.

**(e) failed by ENOENT crash first** — a `readFileSync` byte-compare whose
subject the mutant had moved. FOURTH instance, and I wrote this test AFTER
saving the rule about it. The rule is easy to state and easy to not apply:
existence check with a message BEFORE any read whose subject a mutant can
delete.

## Verification

Full suite **3252/3252, ESCAPES: 0** (3243 + 9). Fence: `scripts/memory-tag/`
and `test/` only. **Live store untouched — 194 units, no `superseded/`.**
Everything ran against temp fixtures or the scratchpad copy.

---

# t136 — consolidation rework: two-phase apply, most-conservative-wins

## Forensics on the live run (read-only, buckets.clodex.20260731-231404)

Verdict totals across 22 files: **193 keep, 31 superseded, 27 expired, 12
partial**. 46 distinct ids carried an archive verdict; 76 ids appeared in more
than one bucket.

**The headline, measured:** 13 of those 46 archives — **28%** — had a `keep` or
`partial` verdict in ANOTHER bucket that the applier discarded. 5c0ues is the
named case (`partial` in team-delegation, `expired` in cold-review, size-desc
order ran team-delegation first, so the conservative verdict was written and
then overridden). This is the OR-apply, and it confirms the review's framing:
the pipeline produced the conservative verdict and threw it away.

All three chain fixtures confirmed in the files:
- wirescope:5-6 — 1wl5rh superseded by 3mt55w, then 3mt55w expired.
- task-tracking:1-4 — mrg172 → jihgdf → dzvf78 → 90ml4f, and 90ml4f expired.
  Four links, every superseder itself archived.
- cross-bucket — connection-unification:16 neqwg1 → 2ndk3j, task-tracking:8
  expires 2ndk3j.

## Design (order per the ticket; item 1 first, it is the precondition)

`archive.js` splits into three stages with NO mutation before the last:

1. **collect** — parse every verdict file into `byId: Map<id, [{tag, verdict,
   arg, reason}]>`. Membership (item 6) and the pin gate (item 4) reject HERE,
   per source line, so a rejection names its bucket and line.
2. **resolve** — per id, most-conservative-wins `keep > partial > superseded >
   expired`. Forced to keep+report: two buckets naming DIFFERENT superseders,
   and any supersession cycle. Then FIXPOINT (item 2): iterate the batch until
   no `superseded` points at a unit that also dies — re-point to the surviving
   head, or demote to keep+report if the whole chain dies. Then the sole-
   refutation guard (item 3) using find-pointers' PATTERNS/resolve().
3. **apply** — move, with alarms (item 5) and the persisted record (item 7).

`run()` keeps its single-file signature as a thin wrapper over the three so the
existing call sites and tests that are still valid keep working; the new entry
point takes N verdict files.

**test/memory-consolidate.test.js:301 encodes the defect** (first-archiver-wins
across two runs, written in t135 to prove the double-archive path fires). It
gets REWRITTEN to the new rule, not preserved — flagged because I added it one
ticket ago on clodex's instruction.

## Stages 1+2 landed (archive.js)

- `collect(files, …)` — parses N verdict files, mutates nothing. Rejects per
  SOURCE LINE with its tag: unparseable, not active, **not in bucket** (item 6,
  via `bucketMembers()` reading `### mem-…` from the bucket file), self-
  supersession, and **pinned + bare expired** (item 4, `--allow-pinned-expiry`
  to override).
- `resolve(byId, …)` — `CONSERVATISM = [keep, partial, superseded, expired]`,
  most conservative wins. Conflicting superseders → keep+report. Cycles →
  every superseded member demoted to keep. Then the **fixpoint**: any
  `superseded` whose target also dies is re-pointed to the surviving head of
  the chain, or demoted to keep if the whole chain dies.
- `protectRefutations()` (item 3) — reuses find-pointers' `matchesIn` /
  `contextAt` / `docFreq` / `resolve` rather than growing a second detector.
  A unit whose body refutes a still-active belief is forced to keep.

find-pointers now exports `contextAt` / `docFreq` for that reuse. No circular
import (archive requires find-pointers, not the reverse); verified by loading.

Nits folded in: the `partial` clause regex is now GREEDY to the last matching
quote in BOTH places (the reason-split and the clause extraction) — a lazy
match ends the clause at an inner quote and the remainder reads as prose, which
damaged two clauses in the live run.

Existing 18 consolidate cases still green after the parser change.

## Stage 3 landed (archive.js)

- `applyDecided()` — the only stage that touches a file.
- `consolidate(files, opts)` — collect -> resolve -> cap check -> snapshot ->
  apply. Returns `reported` (the resolution log) alongside the usual buckets.
- Item 5: `ARCHIVE_ALARM = 0.25` (per-run rate warning) and `ARCHIVE_CAP =
  0.15` of the STORE, checked on the decided batch BEFORE stage 3 so it
  aborts rather than reports. Exit 2 when it fires; `--force` overrides.
- Item 7: `snapshot()` copies the agent dir before the first mutation;
  `--out=DIR` writes `archive.log` (the full report INCLUDING the resolution
  log, which has no other home) and `partials.txt`.
- CLI now takes N verdict files and derives each one's bucket file by stem, so
  membership checking needs no extra wiring in the shell.

Existing 31 cases still green.

## Shell + prompt + nits landed

- `consolidate.sh`: PHASE 1 collects every verdict file with no mutation, then
  PHASE 2 makes ONE `archive.js` call over all of them with `--out=$BUCKET_DIR`,
  teed to `archive.stdout.log`. `PIPESTATUS[0]` because tee eats the status.
  The false comment at :69-71 is gone (build-buckets renders all buckets up
  front, so "the next bucket sees a store reflecting this one" was never true).
- Prompt: pin-pressure framing DELETED (it hardcoded a stale count and handed a
  global quota to 22 independent calls — the only quantified goal, pointing at
  archiving); replaced with an explicit "no quota, you judge this bucket only".
  Added the refutation clause (item 3) and the missing verdict for a durable
  unit with an EXPIRED clause — that gap is why team-delegation bent `partial`
  to fit 5c0ues.
- `build-buckets.js render()` now fences body lines starting with `#`, so a
  body cannot forge a `### mem-…` header. Used a leading SPACE rather than a
  zero-width space: an invisible character would enter the corpus silently.

31 existing cases still green; `bash -n` clean.

## Tests landed — consolidate 18 -> 33, all green

Rewrote the first-archiver-wins case (it encoded the defect) into
"two buckets disagreeing resolve to the most conservative". Added 14 more:
order-independence of conservative-wins, the CONSERVATISM comparator (both
argument orders), intra-batch superseder death, the four-link chain, chain
re-point, cross-bucket chain, chain order-independence, conflicting
superseders, cycle, refutation guard (+ its negative case), pin gate (+ the
flag and the ungated supersession path), bucket membership, cap abort (+ under
cap + --force), snapshot, quotes in a clause.

### A REAL DEFECT the four-link fixture caught — in MY OWN t136 fixpoint

The sweep-until-stable loop I wrote for item 2 was ORDER-DEPENDENT. Measured on
a->b->c->d with d expired, against the pristine copy:

- forward file order: `a=keep b=keep c=keep d=expired` (1 archive)
- reversed file order: `a=superseded->b b=superseded->b c=keep d=expired` (2)

A sweep decides the head of a chain before it knows whether the tail survives,
and a demotion to keep is never undone. Replaced with a memoised recursion that
resolves each chain from its END (`headFor`/`survives`, heads computed against
the ORIGINAL verdicts then applied in one pass). No file order changes a
verdict now — pinned by the order-independence case.

### Two of my expectations were wrong, and the code was right

I asserted the four-link chain collapses to blanket keeps. It collapses to its
LAST SURVIVOR: c is kept (its superseder died), then a and b archive pointing
at c — a pointer a reader can still follow, which is the actual invariant. The
test now asserts THAT: every archived `superseded` unit's `superseded_by` must
name a unit still in the active dir. Kept the order-independence case pinned to
the literal shape too, since two orders agreeing on a wrong answer would pass
a bare equality.

## Mutants — 12, all reddening by message

or-apply (2 red) · fixpoint-off (5) · repoint-never-demotes · cycle-off ·
conflict-off · refutation-off · pin-gate-off · membership-off · cap-warns-only ·
snapshot-after-apply · lazy-clause · lazy-reason-split. Applied through a
harness that refuses to run if the product differs from pristine and verifies
byte-identity after restore; all three products confirmed identical at the end.

### Two escaped on the first pass, both fixture gaps, both now closed

- **repoint-never-demotes** — killing the "superseder is not an active unit"
  branch changed nothing observable, because every batch case had its ghost
  arrive via a same-batch death. No batch-path test existed for a superseder
  that was NEVER active. Added one; the mutant now reddens on the reported
  reason, which is the only thing that differs between the two branches.
- **lazy-reason-split** — all four clause cases put the hash BEFORE the inner
  quote, where a lazy span happens to land correctly. The case that
  discriminates is a hash AFTER an inner quote (`"the "always fence" rule # 4
  applies"`): a lazy match ends at the inner quote, and the hash search then
  starts INSIDE the clause and cuts the deliverable in half. Added, plus a
  reason assertion for the same line — a truncated clause with an intact reason
  would pass a clause-only check.

Consolidate tests: 18 -> 34. Full suite 3268/3268, ESCAPES 0.

## t136 COMPLETE — reported and closed.
