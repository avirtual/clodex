// Run: node --test
// Covers the static catalogs: the tool universe + deny floor invariant, the
// skill seed + re-enable gate, and the shared identifiers (workspace id, name
// regex, theme keys).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CLAUDE_TOOLS, OPTIMIZED_TOOLS, DEFAULT_TOOL_DENY_FLOOR,
  CLAUDE_SKILLS, OPTIMIZED_SKILLS, DEFAULT_SKILL_DENY_FLOOR, SKILL_REENABLE_CONFIRMED,
  DEFAULT_BUILTIN_DENY_FLOOR,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
} = require('../catalogs');
const { BUILTIN_AGENTS } = require('../agents-util');
const { expandSkillsOff, skillDenyKeepList } = require('../skills-off');

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
// observed on the live wire is the only cheap guard, and it has now missed
// twice: ListAgents, then SendFeedback, each noticed only when it appeared in a
// live system prompt. A pin can only assert the names someone already saw, so
// this list trails the wire by one drop and adding to it is a standing chore.
test('CLAUDE_TOOLS: covers the tools observed on the live wire', () => {
  for (const t of ['SendMessage', 'ListAgents', 'SendFeedback', 'Agent', 'Skill', 'WebSearch']) {
    assert.ok(CLAUDE_TOOLS.includes(t), `missing ${t}`);
  }
});

// t913: the floor is now DERIVED (`CLAUDE_TOOLS.filter(not in OPTIMIZED_TOOLS)`),
// which makes "every entry is a known tool" true by construction and so vacuous
// on its own. What can still break is the allow list: a typo there is not an
// error, it just fails to match and silently widens the floor by one — the
// direction nobody notices, because the tool simply stays denied.
test('DEFAULT_TOOL_DENY_FLOOR: derived from the allow list, which holds only real tools', () => {
  assert.ok(Array.isArray(DEFAULT_TOOL_DENY_FLOOR));
  for (const t of DEFAULT_TOOL_DENY_FLOOR) {
    assert.ok(CLAUDE_TOOLS.includes(t), `${t} not in CLAUDE_TOOLS`);
  }
  for (const t of OPTIMIZED_TOOLS) {
    assert.ok(CLAUDE_TOOLS.includes(t), `OPTIMIZED_TOOLS: ${t} not in CLAUDE_TOOLS — a typo widens the floor`);
  }
  assert.deepStrictEqual(DEFAULT_TOOL_DENY_FLOOR.filter((t) => OPTIMIZED_TOOLS.includes(t)), [],
    'the floor must not deny a curated tool');
  assert.strictEqual(DEFAULT_TOOL_DENY_FLOOR.length + OPTIMIZED_TOOLS.length, CLAUDE_TOOLS.length,
    'floor + allow list partition the catalog exactly');
  // The one thing the derivation cannot catch: an allow list that quietly grew
  // to most of the catalog is no longer a curated subset, which is the defect
  // t913 fixed (33 of 44 tools left checked in "optimized").
  assert.ok(OPTIMIZED_TOOLS.length * 2 < CLAUDE_TOOLS.length,
    'optimized must keep a minority of the catalog, or it is not a curated subset');
});

// Same shape for skills. Before t913 this floor did not exist and
// getDefaultSkillDeny() returned [] when the `*` key was absent, which made the
// Mode selector a literal no-op for the whole skills category on a fresh root.
// t918 made it deferred, so the partition is asserted over the EXPANSION.
test('DEFAULT_SKILL_DENY_FLOOR: deferred, derived, and partitions CLAUDE_SKILLS when expanded', () => {
  assert.ok(Array.isArray(DEFAULT_SKILL_DENY_FLOOR));
  assert.ok(DEFAULT_SKILL_DENY_FLOOR.includes('*'),
    'a floor without the sentinel is a snapshot: a skill the CLI announces after the dialog closed arrives ON');
  for (const s of OPTIMIZED_SKILLS) {
    assert.ok(CLAUDE_SKILLS.includes(s), `OPTIMIZED_SKILLS: ${s} not in CLAUDE_SKILLS`);
  }
  assert.deepStrictEqual(skillDenyKeepList(DEFAULT_SKILL_DENY_FLOOR), [...OPTIMIZED_SKILLS],
    'the exemptions ARE the keep list — a floor that exempts something else denies a curated skill');
  const expanded = expandSkillsOff(DEFAULT_SKILL_DENY_FLOOR, { known: [...CLAUDE_SKILLS] });
  assert.deepStrictEqual(expanded, CLAUDE_SKILLS.filter((s) => !OPTIMIZED_SKILLS.includes(s)).sort(),
    'floor + allow list partition the skill catalog exactly, once the sentinel is resolved');
  assert.ok(expandSkillsOff(DEFAULT_SKILL_DENY_FLOOR, { known: ['a-skill-shipped-next-month'] })
    .includes('a-skill-shipped-next-month'),
    'a skill in NO list when the dialog closed must still land in the off list at spawn — the half a '
    + 'materialised floor cannot do, and the whole defect t918 exists to fix');
  // The tool half carries this bound and the skill half did not, which is the
  // asymmetry that let the tool floor rot in the first place: an allow list
  // grown to 13-of-14 keeps every other pin here green.
  assert.ok(OPTIMIZED_SKILLS.length * 2 < CLAUDE_SKILLS.length,
    'optimized must keep a minority of the skill catalog, or it is not a curated subset');
});

// A name outside BUILTIN_AGENTS can never be denied: the checklist offers only
// that list, and getDefaultBuiltinDeny filters against it — so a typo in the
// floor is a silently weaker default, not an error.
test('DEFAULT_BUILTIN_DENY_FLOOR: a subset of BUILTIN_AGENTS, sparing exactly Explore and general-purpose', () => {
  assert.ok(Array.isArray(DEFAULT_BUILTIN_DENY_FLOOR));
  for (const a of DEFAULT_BUILTIN_DENY_FLOOR) {
    assert.ok(BUILTIN_AGENTS.includes(a), `${a} not in BUILTIN_AGENTS`);
  }
  const spared = BUILTIN_AGENTS.filter((a) => !DEFAULT_BUILTIN_DENY_FLOOR.includes(a));
  assert.deepStrictEqual(spared.sort(), ['Explore', 'general-purpose'],
    'the floor denies every built-in but these two');
});

test('CLAUDE_SKILLS + re-enable gate', () => {
  assert.ok(Array.isArray(CLAUDE_SKILLS) && CLAUDE_SKILLS.includes('code-review'));
  for (const s of ['design', 'dataviz', 'artifact-design', 'artifact-diagramming', 'artifact-capabilities']) {
    assert.ok(CLAUDE_SKILLS.includes(s),
      `the shipping CLI offers '${s}' and the seed does not name it — on a fresh root the seed is the ONLY `
      + 'thing `*` can expand against, so a name missing here is a skill optimized mode cannot deny');
  }
  assert.strictEqual(SKILL_REENABLE_CONFIRMED, false);
});

test('shared identifiers: workspace id, name regex, theme keys', () => {
  assert.strictEqual(DEFAULT_WORKSPACE_ID, 'default');
  assert.ok(AGENT_NAME_RE.test('my-agent_1.2'));
  assert.ok(!AGENT_NAME_RE.test('bad name'));
  assert.ok(!AGENT_NAME_RE.test(''));
  assert.deepStrictEqual(THEME_KEYS, ['midnight', 'claude', 'paper', 'light']);
});
