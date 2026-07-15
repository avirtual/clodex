'use strict';
// Unit tests for renderer/lib/peer-visibility.js — the pure array math behind
// ensurePeerSessionVisible (the create-on-peer "lands invisible" fix). The IPC +
// renderPeers plumbing in peers-ui.js is thin around this decision.

const test = require('node:test');
const assert = require('node:assert');
const { nextVisibleWithName } = require('../renderer/lib/peer-visibility');

test('nextVisibleWithName: unmaterialized selection is a no-op (shows all already)', () => {
  // No explicit array ⇒ every session shows, so nothing to patch.
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
  // The all-hidden edge: an explicit [] still needs the new name added.
  assert.deepStrictEqual(nextVisibleWithName([], 'beta'), ['beta']);
});

test('nextVisibleWithName: does not mutate the input array', () => {
  const sel = ['alpha'];
  const next = nextVisibleWithName(sel, 'beta');
  assert.deepStrictEqual(sel, ['alpha'], 'input untouched');
  assert.notStrictEqual(next, sel, 'returns a fresh array');
});
