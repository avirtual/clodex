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

## Two blockers for t141 — measured, not predicted

1. **Coverage saturates.** MIN_COVERAGE=0.35 was derived on a 182-unit memory
   store. Document frequencies over 13,926 short messages are far flatter, and
   several unrelated records tie at 100% coverage. The threshold does not
   transfer; the basket retriever needs its own calibration, measured on this
   corpus. This is exactly why the spec says a retriever that cannot state its
   confidence band gets its own tier rather than being merged.

2. **330ms per query** vs 9.6ms for the memory store — 34x, and the Enter path
   is synchronous before `pty.write`. The basket cannot be ranked the same way
   the memory store is. Needs a persisted index, not a per-query rebuild.

## Confinement is not hypothetical

153 distinct `cwd` values; 651 records touch crypto/trader/stocks, including
`/Users/bogdan/projects/crypto-trader` (223). t141's rule — confinement
enforced BEFORE ranking, never by scoring — has real records to exclude on
day one. `agent` and `workspace` are null for every mined record: history
predates that seam and it is not reconstructable.
