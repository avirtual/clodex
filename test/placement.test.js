'use strict';
// Unit tests for renderer/lib/placement.js — the New Session "Run in" placement
// decisions (docs/sandbox-plan.md M3, generalized to N boxes in M6b P3). Pure
// branch logic; the DOM plumbing in renderer.js is thin around these. A placement
// is 'host' or a box id — the leaf treats any non-'host' value as a box.

const test = require('node:test');
const assert = require('node:assert');
const {
  HOST_PLACEMENT, SANDBOX_PLACEMENT_CWD,
  isBoxPlacement, showPlacementSelector, nextCwd, richFieldsGreyed,
} = require('../renderer/lib/placement');

test('isBoxPlacement: any non-host, non-empty value is a box; host/empty are not', () => {
  assert.strictEqual(isBoxPlacement('sandbox'), true);
  assert.strictEqual(isBoxPlacement('proj-alpha'), true, 'any box id counts');
  assert.strictEqual(isBoxPlacement('host'), false);
  assert.strictEqual(isBoxPlacement(''), false);
  assert.strictEqual(isBoxPlacement(undefined), false);
  assert.strictEqual(isBoxPlacement(null), false);
});

test('showPlacementSelector: shown only when at least one box is registered', () => {
  assert.strictEqual(showPlacementSelector([{ id: 'sandbox' }]), true);
  assert.strictEqual(showPlacementSelector([{ id: 'sandbox' }, { id: 'proj' }]), true);
  assert.strictEqual(showPlacementSelector([]), false);
  assert.strictEqual(showPlacementSelector(undefined), false);
  assert.strictEqual(showPlacementSelector(null), false);
});

test('nextCwd: host→box swaps the host default to the container path (any box id)', () => {
  assert.strictEqual(nextCwd('sandbox', '/Users/me', '/Users/me'), SANDBOX_PLACEMENT_CWD);
  assert.strictEqual(nextCwd('proj-alpha', '/Users/me', '/Users/me'), SANDBOX_PLACEMENT_CWD);
});

test('nextCwd: box→host swaps the container default back to the host default', () => {
  assert.strictEqual(nextCwd('host', SANDBOX_PLACEMENT_CWD, '/Users/me'), '/Users/me');
});

test('nextCwd: box→box keeps the container default (no swap between two boxes)', () => {
  // Selecting a different box while already on the container default leaves it.
  assert.strictEqual(nextCwd('proj', SANDBOX_PLACEMENT_CWD, '/Users/me'), SANDBOX_PLACEMENT_CWD);
});

test('nextCwd: a hand-typed path is preserved across a placement flip', () => {
  // Not equal to either default → left untouched in both directions.
  assert.strictEqual(nextCwd('sandbox', '/Users/me/project', '/Users/me'), '/Users/me/project');
  assert.strictEqual(nextCwd('host', '/srv/thing', '/Users/me'), '/srv/thing');
});

test('richFieldsGreyed: host is never greyed, regardless of create2', () => {
  assert.strictEqual(richFieldsGreyed('host'), false);
  assert.strictEqual(richFieldsGreyed('host', false), false);
  assert.strictEqual(richFieldsGreyed('host', true), false);
});

test('richFieldsGreyed: a non-create2 box stays greyed (M3 behaviour, cap gate)', () => {
  assert.strictEqual(richFieldsGreyed('sandbox'), true, 'default (no cap) → greyed, safe');
  assert.strictEqual(richFieldsGreyed('sandbox', false), true);
  assert.strictEqual(richFieldsGreyed('proj-alpha', false), true, 'any box id, same gate');
});

test('richFieldsGreyed: a create2 box un-greys (M5 full-param create)', () => {
  assert.strictEqual(richFieldsGreyed('sandbox', true), false);
  assert.strictEqual(richFieldsGreyed('proj-alpha', true), false);
});

test('HOST_PLACEMENT / SANDBOX_PLACEMENT_CWD constants', () => {
  assert.strictEqual(HOST_PLACEMENT, 'host');
  assert.strictEqual(SANDBOX_PLACEMENT_CWD, '/home/clodex/work');
});
