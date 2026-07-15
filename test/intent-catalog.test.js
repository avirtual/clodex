'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GATEABLE_INTENTS, GATEABLE_TYPES, intentEnabled, intentsAllowlistFromChecked, deniedIntentCount } = require('../intent-catalog');

const ALL_TYPES = GATEABLE_INTENTS.map((i) => i.type);

test('catalog: the 10 gateable types in grammar order, name excluded', () => {
  assert.deepStrictEqual(
    GATEABLE_INTENTS.map((i) => i.type),
    ['dm', 'who', 'context', 'memory', 'spawn', 'file', 'resend', 'exec', 'remind', 'notify-user'],
  );
  // Identity is never gateable.
  assert.strictEqual(GATEABLE_TYPES.has('name'), false);
  // Every catalog row has a non-empty label for the checklist.
  for (const i of GATEABLE_INTENTS) assert.ok(i.label && typeof i.label === 'string');
  // GATEABLE_TYPES is the type set of the ordered list.
  assert.strictEqual(GATEABLE_TYPES.size, GATEABLE_INTENTS.length);
});

test('intentEnabled: absent list → everything enabled (back-compat default)', () => {
  for (const list of [undefined, null, 'not-an-array', 42, {}]) {
    assert.strictEqual(intentEnabled('dm', list), true);
    assert.strictEqual(intentEnabled('exec', list), true);
    assert.strictEqual(intentEnabled('notify-user', list), true);
  }
});

test('intentEnabled: present list → membership for gateable types', () => {
  const list = ['dm', 'exec', 'remind']; // a trader seat
  assert.strictEqual(intentEnabled('dm', list), true);
  assert.strictEqual(intentEnabled('exec', list), true);
  assert.strictEqual(intentEnabled('remind', list), true);
  assert.strictEqual(intentEnabled('who', list), false);
  assert.strictEqual(intentEnabled('spawn', list), false);
  assert.strictEqual(intentEnabled('notify-user', list), false);
});

test('intentEnabled: empty array is a real value → everything gated', () => {
  assert.strictEqual(intentEnabled('dm', []), false);
  assert.strictEqual(intentEnabled('exec', []), false);
  // …but name / non-gateable verbs survive even an empty list.
  assert.strictEqual(intentEnabled('name', []), true);
});

test('intentEnabled: name + non-gateable verbs are always enabled, list or not', () => {
  // name is identity — never gateable, regardless of the list.
  assert.strictEqual(intentEnabled('name', ['dm']), true);
  assert.strictEqual(intentEnabled('name', []), true);
  assert.strictEqual(intentEnabled('name', undefined), true);
  // A parsed-but-uncatalogued verb (e.g. a future non-gateable one) is enabled
  // even when a restrictive list is present — ungateable by omission.
  assert.strictEqual(intentEnabled('escape', ['dm']), true);
  assert.strictEqual(intentEnabled('peers', []), true);
});

test('intentsAllowlistFromChecked: every gateable box checked → null (omit the field)', () => {
  // The all-enabled state persists as ABSENCE, never a frozen array — so a future
  // intent lights up in this seat by default. Order of the input doesn't matter.
  assert.strictEqual(intentsAllowlistFromChecked(ALL_TYPES), null);
  assert.strictEqual(intentsAllowlistFromChecked(ALL_TYPES.slice().reverse()), null);
});

test('intentsAllowlistFromChecked: a subset → the enabled list in CATALOG order', () => {
  // A trader seat, checked out of order in the DOM — normalized to catalog order.
  assert.deepStrictEqual(
    intentsAllowlistFromChecked(['remind', 'exec', 'dm']),
    ['dm', 'exec', 'remind'],
  );
});

test('intentsAllowlistFromChecked: nothing checked → [] (a real "everything gated" value)', () => {
  const r = intentsAllowlistFromChecked([]);
  assert.ok(Array.isArray(r));
  assert.strictEqual(r.length, 0);
});

test('deniedIntentCount: absent/null allowlist → 0 (the living all-enabled default)', () => {
  assert.strictEqual(deniedIntentCount(null), 0);
  assert.strictEqual(deniedIntentCount(undefined), 0);
  assert.strictEqual(deniedIntentCount('not-an-array'), 0);
});

test('deniedIntentCount: [] → every gateable intent denied', () => {
  assert.strictEqual(deniedIntentCount([]), GATEABLE_INTENTS.length);
});

test('deniedIntentCount: a subset → the complement count', () => {
  // Two allowed → the rest denied.
  assert.strictEqual(deniedIntentCount(['dm', 'who']), GATEABLE_INTENTS.length - 2);
  // All allowed → 0.
  assert.strictEqual(deniedIntentCount(ALL_TYPES), 0);
});

test('deniedIntentCount: strays in the list do not offset the denied count', () => {
  // A bogus/non-gateable entry can never mark a real intent enabled, so it can't
  // shrink the denied count — only catalog membership counts.
  assert.strictEqual(deniedIntentCount(['dm', 'name', 'bogus']), GATEABLE_INTENTS.length - 1);
});

test('intentsAllowlistFromChecked: stray/non-gateable values are dropped, not counted', () => {
  // A stray `name` (never a checklist row) or an unknown token can't inflate the
  // count to "all" nor leak into the stored list — only catalog types survive.
  assert.deepStrictEqual(
    intentsAllowlistFromChecked([...ALL_TYPES, 'name', 'bogus']),
    null, // the 10 real ones are all present → still all-enabled
  );
  assert.deepStrictEqual(
    intentsAllowlistFromChecked(['dm', 'name', 'bogus']),
    ['dm'], // strays dropped
  );
});
