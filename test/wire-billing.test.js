'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PRICES, PRICES_OPENAI, PRICES_SPEED_FAST, PRICES_DATED, priceFor, round6, billing, billingOpenai, newTotals, bump, Ledger } = require('../wire/billing');

// Both sides of the WITHDRAWN sonnet-5 repricing's old effective date, as LOCAL
// noon so no timezone offset can carry either across the boundary. Every dated
// assertion injects one: reading the real clock would leave these tests passing
// only because of which side of 2026-09-01 the suite happens to run on.
const BEFORE_FLIP = new Date(2026, 7, 31, 12, 0, 0);  // 2026-08-31
const AFTER_FLIP  = new Date(2026, 8, 1, 12, 0, 0);   // 2026-09-01
const LONG_AFTER  = new Date(2027, 0, 15, 12, 0, 0);  // 2027-01-15

// The dated MECHANISM outlived its only entry, so every assertion about the walk
// is vacuous against an empty PRICES_DATED. Register a synthetic schedule on a
// real prefix and remove it in a finally, so the walk stays pinned and no other
// test sees the entry.
function withDated(pfx, schedule, fn) {
  PRICES_DATED[pfx] = schedule;
  try { return fn(); } finally { delete PRICES_DATED[pfx]; }
}

test('round6 matches Python round(): ties-to-even on the exact binary value', () => {
  // exact dyadic ties — toFixed would give ...63 / ...25; Python gives even.
  // Golden-gate regression: 203125 * 0.50 / 1e6 and 78125 * 0.50 / 1e6.
  assert.equal(round6(203125 * 0.50 / 1e6), 0.101562);
  assert.equal(round6(78125 * 0.50 / 1e6), 0.039062);
  assert.equal(round6(0.0000015), 0.000002); // 0.0000015 double is above the true tie
  // non-tie: the double for 1.0000005 sits slightly ABOVE the true tie
  assert.equal(round6(1.0000005), 1.000001);
  assert.equal(round6(0), 0);
  assert.equal(round6(-0.1015625), -0.101562);
  assert.equal(round6(0.026262), 0.026262);
});

test('priceFor: longest prefix wins (opus-4-8 must not hit legacy opus-4)', () => {
  assert.equal(priceFor('claude-opus-4-8-20260115').in, 5.0);
  assert.equal(priceFor('claude-opus-4-1-20250805').in, 15.0); // legacy pricing
  assert.equal(priceFor('claude-fable-5').in, 10.0);
  assert.equal(priceFor('claude-sonnet-5', { now: BEFORE_FLIP }).in, 2.0);
  assert.equal(priceFor('claude-sonnet-5-20260601', { now: BEFORE_FLIP }).cache_read, 0.20);
  // sonnet-4.x must still fall through to the sonnet-4 entry.
  assert.equal(priceFor('claude-sonnet-4-5-20250929').in, 3.0);
  assert.equal(priceFor('unknown-model'), null);
  assert.equal(priceFor(null), null);
  assert.equal(priceFor('gpt-5.4-mini', { table: PRICES_OPENAI }).out, 4.5);
  assert.equal(priceFor('gpt-5.4-turbo', { table: PRICES_OPENAI }).out, 15.0); // prefix of 5.4
});

// FAST MODE — the premium row was missing from this port entirely while the
// vendor had carried it since 2026-07-25, so every fast-mode turn under-billed
// by exactly 2x. Silent by construction: the model IS priced, so nothing takes
// the unpriced branch and no warning fires — the totals just come out half.
test('priceFor: speed=fast overlays the premium row, and only where one exists', () => {
  assert.equal(priceFor('claude-opus-5', { speed: 'fast' }).in, 10.0);
  assert.equal(priceFor('claude-opus-5', { speed: 'fast' }).out, 50.0);
  assert.equal(priceFor('claude-opus-5').in, 5.0, 'absent speed is standard');
  assert.equal(priceFor('claude-opus-5', { speed: 'standard' }).in, 5.0, 'explicit standard is standard');
  // Matched on the SAME winning prefix: opus-4-6 has no premium entry, so a
  // fast ASK that the model silently downgraded keeps standard rates rather
  // than falling through to a shorter prefix's premium.
  assert.equal(priceFor('claude-opus-4-6-20260101', { speed: 'fast' }).in, 5.0);
  assert.equal(priceFor('claude-sonnet-5', { speed: 'fast', now: BEFORE_FLIP }).in, 2.0);
  // Dated ids must reach it too — that is what actually arrives on the wire.
  assert.equal(priceFor('claude-opus-4-8-20260115', { speed: 'fast' }).in, 10.0);
  // An explicit table is the caller's own axis; anthropic premiums must not
  // leak onto it. NOTE this assertion is currently VACUOUS — PRICES_SPEED_FAST
  // holds only claude-* keys, so no openai id can match one even with the
  // `!table` guard removed (mutation-verified). Kept as a live example of the
  // intended contract, and because the guard is what keeps it true if either
  // table ever grows a colliding prefix. Do not read its green as coverage.
  assert.equal(priceFor('gpt-5.4-mini', { table: PRICES_OPENAI, speed: 'fast' }).out, 4.5);
  // The premium equals fable-5's row (universal cache multipliers on top).
  assert.deepEqual(PRICES_SPEED_FAST['claude-opus-5'], PRICES['claude-fable-5']);
});

// The 5.1 read rate is the WHOLE point of the row, and the pair is the whole
// point of the test: 'claude-fable-5' is a prefix of 'claude-fable-5-1', so
// dropping the 5.1 row prices 5.1 reads 4x over while longest-prefix SUCCEEDS on
// the 5.0 row — priced, no unpriced warning, no signal anywhere. Either rate
// asserted ALONE is satisfied by a table where one row swallows the other.
test('priceFor: fable-5-1 keeps its own read rate and is not swallowed by fable-5', () => {
  assert.equal(priceFor('claude-fable-5-1').cache_read, 0.25);
  assert.equal(priceFor('claude-fable-5').cache_read, 1.00);
  // The dated ids that actually arrive on the wire must land the same way.
  assert.equal(priceFor('claude-fable-5-1-20260901').cache_read, 0.25);
  assert.equal(priceFor('claude-fable-5-20260601').cache_read, 1.00);
  // The read rate is the ONLY delta from 5.0 — 5.1 breaks the universal 0.1x
  // read multiplier and nothing else, so a row copied wholesale is wrong too.
  assert.equal(priceFor('claude-fable-5-1').in, 10.0);
  assert.equal(priceFor('claude-fable-5-1').out, 50.0);
  assert.equal(priceFor('claude-fable-5-1').cache_write_5m, 12.5);
  assert.equal(priceFor('claude-fable-5-1').cache_write_1h, 20.0);
});

// The vendor's PRICES carries claude-mythos-5-1 and claude-mythos-5; ours ports
// NEITHER, by decision — we never route mythos, and an unpriced model is loud
// (est_usd null, unpriced_requests ticks, warnUnpriced fires) where a guessed
// rate is silent. This pins the decision so a later half-port is red: adding a
// bare 'claude-mythos-5' alone would swallow 'claude-mythos-5-1' exactly as
// fable-5 swallowed fable-5-1 above.
test('priceFor: mythos is unpriced by decision, not by oversight', () => {
  assert.equal(priceFor('claude-mythos-5'), null);
  assert.equal(priceFor('claude-mythos-5-1'), null);
  assert.equal(PRICES['claude-mythos-5'], undefined);
  assert.equal(PRICES['claude-mythos-5-1'], undefined);
});

// WITHDRAWN REPRICING — the scheduled sonnet-5 rise to $3/$15 was announced,
// dated 2026-09-01, and then withdrawn; the $2/$10 rate became standard. The
// entry had ALREADY FIRED, so this is the direction that actually over-bills:
// priced, no warning, every receipt 1.5x over. The date must now be inert.
test('priceFor: the withdrawn sonnet-5 repricing never fires, on either side of its old date', () => {
  for (const [label, now] of [['the day before', BEFORE_FLIP],
                              ['the old effective date', AFTER_FLIP],
                              ['months later', LONG_AFTER]]) {
    assert.equal(priceFor('claude-sonnet-5', { now }).in, 2.0, `in, ${label}`);
    assert.equal(priceFor('claude-sonnet-5', { now }).out, 10.0, `out, ${label}`);
    assert.equal(priceFor('claude-sonnet-5', { now }).cache_read, 0.20, `cache_read, ${label}`);
  }
  // Dated wire ids inherit the base row too, and so does 5.1 by prefix.
  assert.equal(priceFor('claude-sonnet-5-20260601', { now: LONG_AFTER }).in, 2.0);

  // The substance of the withdrawal: sonnet-5 is NOT sonnet-4 priced. This is
  // the assertion that fails if someone "fixes" the symptom by editing the base
  // row to $3/$15 instead of removing the withdrawn schedule.
  assert.notDeepEqual(priceFor('claude-sonnet-5', { now: LONG_AFTER }), PRICES['claude-sonnet-4']);
  assert.equal(PRICES['claude-sonnet-4'].in, 3.0);

  // The registry stays EMPTY rather than deleted — the mechanism is still wanted
  // for the next real repricing (exercised via withDated below).
  assert.deepEqual(Object.keys(PRICES_DATED), []);
});

// The boundary is the LOCAL calendar day, mirroring the vendor's
// time.localtime(now). A UTC comparison (toISOString().slice(0,10)) flips up to
// a day early or late depending on the offset's sign, and the two ports would
// then disagree about which side of midnight a receipt falls on. Asserting BOTH
// edges catches that for every nonzero offset: west of UTC the last minute of
// 2026-08-31 is already Sep 1 in UTC, east of it the first minute of Sep 1 is
// still Aug 31. At TZ=UTC exactly the two are identical and this test is
// vacuous by construction — run it under TZ=America/Los_Angeles to see it bite.
test('priceFor: the dated boundary is the LOCAL day, not UTC', () => {
  withDated('claude-haiku-4', [['2026-09-01', { in: 9.0, out: 45.0, cache_write_5m: 11.25, cache_write_1h: 18.0, cache_read: 0.9 }]], () => {
    assert.equal(priceFor('claude-haiku-4', { now: new Date(2026, 7, 31, 23, 59, 30) }).in, 1.0,
      'last local minute of 2026-08-31 is still the base rate');
    assert.equal(priceFor('claude-haiku-4', { now: new Date(2026, 8, 1, 0, 0, 30) }).in, 9.0,
      'first local minute of 2026-09-01 is already the scheduled rate');
  });
  assert.equal(priceFor('claude-haiku-4', { now: new Date(2026, 8, 1, 0, 0, 30) }).in, 1.0,
    'the synthetic schedule must not outlive the block that registered it');
});

// Overlay ORDER, pinned because it is invisible in the output otherwise: the
// vendor applies dated first, then fast on the same winning prefix, so fast
// wins where both could apply. Swapping them changes nothing for today's tables
// (no model has both) — this is a live example that fails only once one does.
test('priceFor: dated overlay applies before fast, per the vendor order', () => {
  // opus-5 HAS a premium row, so a synthetic schedule on it makes the order
  // observable from outside for the first time: swap the two overlays and the
  // middle assertion returns the dated rate instead of the premium one.
  withDated('claude-opus-5', [['2026-09-01', { in: 7.0, out: 35.0, cache_write_5m: 8.75, cache_write_1h: 14.0, cache_read: 0.7 }]], () => {
    assert.equal(priceFor('claude-opus-5', { now: AFTER_FLIP }).in, 7.0,
      'dated alone applies once its date is reached');
    assert.equal(priceFor('claude-opus-5', { now: AFTER_FLIP, speed: 'fast' }).in, 10.0,
      'fast wins where BOTH could apply');
    assert.equal(priceFor('claude-opus-5', { now: BEFORE_FLIP, speed: 'fast' }).in, 10.0,
      'before the date, fast applies to the base row unchanged');
  });
});

// The signature is an OBJECT and must stay one: the vendor is positional
// (`_price_for(model, table, now, speed)`) and a port that lands `now` in a
// positional `speed` slot fails OPEN — wrong rates, no throw. A stray second
// positional must not be silently read as a table.
test('priceFor: options are named — a positional table/speed cannot be mis-ordered', () => {
  assert.equal(priceFor('gpt-5.4-mini', { table: PRICES_OPENAI }).out, 4.5);
  // The old positional call shape now yields the DEFAULT table, not the openai
  // one, and an openai id matches nothing there => null rather than wrong rates.
  assert.equal(priceFor('gpt-5.4-mini', PRICES_OPENAI), null);
  // A Date passed where a table used to go does not become a table either.
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).in, 2.0);
  assert.equal(priceFor('claude-opus-5', {}).in, 5.0, 'empty options == defaults');
  assert.equal(priceFor('claude-opus-5').in, 5.0, 'omitted options == defaults');
});

test('billing: prices at receipt time, and sonnet-5 bills at the base row', () => {
  // billing() reads the wall clock (no now seam by design: production prices at
  // receipt time). Assert the dollars against HARDCODED rates, not against a row
  // re-read from the table — reusing priceFor's output on both sides would only
  // assert that billing() agrees with itself, and would have stayed green
  // through the withdrawn repricing this ticket removed.
  const b = billing('messages', {
    modelResolved: 'claude-sonnet-5',
    usageStart: { input_tokens: 1000 },
    usageFinal: { output_tokens: 2000 },
  });
  assert.equal(b.est_usd, round6((1000 * 2.0 + 2000 * 10.0) / 1e6));
  assert.equal(b.unpriced, false);
  // A fable-5-1 receipt bills its own read rate end to end, not the 5.0 one.
  const f = billing('messages', {
    modelResolved: 'claude-fable-5-1-20260901',
    usageFinal: { output_tokens: 0, cache_read_input_tokens: 1_000_000 },
  });
  assert.equal(f.est_usd, 0.25);
});

test('billing: usage.speed=fast bills at premium and says so in the basis', () => {
  const args = {
    modelResolved: 'claude-opus-5',
    usageStart: { input_tokens: 1000, cache_read_input_tokens: 100000 },
    usageFinal: { output_tokens: 2000, speed: 'fast',
      cache_creation: { ephemeral_5m_input_tokens: 5000 } },
  };
  const fast = billing('messages', args);
  assert.equal(fast.tokens.speed, 'fast');
  // 1000*10 + 2000*50 + 100000*1.00 + 5000*12.5, per 1M
  assert.equal(fast.est_usd, 0.2725);
  assert.match(fast.price_basis, /FAST MODE premium rates/);

  // The same tokens at standard rates — exactly half, which is the whole point.
  const std = billing('messages', { ...args,
    usageFinal: { ...args.usageFinal, speed: 'standard' } });
  assert.equal(std.est_usd, 0.13625);
  assert.equal(round6(fast.est_usd / std.est_usd), 2, 'fast mode is exactly 2x');
  assert.ok(!std.price_basis.includes('FAST MODE'));
});

test('billing: speed is read from the RESPONSE, final winning over start', () => {
  // The request's speed is only an ASK — a 429/529 can refuse it and opus-4-6
  // silently downgrades, and in both cases usage.speed says standard and
  // standard rates are what is charged. Billing the ask would over-report.
  const refused = billing('messages', {
    modelResolved: 'claude-opus-5',
    usageStart: { input_tokens: 1000, speed: 'fast' },
    usageFinal: { output_tokens: 2000, speed: 'standard' },
  });
  assert.equal(refused.tokens.speed, 'standard', 'final wins over start');
  assert.equal(refused.est_usd, 0.055);   // 1000*5 + 2000*25, per 1M
  assert.ok(!refused.price_basis.includes('FAST MODE'));

  // Absent on final falls back to start (py getOr semantics, as elsewhere here).
  const fromStart = billing('messages', {
    modelResolved: 'claude-opus-5',
    usageStart: { input_tokens: 1000, speed: 'fast' },
    usageFinal: { output_tokens: 2000 },
  });
  assert.equal(fromStart.tokens.speed, 'fast');
  assert.equal(fromStart.est_usd, 0.11);  // 1000*10 + 2000*50, per 1M

  // Absent everywhere => standard. Every non-beta request looks like this, so
  // this is the case that must not regress.
  const plain = billing('messages', {
    modelResolved: 'claude-opus-5',
    usageStart: { input_tokens: 1000 },
    usageFinal: { output_tokens: 2000 },
  });
  assert.equal(plain.tokens.speed, null);
  assert.equal(plain.est_usd, 0.055);
});

test('billing: a fast request on a model with NO premium row is billed standard, and the basis does not claim otherwise', () => {
  const b = billing('messages', {
    modelResolved: 'claude-opus-4-6-20260101',
    usageStart: { input_tokens: 1000 },
    usageFinal: { output_tokens: 2000, speed: 'fast' },
  });
  assert.equal(b.est_usd, 0.055, 'standard rates');
  assert.ok(!b.price_basis.includes('FAST MODE'),
    'the basis must report what was CHARGED, not what was asked for');
});

test('billing: TTL-correct pricing, asymmetric start/final fallbacks', () => {
  const b = billing('messages', {
    modelResolved: 'claude-sonnet-4-5-20250929',
    usageStart: {
      input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      service_tier: 'standard',
    },
    usageFinal: { output_tokens: 500 },
  });
  const t = b.tokens;
  assert.equal(t.input_tokens, 4);            // final absent → start
  assert.equal(t.output_tokens, 500);          // final ONLY
  assert.equal(t.cache_read_input_tokens, 10000);
  assert.equal(t.cache_write_5m_tokens, 1000);
  assert.equal(t.cache_write_1h_tokens, 2000);
  assert.equal(t.cache_write_flat_tokens, 3000);
  assert.equal(t.service_tier, 'standard');    // start ONLY
  // 4*3 + 500*15 + 10000*0.30 + 1000*3.75 + 2000*6.0, per 1M
  assert.equal(b.est_usd, 0.026262);
  assert.equal(b.unpriced, false);
});

test('billing: output_tokens never falls back to message_start', () => {
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5-20251001',
    usageStart: { input_tokens: 10, output_tokens: 7 },
    usageFinal: { input_tokens: 10 },
  });
  assert.equal(b.tokens.output_tokens, null);
});

test('billing: flat cache_creation total priced at the 5m rate when split absent', () => {
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5-20251001',
    usageFinal: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 800 },
  });
  assert.equal(b.tokens.cache_write_5m_tokens, null); // reported as absent
  assert.equal(b.tokens.cache_write_flat_tokens, 800);
  // 100*1 + 10*5 + 800*1.25 per 1M = 0.0001 + 0.00005 + 0.001
  assert.equal(b.est_usd, 0.00115);
  assert.match(b.price_basis, /flat total priced at 5m rate/);
});

test('billing: empty cache_creation in usage_final falls through to usage_start (py or-semantics)', () => {
  const b = billing('messages', {
    modelResolved: 'claude-opus-4-8',
    usageStart: { cache_creation: { ephemeral_5m_input_tokens: 400 } },
    usageFinal: { output_tokens: 1, cache_creation: {} },
  });
  assert.equal(b.tokens.cache_write_5m_tokens, 400);
});

test('billing: unpriced model is loud, not a silent zero', () => {
  const b = billing('messages', {
    modelResolved: 'claude-nova-9', usageFinal: { input_tokens: 5, output_tokens: 5 },
  });
  assert.equal(b.est_usd, null);
  assert.equal(b.unpriced, true);
});

test('billing: count_tokens is not billed for tokens', () => {
  const b = billing('count_tokens', { countTokens: { input_tokens: 1234 } });
  assert.equal(b.billable, false);
  assert.equal(b.counted_input_tokens, 1234);
  assert.equal(b.est_usd, 0.0);
});

test('billingOpenai: cached portion split out of input_tokens, reasoning as thinking', () => {
  const b = billingOpenai('gpt-5.3-codex', {
    input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 },
    output_tokens: 1000, output_tokens_details: { reasoning_tokens: 600 },
  });
  assert.equal(b.tokens.input_tokens, 2000);
  assert.equal(b.tokens.cache_read_input_tokens, 8000);
  assert.equal(b.tokens.thinking_tokens, 600);
  // 2000*1.75 + 8000*0.175 + 1000*14 per 1M
  assert.equal(b.est_usd, 0.0189);
});

test('billingOpenai: cached larger than input clamps to zero', () => {
  const b = billingOpenai('gpt-5.4', {
    input_tokens: 100, input_tokens_details: { cached_tokens: 150 }, output_tokens: 1,
  });
  assert.equal(b.tokens.input_tokens, 0);
  assert.equal(b.tokens.cache_read_input_tokens, 150);
});

test('bump: turns / refusals / unpriced / cache-write flat fallback in totals', () => {
  const totals = newTotals();
  const priced = billing('messages', {
    modelResolved: 'claude-haiku-4-5',
    usageFinal: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 800 },
  });
  bump(totals, priced, { stop_reason: 'end_turn', is_turn: true });
  assert.equal(totals.requests, 1);
  assert.equal(totals.billed_requests, 1);
  assert.equal(totals.turns, 1);
  assert.equal(totals.cache_write_tokens, 800); // flat fallback
  assert.equal(totals.est_usd, 0.00115);

  bump(totals, priced, { stop_reason: 'tool_use', is_turn: false });
  assert.equal(totals.turns, 1); // mid-turn hop doesn't count

  const unpriced = billing('messages', {
    modelResolved: 'claude-nova-9', usageFinal: { input_tokens: 1, output_tokens: 1 },
  });
  bump(totals, unpriced, null);
  assert.equal(totals.unpriced_requests, 1);
  assert.deepEqual(totals.unpriced_models, ['claude-nova-9']);
  assert.equal(totals.est_usd, 0.0023); // unchanged by unpriced traffic

  bump(totals, billing('count_tokens', { countTokens: { input_tokens: 9 } }), null);
  assert.equal(totals.count_tokens_requests, 1);
  assert.equal(totals.billed_requests, 3);
});

test('bump: refusal events keep full stop_details, capped at 20', () => {
  const totals = newTotals();
  const b = billing('messages', { modelResolved: 'claude-fable-5', usageFinal: { output_tokens: 0 } });
  for (let i = 0; i < 25; i++) {
    bump(totals, b, {
      stop_reason: 'refusal', is_turn: true,
      stop_details: { category: 'test', n: i }, request_id: `req_${i}`,
    });
  }
  assert.equal(totals.refusals, 25);
  assert.equal(totals.refusal_events.length, 20);
  assert.equal(totals.refusal_events[0].stop_details.n, 5); // oldest 5 dropped
  assert.equal(totals.refusal_events[19].request_id, 'req_24');
  assert.equal(totals.refusal_events[19].category, 'test');
});

test('Ledger: global and per-session totals accumulate independently', () => {
  const led = new Ledger();
  const b = billing('messages', {
    modelResolved: 'claude-haiku-4-5', usageFinal: { input_tokens: 10, output_tokens: 10 },
  });
  led.accumulate(b, 'sess-a', { stop_reason: 'end_turn', is_turn: true });
  led.accumulate(b, 'sess-b', { stop_reason: 'end_turn', is_turn: true });
  assert.equal(led.totals.requests, 2);
  assert.equal(led.session('sess-a').requests, 1);
  assert.equal(led.session('sess-b').turns, 1);
  led.forget('sess-a');
  assert.equal(led.session('sess-a').requests, 0); // fresh after forget
  assert.equal(led.totals.requests, 2);            // global untouched
});

// --- PREFIX-SHADOW AUDIT ------------------------------------------------------
//
// A too-SHORT row is LOUD: nothing matches, warnUnpriced fires, est_usd is null
// and unpriced_requests ticks. A too-GREEDY row is SILENT: longest-prefix
// SUCCEEDS on the wrong row and every signal above stays quiet. The mode flips
// the day a vendor ships an `X-1` after an `X`, so the trigger is a vendor
// release, not an edit of ours — no diff to review, no test to re-run.
//
// Live today: priceFor('claude-sonnet-5-1') returns the sonnet-5 row (object
// identity, not merely equal rates). Fable 5.1 already broke the universal 0.1x
// read multiplier; a sonnet 5.1 doing the same misprices from its first receipt.
//
// TWO properties, because this ticket's own remedy causes the second:
//   (a) no vendor row strictly EXTENDS one of our PRICES keys while we lack it —
//       that is precisely our row swallowing traffic the vendor prices apart;
//   (b) no PRICES key strictly EXTENDS a PRICES_SPEED_FAST / PRICES_DATED key —
//       both overlays are keyed on the EXACT winning prefix, so a longer PRICES
//       row silently orphans the overlay. Adding an `X-1` row is what fixing (a)
//       DOES, which is why (b) has to be asserted alongside it.
//
// Rates are deliberately NOT compared against the vendor: that would make this
// file a third copy of the table (test/diff-argv-single-source.test.js's header
// for why a third copy is worse than two). Keys alone carry the shadow property.

const VENDOR_BILLING_PY = path.join(__dirname, '..', 'vendor', 'wirescope', 'proxylab', 'billing.py');

// Keys of a top-level `NAME = { ... }` dict literal in the vendored Python.
// Throws rather than returning [] when the table moves or is renamed: an
// extractor that quietly finds nothing is green forever on a file it never read.
function vendorTableKeys(src, name) {
  const head = `\n${name} = {\n`;
  const start = src.indexOf(head);
  if (start === -1) throw new Error(`vendor table ${name} not found`);
  const bodyStart = start + head.length;
  const end = src.indexOf('\n}\n', bodyStart);
  if (end === -1) throw new Error(`vendor table ${name} is unterminated`);
  return src.slice(bodyStart, end).split('\n')
    .map((line) => line.match(/^\s*"([^"]+)"\s*:/))
    .filter(Boolean).map((m) => m[1]);
}

// Pairs [ours, theirs] where a vendor key strictly extends one of ours and we
// do not carry it — the shadow. A vendor key unrelated to every key of ours is
// NOT reported: that model is unpriced-and-loud here, which is a decision, not a
// defect. This is why mythos needs no exception entry — we hold neither mythos
// row, so nothing of ours can swallow them.
function shadowedRows(ourKeys, theirKeys) {
  const ours = new Set(ourKeys);
  const out = [];
  for (const theirs of theirKeys) {
    if (ours.has(theirs)) continue;
    for (const mine of ourKeys) {
      if (theirs.length > mine.length && theirs.startsWith(mine)) out.push([mine, theirs]);
    }
  }
  return out;
}

// Pairs [overlayKey, pricesKey] where a PRICES key strictly extends an overlay
// key, so traffic winning on the longer prefix never sees the overlay.
function orphanedOverlayRows(priceKeys, overlayKeys) {
  const out = [];
  for (const ok of overlayKeys) {
    for (const pk of priceKeys) {
      if (pk.length > ok.length && pk.startsWith(ok)) out.push([ok, pk]);
    }
  }
  return out;
}

// Both detectors above answer "is this set empty?", and an empty set satisfies
// an emptiness assertion for the boring reason as readily as the correct one —
// including when the detector is broken and finds nothing anywhere. So each one
// is driven RED against a synthetic table before any real table is handed to it.
test('prefix-shadow audit: the detectors are red on a table that has the defect', () => {
  // (a) the half-port the mythos comment in wire/billing.js warns about: take
  // the bare row and not the -1, and 5.1 traffic prices at the 5.0 read rate.
  assert.deepEqual(
    shadowedRows(['claude-mythos-5', 'claude-haiku-4'],
      ['claude-mythos-5', 'claude-mythos-5-1', 'claude-haiku-4']),
    [['claude-mythos-5', 'claude-mythos-5-1']]);
  // A vendor row extending nothing of ours is unpriced-and-loud, not a shadow.
  assert.deepEqual(shadowedRows(['claude-haiku-4'], ['claude-mythos-5-1']), []);
  // Carrying the longer row ourselves is the fix, and must read as clean.
  assert.deepEqual(
    shadowedRows(['claude-mythos-5', 'claude-mythos-5-1'],
      ['claude-mythos-5', 'claude-mythos-5-1']), []);

  // (b) exactly what fixing (a) for a fast-mode model would do.
  assert.deepEqual(
    orphanedOverlayRows(['claude-opus-5', 'claude-opus-5-1'], ['claude-opus-5']),
    [['claude-opus-5', 'claude-opus-5-1']]);
  assert.deepEqual(orphanedOverlayRows(['claude-opus-5'], ['claude-opus-5']), []);

  // The parser must throw, not return [], when it cannot find its table.
  assert.throws(() => vendorTableKeys('PRICES = {\n    "a": 1,\n}\n', 'NOPE'), /not found/);
  assert.throws(() => vendorTableKeys('\nPRICES = {\n    "a": 1,\n', 'PRICES'), /unterminated/);
  assert.deepEqual(vendorTableKeys('\nT = {\n    # "commented": 1,\n    "a-1": {},\n}\n', 'T'), ['a-1']);
});

// (a) The vendor is the oracle here for a reason worth stating: the defect is an
// ABSENCE — the longer row we do not have. Every strict-prefix pair we DO carry
// (fable-5/fable-5-1, opus-4/opus-4-N) is longest-prefix working as intended, so
// a check reading only our own table has no failure mode and cannot see this
// class at all. Agreeing with the vendored Python converts "what will the vendor
// ship next?" into "do these two files still agree?", and a re-vendor that adds
// an `X-1` row we lack turns this red on the commit that lands it.
test('prefix-shadow audit: no vendor row is swallowed by a shorter row of ours', () => {
  const src = fs.readFileSync(VENDOR_BILLING_PY, 'utf8');
  const theirs = vendorTableKeys(src, 'PRICES');

  // ENTER: the parse reached the real rows, and specifically the rows this audit
  // exists to reason about. Asserted as literals — a count alone would pass on
  // thirteen keys read out of the wrong table.
  assert.ok(theirs.includes('claude-mythos-5') && theirs.includes('claude-mythos-5-1'),
    `vendor PRICES parse missed the mythos pair: ${JSON.stringify(theirs)}`);
  assert.ok(theirs.includes('claude-fable-5-1'), 'vendor PRICES parse missed fable-5-1');

  assert.deepEqual(shadowedRows(Object.keys(PRICES), theirs), [],
    'a vendor row extends one of ours that we do not carry: our shorter row ' +
    'swallows it by longest prefix, priced and silent');

  // The openai axis is the same class on the same matching rule, and it has a
  // live strict-prefix pair (gpt-5.4 / gpt-5.4-mini) that is only correct
  // because we carry both — dropping the longer one prices mini traffic 3x over.
  const theirsOpenai = vendorTableKeys(src, 'PRICES_OPENAI');
  assert.ok(theirsOpenai.includes('gpt-5.4-mini'), 'vendor PRICES_OPENAI parse missed gpt-5.4-mini');
  assert.deepEqual(shadowedRows(Object.keys(PRICES_OPENAI), theirsOpenai), []);
});

// (b) has no vendor analogue to lean on — the vendor keys its overlays on the
// winning prefix exactly as we do, so agreement between the two ports says
// nothing about it. It is checkable against ourselves alone, and must be,
// because it is the defect this ticket's own remedy introduces.
test('prefix-shadow audit: no PRICES row strictly extends a fast-mode overlay key', () => {
  assert.deepEqual(
    orphanedOverlayRows(Object.keys(PRICES), Object.keys(PRICES_SPEED_FAST)), [],
    'a PRICES row extends a PRICES_SPEED_FAST key: fast traffic wins on the ' +
    'longer prefix, the premium overlay never applies, and it bills 2x UNDER ' +
    'at standard rates with no warning');
});

// PRICES_DATED is empty, so running the detector over it live asserts nothing.
// withDated puts a real schedule on 'claude-opus-4' — which four opus-4-N rows
// already extend — so the orphan is not synthetic: were that schedule real, every
// opus-4.5+ receipt would miss the repricing while legacy opus-4.0/4.1 took it.
test('prefix-shadow audit: the dated overlay is checked on the same rule, and the check bites', () => {
  const schedule = [['2026-09-01', { in: 9.0, out: 45.0, cache_write_5m: 11.25, cache_write_1h: 18.0, cache_read: 0.9 }]];
  withDated('claude-opus-4', schedule, () => {
    assert.deepEqual(
      orphanedOverlayRows(Object.keys(PRICES), Object.keys(PRICES_DATED)),
      [['claude-opus-4', 'claude-opus-4-5'], ['claude-opus-4', 'claude-opus-4-6'],
        ['claude-opus-4', 'claude-opus-4-7'], ['claude-opus-4', 'claude-opus-4-8']]);
    // The orphaning is real, not just a name-shape finding: opus-4-5 keeps the
    // base rate on a date its schedule has passed, while bare opus-4 takes it.
    assert.equal(priceFor('claude-opus-4-5', { now: AFTER_FLIP }).in, 5.0);
    assert.equal(priceFor('claude-opus-4-1-20250805', { now: AFTER_FLIP }).in, 9.0);
  });
  // Live, with the registry empty again, the audit is clean — and vacuous, which
  // is why the bite above is asserted inside the block rather than trusted here.
  assert.deepEqual(
    orphanedOverlayRows(Object.keys(PRICES), Object.keys(PRICES_DATED)), []);
});
