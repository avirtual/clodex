'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PRICES, PRICES_OPENAI, PRICES_SPEED_FAST, PRICES_DATED, priceFor, round6, billing, billingOpenai, newTotals, bump, Ledger } = require('../wire/billing');

// Both sides of the sonnet-5 flip, as LOCAL noon so no timezone offset can
// carry either across the boundary. Every dated assertion injects one of these:
// reading the real clock would make this file's verdict change on 2026-09-01.
const BEFORE_FLIP = new Date(2026, 7, 31, 12, 0, 0);  // 2026-08-31
const AFTER_FLIP  = new Date(2026, 8, 1, 12, 0, 0);   // 2026-09-01

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
  // sonnet-5 INTRO rate (through 2026-08-31; wirescope msg-88121-2) — clock
  // injected, or this assertion silently becomes a different one on 2026-09-01.
  // sonnet-4.x must still fall through to the sonnet-4 entry.
  assert.equal(priceFor('claude-sonnet-5', { now: BEFORE_FLIP }).in, 2.0);
  assert.equal(priceFor('claude-sonnet-5-20260601', { now: BEFORE_FLIP }).cache_read, 0.20);
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

// SCHEDULED REPRICING — the JS port had no dated table at all while the vendor
// carried one, so from 2026-09-01 it would bill sonnet-5 at the expired intro
// rate with nothing signalling it: priced, no warning, totals just 33% light.
test('priceFor: PRICES_DATED flips sonnet-5 on 2026-09-01, both sides of the boundary', () => {
  // The day BEFORE is still intro. 2026-08-31 is the last such day.
  assert.equal(priceFor('claude-sonnet-5', { now: BEFORE_FLIP }).in, 2.0);
  assert.equal(priceFor('claude-sonnet-5', { now: BEFORE_FLIP }).out, 10.0);
  assert.equal(priceFor('claude-sonnet-5', { now: BEFORE_FLIP }).cache_read, 0.20);

  // ON the effective date the standard row applies (>=, not >).
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).in, 3.0);
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).out, 15.0);
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).cache_write_5m, 3.75);
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).cache_write_1h, 6.0);
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).cache_read, 0.30);

  // Dated model ids reach the schedule too — that is what arrives on the wire.
  assert.equal(priceFor('claude-sonnet-5-20260601', { now: AFTER_FLIP }).in, 3.0);

  // Post-flip sonnet-5 == sonnet-4, which is the substance of the repricing.
  assert.deepEqual(priceFor('claude-sonnet-5', { now: AFTER_FLIP }), PRICES['claude-sonnet-4']);

  // Epoch ms is accepted as well as a Date (only tests inject either).
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP.getTime() }).in, 3.0);

  // Models with no schedule are untouched by the date.
  assert.equal(priceFor('claude-opus-5', { now: AFTER_FLIP }).in, 5.0);
  assert.equal(priceFor('claude-fable-5', { now: AFTER_FLIP }).in, 10.0);

  // The base row must stay the INTRO rate: editing it in place instead of
  // scheduling would retro-reprice every receipt billed before the flip.
  assert.equal(PRICES['claude-sonnet-5'].in, 2.0);
  assert.equal(PRICES_DATED['claude-sonnet-5'][0][0], '2026-09-01');
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
  assert.equal(priceFor('claude-sonnet-5', { now: new Date(2026, 7, 31, 23, 59, 30) }).in, 2.0,
    'last local minute of 2026-08-31 is still the intro rate');
  assert.equal(priceFor('claude-sonnet-5', { now: new Date(2026, 8, 1, 0, 0, 30) }).in, 3.0,
    'first local minute of 2026-09-01 is already the standard rate');
});

// Overlay ORDER, pinned because it is invisible in the output otherwise: the
// vendor applies dated first, then fast on the same winning prefix, so fast
// wins where both could apply. Swapping them changes nothing for today's tables
// (no model has both) — this is a live example that fails only once one does.
test('priceFor: dated overlay applies before fast, per the vendor order', () => {
  // A model carrying BOTH a schedule and a premium row does not exist yet, so
  // assert the two independently and the invariant that keeps them separable.
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP, speed: 'fast' }).in, 3.0,
    'sonnet-5 has no premium row: fast leaves the dated row standing');
  assert.equal(priceFor('claude-opus-5', { now: AFTER_FLIP, speed: 'fast' }).in, 10.0,
    'opus-5 has no schedule: the premium row applies unmodified');
  const overlap = Object.keys(PRICES_DATED).filter((k) => k in PRICES_SPEED_FAST);
  assert.deepEqual(overlap, [],
    'once a model appears in BOTH tables, add a direct order assertion here — ' +
    'until then fast-wins-over-dated is unobservable from outside');
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
  assert.equal(priceFor('claude-sonnet-5', { now: AFTER_FLIP }).in, 3.0);
  assert.equal(priceFor('claude-opus-5', {}).in, 5.0, 'empty options == defaults');
  assert.equal(priceFor('claude-opus-5').in, 5.0, 'omitted options == defaults');
});

test('billing: prices at receipt time — sonnet-5 traffic after the flip is not intro-rated', () => {
  // billing() reads the wall clock (no now seam by design: production prices at
  // receipt time). Pin the rate arithmetic through priceFor, then assert
  // billing() consumes THAT row rather than a hardcoded one.
  const row = priceFor('claude-sonnet-5', { now: AFTER_FLIP });
  const b = billing('messages', {
    modelResolved: 'claude-sonnet-5',
    usageStart: { input_tokens: 1000 },
    usageFinal: { output_tokens: 2000 },
  });
  const today = priceFor('claude-sonnet-5');
  assert.equal(b.est_usd, round6((1000 * today.in + 2000 * today.out) / 1e6));
  // And the post-flip row differs from the intro one, so the flip is material.
  assert.notEqual(row.in, PRICES['claude-sonnet-5'].in);
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
