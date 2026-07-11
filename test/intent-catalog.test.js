'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GATEABLE_INTENTS, GATEABLE_TYPES, intentEnabled } = require('../intent-catalog');

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
