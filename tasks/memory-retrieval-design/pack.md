# Context pack — how an agent should reach what it knows

Written 2026-08-02 01:48 EEST by clodex (lead) for the designer seat.
Every number here was MEASURED this session, not estimated. Where I state a
constraint I also state how I know it, so you can challenge the framing rather
than inherit it.

## The problem

An agent has ~11.2 MB of durable knowledge about its operator and its projects.
It can carry roughly 8 KB of that into a conversation. The current mechanism
PUSHES a fixed digest at session start. That mechanism is now measurably full,
and the overflow is silent.

Design how an agent should actually reach this material. Storage, identity, and
access are all in scope — I do not want a tuning pass on the existing retriever.

## What exists, measured

### The push channel (Clodex, shipped)

`memory-store.js` → `digestTiers()` composes a boot digest under
`DIGEST_BUDGET = 8 * 1024`. Every unit lands in one of three tiers, and the
tiers are consumer-facing facts, not bookkeeping:

- `full` — body is in context, the agent can read it
- `title` — the agent knows the unit exists and CANNOT read it
- `absent` — invisible; the agent does not know it exists

My own store, measured this session:

| | |
|---|---|
| units | 190 (112 pinned) |
| digest | 8,184 / 8,192 bytes — **99.9% full** |
| `full` | **2** |
| `title` | 29 |
| `absent` | **159** |

Bodies get at most half the budget by construction. Pinned-first, newest-first,
whole units only; overflow is counted in a tail line, never truncated mid-unit.
The tail is the only reason withholding is safe — it is what keeps an omitted
unit countable rather than invisible.

Read the header comments in `memory-store.js` around `digestTiers` before
proposing changes there. Two failure modes are already recorded in them: a
per-pin reserve that starved bodies to ZERO at ~60 pins (108 pins, 0 bodies, no
test caught it because an empty digest satisfies every size assertion), and an
ascending pin order that froze the served set at the earliest pins forever.

### The corpora (recall-lab, `~/projects/recall-lab`, NOT a git repo, nothing backs it up)

| source | records | size | median record |
|---|---|---|---|
| memory | 190 units | 224 KB | — |
| claims | 1,650 | 565 KB | **345 chars** |
| basket | 13,926 | 10.7 MB | 652 chars |

Total **11.2 MB**. An 8 KB digest carries **0.07%** of it.

- **memory** — curated units, YAML-ish front matter + body, written by Clodex's
  `memory-store`. `~/.clodex/library/memory/<agent>/*.md`.
- **basket** — raw operator↔agent exchanges, JSONL, append-only, LIVE (Clodex
  appends to it at runtime; recall-lab is read-only against it).
- **claims** — 1,650 distilled assertions extracted from a claude.ai export.
  One or two sentences each, with `quote`, `kind`, `scope`, `authority`,
  `confidence`, `volatility`, `said_at`. Authority is 1,568 operator-stated /
  70 operator-confirmed / 12 agent-asserted. `said_at` is stamped from the cited
  message timestamps, never written by the extracting model.

The claims corpus is the reason this design is worth doing now: at a 345-char
median, three claims cost ~1 KB. It is the only source small enough that
retrieval can afford to be generous.

### The pull mechanism (`recall-lab/probe-sources.js`, working, 15/15)

Three corpora, one gate, no merged index:

- Each abstains against its OWN floor `log(1+N)` — memory 5.25, claims 7.41,
  basket 9.54. Per-corpus is what makes a 75x size difference comparable.
- Winner is the **confidence ratio** `score / floor`. Raw IDF scores from
  different-sized corpora are not comparable; the ratio is.
- **Lexical gates, embeddings rank.** Measured: junk queries score cosine
  0.490–0.600 and real ones 0.536–0.708 — the populations OVERLAP, so no cosine
  threshold separates them. Embeddings therefore only re-rank candidates lexical
  already vouched for, at sim ≥ 0.65.
- df cap `MAX_DF_RATIO = 0.08` drops structural terms.

Vector store: 15,764 vectors, 0 orphans, all three corpora embedded
(`nomic-embed-text`, 768-dim, local Ollama). Keyed by content hash — editing a
record orphans its old vector rather than replacing it, so re-indexing prunes.

Reproducible harness: `eval/run.js` + `eval/queries.json`, currently **15/15,
exit 0**. Expectations record MEASURED behaviour, not desired — one case pins a
verdict that is WRONG on purpose. Mutation-checked (`MAX_DF_RATIO` 0.08 → 0.9
makes it exit 1), so it is a real detector.

## What is already known not to work — do not re-propose without new evidence

Each was implemented, measured, and reverted this session. In-code comments at
each site record the numbers.

1. **Stemming** (fold plural/possessive `s`). Correctly folds 877 term pairs.
   Did NOT fix its target query, and made "quantum entanglement basics"
   false-arm. Merging terms inflates df → lowers idf → pushes real answers down
   while lifting coincidences.
2. **Proximity discounting** (two query terms <60 chars apart count once).
   Killed a known false arm; broke THREE correct answers doing it. Structural,
   not a bad constant: **a claim is one or two sentences, so its terms are
   legitimately adjacent** — any co-occurrence penalty punishes the distilled
   corpus hardest, and that is the corpus we most want to favour.
3. **Lowering the floor to meet single-term scores.** Every relaxed pass then
   read exactly 1.00x floor — passing guaranteed by construction rather than
   earned — and "purple elephant xylophone" answered with a SQL fragment. A gate
   that admits nonsense is worse than one that over-abstains: a false arm spends
   tokens AND teaches the reader to ignore hints.

## The open defects, and why they are the interesting part

Two pinned in `eval/queries.json`, plus one found tonight that I think is the
most informative:

**"what is my name?" — the corpus holds it, retrieval cannot reach it.**
Seven claims name the operator. But the query says `name` and the answer says
`Bogdan Ionescu` — **query and answer share no term**, so lexical cannot bridge
it by construction. `name` is structural anyway (df 43/190 memory, 1334/13926
basket, dropped by the df cap in both). Embeddings do not rescue it either: a
whole-store search tops out at 0.690 on a record ABOUT name-testing rather than
the record CONTAINING the name, while junk sits at 0.625 — a 0.025 margin. So a
direct embedding fallback would confidently return the wrong thing.

This is a class, not a case: **the answer entity is absent from the question.**
Identity, relationships, preferences, and "what is X's Y" all have this shape.

**"release process for clodex"** abstains for the opposite reason — every
informative term is structural in a corpus about Clodex releases.

Both suggest the same suspicion, which I hold loosely and want you to test:
**term-matching may be the wrong primitive for a personal corpus**, where the
most-wanted facts are exactly the ones whose vocabulary is everywhere.

## Constraints that are real

- **Clodex must never write into a user's project.** Durable artifacts live
  under `~/.clodex/`, and at its ROOT — `run/{name}/` is `rm -rf`'d on cleanup.
- **recall-lab is read-only against `~/.clodex`.** It must never write the live
  basket JSONL that Clodex appends to.
- **The retriever seam already exists** and is deliberately not memory-specific:
  `hint-retrieve.js` → `retrieve(draft, { agent, limit }) -> [{ id, text, tags,
  scope, source, confidence, evidence }]`. Its header states that project facts,
  docs and an embedding tier "must slot in here without hint-arm.js changing."
  Scores from different retrievers are NOT comparable, so each normalises into
  `confidence`.
- **A hint costs tail budget in a live turn**, so precision matters more than
  recall: a wrong hint is worse than no hint.
- Local embedding via Ollama is available and cheap. Anything requiring a paid
  API call per query is a different cost class — say so explicitly if you
  propose it.

## Known blockers for wiring claims into Clodex

1. **Positional ids.** A claim is identified as `claims.151[9]` — file plus
   array index. Re-extraction shifts them, so a tier ledger or cooldown keyed on
   them silently points at the wrong record. Content-hash ids are the obvious
   fix; whether identity should be content-based at all is yours to decide.
2. **No tier state for claims.** Memory has `full`/`title`/`absent`. Claims have
   no equivalent, so nothing can express "you know this exists, recall it."
3. **Duplication.** Independent extraction batches cannot dedupe against each
   other — five separate "Bogdan uses a MacBook" claims in one sample. At 1,650
   claims this is likely the largest waste source.

## What I want from you

Rethink access, storage, and identity together — they are coupled, and I have
been treating them separately, which may be my error.

Questions I care about, in rough priority:

1. **How should an agent reach the right ~2 KB out of 11.2 MB, at the right
   moment?** Boot-time push is provably insufficient (0.07%). Is per-turn pull
   the answer, a different index, a different granularity, something else?
2. **Is the answer-entity-absent-from-query class solvable** without paying an
   embedding call per turn, and without a gate that admits nonsense?
3. **What is the right unit?** Memory units, 345-char claims, and 652-char
   exchanges are three granularities of the same knowledge. Should they converge?
4. **What should identify a record** so it survives re-extraction, dedupes
   across batches, and can carry per-agent state (served/cooldown/tier)?
5. **Does the three-tier model generalise** beyond the boot digest, or is it an
   artifact of a fixed budget?

Challenge any of this. If the right design contradicts how I have framed the
problem, say so plainly and design the better thing — I have been inside this
for a day and may be attached to the wrong primitive.

## Where things are

- `~/projects/recall-lab/` — `probe-sources.js`, `lib/{lexical,semantic,corpus,strip-intents}.js`,
  `eval/{run.js,queries.json}`, `index.js`, `extract/chat-claims/*.json`
- `~/projects/tmux/wb-wrap-ui/` — `memory-store.js`, `hint-retrieve.js`
- `~/.clodex/library/memory/clodex/*.md`, `~/.clodex/library/basket/operator.jsonl`

Write the design to `tasks/memory-retrieval-design/design.md` and DM me the path
with a summary of the approach and anything needing a decision.
