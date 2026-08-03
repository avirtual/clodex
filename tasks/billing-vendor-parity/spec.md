# wire/billing.js ↔ billing.py parity: `now` and PRICES_DATED

Found by cold review of the prompt-refresh rework (NIT 4), deliberately left
out of that change set — it is the vendor-parity seam, not the refresh.

## Deadline

`PRICES_DATED` flips `claude-sonnet-5` to standard rates on **2026-09-01**
(`vendor/wirescope/proxylab/billing.py:215-221`). The JS port has no dated
table at all, so from that date it bills sonnet-5 at the expired intro rate
with nothing signalling the divergence. This is the reason the ticket has a
date rather than a backlog slot.

## Two defects

1. **Positional divergence.** Python is
   `_price_for(model, table=None, now=None, speed=None)` (`billing.py:224`);
   JS is `priceFor(model, table, speed)` (`wire/billing.js:82`). Any future
   port of a `now`-taking call site silently lands `now` in `speed` — which
   fails open (no throw, just wrong rates), the same shape as the missing
   opus-5 row that made turns bill zero.
2. **`PRICES_DATED` absent** from the JS side entirely, plus the flip is
   tracked only as a hand-edit note at `wire/billing.js:30-33`.

## Shape

Prefer `priceFor(model, { table, now, speed })` over adding an ignored
positional `now`: the object form cannot be mis-ordered by a future porter,
which is the actual failure being prevented. Callers are few — `billing()`
at `wire/billing.js:186,202` and the export at :343; `billingOpenai` passes
no speed.

Port the dated overlay in the vendor's order: dated overlay first, then the
fast-mode overlay on the same winning prefix (fast currently wins on the
models where both could apply, and that ordering is the vendor's).

## Verification

- Vendor parity is the spec: diff the JS against `billing.py:202-248`
  field-for-field, as the reviewer did for the fast-mode rows.
- Extend `test/wire-billing.test.js`. It already covers the fast axis
  (:35-125) and self-declares one vacuous assertion (:52-56) — keep that
  honesty. `now` being injectable is the whole point: pin the 2026-09-01
  boundary from both sides with an injected clock, never the real one.
- Mutation-check the new tests before trusting them (drop the dated overlay;
  swap the overlay order) — a dated-table test that passes against a missing
  table is the easy false green here.

## Do not

Touch `wire/billing.js` while the prompt-refresh rework is uncommitted — that
tree already modifies this file. Dispatch only after it lands.
