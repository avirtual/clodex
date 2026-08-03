# t150 — wire/billing.js ↔ billing.py parity (`now` + PRICES_DATED)

Seat: clodex-hand. Started after `d3d0bdc` landed and the hold was lifted.
Files touched: `wire/billing.js`, `test/wire-billing.test.js`, this journal.
Nothing else. No commit.

## What changed

**`wire/billing.js`**
- Added `PRICES_DATED` — `claude-sonnet-5` → standard rates on `2026-09-01`,
  field-for-field from `vendor/wirescope/proxylab/billing.py:215-221`.
- Added `localDay(now)` — mirrors the vendor's
  `time.strftime("%Y-%m-%d", time.localtime(now))`. LOCAL, not UTC. Accepts a
  Date or epoch **ms** (JS convention; the vendor's takes epoch seconds — noted
  in the comment, it is the one deliberate signature divergence).
- `priceFor(model, table, speed)` → `priceFor(model, { table, now, speed })`.
  Object form per the spec: it is what makes the vendor's positional `now`
  un-mis-orderable by a future porter.
- Overlay order is the vendor's: **dated first, then fast** on the same winning
  prefix. Both still gated on the default table only.
- The `⚠️ FLIP ON 2026-09-01` hand-edit note above the sonnet-5 row is gone —
  the schedule now does that job, and editing the base row in place would
  retro-reprice receipts billed before the flip.
- `PRICES_DATED` added to the export list.

Call sites updated (all of them; `grep` confirms none left):
`wire/billing.js:186` (`{ speed }`), `:202` (`{}`), `:238`
(`{ table: PRICES_OPENAI }`), export at :343.

**`test/wire-billing.test.js`** — 17 → 22 tests. Existing tests converted to the
object form. Five new:
1. `PRICES_DATED` flips sonnet-5 on 2026-09-01, both sides of the boundary
   (`>=` not `>`), dated model ids, post-flip row `deepEqual` sonnet-4, epoch-ms
   accepted, unscheduled models untouched, base row still intro.
2. The boundary is the LOCAL day, not UTC — asserts the last local minute of
   08-31 and the first of 09-01.
3. Overlay order (dated before fast) + an invariant assertion that the two
   tables do not yet overlap, which is why the order is unobservable today.
4. Options are named — the old positional shape now returns `null` for an
   openai id rather than wrong rates.
5. `billing()` prices at receipt time off the same row `priceFor` returns.

Two pre-existing clock reads were made explicit: the sonnet-5 intro assertions
in the longest-prefix test now inject `BEFORE_FLIP`. Without that they would
have silently become assertions about a *different* rate on 2026-09-01 — a
green that changes meaning on a date is worse than a red.

## Mutation kill counts (6 run, 4 kill, 2 escape)

| # | Mutation | Result |
|---|---|---|
| M1 | drop the dated overlay entirely | **KILL** 4 fail |
| M2 | swap overlay order (fast then dated) | **ESCAPE** 0 fail |
| M3 | boundary `>=` → `>` (flip a day late) | **KILL** 4 fail |
| M4 | `localDay` → `toISOString().slice(0,10)` (UTC) | **KILL** 1 fail *(after adding test 2; escaped before it)* |
| M5 | dated overlay loses its `!table` guard | **ESCAPE** 0 fail |
| M6 | options silently accept a positional table | **KILL** 9 fail |

The two escapes are **structural, not gaps in the tests**, and both are declared
in the test file rather than papered over:

- **M2 (order).** No model exists in both `PRICES_DATED` and
  `PRICES_SPEED_FAST`, so the order genuinely has no observable effect today.
  I pinned the emptiness of the intersection instead, with an assertion message
  telling the next person to add a direct order assertion the moment a model
  lands in both. Faking a kill would have meant inventing a table entry, i.e.
  testing a fixture rather than the product.
- **M5 (`!table` guard on the dated overlay).** Same vacuity the file already
  declares at :52-56 for the fast guard: `PRICES_DATED` holds only `claude-*`
  keys, so no openai id can reach it even unguarded. The guard is kept because
  it is what keeps that true if either table grows a colliding prefix.

M4 is worth noting: it escaped on the first pass and I added a test for it
rather than reporting the escape. This box is UTC+3, so the east-of-UTC edge
bites; **at `TZ=UTC` that test is vacuous by construction** and says so in a
comment. It cannot be made to bite in every timezone from one assertion pair.

## Verification

`node --test test/wire-billing.test.js` → **22/22**.
Vendor parity re-checked field-for-field after the edit: `PRICES_DATED` and
`PRICES_SPEED_FAST` dumped from the JS module match `billing.py:209-221`
exactly; overlay order matches `_price_for`'s.

Full suite (`clodex-run-tests`): **3557/3557 green, 0 escapes.** Baseline was
3552; the delta is exactly the 5 tests added here. No `cli/test/attach.test.js`
wedge this run.
