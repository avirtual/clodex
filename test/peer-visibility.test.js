'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nextVisibleWithName, nextVisibleWithoutName } = require('../peer-visibility');

test('nextVisibleWithName: unmaterialized selection is a no-op (shows all already)', () => {
  assert.strictEqual(nextVisibleWithName(undefined, 'alpha'), null);
  assert.strictEqual(nextVisibleWithName(null, 'alpha'), null);
});

test('nextVisibleWithName: a name already whitelisted is a no-op', () => {
  assert.strictEqual(nextVisibleWithName(['alpha', 'beta'], 'alpha'), null);
});

test('nextVisibleWithName: a materialized set missing the name appends it', () => {
  assert.deepStrictEqual(nextVisibleWithName(['alpha'], 'beta'), ['alpha', 'beta']);
});

test('nextVisibleWithName: appending an empty whitelist yields just the name', () => {
  assert.deepStrictEqual(nextVisibleWithName([], 'beta'), ['beta']);
});

test('nextVisibleWithName: does not mutate the input array', () => {
  const sel = ['alpha'];
  const next = nextVisibleWithName(sel, 'beta');
  assert.deepStrictEqual(sel, ['alpha'], 'input untouched');
  assert.notStrictEqual(next, sel, 'returns a fresh array');
});

test('nextVisibleWithoutName: a materialized set drops the name and ignores liveNames', () => {
  assert.deepStrictEqual(nextVisibleWithoutName(['alpha', 'beta'], 'alpha', ['gamma']), ['beta']);
});

test('nextVisibleWithoutName: a name already absent from the whitelist is a no-op', () => {
  assert.strictEqual(nextVisibleWithoutName(['beta'], 'alpha', ['alpha', 'beta']), null);
});

test('nextVisibleWithoutName: an unmaterialized selection materializes from liveNames minus the name', () => {
  assert.deepStrictEqual(nextVisibleWithoutName(undefined, 'alpha', ['alpha', 'beta', 'beta', 'gamma']), ['beta', 'gamma']);
  assert.deepStrictEqual(nextVisibleWithoutName(null, 'alpha', ['alpha']), []);
});

test('nextVisibleWithoutName: an unmaterialized selection with no liveNames array is a no-op', () => {
  assert.strictEqual(nextVisibleWithoutName(undefined, 'alpha', undefined), null);
  assert.strictEqual(nextVisibleWithoutName(null, 'alpha', 'alpha'), null);
});

test('nextVisibleWithoutName: does not mutate the input array', () => {
  const sel = ['alpha', 'beta'];
  const next = nextVisibleWithoutName(sel, 'alpha', []);
  assert.deepStrictEqual(sel, ['alpha', 'beta'], 'input untouched');
  assert.notStrictEqual(next, sel, 'returns a fresh array');
});
