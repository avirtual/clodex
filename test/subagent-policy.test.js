'use strict';
// The subagent live/done/drop policy (renderer/lib/subagent-policy.js). There is
// no wire signal for "subagent done", so this module IS the definition — the
// sidebar child rows and the drawer's Activity chips both classify through it,
// and the reason it is a leaf is that two copies could disagree.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  classifySubagent, SUBAGENT_ACTIVE_S, SUBAGENT_DROP_S,
} = require('../renderer/lib/subagent-policy');

test('a sub seen just now is active', () => {
  assert.strictEqual(classifySubagent({ lastActiveS: 2 }, 0), 'active');
});

test('a sub idle past ACTIVE_S is done, not dropped', () => {
  assert.strictEqual(classifySubagent({ lastActiveS: 60 }, 0), 'done');
});

test('a sub idle past DROP_S is dropped (null), which is not done', () => {
  const r = classifySubagent({ lastActiveS: 400 }, 0);
  assert.strictEqual(r, null);
  assert.notStrictEqual(r, 'done'); // drop hides the row; done still renders
});

// The whole reason payloadAgeS is a parameter. A 25s-idle sub in a 10s-old
// payload has been idle 35s NOW; classifying on lastActiveS alone would report
// it live for a full poll interval after it stopped.
test('payload age is added to the idle time, not ignored', () => {
  assert.strictEqual(classifySubagent({ lastActiveS: 25 }, 0), 'active');
  assert.strictEqual(classifySubagent({ lastActiveS: 25 }, 10), 'done');
});

test('payload age alone can push a sub over the drop threshold', () => {
  assert.strictEqual(classifySubagent({ lastActiveS: 299 }, 0), 'done');
  assert.strictEqual(classifySubagent({ lastActiveS: 299 }, 2), null);
});

// A sub that has never made a request carries no lastActiveS. It was just
// spawned, so it is live — treating a missing field as "infinitely idle" would
// drop every subagent on the turn it appears.
test('a missing lastActiveS reads as zero idle, so a brand-new sub is active', () => {
  assert.strictEqual(classifySubagent({}, 0), 'active');
  assert.strictEqual(classifySubagent({ lastActiveS: null }, 0), 'active');
  // ...even in an old payload: there is no evidence of idleness to age.
  assert.strictEqual(classifySubagent({ lastActiveS: null }, 120), 'active');
});

// Exactly-at-boundary, both directions, because both comparisons are strict and
// flipping either to `<=`/`>=` is a one-character mistake with no other witness.
test('the boundaries are exact: ACTIVE_S is done, DROP_S is still done', () => {
  assert.strictEqual(classifySubagent({ lastActiveS: SUBAGENT_ACTIVE_S - 0.01 }, 0), 'active');
  assert.strictEqual(classifySubagent({ lastActiveS: SUBAGENT_ACTIVE_S }, 0), 'done');
  assert.strictEqual(classifySubagent({ lastActiveS: SUBAGENT_DROP_S }, 0), 'done');
  assert.strictEqual(classifySubagent({ lastActiveS: SUBAGENT_DROP_S + 0.01 }, 0), null);
});

test('the thresholds are the values the sidebar shipped with', () => {
  assert.strictEqual(SUBAGENT_ACTIVE_S, 30);
  assert.strictEqual(SUBAGENT_DROP_S, 300);
});
