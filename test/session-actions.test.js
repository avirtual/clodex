'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sessionMenuEntries } = require('../renderer/lib/session-actions');
const { PROVIDER_CAPS, capsFor } = require('../renderer/lib/provider-caps');

test('claude: full config surface + conversation actions, in order', () => {
  const acts = sessionMenuEntries('claude').map((e) => e.act);
  assert.deepStrictEqual(acts,
    ['tools', 'skills', 'agents', 'intents', 'plugins', 'edit', 'history', 'reload']);
  // Every entry has a non-empty label for the menu row.
  for (const e of sessionMenuEntries('claude')) {
    assert.ok(e.label && typeof e.label === 'string');
  }
});

test('codex: the intent gate, the skills editor, and the shared entries', () => {
  const acts = sessionMenuEntries('codex').map((e) => e.act);
  assert.deepStrictEqual(acts, ['intents', 'skills', 'plugins', 'edit', 'history', 'reload']);
  // Codex consumes the intent allowlist on spawn and the dispatch gate is shared,
  // so the editor must be reachable; the same holds for the Custom skills it is
  // given at create time (t750). The CLI-roster launchers stay claude-only.
  assert.ok(acts.includes('intents'), 'the intent gate bites a codex seat, so it must be editable');
  for (const gone of ['tools', 'agents']) {
    assert.ok(!acts.includes(gone), `${gone} must not be offered to codex`);
  }
});

// t750: the entry is offered exactly where the caps table says a skills surface
// exists, so a provider added to that table cannot get the menu row without the
// popover that opens from it, or vice versa. Literal per row, not `capsFor(t)`
// re-applied: an expectation computed by the module's own rule would assert only
// that it agrees with itself, and could not express an exception.
test('t750: skills is offered exactly to the types with a skills capability', () => {
  const EXPECTED = { claude: true, codex: true };
  assert.deepStrictEqual(Object.keys(PROVIDER_CAPS).sort(), Object.keys(EXPECTED).sort(),
    'ENTER: the caps table still holds exactly the rows this table names');
  for (const [type, want] of Object.entries(EXPECTED)) {
    const caps = capsFor(type);
    assert.strictEqual(caps.injectSkills || caps.skillRoster, want,
      `ENTER: ${type}'s caps row must have a skills surface for this row to mean anything`);
    assert.strictEqual(sessionMenuEntries(type).some((e) => e.act === 'skills'), want,
      `${type} must ${want ? '' : 'not '}be offered the skills editor`);
  }
});

// The labels as LITERALS, per the table rule: computing an expectation from the
// module's own list would assert only that it agrees with itself, and the rows
// this table exists to pin are `plugins` and `intents` — the entries shared with
// codex while the CLI-roster editors stay claude-only.
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
    assert.ok(entries.some((e) => e.act === 'intents'),
      `ENTER: ${type} must offer the intents row this table is here to pin`);
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
  const codex = sessionMenuEntries('codex').map((e) => e.act);
  assert.strictEqual(codex[0], 'intents', 'the gating editor a codex seat has leads its menu');
  assert.strictEqual(codex[codex.indexOf('plugins') - 1], 'skills');
  assert.strictEqual(codex[codex.indexOf('plugins') + 1], 'edit');
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
