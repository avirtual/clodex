# t126 — memory digest serves zero bodies at scale (composeDigest starvation)

## Repro, before any change

    units 191 pinned 108
    0 bodies 8248 bytes

Confirmed against the lead's live store. Note the digest is also **56 bytes
over** the 8192 budget — the tail is appended unconditionally today, after the
index loops have already filled to `budget`. Not the reported bug, but the same
region, and the new index limit fixes it as a side effect.

## Cause (verified in source, `memory-store.js:186-213`)

`reserveAfter[i]` sums a fallback index line for EVERY remaining pin before any
body is spent. 108 pins × ~132 bytes = ~14.2KB > 8192, so
`used + block.length + reserve > budget` is true at i=0 and every i after it.
Every pin demotes; the body loop can never serve anything again once a store
crosses ~55-65 pins. The reserve is not a tuning problem — it is unbounded in
the number of pins while the budget is fixed.

## Policy change (as specced by the lead)

1. Bodies newest-first until **half the budget** is spent. No hardcoded count:
   bodies run 248→2000 bytes, so the count follows the store.
2. Remainder to index lines, demoted pins first (ordering preserved).
3. Reachability moves from the per-pin reserve to the **tail**, which names the
   total and the verb and must appear whenever anything was withheld.

The old reserve fixed a real bug (`:188`: 97 pins → 8 bodies, 89 pins with no
line at all). That property must survive under the new mechanism, which is why
`test/memory-store.test.js:184` is REPLACED rather than deleted.

## Vacuity trap

"The digest fits the budget" is maximised by serving nothing — which is exactly
how this bug survived a green suite. The load-bearing test must assert bodies
ARE served at scale (>= 3) as well as the size bound.

## Plan

1. `memory-store.js` — replace the reserve loop with a body budget; add a tail
   reserve so the index cannot crowd the tail out; update the header comment at
   `:146-150`, whose "demoted to an index line, never dropped" clause is already
   false (a demoted pin CAN be omitted when the index overflows).
2. `test/memory-store.test.js:184` — replace with the same reachability property
   under the new mechanism (every withheld pin accounted for by the tail count),
   plus the at-scale body assertion.
3. `cli-hooks.js:70-71` — delete the stale "startup/clear only" claim; `:105`
   and `:107` already say compact is included.

## Implemented

1. **`memory-store.js`** — reserve loop replaced by `bodyBudget = floor(budget/2)`.
   Two things the spec did not name, both forced by the code:
   - The `Pinned (full text):` header now emits with the FIRST body rather than
     before the loop. One oversized pin demotes everything, and the old
     placement left an empty section header behind.
   - The index loops now fill to `limit`, not `budget`, where `limit` reserves a
     WORST-CASE tail. The tail was appended unconditionally after the loops had
     already filled to `budget`, so a full index pushed the digest over — the
     live store measured **8248 bytes against a 8192 budget** before this change.
     The exact tail cannot be reserved (its numbers come out of the loops it
     bounds), so the reservation is the largest tail the clause set can produce.
2. **`test/memory-store.test.js:184`** — replaced, not deleted, per the spec.
   The tail-accounting property is read back FROM THE TAIL'S OWN WORDS rather
   than recomputed, since the tail is all a digest reader has.
3. **`cli-hooks.js:70-71`** — stale clause deleted (`:104-106` already says
   compact is included).

## Verification

Repro after the fix: **4 bodies, 8188 bytes** (was 0 bodies, 8248 bytes).

| # | mutant | result |
|---|---|---|
| M-1 | product reverted to the reserve loop | 2 fail — `got 1` body |
| M-2 | `bodyBudget = budget` (greedy, the naive "delete the reserve" fix) | 6 fail |
| M-3 | index limit back to `budget` (tail unreserved) | 1 fail — `8279 bytes, over the 8192 budget` |
| M-4 | tail suppressed | 3 fail |

Product restored byte-identical after every mutant (`diff` against a pristine copy).

### A hole in my own test, found by M-2 and fixed

My first draft of the at-scale case guarded the greedy fix with `listed > 0`.
It **passed** under M-2 — greedy still emits 8 index lines, just not 80 — so the
assertion could not distinguish the two policies and my comment claiming it
could was false. Replaced with the invariant that IS the policy: body bytes
<= half the budget. That fails at `bodies took 7440 of 8192`.

Worth recording why the weak version looked fine: greedy bodies do not produce
zero index lines, they produce a few. An assertion against zero tests a
degenerate case the mutant never reaches. Measured both (3 bodies/80 lines vs
6 bodies/8 lines) rather than reasoning about it.

### Collateral test predicted to move

`:108 'composeDigest: pinned units are served newest-first'` asserts TWO of
three 300-byte bodies are served at `budget: 1000`. Under a half-budget that is
one body, so the ordering property it names needs a budget where two still fit.
Bumping its budget preserves exactly what the test is for; rewriting its
assertions would not. Flagged as a deviation-adjacent judgement call.

Confirmed: it failed exactly as predicted (`/## mem-2-middle\ny{300}/` no
longer matched) and the budget moved 1000 → 1600. Assertions untouched.

## Result

Full suite **3208/3208 green, ESCAPES: 0** (was 3207; net +1 = one test added,
one replaced in place). Live store: **4 bodies, 8188 bytes**, inside budget.

No `build:web` — nothing bundled was touched.
