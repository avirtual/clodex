'use strict';
// Unit tests for renderer/lib/placement.js — the New Session "Run in" placement
// decisions (docs/sandbox-plan.md M3). Pure branch logic; the DOM plumbing in
// renderer.js is thin around these.

const test = require('node:test');
const assert = require('node:assert');
const {
  SANDBOX_PLACEMENT_CWD, hasSandboxPeer, nextCwd, richFieldsGreyed,
} = require('../renderer/lib/placement');

test('hasSandboxPeer: true only when a peer with id "sandbox" is present', () => {
  assert.strictEqual(hasSandboxPeer([{ id: 'other' }, { id: 'sandbox' }]), true);
  assert.strictEqual(hasSandboxPeer([{ id: 'other' }]), false);
  assert.strictEqual(hasSandboxPeer([]), false);
  assert.strictEqual(hasSandboxPeer(undefined), false);
});

test('nextCwd: host→sandbox swaps the host default to the container path', () => {
  assert.strictEqual(nextCwd('sandbox', '/Users/me', '/Users/me'), SANDBOX_PLACEMENT_CWD);
});

test('nextCwd: sandbox→host swaps the container default back to the host default', () => {
  assert.strictEqual(nextCwd('host', SANDBOX_PLACEMENT_CWD, '/Users/me'), '/Users/me');
});

test('nextCwd: a hand-typed path is preserved across a placement flip', () => {
  // Not equal to either default → left untouched in both directions.
  assert.strictEqual(nextCwd('sandbox', '/Users/me/project', '/Users/me'), '/Users/me/project');
  assert.strictEqual(nextCwd('host', '/srv/thing', '/Users/me'), '/srv/thing');
});

test('richFieldsGreyed: sandbox greys, host does not', () => {
  assert.strictEqual(richFieldsGreyed('sandbox'), true);
  assert.strictEqual(richFieldsGreyed('host'), false);
});

test('SANDBOX_PLACEMENT_CWD is the container work mount', () => {
  assert.strictEqual(SANDBOX_PLACEMENT_CWD, '/home/clodex/work');
});
