'use strict';

// t619 — per-model, operator-editable context-reminder thresholds.
//
// Three things are worth pinning here and each one has a shape it needs.
//
// THE PRE-CHANGE PIN. "An operator who never opened the setting sees the shipped
// behaviour" cannot be checked against a fixture captured from this code — that
// asserts only that the code agrees with itself. So the old module is checked
// out from the base commit into a temp file and RUN.
//
// The baseline NUMBERS moved deliberately, so byte
// equality at equal token counts is no longer the claim. What must still hold is
// that only the numbers moved: fed the base module's OWN thresholds, the new
// decision reproduces it exactly — same boundaries, same wording, same rounding.
// A change that reworded the reminder or moved a boundary relative to its
// threshold fails here; a retune does not.
//
// THE TABLE PROPERTY. The failure this repo has twice paid for is not a lookup
// that misses, it is a lookup that HITS THE WRONG ROW — silent by construction,
// because a wrong threshold looks exactly like a right one. So the matching test
// is a property over the whole table (no id any row owns is reachable from
// another row) rather than a case per model, and every expectation is a literal:
// re-deriving it with modelFamily would assert the rule against itself and could
// not express an exception.
//
// THE ENTER. Most assertions below are absences — no override applied, no wrong
// row reached, no change from the old module. All of those pass for free against
// a resolver that returned a constant. `test('ENTER: ...')` is what proves the
// machinery is live: fable-5 really does move, and the settings layer really does
// reach the decision.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  ctxReminderFor, ctxThresholdsFor, modelFamily, sanitizeCtxThresholds,
  CTX_REMINDER_NUDGE_TOKENS, CTX_REMINDER_ESCALATE_TOKENS, CTX_MODEL_THRESHOLDS,
  CTX_ESCALATE_MIN_GAP, CTX_THRESHOLD_MIN, CTX_THRESHOLD_MAX,
} = require('../ctx-reminder');

const BASE = '44430fd';

// ---------------------------------------------------------------------------
// Invariant 4 — absent settings resolve to the SHIPPED behaviour, checked
// against the module as it existed before this ticket.
// ---------------------------------------------------------------------------

function loadBaseModule(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t619-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = execFileSync('git', ['show', `${BASE}:ctx-reminder.js`], {
    cwd: path.join(__dirname, '..'), encoding: 'utf-8',
  });
  const file = path.join(dir, 'ctx-reminder-base.js');
  fs.writeFileSync(file, src);
  return require(file);
}

// Around both thresholds and well outside them, so a shifted boundary or a
// swapped wording arm shows up rather than being stepped over.
const SWEEP = [
  0, 1, 50_000, 149_999, 150_000, 199_998, 199_999, 200_000, 200_001,
  224_999, 249_999, 250_000, 250_001, 260_400, 309_999, 310_000, 400_000,
  1_000_000,
];

// The model axis is REAL here: each id is resolved through ctxThresholdsFor with
// no overrides, so the loop asserts that every one of them lands on the same
// baseline pair. That is the claim worth making — the shipped table is empty, so
// no model may resolve anywhere else — and it is what would fail if a row were
// added without a decision to add it. Fable is the interesting id: it is the
// model the ticket was raised about, and the pair 5.1/5.0 must resolve alike
// while remaining independently addressable.
const UNCHANGED_MODELS = [
  null,
  'claude-opus-5',
  'us.anthropic.claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-3-5-sonnet-20241022',
  'something-that-is-not-a-model',
];

test('invariant 4: fed the base commit\'s thresholds, the decision reproduces it byte for byte', (t) => {
  const base = loadBaseModule(t);
  // ENTER: the base module must actually be the pre-change one, or "identical"
  // is a comparison of this file against itself.
  assert.strictEqual(base.ctxReminderFor.length, 1,
    `${BASE}:ctx-reminder.js must be the single-argument version`);
  assert.strictEqual(base.CTX_REMINDER_NUDGE_TOKENS, 200_000);
  assert.strictEqual(base.CTX_REMINDER_ESCALATE_TOKENS, 250_000);
  assert.strictEqual(typeof base.ctxThresholdsFor, 'undefined',
    'the base module predates the per-model resolver');

  // Shape first: no model may resolve away from the shipped baseline while the
  // table is empty. This is what makes the sweep below a statement about every
  // model rather than about one pair checked nine times.
  for (const model of UNCHANGED_MODELS) {
    const r = ctxThresholdsFor(model, {});
    assert.deepStrictEqual({ nudge: r.nudge, escalate: r.escalate },
      { nudge: CTX_REMINDER_NUDGE_TOKENS, escalate: CTX_REMINDER_ESCALATE_TOKENS },
      `${model} must resolve to the shipped baseline while no row ships`);
    assert.strictEqual(r.source, 'builtin-default', `${model} reached a table row it should not have`);
  }

  // Then wording and boundaries: fed the base module's own numbers, each model's
  // resolved decision reproduces it exactly. Substituting only the thresholds is
  // what isolates the retune from a reword or a moved boundary.
  const asBase = { nudge: base.CTX_REMINDER_NUDGE_TOKENS, escalate: base.CTX_REMINDER_ESCALATE_TOKENS };
  for (const model of UNCHANGED_MODELS) {
    const resolved = ctxThresholdsFor(model, {});
    const atBase = { ...resolved, ...asBase };
    for (const tok of SWEEP) {
      assert.strictEqual(
        ctxReminderFor(tok, atBase),
        base.ctxReminderFor(tok),
        `model=${model} tokens=${tok}: only the numbers may have moved`);
    }
  }
  // ENTER for the sweep itself: it must span both boundaries, or "identical"
  // is a comparison over a region where both modules return null.
  assert.ok(SWEEP.some((t2) => base.ctxReminderFor(t2) === null), 'the sweep covers the silent band');
  assert.ok(SWEEP.some((t2) => (base.ctxReminderFor(t2) || '').includes('getting heavy')), 'and the nudge band');
  assert.ok(SWEEP.some((t2) => (base.ctxReminderFor(t2) || '').includes('very heavy')), 'and the escalate band');
});

// The retune itself, stated as the behaviour change it is: a standing seat is
// now nudged earlier. Literals on both sides — reading the constants would
// make this true of any retune, including back to the values it corrects.
test('the baseline retune fires 25k earlier than the base commit did', (t) => {
  const base = loadBaseModule(t);
  const now = ctxThresholdsFor('claude-opus-5', {});
  assert.deepStrictEqual({ nudge: now.nudge, escalate: now.escalate },
    { nudge: 175_000, escalate: 225_000 });
  assert.strictEqual(base.ctxReminderFor(175_000), null, 'the base module was silent at 175k');
  assert.ok(ctxReminderFor(175_000, now).includes('getting heavy'), 'and this one nudges there');
  // The nudge stays under 200k, where a long-context surcharge would begin: the
  // nudge is what asks a seat to act, so it must fire before that line.
  assert.ok(now.nudge < 200_000, 'the nudge must not cross the surcharge line');
  assert.ok(ctxReminderFor(199_999, now).includes('getting heavy'),
    'a seat is still only nudged, not escalated, just under the line');
});

test('invariant 4: a real settings file lacking the key resolves to the shipped default', (t) => {
  const { initStores } = require('../stores');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t619-abs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A settings file as written before this key existed.
  fs.writeFileSync(path.join(dir, 'ui-settings.json'),
    JSON.stringify({ theme: 'midnight', speakRate: 210 }));
  const { uiSettings } = initStores(dir, { registryDir: path.join(dir, 'run') });
  const s = uiSettings.get();
  assert.deepStrictEqual(s.ctxReminderThresholds, {},
    'an absent key reads as no overrides, never as undefined');

  // Absent key resolves to the SHIPPED constants — not to null, not to a
  // hardcoded copy that could drift from the module that decides.
  const r = ctxThresholdsFor('claude-opus-5', s.ctxReminderThresholds);
  assert.strictEqual(r.source, 'builtin-default');
  assert.deepStrictEqual({ nudge: r.nudge, escalate: r.escalate },
    { nudge: CTX_REMINDER_NUDGE_TOKENS, escalate: CTX_REMINDER_ESCALATE_TOKENS });
  assert.deepStrictEqual({ nudge: r.nudge, escalate: r.escalate },
    { nudge: 175_000, escalate: 225_000 }, 'and those are the ruled values');
});

// ---------------------------------------------------------------------------
// Invariant 3 — no rule can reach a row it does not own.
// ---------------------------------------------------------------------------

// Each row carries its expected family as a LITERAL. Recomputing it with
// modelFamily would make every row true by construction and leave the table
// unable to express the exception it exists to catch.
const FAMILY_CASES = [
  // The pair this ticket exists for. Their cached-read prices differ 4x
  // (wire/billing.js), so folding them together would make the table unable to
  // express the only case it was built for.
  ['claude-fable-5-1', 'fable-5-1'],
  ['claude-fable-5', 'fable-5'],
  // A release date names a build, not an economic difference: it is dropped, so
  // one model does not fragment across every date it shipped under.
  ['claude-fable-5-1-20260901', 'fable-5-1'],
  ['claude-fable-5-20260601', 'fable-5'],
  // The normalisations that must survive the minor version being kept.
  ['claude-fable-5-1[1m]', 'fable-5-1'],
  ['claude-fable-5[1m]', 'fable-5'],
  ['CLAUDE-FABLE-5-1', 'fable-5-1'],
  ['us.anthropic.claude-fable-5-1-v1:0', 'fable-5-1'],
  ['claude-fable-5-1@20260901', 'fable-5-1'],
  ['claude-fable-6', 'fable-6'],
  ['claude-fable-51', 'fable-51'],
  ['claude-opus-5', 'opus-5'],
  ['claude-opus-4-1', 'opus-4-1'],
  ['claude-opus-4-1-20250805', 'opus-4-1'],
  ['us.anthropic.claude-sonnet-4-6', 'sonnet-4-6'],
  ['claude-sonnet-5', 'sonnet-5'],
  ['claude-haiku-4-5', 'haiku-4-5'],
  ['claude-haiku-4-5-20251001', 'haiku-4-5'],
  ['claude-3-5-sonnet-20241022', null],
  ['claude-sonnet-5-introductory-pricing', null],
  ['gpt-5-codex', null],
  ['', null],
  [null, null],
  [undefined, null],
  ['claude-', null],
  ['claude-fable', null],
];

test('modelFamily: each id reduces to the family literal its row names', () => {
  for (const [id, want] of FAMILY_CASES) {
    assert.strictEqual(modelFamily(id), want, `modelFamily(${JSON.stringify(id)})`);
  }
});

// A differentiated row per family in FAMILY_CASES, so the property has something
// to be violated over. Values are spaced far apart and are literals: if an id
// reached a row it does not own, the nudge it gets identifies WHICH row.
const FIXTURE_TABLE = {
  // The row pair that would have caught the collapse: if 5.0 ever reached 5.1's
  // row (or the reverse), the nudge it comes back with names WHICH row leaked.
  'fable-5-1': { nudge: 250_000, escalate: 310_000 },
  'fable-5': { nudge: 500_000, escalate: 600_000 },
  'fable-6': { nudge: 260_000, escalate: 320_000 },
  'fable-51': { nudge: 270_000, escalate: 330_000 },
  'opus-5': { nudge: 280_000, escalate: 340_000 },
  'opus-4-1': { nudge: 290_000, escalate: 350_000 },
  'sonnet-4-6': { nudge: 300_000, escalate: 360_000 },
  'sonnet-5': { nudge: 310_000, escalate: 370_000 },
  'haiku-4-5': { nudge: 320_000, escalate: 380_000 },
};

test('invariant 3: no model id reaches a row belonging to another family', () => {
  // ENTER: the property is vacuous unless the table actually has rows AND some
  // id actually hits one. Both are asserted before the sweep below trusts it.
  const hits = FAMILY_CASES.filter(([id]) => ctxThresholdsFor(id, FIXTURE_TABLE).source === 'settings-model');
  assert.ok(Object.keys(FIXTURE_TABLE).length >= 8, 'the fixture table must have rows to protect');
  assert.ok(hits.length >= 8, 'and real ids must reach them, or nothing is being tested');

  for (const [id, family] of FAMILY_CASES) {
    const got = ctxThresholdsFor(id, FIXTURE_TABLE);
    if (family && FIXTURE_TABLE[family]) {
      assert.deepStrictEqual(
        { nudge: got.nudge, escalate: got.escalate },
        FIXTURE_TABLE[family],
        `${JSON.stringify(id)} must get the ${family} row and no other`);
      assert.strictEqual(got.source, 'settings-model');
    } else {
      assert.strictEqual(got.source, 'builtin-default',
        `${JSON.stringify(id)} owns no row and must land on the baseline`);
      assert.strictEqual(got.nudge, CTX_REMINDER_NUDGE_TOKENS);
    }
  }
});

// The shipped table is empty today, so the builtin-model arm has no live row to
// exercise. Ships-with-no-row is a DEFAULTS decision, not a mechanism decision:
// this inserts a row to prove the arm resolves and that the decision uses what
// it returns, which is what makes reinstating a row a data change.
test('the per-model mechanism works even though no model differs by default', () => {
  assert.strictEqual(CTX_MODEL_THRESHOLDS.size, 0,
    'no differentiated row ships: the >200k surcharge question is unanswered');
  assert.ok(!CTX_MODEL_THRESHOLDS.has('fable-5-1'), 'fable 5.1 in particular is at the baseline');

  const restore = new Map(CTX_MODEL_THRESHOLDS);
  try {
    CTX_MODEL_THRESHOLDS.set('fable-5-1', { nudge: 250_000, escalate: 310_000 });
    const fable = ctxThresholdsFor('claude-fable-5-1', {});
    assert.strictEqual(fable.source, 'builtin-model');
    assert.deepStrictEqual({ nudge: fable.nudge, escalate: fable.escalate },
      { nudge: 250_000, escalate: 310_000 });
    // The decision USES it, not merely reports it.
    assert.strictEqual(ctxReminderFor(210_000, fable), null, 'a raised row defers the nudge');
    assert.ok(ctxReminderFor(260_000, fable).includes('getting heavy'));
    assert.ok(ctxReminderFor(310_000, fable).includes('very heavy'));
    // And it does not leak to a model that does not own it.
    const opus = ctxThresholdsFor('claude-opus-5', {});
    assert.strictEqual(opus.source, 'builtin-default');
    assert.ok(ctxReminderFor(210_000, opus), 'opus still nudges at the baseline');
    // A settings row still outranks a shipped one.
    const over = ctxThresholdsFor('claude-fable-5-1', { 'fable-5-1': { nudge: 400_000, escalate: 500_000 } });
    assert.strictEqual(over.source, 'settings-model');
    assert.strictEqual(over.nudge, 400_000);
  } finally {
    CTX_MODEL_THRESHOLDS.clear();
    for (const [k, v] of restore) CTX_MODEL_THRESHOLDS.set(k, v);
  }
  assert.strictEqual(CTX_MODEL_THRESHOLDS.size, 0, 'the fixture row is not left behind');
});

// The defect this file exists to prevent, stated over the SHIPPED price table
// rather than as a case: any two ids the vendor prices differently must be
// independently addressable, or the per-model table cannot express the
// difference that justifies a per-model threshold in the first place. Driven off
// wire/billing.js so a future price split fails HERE rather than silently
// inheriting a neighbour's thresholds.
test('invariant 3: two models with different shipped prices never share a family', () => {
  const { PRICES } = require('../wire/billing');
  const ids = Object.keys(PRICES).filter((id) => modelFamily(id));
  // ENTER: the property is vacuous if the grammar rejects every priced id, and
  // it must actually cover the pair the reviewer caught.
  assert.ok(ids.length >= 5, 'the price table must contribute ids the grammar accepts');
  assert.ok(ids.includes('claude-fable-5-1') && ids.includes('claude-fable-5'),
    'the 4x cached-read split is the case this property is for');

  const byFamily = new Map();
  for (const id of ids) {
    const fam = modelFamily(id);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(id);
  }
  for (const [fam, sharing] of byFamily) {
    if (sharing.length < 2) continue;
    const [first, ...rest] = sharing;
    for (const other of rest) {
      assert.deepStrictEqual(PRICES[other], PRICES[first],
        `${other} and ${first} both reduce to "${fam}" but are priced differently — `
        + 'one row would silently govern both');
    }
  }

  // The specific collapse, named: these two differ 4x on cached reads.
  assert.notStrictEqual(PRICES['claude-fable-5-1'].cache_read, PRICES['claude-fable-5'].cache_read);
  assert.notStrictEqual(modelFamily('claude-fable-5-1'), modelFamily('claude-fable-5'));
});

test('a threshold set for fable-5-1 does not move fable-5', () => {
  const ov = { 'fable-5-1': { nudge: 250_000, escalate: 310_000 } };
  const newer = ctxThresholdsFor('claude-fable-5-1', ov);
  const older = ctxThresholdsFor('claude-fable-5', ov);
  assert.strictEqual(newer.source, 'settings-model');
  assert.deepStrictEqual({ nudge: newer.nudge, escalate: newer.escalate },
    { nudge: 250_000, escalate: 310_000 });
  assert.strictEqual(older.source, 'builtin-default', 'fable 5.0 owns no row and must not inherit one');
  assert.strictEqual(older.nudge, CTX_REMINDER_NUDGE_TOKENS);
  // And the decision acts on the split, not merely reports it.
  assert.strictEqual(ctxReminderFor(210_000, newer), null, '5.1 defers past the baseline');
  assert.ok(ctxReminderFor(210_000, older), '5.0 still nudges at the baseline');
});

test('invariant 3: a model matching nothing lands on the baseline AUDIBLY', () => {
  const r = ctxThresholdsFor('totally-unknown-model', {});
  assert.strictEqual(r.family, null);
  assert.strictEqual(r.source, 'builtin-default');
  assert.strictEqual(r.nudge, CTX_REMINDER_NUDGE_TOKENS);
  // A row whose values happen to equal the baseline is distinguishable from a
  // miss — which is the whole difference a silent lookup would erase.
  const named = ctxThresholdsFor('claude-opus-5', { 'opus-5': { nudge: 175_000, escalate: 225_000 } });
  assert.strictEqual(named.source, 'settings-model');
  assert.deepStrictEqual(
    { nudge: named.nudge, escalate: named.escalate },
    { nudge: CTX_REMINDER_NUDGE_TOKENS, escalate: CTX_REMINDER_ESCALATE_TOKENS });
});

// ---------------------------------------------------------------------------
// The ENTER for the whole file: the mechanism is live.
// ---------------------------------------------------------------------------

test('ENTER: the shipped baseline is the ruled one, and it applies to every model', () => {
  assert.strictEqual(CTX_REMINDER_NUDGE_TOKENS, 175_000);
  assert.strictEqual(CTX_REMINDER_ESCALATE_TOKENS, 225_000);
  for (const id of ['claude-fable-5-1', 'claude-opus-5', 'us.anthropic.claude-sonnet-4-6']) {
    const r = ctxThresholdsFor(id, {});
    assert.deepStrictEqual({ nudge: r.nudge, escalate: r.escalate },
      { nudge: 175_000, escalate: 225_000 }, id);
    assert.strictEqual(ctxReminderFor(174_999, r), null, `${id} is not nudged below 175k`);
    assert.ok(ctxReminderFor(175_000, r).includes('getting heavy'), `${id} nudges at 175k`);
    assert.ok(ctxReminderFor(225_000, r).includes('very heavy'), `${id} escalates at 225k`);
  }
});

test('ENTER: an operator override reaches the decision and outranks the shipped row', () => {
  const ov = { default: { nudge: 120_000, escalate: 300_000 }, 'fable-5-1': { nudge: 400_000, escalate: 500_000 } };
  const opus = ctxThresholdsFor('claude-opus-5', ov);
  assert.deepStrictEqual({ ...opus }, { nudge: 120_000, escalate: 300_000, family: 'opus-5', source: 'settings-default' });
  assert.ok(ctxReminderFor(130_000, opus), 'the lowered baseline fires where the shipped one would not');
  assert.strictEqual(ctxReminderFor(130_000, ctxThresholdsFor('claude-opus-5', {})), null);

  const fable = ctxThresholdsFor('claude-fable-5-1', ov);
  assert.strictEqual(fable.source, 'settings-model');
  assert.deepStrictEqual({ nudge: fable.nudge, escalate: fable.escalate }, { nudge: 400_000, escalate: 500_000 });
  assert.strictEqual(ctxReminderFor(390_000, fable), null, 'and the decision uses it');
});

test('a baseline override does not move a model that has its own row', () => {
  const restore = new Map(CTX_MODEL_THRESHOLDS);
  try {
    CTX_MODEL_THRESHOLDS.set('fable-5-1', { nudge: 250_000, escalate: 310_000 });
    const fable = ctxThresholdsFor('claude-fable-5-1', { default: { nudge: 100_000, escalate: 400_000 } });
    assert.strictEqual(fable.source, 'builtin-model');
    assert.deepStrictEqual({ nudge: fable.nudge, escalate: fable.escalate },
      { nudge: 250_000, escalate: 310_000 },
      'most specific wins: a baseline edit must not silently erase per-model tuning');
  } finally {
    CTX_MODEL_THRESHOLDS.clear();
    for (const [k, v] of restore) CTX_MODEL_THRESHOLDS.set(k, v);
  }
});

// ---------------------------------------------------------------------------
// Clamps.
// ---------------------------------------------------------------------------

test('sanitizeCtxThresholds: junk drops the whole row rather than half of it', () => {
  const cases = [
    [{ default: { nudge: 10, escalate: 500_000 } }, {}, 'below the floor'],
    [{ default: { nudge: 9_000_000, escalate: 9_500_000 } }, {}, 'above the ceiling'],
    [{ default: { nudge: 200.5, escalate: 300_000 } }, {}, 'non-integer nudge'],
    [{ default: { nudge: '200000', escalate: 300_000 } }, {}, 'string nudge'],
    [{ default: { escalate: 300_000 } }, {}, 'no nudge at all'],
    [{ default: null }, {}, 'null row'],
    [{ default: 5 }, {}, 'scalar row'],
    [{ 'not a family': { nudge: 200_000, escalate: 300_000 } }, {}, 'unparseable key'],
    [{ __proto__: { nudge: 200_000, escalate: 300_000 } }, {}, 'inherited key'],
    [null, {}, 'null map'],
    [[{ nudge: 200_000 }], {}, 'array'],
    ['nope', {}, 'string'],
  ];
  for (const [raw, want, why] of cases) {
    assert.deepStrictEqual(sanitizeCtxThresholds(raw), want, why);
  }
});

test('sanitizeCtxThresholds: escalate is lifted, never dropped, so the two events cannot collapse', () => {
  // Each row's expected escalate is a literal: recomputing it as nudge + GAP
  // would assert the clamp against its own rule.
  const cases = [
    [{ nudge: 200_000, escalate: 250_000 }, 250_000, 'a valid pair is untouched'],
    [{ nudge: 200_000, escalate: 200_000 }, 225_000, 'equal values are separated'],
    [{ nudge: 200_000, escalate: 100_000 }, 225_000, 'an inverted pair is corrected upward'],
    [{ nudge: 200_000, escalate: 210_000 }, 225_000, 'too close is pushed to the gap'],
    [{ nudge: 200_000 }, 225_000, 'a missing escalate is derived'],
    [{ nudge: 200_000, escalate: 'x' }, 225_000, 'a junk escalate does not drop the nudge'],
    [{ nudge: 60_000, escalate: 1_000_000 }, 1_000_000, 'a wide gap is allowed'],
  ];
  for (const [raw, wantEscalate, why] of cases) {
    const got = sanitizeCtxThresholds({ default: raw }).default;
    assert.ok(got, `${why}: the row must survive`);
    assert.strictEqual(got.nudge, raw.nudge, why);
    assert.strictEqual(got.escalate, wantEscalate, why);
    assert.ok(got.escalate - got.nudge >= CTX_ESCALATE_MIN_GAP, `${why}: gap holds`);
  }
});

test('the clamp band is expressed as literals', () => {
  assert.strictEqual(CTX_THRESHOLD_MIN, 50_000);
  assert.strictEqual(CTX_THRESHOLD_MAX, 2_000_000);
  assert.strictEqual(CTX_ESCALATE_MIN_GAP, 25_000);
  assert.deepStrictEqual(sanitizeCtxThresholds({ default: { nudge: 49_999, escalate: 100_000 } }), {});
  assert.deepStrictEqual(sanitizeCtxThresholds({ default: { nudge: 50_000, escalate: 100_000 } }),
    { default: { nudge: 50_000, escalate: 100_000 } });
  assert.deepStrictEqual(sanitizeCtxThresholds({ default: { nudge: 2_000_001, escalate: 3_000_000 } }), {});
});

// Two independent expressions of the family shape — the grammar that EMITS one
// and the settings guard that ACCEPTS one — drift apart silently: a family the
// guard rejects becomes an override dropped on load, with the operator's edit
// vanishing and no error anywhere. Driven off FAMILY_CASES so widening the
// grammar without widening the guard fails here.
test('every family the grammar can emit survives the settings-key guard', () => {
  const families = [...new Set(FAMILY_CASES.map(([id]) => modelFamily(id)).filter(Boolean))];
  assert.ok(families.length >= 8, 'ENTER: the cases must actually produce families to check');
  for (const fam of families) {
    const kept = sanitizeCtxThresholds({ [fam]: { nudge: 300_000, escalate: 400_000 } });
    assert.deepStrictEqual(kept, { [fam]: { nudge: 300_000, escalate: 400_000 } },
      `"${fam}" is a family the grammar emits, so an override keyed by it must survive`);
  }
});

test('an override for a family this build ships no row for survives sanitizing', () => {
  const ov = sanitizeCtxThresholds({ 'sonnet-9-2': { nudge: 300_000, escalate: 400_000 } });
  assert.deepStrictEqual(ov, { 'sonnet-9-2': { nudge: 300_000, escalate: 400_000 } });
  const r = ctxThresholdsFor('claude-sonnet-9-2', ov);
  assert.strictEqual(r.source, 'settings-model');
  assert.strictEqual(r.nudge, 300_000);
});

// ---------------------------------------------------------------------------
// Purity (invariant 5) and the settings round-trip.
// ---------------------------------------------------------------------------

test('invariant 5: the decision stays pure — tokens and thresholds, nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ctx-reminder.js'), 'utf-8');
  assert.ok(!/\brequire\s*\(/.test(src), 'ctx-reminder.js must stay dependency-free');
  assert.strictEqual(ctxReminderFor.length, 2, 'tokens + thresholds; no seat argument');
  assert.strictEqual(ctxThresholdsFor.length, 2, 'model id + overrides; nothing session-shaped');
  // Same inputs, same output, no matter how often or in what order.
  const a = ctxReminderFor(300_000, ctxThresholdsFor('claude-fable-5', {}));
  ctxReminderFor(1, ctxThresholdsFor('claude-opus-5', { default: { nudge: 60_000, escalate: 90_000 } }));
  assert.strictEqual(ctxReminderFor(300_000, ctxThresholdsFor('claude-fable-5', {})), a);
  // The resolver must not retain what it was handed.
  const ov = { default: { nudge: 60_000, escalate: 90_000 } };
  ctxThresholdsFor('claude-opus-5', ov);
  assert.deepStrictEqual(ov, { default: { nudge: 60_000, escalate: 90_000 } }, 'the caller’s object is not mutated');
});

test('settings round-trip: written, reloaded, and surviving a save that never mentions the key', (t) => {
  const { initStores } = require('../stores');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-t619-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { uiSettings } = initStores(dir, { registryDir: path.join(dir, 'run') });

  uiSettings.set({ ctxReminderThresholds: { default: { nudge: 180_000, escalate: 260_000 } } });
  assert.deepStrictEqual(uiSettings.get().ctxReminderThresholds,
    { default: { nudge: 180_000, escalate: 260_000 } });

  // Reloaded from disk by a second store over the same directory — get() is a
  // read of the file, so this is the persisted bytes and not a cached object.
  const second = initStores(dir, { registryDir: path.join(dir, 'run') });
  assert.deepStrictEqual(second.uiSettings.get().ctxReminderThresholds,
    { default: { nudge: 180_000, escalate: 260_000 } });

  // An unrelated save must not erase it.
  uiSettings.set({ speakRate: 240 });
  assert.deepStrictEqual(uiSettings.get().ctxReminderThresholds,
    { default: { nudge: 180_000, escalate: 260_000 } }, 'an unrelated save carries the key forward');
  assert.strictEqual(uiSettings.get().speakRate, 240, 'ENTER: the unrelated save actually landed');

  // A per-model row set by hand survives a Preferences save, which sends only
  // the baseline — the merge this store does rather than a whole-object write.
  uiSettings.set({ ctxReminderThresholds: { 'fable-5': { nudge: 400_000, escalate: 460_000 } } });
  uiSettings.set({ ctxReminderThresholds: { default: { nudge: 190_000, escalate: 240_000 } } });
  assert.deepStrictEqual(uiSettings.get().ctxReminderThresholds, {
    default: { nudge: 190_000, escalate: 240_000 },
    'fable-5': { nudge: 400_000, escalate: 460_000 },
  }, 'the baseline save keeps the per-model row');

  // Clearing the baseline in Preferences sends an explicit null.
  uiSettings.set({ ctxReminderThresholds: { default: null } });
  assert.deepStrictEqual(uiSettings.get().ctxReminderThresholds,
    { 'fable-5': { nudge: 400_000, escalate: 460_000 } }, 'the baseline resets, the model row stays');

  // A junk write cannot land a value that reads back as itself.
  uiSettings.set({ ctxReminderThresholds: { default: { nudge: 5, escalate: 9 } } });
  assert.strictEqual(uiSettings.get().ctxReminderThresholds.default, undefined);
});
