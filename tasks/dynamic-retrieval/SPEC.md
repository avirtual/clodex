# t141 — dynamic retrieval across memories + operator basket

Turn the single-source ranker t139 builds into a multi-source one: agent
memories AND the operator basket, ranked together, feeding the same arming
decision.

**Depends on t139 (hint arming) and t140 (basket capture). Do not start until
both have landed** — this ticket is the merge layer between them and has
nothing to build on its own if either is missing.

## The problem this exists to solve

Scores from different retrievers are NOT comparable. Measured 2026-08-01 on
the real 178-unit corpus: lexical IDF returns 8.90 for a strong match; cosine
similarity returns 0.82 for a strong match. Sorting a merged list by raw
score puts every lexical result above every semantic one, permanently.

So: each retriever normalises to a documented 0-1 `confidence` band, and the
band is part of the retriever's contract, not a constant in the merge code.
A retriever that cannot state its band does not get merged — it can only be
its own tier.

## Interface (fixed by t139, do not change it)

```
retrieve(draft, { agent, workspace, cwd, limit })
  -> [{ id, text, tags, scope, source, confidence, evidence }]
```

`source` is the retriever name. `evidence` is why it matched (matched terms
for lexical) and exists so a bad hint can be diagnosed without re-running the
query.

## Retrievers in this cut

1. **memory** — exists from t139. Unchanged.
2. **basket** — new. Reads `~/.clodex/library/basket/operator.jsonl` plus
   today's `raw/YYYY-MM-DD.jsonl` (today's data must be retrievable the same
   day; the nightly pass is a compaction, not a gate on visibility).

Both lexical this cut. A local-embed tier (Ollama nomic-embed-text, 16ms
warm, measured) is a later ticket and must slot in behind this interface
without editing the merge.

## Basket retriever specifics

The record is an exchange: operator text plus the reply that answered it.
**Index both halves, return the exchange.** A question is often findable by
words that appear only in the answer.

Cap what a single basket hit contributes to the hint — an exchange can be
long. Truncate the reply half first, the operator half last: the operator's
words are the durable part.

Recency matters here in a way it does not for curated memory. A curated unit
was promoted because it was durable; a raw basket line is just something that
was said. Apply a mild recency prior and state the function you used in the
JOURNAL. Mild: it must not let a recent irrelevant line outrank an older
exact match.

## Destination is a feature, not a filter

The operator's ruling: one basket, destination scores rather than partitions.

Boost, do not filter:
- `agent` on the record equals the querying agent
- `workspace` matches
- `cwd` matches

The reason this is not a filter, in the operator's own words: standing
rulings are routinely said to ONE agent and bind ALL of them ("never commit,
tag or push" was said to clodex-hand and governs the lead's review
behaviour). A hard destination filter drops exactly those, and drops them
silently — nothing in any log shows a ruling that failed to surface.

State the boost weights in the JOURNAL. A strong cross-agent match must still
be able to beat a weak same-agent one; verify that with a test.

## Confinement — the one hard boundary

Boosts are relevance. Confinement is not, and must be enforced BEFORE
ranking, not by scoring.

A source declares which sessions may read it. Records whose `cwd` or
`workspace` falls outside the querying session's allowed set are never passed
to the ranker at all — not ranked low, not seen.

Concretely: finance-agent context (trader, stocks, crypto, degen) must not be
rankable from a session working in a public repo, at any score. Implement the
mechanism generally (a per-source predicate over the querying session), not
as a hardcoded list of agent names.

Test that a confined record cannot surface even when it is a perfect lexical
match — a confinement test that passes because the record scored low is not a
test.

## Merge

- Query retrievers in parallel; a slow or throwing retriever must not block
  or fail the others. Budget the whole merge at 50ms and return what is ready
  (lexical measured at 0.14ms/query, so this is a fault ceiling, not a
  typical cost).
- Dedupe across sources by id, then by normalised text — a promoted basket
  line can also exist as a curated memory unit. Prefer the curated copy: it
  was promoted deliberately and is shorter.
- Per-source cap so one source cannot fill the hint alone.
- Total tail budget for the composed hint stays where t139 set it.

## Suppression carries over unchanged

Both suppression ledgers from t139 apply to basket hits too:
- already in context (`memory-load.js` `stateOf`) — FULL suppresses, TITLE
  does NOT (best hint case), ABSENT offers, unknown/error offers
- already offered — per (agent, id), 10min cooldown or until clear/compact

A basket record has no `stateOf` (it is not a memory unit and cannot be
`recall`ed). Treat it as ABSENT always, and rely on the already-offered
ledger for repeat control. Do NOT invent a load state for basket records —
that would make `stateOf` start lying, which is the failure t139 is built to
avoid.

## Retrieval accounting

Every returned record gets a `retrieval_count` and `last_retrieved_at`
incremented on ARM (a hint was actually posted), not on rank.

This is the feedback loop that makes ingestion policy correctable by evidence
instead of argument. Workbench's DB is the cautionary case: 4,822 fragments,
**73% never retrieved once**, and nobody knew until it was counted. "Never
retrieved in N sessions" is a fact; "reads stale" is a judgement, and the
judgement is what inverted on 2026-07-31.

Counters live beside the source, never inside the memory unit's frontmatter
(a retrieval must not dirty a curated file).

## Tests

- Two retrievers with different raw score scales merge in a sane order.
- A retriever that throws does not fail the merge.
- A retriever that hangs is dropped at the budget.
- Cross-agent strong match outranks same-agent weak match.
- Confined record does not surface on a perfect lexical match.
- Dedupe prefers the curated copy.
- Today's raw basket lines are retrievable before any nightly run.
- Basket record is never marked loaded; repeat control comes from the offered
  ledger.
- retrieval_count increments on arm, not on rank.
- No curated memory file is modified by a retrieval.

Suite green: `[agent:exec clodex-run-tests]`, baseline 3279.
New modules go in `test/free-identifier-leaks.test.js` SCANNED_MODULES.

## Journal

`tasks/dynamic-retrieval/JOURNAL.md`, as you go: confidence bands per
retriever and how derived, boost weights, the recency function, and anything
in t139/t140's seams that did not match this spec.

## Standing constraints

Do not commit, tag or push. Leave the tree dirty for review. No secret values
in argv, logs, markers or errors. No emojis. Comments earn their place by
naming a wrong change they prevent.
