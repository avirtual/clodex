# Historic operator messages — backfill (2026-08-01)

`scripts/mine-operator-messages.js` mined the Claude CLI transcripts into
`~/.clodex/library/basket/operator.jsonl`, the format t141's basket retriever
reads. One-time job; live capture (t140) keys off provenance at the seam and
must never adopt the rules below.

## Result

| | |
|---|---|
| transcripts scanned | 88,352 files / 10GB |
| `user`-role text entries | 113,999 |
| kept as operator messages | **13,926** (12%) |
| with the reply attached | 13,539 (97%) |
| operator text | 2.7MB |
| provenance tier / heuristic tier | 7,798 / 6,128 |

## Why 88% was dropped

The `user` role is a junk drawer. agent-workbench relays its entire bus
through it, and the vendor keeps inventing new machine shapes. Measured
category counts over the 113,999:

```
29,610  [wb:response ...] / [response ...]    tool responses
26,354  [#channel t=...]                      channel posts
22,912  [DM from <agent> ...]                 inter-agent traffic
 9,001  [DM from operator ...]                <- OPERATOR, relayed
 5,706  [system t=...]
 4,694  other bracket-prefixed
 2,643  subagent task briefs ("You are...")
   146  event=...
12,933  unlabelled prose
```

## Two tiers, and only one of them is a guess

**provenance (7,798)** — `[DM from operator t=...]` is a *recorded* sender
stamp from workbench, not an inference. Unwrapped and kept, including
messages the heuristic below would reject.

**heuristic (6,128)** — CLI transcripts record nothing about how text
arrived, so shape is all there is. The operator types in lowercase; agent
task briefs are composed prose opening with a capital ("You are…", "Review
the branch…", "Read orient.md…"). Of 15,576 unlabelled messages, 6,129 start
lowercase; a 40-message audit of those found no agent-authored text.

This drops genuine operator messages that start with a capital. That is the
intended direction: a false operator message is indistinguishable from a real
one once stored and pollutes retrieval permanently, while a missed one costs
one absent record out of thousands.

`tier` is stored on every record so a precision problem can be traced to the
tier that caused it.

## Verified retrievable

Ranked with the shipped lexical retriever over operator text + reply:

```
"what did i say about env vars and clodex settings checkbox"
  -> "we do not add random env vars. it has to be a checkbox in clodex settings"
"claude.md busts cache on every change"
  -> "that file must NOT be touched. it busts the context of all agents in your cwd"
```

## Speed: SOLVED (`basket-retrieve.js`)

Per-query rebuild was 330ms, of which 230ms was tokenizing all 13,926
records. An inverted index built once and cached against the file's
mtime+size makes a query touch only the records containing its terms:

| | before | after |
|---|---|---|
| index build | per query | 285-580ms, once |
| query | 330ms | **0.2-9.7ms** |

Cache invalidates on write, so a message captured seconds ago is
retrievable — verified by test, not by inspection.

## Precision: NOT SOLVED, and not by tuning

MIN_COVERAGE=0.35 was derived on a 182-unit store where it separated
related from unrelated cleanly (42-100% vs 19-32%). On 13,926 records it
collapses, and so does every alternative tried:

```
query                                    top mass   coverage
"env vars clodex settings checkbox"        17.3       85%    <- good hit
"claude.md busts cache on every change"    10.3      100%    <- good hit
"never commit tag or push tree dirty"      25.1      100%    <- WRONG record
"do we touch user project files"            9.8      100%    <- WRONG record
"what is the plan for today"                6.2      100%    <- WRONG record
```

Coverage cannot separate them (100% on both sides). Absolute mass cannot
either — the worst vague query outscores the best good one. Rare-term
floors from 4.5 to 5.5 either admit the wrong records or reject the right
ones.

The cause is corpus size, not the constants: with 14k records averaging
200 tokens, some record contains every term of any short query. This is
the same aboutness gap as the memory store's `z3leb7` case, made
unavoidable by scale.

**Therefore the basket retriever is built but NOT wired into arming.** The
semantic tier is the gate, not a refinement. Acceptance fixture for it:
rank the env-vars ruling above all five records that currently tie at
100% on "do we touch user project files".

## Confinement is not hypothetical

153 distinct `cwd` values; 651 records touch crypto/trader/stocks, including
`/Users/bogdan/projects/crypto-trader` (223). t141's rule — confinement
enforced BEFORE ranking, never by scoring — has real records to exclude on
day one. `agent` and `workspace` are null for every mined record: history
predates that seam and it is not reconstructable.
