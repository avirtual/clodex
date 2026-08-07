// Run: node --test
// Covers the static catalogs: the tool universe + deny floor invariant, the
// skill seed + re-enable gate, and the shared identifiers (workspace id, name
// regex, theme keys).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CLAUDE_TOOLS, DEFAULT_TOOL_DENY_FLOOR, CLAUDE_SKILLS, SKILL_REENABLE_CONFIRMED,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
} = require('../catalogs');

test('CLAUDE_TOOLS: non-empty, unique, includes the staples', () => {
  assert.ok(Array.isArray(CLAUDE_TOOLS) && CLAUDE_TOOLS.length > 0);
  assert.strictEqual(new Set(CLAUDE_TOOLS).size, CLAUDE_TOOLS.length, 'no dupes');
  for (const t of ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'Agent', 'Skill']) {
    assert.ok(CLAUDE_TOOLS.includes(t), `missing ${t}`);
  }
});

// A tool absent from the catalog cannot be denied AT ALL: cli-hooks filters
// disabledTools against it, so unchecking one in the UI is silently dropped.
// That makes a missed addition a functional gap rather than a cosmetic one, and
// it is invisible — the checklist just never offers the tool. Pinning the ones
// observed on the live wire is the only cheap guard; ListAgents shipped in an
// Anthropic drop and went unnoticed until it showed up in a system prompt.
test('CLAUDE_TOOLS: covers the tools observed on the live wire', () => {
  for (const t of ['SendMessage', 'ListAgents', 'Agent', 'Skill', 'WebSearch']) {
    assert.ok(CLAUDE_TOOLS.includes(t), `missing ${t}`);
  }
});

test('DEFAULT_TOOL_DENY_FLOOR: every entry is a known tool', () => {
  assert.ok(Array.isArray(DEFAULT_TOOL_DENY_FLOOR));
  for (const t of DEFAULT_TOOL_DENY_FLOOR) {
    assert.ok(CLAUDE_TOOLS.includes(t), `${t} not in CLAUDE_TOOLS`);
  }
});

test('CLAUDE_SKILLS + re-enable gate', () => {
  assert.ok(Array.isArray(CLAUDE_SKILLS) && CLAUDE_SKILLS.includes('code-review'));
  assert.strictEqual(SKILL_REENABLE_CONFIRMED, false);
});

test('shared identifiers: workspace id, name regex, theme keys', () => {
  assert.strictEqual(DEFAULT_WORKSPACE_ID, 'default');
  assert.ok(AGENT_NAME_RE.test('my-agent_1.2'));
  assert.ok(!AGENT_NAME_RE.test('bad name'));
  assert.ok(!AGENT_NAME_RE.test(''));
  assert.deepStrictEqual(THEME_KEYS, ['midnight', 'claude', 'paper', 'light']);
});
