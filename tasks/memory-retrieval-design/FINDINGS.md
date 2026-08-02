# Memory retrieval — what the measurements settled

Written 2026-08-02 05:00 EEST by clodex (lead), after an overnight measurement
run in `~/projects/recall-lab`. This is the verdict layer over `design.md`; the
design itself is unedited. Every number here was reproduced independently of the
worker that produced it.

**Read this before proposing anything about memory retrieval.** Six of the
design's open questions are closed by measurement. Re-opening any of them costs
new evidence of a different kind, and the specific kind is named per item.

Full evidence lives in `~/projects/recall-lab/tasks/*/journal.md`, each with a
CLOSE-OUT block at the top. The lab is local-only and has no remote.

## The one-sentence result

**Every failure is a selection failure.** Capacity, reachability and mechanics
were never the binding constraint — the 88 records that answer the gold set fit
in 26 KB, and retrieval reaches the right record 91% of the time at depth 50.
We cannot name the right records without the answer key.

## Closed by measurement

| # | Question | Verdict | Reopening costs |
|---|---|---|---|
| 1 | Can the lexical gate be tuned into precision? | **No.** 60-cell floor×SEM grid: hit@3 spans 27–49% against a shipped 48%. Zero cells beat baseline on wrong-record AND abstention. | A better ranker or tokeniser — not another cell, sweep or grid. |
| 2 | Are floor and SEM_PROMOTE independent? | **No.** `near` is the exact complement of `pass`, and `near` IS the promoter's candidate set. Raising the floor RELOCATES a false arm from gate to promoter (lexical arms 19→0, promoted 2→12, total frozen). | Nothing — this is structural, read `probe-sources.js:96`. |
| 3 | Can cosine decide cluster membership for merging? | **No.** Two different people at two different clients sit at cosine 0.9264 in the same kind+scope cell — above the whole tested band. Purity 20/55/80% impure at t=0.92/0.88/0.85. | A non-cosine membership gate. This is the open decision below. |
| 4 | Can query discriminability gate abstention? | **No.** Rarest-term df predicts *reachability* beautifully (rare-term queries 82% top-3 / 5% unreachable; common-term 30% / 40%) but hard negatives have LOWER minDf than positives (median 18 vs 40). Anti-predictive for absence. | A signal correlated with corpus *silence*, which this is not. |
| 5 | Can a profile card be selected automatically? | **No.** Blind selectors reach 0–8% of gold; nothing beats picking the shortest records. Non-corpus signals (pinned, authority, volatility, confidence, age) all land at or below the random baseline, ≤6% of oracle. | A matured usage signal, or a human editorial pass. |
| 6 | Does the card have room for the answers? | **Yes — this one survives.** All 88 gold-named records cost 26 KB. Identity+preference is 24 records in 4.3 KB; 3 KB buys 81% of it. Oracle card: 51% coverage at 8 KB, 91% at 32 KB. | — |

## The ceiling, which bounds anything built next

Ungated, over all 15,777 records, 106 gold positives:

| channel | @1 | @3 | @10 | @50 | unreachable |
|---|---|---|---|---|---|
| semantic | 46% | 57% | 67% | 81% | 20 |
| lexical | 34% | 45% | 59% | 78% | 23 |
| **union (oracle)** | **55%** | **66%** | **76%** | **91%** | **10** |

Two things follow, and they point opposite ways. Reachability at depth 50 is
91% against a shipped hit@3 of 48%, so **~17 points of top-3 are lost to
admission policy, not reachability** — that is fixable architecture. But an
oracle picking the better channel per query still ranks correctly first only
55% of the time, so **a perfect reranker caps at 66% @3**. Fixing the gate buys
a better system with a hard roof, not a solved one.

## Why the failures cluster where they do

Every signal that failed — df weighting, cosine, degree centrality, minDf — is
a **function of the corpus text**. They collapse on exactly the questions whose
text is generic ("What does Bogdan do at work?" has no term rarer than df 3558).
That is not a ranking failure: there is no signal in the query to rank on.

The non-corpus signals were the remaining hypothesis and they failed too, but
for a different and more interesting reason — see the shape mismatch below.

## Live, not closed

- **Carriage itself.** §7.3's size premise survived; only its selector is
  missing. A human picking the card once is an inspectable editorial act, which
  is what §1 argues the mechanism is *for*. Not a measurement's call.
- **The `pinned` shape mismatch.** 126 pinned records, median body over 1 KB, so
  an 8 KB card fits 7.9 of them. Pinning marks a unit always-relevant, but the
  unit is a page and the card needs a line. **The card wants short authored
  assertions — a different artifact from a memory unit.** This is the most
  promising unexplored direction.
- **Access frequency is immature, not refuted.** `library/memory-loadlog/` holds
  5 events over one day. **Do not instrument digest deliveries to fatten it**:
  a digest delivers *pinned* units, so digest frequency IS a pinned-ness signal,
  and pinned measured at 2% of oracle — below random. Only explicit recall is an
  honest usage signal, and it accrues at ~5/day. Revisit in months.
- **Metadata partitions rather than ranks.** No field spans both corpora:
  `pinned` is memory-only, `authority`/`volatility`/`confidence` are claims-only.
  A real implementation hits this before it hits any threshold.

## Open decision — Bogdan's, raised and unanswered

Extractive merge is safe only if something other than cosine decides cluster
membership, which promotes the LLM from sanity-check to **gatekeeper over 1,650
claims** — a different cost class than `design.md` assumed.

**Tonight's work argues against spending it.** Consolidation's main purpose was
to feed the profile card, and the card's binding constraint turned out to be
selection, not merging or space. Merging 1,650 claims does not help us *name*
the right 88 records. The decision stands open, but its expected value dropped.

## Instrument gotchas — these cost real time to rediscover

- **`eval/gold.js` MUTATES `data/vectors.bin`.** Any A/B through it must give
  each arm its own copy. This confounded one run.
- **An LLM judge needs a directional-bias check, not just an agreement rate.**
  qwen2.5:7b scored 60% three-way against hand labels, and its bias pointed *at
  the conclusion under test* — it demanded records echo the question's
  vocabulary, so it read true answers as merely "related". Taken at face value
  it would have looked like clean confirmation.
- **A clean zero is a claim about the instrument until proven otherwise.** The
  labelled oracle is what separated "the card cannot work" from "this selector
  does not work" — opposite conclusions from the same near-zero table.
- **Check base rates before reading a proportion as signal.** 9 of 10 unreachable
  queries were `source:"synth"` — and so were 104 of 106 positives.
- **Capitalisation is not specificity.** Labelling by proper noun/acronym gives a
  flat result; only corpus rarity works.

## Landed in Clodex from this work

- `f291295` — basket duplicate collapse. One message broadcast to several
  worktrees was journalled once per destination: 802 ids across 2–4 worktrees,
  983 of 13,926 lines (7%), giving one exchange several shots at every ranked
  list and pushing four terms over the df cap. Collapsed on id+text with every
  origin carried, so confinement does not narrow.
- `f291295` also corrected the confinement comment above `rank()`, which claimed
  index-time dropping the code does not and cannot do (the index is cached
  across queries; `allow` varies per query).
- `a4c5b31` — the hint preamble now states that delivery is one-shot.

**Not contaminated, checked before assuming:** Clodex's live memory store is
clean (455 units, 106 scopes, all topic labels, zero paths), and
`basket-retrieve.js` already handled cwd correctly. The cwd-in-scope defect was
the lab's loader, not the shipped product.
