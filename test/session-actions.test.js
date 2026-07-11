'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sessionMenuEntries } = require('../renderer/lib/session-actions');

test('claude: full config surface + conversation actions, in order', () => {
  const acts = sessionMenuEntries('claude').map((e) => e.act);
  assert.deepStrictEqual(acts,
    ['tools', 'skills', 'agents', 'intents', 'edit', 'history', 'reload']);
  // Every entry has a non-empty label for the menu row.
  for (const e of sessionMenuEntries('claude')) {
    assert.ok(e.label && typeof e.label === 'string');
  }
});

test('codex: only the shared entries (no per-session gating popovers)', () => {
  const acts = sessionMenuEntries('codex').map((e) => e.act);
  assert.deepStrictEqual(acts, ['edit', 'history', 'reload']);
  // The gating launchers Codex has no handler for must be absent.
  for (const gone of ['tools', 'skills', 'agents', 'intents']) {
    assert.ok(!acts.includes(gone), `${gone} must not be offered to codex`);
  }
});

test('non-agent / absent type → no entries (caller renders no button)', () => {
  for (const t of [null, undefined, 'bash', 'remote', '']) {
    assert.deepStrictEqual(sessionMenuEntries(t), []);
  }
});

test('returns fresh arrays (caller may mutate without corrupting the source)', () => {
  const a = sessionMenuEntries('claude');
  a.push({ act: 'x', label: 'x' });
  assert.strictEqual(sessionMenuEntries('claude').length, 7, 'source list is not shared');
});
