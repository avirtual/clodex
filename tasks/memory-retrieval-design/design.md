# Design: how an agent reaches what it knows

For: clodex (lead). From: clodex-designer, 2026-08-02. **Rev 2**, after cold
review — incorporates the reviewer's arithmetic (the asks index cannot serve a
one-surviving-term query at the strict gate; verified against
`probe-sources.js` `minHitsFor` and the floor) and clodex's seven decisions,
which are taken as settled here, not re-litigated.
Input: `tasks/memory-retrieval-design/pack.md` + the code it points at
(`memory-store.js`, `hint-retrieve.js`, recall-lab `probe-sources.js`,
`lib/{lexical,semantic,corpus}.js`, plus the claims corpus itself —
kind/scope distributions and the seven name-claims were re-measured, not
assumed).

---

## 1. The reframe: the two defects are not retrieval failures

The pack's suspicion — "term matching may be the wrong primitive for a
personal corpus" — is half right, and the half that's right points somewhere
more useful than a new retriever.

Look at what actually characterizes the answer-entity-absent class
(identity, relationships, preferences, "what is X's Y"):

- **stable** — the operator's name does not change between sessions;
- **compact** — the answer is a phrase, not a document;
- **universally relevant** — no conversation exists where knowing it is wrong;
- **vocabulary-saturated** — its terms (`bogdan`, `name`, `clodex`,
  `release`) are structural in the corpus *because the fact is core to the
  operator*.

That last point is the inversion worth stating plainly: **the df cap is not
merely dropping noise — high document frequency is a detector for "this
topic is central to this operator."** A term the df cap kills is a term the
whole corpus is about. Facts whose every informative term is structural are
precisely the facts that are too central to be *retrieved* — they should be
*carried*. Both open defects have this shape: "what is my name" (identity)
and "release process for clodex" (a settled procedure for the operator's
main project — which, note, is already answered inside the project's own
CLAUDE.md; it never needed the personal corpus).

And carrying is not just a cheaper venue for the same decision — it is a
**different decision in kind**. Retrieval decides relevance *conditional on
an unseen query*, per turn, under a precision constraint where every error
is invisible (a wrong hint is read once and silently mistrusted; a wrong
abstention is never seen at all). A profile card decides relevance
*query-independently, once*, over a ~3 KB artifact a human reads end to end,
where every error surfaces in a reviewable diff. Moving the
answer-entity-absent class from retrieval to carriage doesn't relocate the
relevance problem — it converts it from a per-turn statistical gamble into a
one-time, inspectable editorial act. That conversion, not the byte savings,
is why the profile card is the right mechanism for this class.

The design therefore routes facts by their character, not by their corpus:

| fact class | shape | access mechanism |
|---|---|---|
| identity, relationships, environment, contacts | stable, tiny, always relevant | **profile card** — pushed at boot, always in context |
| settled positions, standing rulings | stable, small, usually relevant | top of boot digest (as today, but fed from the knowledge layer) |
| topical preferences, operator facts, project rulings | stable, topical | **pull** — draft-triggered hints + deliberate recall, against a consolidated knowledge layer |
| project procedures | project-scoped | project docs (CLAUDE.md et al.), loaded by cwd |
| episodic history (basket) | bulky, evidentiary | never searched directly by default; reached through a claim's provenance pointers |

**The "project docs loaded by cwd" row is asserted future work, not built
and not designed here.** It appears in no implementation step and no
measurement in this document. It earns its row because the routing table
must name where settled project procedures *belong* (the "release process"
defect is evidence they don't belong in the personal corpus), but nothing
below delivers it.

Push wasn't the wrong mechanism. Push was spent on the wrong content:
8 KB of whole memory-unit bodies (2 fit) instead of ~40 distilled facts at
~80 chars each. The 112-of-190 pinned ratio is the operator and agent
*hand-building a profile card without the tooling for one* — demand for
"always carry this" massively exceeding what whole-unit push can supply.

## 2. Architecture: one pipeline, four layers

Storage, identity, and access stop being three problems when the corpora
are recognized as **stages of one pipeline**, not three parallel sources:

```
basket (raw exchanges, 10.7 MB, append-only, LIVE)
   │  extraction (LLM, batch — exists: extract/chat-claims)
   ▼
claims (distilled assertions, 565 KB) ── INTERMEDIATE ARTIFACT, carries no state
   │  consolidation (embed-cluster + EXTRACTIVE selection, offline)
   ▼
knowledge layer (deduped, minted ids, per-agent state lives HERE)
   │  profile compile (select stable ∧ compact ∧ operator-scoped, offline)
   ▼
profile card (~2–3 KB, regenerated, pushed at boot, imported as a reviewed diff)
```

Each layer has its own identity scheme and its own access mode; that is the
coupling the pack suspected:

- **basket** — immutable archive. Id: timestamp/offset, as today. Never
  carries retrieval state; never searched by default (it's where a claim's
  provenance points when the agent wants the operator's exact words).
- **claims** — extraction output. Id: **content hash of normalized claim
  text**, used only as a cache/provenance key. This dissolves blocker 1:
  the positional-id problem is real, but the fix is not better ids for
  extraction batches — it's that **extraction artifacts must not carry
  state at all**. Re-extraction just produces a new batch; consolidation
  reconciles it (§2.2).
- **knowledge layer** — the corpus retrieval actually runs against. Records
  get **minted ids** (the `mem-*` idiom memory-store already uses), stable
  because this layer is curated output, not re-derived positionally.
  Per-agent state (served, cooldown, tier) attaches only here — blocker 2's
  "no tier state for claims" resolves because raw claims never needed tier
  state; consolidated records get it for free by reusing the unit grammar.
- **profile card** — a compiled artifact, not a store. No per-record
  state; regenerated whole; **every line carries the id of the knowledge
  record it derives from**, and import into the live card is a human-
  reviewed diff, never automatic.

### 2.1 Consolidation is extractive, and it rejects rather than repairs

Clustering: embed all claims (vectors already exist), cluster within
kind+scope at a measured threshold (§7.2). Then, per cluster:

- **The merged record's text is a verbatim member, never a rewrite.** The
  canonical member is selected by authority (operator-stated >
  operator-confirmed > agent-asserted), tie-broken by newest `said_at`. All
  other members ride along as `members:` with their content hashes and
  texts preserved. Abstractive merging is repair — it authors new prose
  whose errors nothing downstream detects — and this pipeline rejects
  rather than repairs. The LLM's role in consolidation is **classification
  only** (cluster sanity, contradiction flagging, asks generation); it
  never writes the asserted text of a knowledge record.
- **Contradiction detector.** Within a candidate cluster: same subject,
  differing objects, distinct `said_at` → the cluster is NOT merged; it is
  routed whole to a review queue (a flat file the operator/agent triages).
  Claims carry no structured subject/object fields, so the detector is
  necessarily heuristic: first a cheap structural pass (members otherwise
  near-identical but differing in a number, email, or proper noun), then an
  LLM used as a yes/no classifier — a detector routing to review, not a
  repairer, which keeps it inside the reject-don't-repair rule. False
  positives cost a review glance; false negatives are bounded by the
  extractive rule (the canonical text is still a real attested claim, not a
  blend of the contradicting members).
- **Duplication becomes signal** (blocker 3): cluster size is recorded as
  `corroboration:` — five independent "Bogdan uses a MacBook" extractions
  is evidence of importance.

**Why corroboration→profile coupling stands** (decision 3 offered break or
defend; defending): the risk named — largest clusters carry both the
highest merge risk and the strongest promotion signal into an ungated boot
assertion — was real under abstractive merging, where a bad merge could
*author* the very sentence the profile asserts. Under extractive selection
it is capped: corroboration only *ranks* candidates for the card; the
asserted text is always a verbatim, authority-selected, operator-attested
claim. A bad cluster can promote the wrong attested fact, not a fabricated
one — and that failure is exactly what the two remaining guards catch:
every profile line carries its source record id, and import is a reviewed
diff. Additionally, contradiction-flagged clusters are excluded from
profile candidacy outright until reviewed. If the reviewed-diff step is
ever automated away, this defense collapses and the coupling must be
broken then.

### 2.2 Minted-id reconciliation across consolidation runs

A consolidation run must not orphan the per-agent state hanging off
knowledge ids. Reconciliation is by **provenance-hash overlap** between the
new run's clusters and the existing knowledge records:

- **Inherit**: a new cluster whose provenance overlaps exactly one existing
  record at ≥ 0.5 of the smaller set inherits that record's id.
- **Mint**: below the threshold, or overlapping nothing → mint a new id.
- **Split** (one old record's provenance lands in several new clusters):
  the largest-overlap cluster inherits the id; the others mint new ids
  carrying `split_from: <old-id>`. Per-agent state follows the inherited
  id; split-off records start clean (unserved / no cooldown / absent) —
  the safe default, since the agent may never have seen that slice.
- **Merge** (several old records land in one cluster): the id with the
  largest provenance overlap survives; the others are marked
  `superseded_by:` and kept as tombstones (never deleted — recall by a
  stale id must resolve, via the tombstone, to the successor). Per-agent
  state merges conservatively: cooldowns take the max, served-status takes
  the union — over-suppressing a hint is recoverable, re-serving spent
  content is not.
- The run emits a **reconciliation report**: counts of inherits, mints,
  splits, merges, supersessions. High churn between runs is a health alarm
  (unstable clustering threshold or a corpus shift), not routine.

The 0.5 threshold is a starting point to be validated in §7.2, not a
measured constant — treat it like MIN_COVERAGE: re-derivable, and
re-measured before trusted on a different corpus shape.

### 2.3 The knowledge layer, concretely

Reuse the memory-unit file grammar (front matter + body) — the parser,
store, recall verb, and pinning already exist and are tested. New directory
per agent, e.g. `~/.clodex/library/knowledge/<agent>/`, kept separate from
`memory/` because memory is agent-authored and knowledge is
pipeline-derived and regenerable. Front matter: what claims already carry
(kind, scope, authority, confidence, volatility, said_at) plus `sources:`
(provenance hashes / basket pointers), `members:`, `corroboration:`,
`split_from:` / `superseded_by:` where applicable, and `asks:` (§3).

The existing agent-authored memory store continues unchanged; over time
its non-settled-position content is also a consolidation input, but that is
not needed for v1.

## 3. The asks index: scoped to what the arithmetic allows

During consolidation, the classifier pass emits 2–4 short questions each
record answers — `asks: what is the operator's name? | who is Bogdan?` —
indexed as a **separate lexical index with its own df space and its own
floor** (N = records carrying asks). Separate is load-bearing: appended to
bodies, formulaic question vocabulary would inflate body-index df and re-run
the stemming failure mode (merged term spaces → df up → idf down → real
answers sink).

**MEASURED 2026-08-02 (t143, 418 asks over 107 claims, qwen2.5:7b) — this
section's original diagnosis was wrong, twice.** Both corrections stand on
numbers, not argument.

*The df cap was never what blocked the bridging term in the corpus that
matters.* Rev 1 argued `name` is "structural anyway (df 43/190 memory,
1334/13926 basket — dropped by the cap)". True for those two, but in
**claims** — the corpus the asks index would sit beside — df is 48/1650 =
2.9%, comfortably under the 132 cap. It *survives* the cap and still fails,
at **0.48× of floor**. So "reset the df landscape with a separate index"
targeted a mechanism that was not the one stopping it: the blocker is the
**floor**, not the cap.

| index | N | df(`name`) | cap | ratio |
|---|---:|---:|---:|---|
| memory | 192 | 43 | 15 | dropped by cap |
| claims | 1650 | 48 | 132 | **0.48×** |
| basket | 13926 | 1334 | 1114 | dropped by cap |
| asks | 107 | 2 | 8 | **0.85×** |

*And a separate index buys far less than it appears to.* Moving to the asks
index shifts the reachable ratio only 0.48× → 0.85× — still an abstain. The
reason is structural rather than a threshold to tune: **a smaller N lowers
the score ceiling (`log(1+N/df)`) about as fast as it lowers df.** Shrinking
the index shrinks the floor and the attainable score together, so a dedicated
index cannot buy a term its way across by size alone.

*The generation does not emit the bridge term either.* Of the 7 claims naming
the operator, exactly **1** produced an ask containing the bare word `name` —
and it is the wrong record (`claims.149[12]`, about posting under a real name
in a Facebook group). Across all 418 asks, `name` appears in 2. The model
writes in each record's own frame ("what is Bogdan Ionescu's work email?")
because **none of these records is ABOUT being named** — the name is
incidental to every one. Doc2query as prompted would not have built the
bridge at any floor; producing it requires explicitly instructing the
generator to emit identity questions, which is a far more leading mechanism
than this section describes and must be evaluated as one.

**What the arithmetic allows — and doesn't.** The reviewer's check stands:
with `weight = log(1+N/df)` and `floor = log(1+N)`, a single surviving term
clears the floor only at df=1. "what is my name?" reduces to one surviving
term, so at any realistic df it sits below floor (0.76× at df=5/N=800), and
relaxing `need` to 1 for it reproduces the known-bad #3 signature — passing
by construction, not on merit. Therefore:

- **Hard `need = 2` on the asks index. No single-term relaxation.** The
  `minHitsFor` scaling rule from probe-sources does not apply here.
- **Asks-only hits reach the deliberate-recall gate ONLY** (§4). They never
  arm an automatic hint. An automatic hint's errors are invisible;
  asks-only evidence — one index, generated text, often few surviving
  terms — is not strong enough for that channel.
- The flagship query is consequently **not** served by the asks index at
  the strict gate, and the design no longer claims it is. "what is my
  name?" is served by the **profile card** (in context before the question
  is asked — the head of the class), and at the recall gate by asks
  matches surfacing as ranked, labeled candidates the agent judges itself.
  The asks index's strict-gate contribution is the *two-informative-term
  tail* of the class — "what's the operator's wife called", "which editor
  does Bogdan prefer" — where two query terms can legitimately match a
  generated question and clear an honest floor.

**False-arm budget.** Adding a second index per source doubles the
independent draws `pickBest` maxes over: 3 corpora → up to 6 (source ×
{body, asks}) candidate verdicts per query. Max-over-draws raises arm rate
at fixed floors even if each index's per-draw rate is unchanged
(1−(1−p)^k in k). The budget is therefore explicit: **on the junk query
set, the combined arm rate across all indexes must not exceed the current
measured baseline (lexical: 1 arm in 12 junk queries).** If full-scale asks
measurement (§7.1) breaches that, the correction is raising the asks
index's own floor (per-index floors exist precisely so one index can be
made stricter), never relaxing another index to compensate. This budget is
also why asks-only hits are quarantined to the recall gate: the automatic
channel's draw count stays at 3, unchanged from today.

Zero query-time cost, no paid API, no change to body-index constants; the
three reverted approaches stay reverted.

## 4. Access: three moments, two gates

Answering pack question 1 — "at the right moment" is three different
moments with different economics.

**Boot (push).** The digest's job changes from "serve units" to "serve the
profile and the map." `DIGEST_BUDGET` **stays 8,192 bytes** — the design's
claim is density, not budget; raising it is a separate decision that needs
its own measurement of boot-context competition, and nothing below requires
it. Byte plan:

| section | min | max | overflow / eviction behaviour |
|---|---|---|---|
| head + recall instructions | 200 B | 300 B | never evicted |
| profile card | 1,024 B | 3,072 B | whole-line eviction, lowest-rank (lowest corroboration) lines first; evicted **last** among evictable sections |
| settled positions (pinned knowledge, full text) | one unit's body | 2,048 B | newest-first fill (keep `digestTiers`' anti-freeze ordering); overflow demotes body → title line → map count |
| corpus map | 256 B | 1,024 B | compresses to a single summary line; never dropped entirely while the knowledge layer is non-empty |
| tail counts | worst-case reservation | ~200 B | never evicted; reserved before filling, as `digestTiers` does today |

Maxima sum to ~6.6 KB against the 8 KB budget — deliberate slack, because
the recorded failure mode of this composer is sections starving each other
at scale. Eviction order under pressure: settled-position bodies first,
then profile lines, then the map compresses. Head and tail never.

The **corpus map** is not per-unit title lines — it is a description of
what exists and how to reach it: *"1,650 assertions about you and your
projects: 507 project facts (tempo, TRS, workbench…), 314 preferences, 247
rulings… Recall with [agent:recall] <question>."* Counts and scopes come
straight from front matter; generated, tiny, covers the whole corpus.

**Invariant test** (decision 5, and the 108-pins/0-bodies lesson: an empty
digest satisfies every size assertion): the digest test must assert
**non-zero served content per section**, conditionally — when the profile
is non-empty, ≥ 1 profile line rides; when pinned knowledge units exist and
the budget is at or above the section minima, ≥ 1 full body rides; when the
knowledge layer is non-empty, the map is present. A size-only assertion is
explicitly insufficient and must not be the only check.

**Draft-triggered hints (automatic pull).** The `hint-retrieve.js` seam
takes a second retriever, `source: 'knowledge'`, running the probe-sources
strict gate — **body index only** (per §3, asks never arm this channel),
per-corpus floors, confidence = score/floor normalized into the 0–1 band as
the header requires. Precision-first: existing floors and MIN_COVERAGE
stand; a hint that costs live tail budget keeps over-abstaining rather than
ever guessing. Nothing in hint-arm changes — that is what the seam was
built for.

**Deliberate recall (agent-initiated pull).** `[agent:recall] <question>` —
the probe-sources pipeline exposed as an intent. Concretely: results that
pass the strict gate (either index) are returned first, marked `pass`;
below them, up to k labeled near-misses — hits meeting the hit requirement
but not the floor, and asks-index matches that survive the df cap but
cannot reach need=2 — each with score, floor ratio, index, and source
shown. The agent asked, judges the results itself, and pays the cost
knowingly; a gate that must never mislead an unasked reader can afford to
be generous with a reader who asked. Same indexes, two gates — the
asymmetry is the point, and it is what keeps the corpus map honest:
"recall to reach it" only works if recall answers more often than the hint
gate does.

The basket is reachable from a recall result ("expand provenance"), not
searchable directly — its 9.54 floor and 652-char records make it the worst
cost/precision pool of the three, and the claims layer already distilled it.

## 5. Answers to the five questions, compressed

1. **How does an agent reach ~2 KB of 11.2 MB at the right moment?**
   Route by fact class, not by mechanism: compile the stable/compact/
   always-relevant head into a pushed profile card — converting per-turn
   statistical relevance decisions into a one-time reviewable editorial
   decision (§1) — and pull the topical tail through a consolidated
   knowledge layer at two gates (strict for automatic hints, generous for
   deliberate recall), leaving the archive as provenance. Boot-push is not
   insufficient — boot-push *of whole units* is. 0.07% coverage is the
   wrong metric; coverage of *questions that will actually be asked* is the
   real one, and a 3 KB profile card covers the single most-asked class
   outright.
2. **Is answer-entity-absent solvable without per-turn embeddings or a
   nonsense-admitting gate?** The head of the class — yes, by making it
   retrieval-free (profile card). The tail splits: two-informative-term
   phrasings become strict-gate-servable via the asks index at an honest
   need=2; irreducibly one-term phrasings are servable only at the
   deliberate-recall gate as labeled candidates, and that is a floor the
   arithmetic imposes, not a tuning choice — serving them automatically
   would require a gate that admits nonsense, which known-bad #3 already
   priced.
3. **What is the right unit?** All three granularities, arranged as a
   pipeline, with retrieval running against exactly one of them (the
   consolidated knowledge record — claim-sized, deduped, question-indexed,
   extractively canonical). Convergence of storage is wrong (the archive
   must stay raw; the profile must stay compiled); convergence of
   *retrieval surface* is right.
4. **What identifies a record?** By layer: content hash as cache/provenance
   key for extraction artifacts, which carry no state; minted stable ids on
   the consolidated layer, which carries all per-agent state and survives
   re-extraction via provenance-overlap reconciliation (§2.2 — inherit at
   overlap, mint + supersede below it, defined split/merge state rules);
   the profile has no record identity — it is regenerated whole, each line
   pointing at its source record.
5. **Does the three-tier model generalize?** The *contract* generalizes —
   in-context / addressable / absent is a real consumer-facing distinction
   worth preserving everywhere. The *per-unit title line* does not scale
   past a few hundred units; it is an artifact of a small corpus. The
   generalization: "addressable" splits into addressable-by-name (title
   lines, still right for pinned settled positions) and addressable-by-
   query (a described collection plus a working recall verb — the corpus
   map). With a map + recall, `absent` shrinks to "not described by the
   map," which for a consolidated corpus is nothing.

## 6. Implementation order (each stage useful alone)

Everything below runs in recall-lab first; Clodex wiring is the last step.
recall-lab stays read-only against `~/.clodex` — the lab **emits** the
knowledge layer, profile card, review queue, and reconciliation report as
artifacts in its own tree; a reviewed import step (Clodex-side command or
operator copy) moves knowledge/profile under `~/.clodex/library/`. The
profile import is a diff review by design (§2.1), not just by constraint.

1. **Consolidation pass** (recall-lab, new `consolidate/`): embed-cluster
   within kind+scope; contradiction detector routes flagged clusters to the
   review queue; extractive canonical selection; emit knowledge records
   with minted ids, members, provenance, corroboration, and asks; emit the
   reconciliation report (trivial on the first run, load-bearing on every
   run after).
2. **Asks index** (recall-lab): second index over asks text, own df space,
   own floor, hard need=2; extend `probe-sources.ask` to consult both
   indexes per source and report which index passed; wire asks-only hits
   into the near/labeled channel only.
3. **Profile compile** (recall-lab): candidates = knowledge where kind ∈
   {fact-operator, preference}, authority ≥ operator-stated, volatility
   low, not contradiction-flagged; ranked by corroboration; each emitted
   line carries its source record id; measure size. Pinned memory units are
   a strong promotion signal (they are the hand-rolled demand).
4. **Clodex wiring**, three independent pieces behind existing seams: a
   knowledge retriever for `hint-retrieve` (same shape as
   `createMemoryRetriever`, body index only); the `[agent:recall]` intent
   (intent-scanner + session-manager `_handleIntent`, same routing as
   memory recall, two-tier pass/near output per §4); digest changes in
   `memory-store.js` — profile + map sections per the §4 byte table,
   respecting every recorded failure mode around `digestTiers` (worst-case
   tail reservation, no per-pin reserve, newest-first) plus the new
   non-empty-section invariant test.

## 7. Measure before committing (in order; each can kill its stage)

**The 15/15 harness does not survive consolidation as a safety net.**
Consolidation moves claims N off 1,650 and shifts every df, so every
floor and every score changes; a harness whose expectations pin measured
behaviour against the old corpus can neither pass nor fail meaningfully
against the new one. Per clodex: a larger gold set with per-class scoring
is being built and becomes the instrument. The **differential report** a
consolidation run should emit against it:

- per query-class and per fact-class: pass / abstain / false-arm counts,
  before and after the corpus swap — deltas, not just totals;
- for every changed verdict: which index (body/asks) and which record
  served it, with score/floor ratio on both sides of the change;
- df movement of the top bridging terms (`name`, `wife`, `editor`, …) in
  both indexes, and the floor movement per index (N changes are silent
  gate changes — say them out loud);
- junk-set arm rate against the §3 budget (must not exceed baseline);
- pipeline health: cluster-size distribution vs previous run, count of
  contradiction-routed clusters, and reconciliation churn
  (inherits/mints/splits/merges/supersessions).

**7.1 Asks index — pre-registered, full-scale** (the design's main
falsifiable claim; decision 6's spec):

- Generate asks at **full scale** (all consolidated records; 1,650 claims
  is an overnight local batch). If sampling is ever substituted, the sample
  must preserve the df *ratio* — df at 1/10th scale with N at 1/10th scale,
  never full-corpus asks measured against a toy N.
- **Held-out paraphrases written BEFORE generation**: ~10 queries per
  target fact class, authored and frozen before the generator runs.
  doc2query's classic failure is answering only the phrasing the generator
  emitted; success is measured on the held-out phrasings only.
- **Pre-registered eval diff of exactly one flip**: the name query moves
  from ABSTAIN to answered-at-recall-gate (as a labeled asks candidate).
  Any other flip in the existing 15 is a failure of the measurement, full
  stop.
- Report the **measured df of each bridging term in the asks index at full
  scale**, with the gate arithmetic shown: which held-out two-term queries
  clear need=2 + floor at the strict gate, and which fall to the recall
  gate. The §3 claim that `name` is non-structural in the asks index is a
  prediction to verify, not a fact.
- Junk set runs against all 6 draws; the §3 arm-rate budget applies.
- Success: held-out two-term paraphrases pass the strict gate; the one
  pre-registered flip occurs; junk stays within budget; body-index results
  unchanged. Local model first for generation; if quality forces a paid
  batch call, that is a different cost class and gets flagged before
  spending.

**7.2 Cluster purity and reconciliation stability** — cluster at 2–3
thresholds, hand-check ~20 clusters per threshold for purity; then run
consolidation twice (second run on a trivially perturbed extraction) and
measure reconciliation churn at the 0.5 overlap threshold. Impure merges
corrupt the layer silently; unstable ids orphan per-agent state silently.
Both thresholds are corpus-specific and must be measured, not chosen.

**7.3 Profile card size and hit-rate** — compile it, then answer ten
identity/relationship/preference questions from the card alone. If it
can't stay under ~3 KB while answering them, the class boundary is drawn
wrong.

## 8. Risks and open decisions

- **LLM in the pipeline = new error class**, now narrowed by design: the
  model classifies (clusters, contradictions, asks) but never authors
  asserted text (§2.1). Asks generation is the one place model output
  enters an index — its failure mode is bad retrieval, not false facts,
  and §7.1 measures it before it ships. `said_at`/provenance stay
  never-model-authored (existing discipline). The archive layer means
  nothing is ever destroyed; every consolidated record is re-derivable.
- **Profile staleness.** The card asserts facts unconditionally; a stale
  one misleads silently. `volatility` exists — high-volatility claims are
  excluded from the card entirely (they stay pull-reachable); the card is
  recompiled on each consolidation run and re-reviewed as a diff.
- **The corroboration→profile defense is conditional** (§2.1): it holds
  while merge is extractive AND import is a reviewed diff. Automating away
  the review breaks it; that decision must revisit the coupling.
- **Consolidation cadence** is open: manual/batch for v1 (the corpus grows
  slowly); anything automatic needs a place to run and is out of scope.
- **recall-lab durability** (flagging, not scoping): the claims corpus —
  565 KB of distilled, partly irreplaceable value (the claude.ai export may
  not be re-obtainable) — lives in a non-git, non-backed-up directory.
  Worth fixing this week regardless of this design.
- **Import boundary**: "lab emits, Clodex imports" keeps the read-only
  constraint intact; if the constraint is instead amended to "never write
  files Clodex owns live," only step-4 plumbing changes.
- **Asserted, not built**: the project-docs-by-cwd routing row (§1).
- **What this design deliberately does not do**: touch the body-index
  gate's constants, re-propose any of the three reverted approaches, merge
  score spaces across corpora or indexes, relax any floor to admit a
  single-term query, or add a query-time model call.
