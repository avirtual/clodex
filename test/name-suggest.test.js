'use strict';
// name-suggest.test.js — the New Session dialog's default-name bump leaf (Task 19
// item 1). Pure: given a base suggestion + the reserved-name set, advance past a
// collision so the user's first Create doesn't bounce.

const test = require('node:test');
const assert = require('node:assert');
const { bumpDefaultName } = require('../renderer/lib/name-suggest');

test('free base is returned untouched', () => {
  assert.strictEqual(bumpDefaultName('session-1', new Set()), 'session-1');
  assert.strictEqual(bumpDefaultName('session-3', new Set(['session-1', 'session-2'])), 'session-3');
});

test('collision increments the trailing integer, staying in session-N form', () => {
  assert.strictEqual(bumpDefaultName('session-1', new Set(['session-1'])), 'session-2');
  assert.strictEqual(
    bumpDefaultName('session-1', new Set(['session-1', 'session-2', 'session-3'])),
    'session-4',
  );
});

test('bumps from the base number, not from 1', () => {
  assert.strictEqual(bumpDefaultName('session-5', new Set(['session-5', 'session-6'])), 'session-7');
});

test('accepts an array of taken names as well as a Set', () => {
  assert.strictEqual(bumpDefaultName('session-1', ['session-1', 'session-2']), 'session-3');
});

test('a base without a trailing number gets a -2, -3 suffix', () => {
  assert.strictEqual(bumpDefaultName('agent', new Set(['agent'])), 'agent-2');
  assert.strictEqual(bumpDefaultName('agent', new Set(['agent', 'agent-2'])), 'agent-3');
});

test('null / undefined reserved → base returned (nothing taken)', () => {
  assert.strictEqual(bumpDefaultName('session-1', null), 'session-1');
  assert.strictEqual(bumpDefaultName('session-1', undefined), 'session-1');
});
