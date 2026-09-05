'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sessionMenuEntries } = require('../renderer/lib/session-actions');

test('claude: full config surface + conversation actions, in order', () => {
  const acts = sessionMenuEntries('claude').map((e) => e.act);
  assert.deepStrictEqual(acts,
    ['tools', 'skills', 'agents', 'intents', 'plugins', 'edit', 'history', 'reload']);
  // Every entry has a non-empty label for the menu row.
  for (const e of sessionMenuEntries('claude')) {
    assert.ok(e.label && typeof e.label === 'string');
  }
});

test('codex: the shared entries, which include the plugin editor', () => {
  const acts = sessionMenuEntries('codex').map((e) => e.act);
  assert.deepStrictEqual(acts, ['plugins', 'edit', 'history', 'reload']);
  // The gating launchers Codex has no handler for must be absent.
  for (const gone of ['tools', 'skills', 'agents', 'intents']) {
    assert.ok(!acts.includes(gone), `${gone} must not be offered to codex`);
  }
});

// The labels as LITERALS, per the table rule: computing an expectation from the
// module's own list would assert only that it agrees with itself, and the row
// this table exists to pin is `plugins` — the one entry that is shared while
// every other gating editor is claude-only.
test('every entry carries its exact menu label, both types', () => {
  const LABELS = {
    tools: '🛠 Tools…',
    skills: '🧩 Skills…',
    agents: '🤖 Agents…',
    intents: '🔒 Intents…',
    plugins: '🔌 Plugins…',
    edit: '⚙ Edit Settings…',
    history: '🕘 History…',
    reload: '🔄 Reload (fresh restart)',
  };
  for (const type of ['claude', 'codex']) {
    const entries = sessionMenuEntries(type);
    assert.ok(entries.some((e) => e.act === 'plugins'),
      `ENTER: ${type} must offer the plugins row this table is here to pin`);
    for (const e of entries) {
      assert.strictEqual(e.label, LABELS[e.act], `${type}/${e.act} label`);
    }
  }
});

// Placement, not just membership: Plugins… leads the shared block, so a claude
// seat reads it after Intents… and a codex seat reads it first.
test('plugins leads the shared block for both types', () => {
  const claude = sessionMenuEntries('claude').map((e) => e.act);
  assert.strictEqual(claude[claude.indexOf('plugins') - 1], 'intents');
  assert.strictEqual(claude[claude.indexOf('plugins') + 1], 'edit');
  assert.strictEqual(sessionMenuEntries('codex')[0].act, 'plugins');
});

test('non-agent / absent type → no entries (caller renders no button)', () => {
  for (const t of [null, undefined, 'bash', 'remote', '']) {
    assert.deepStrictEqual(sessionMenuEntries(t), []);
  }
});

test('returns fresh arrays (caller may mutate without corrupting the source)', () => {
  const a = sessionMenuEntries('claude');
  a.push({ act: 'x', label: 'x' });
  assert.strictEqual(sessionMenuEntries('claude').length, 8, 'source list is not shared');
});
