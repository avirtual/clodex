// Run: node --test
// Covers the clodex skill-injection library helpers: frontmatter parsing,
// SKILL.md normalization (canonical name), and the plugin-scaffold builder.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSkillFrontmatter, skillMd, buildSkillPlugin, unresolvedSubagentRefs } = require('../skills-util');

test('parseSkillFrontmatter: splits frontmatter from body, strips quotes', () => {
  const { meta, body } = parseSkillFrontmatter(
    '---\nname: deploy\ndescription: "Ship the app"\n---\nRun the deploy script.');
  assert.strictEqual(meta.name, 'deploy');
  assert.strictEqual(meta.description, 'Ship the app');
  assert.strictEqual(body, 'Run the deploy script.');
});

test('parseSkillFrontmatter: no fence => all body, empty meta', () => {
  const { meta, body } = parseSkillFrontmatter('just instructions');
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, 'just instructions');
});

test('skillMd: forces canonical name, preserves description + body', () => {
  const out = skillMd('deploy', '---\nname: wrong-name\ndescription: Ship it\n---\nBody here.');
  assert.match(out, /^---\nname: deploy\n/);
  assert.match(out, /description: Ship it/);
  assert.doesNotMatch(out, /wrong-name/);
  assert.match(out, /Body here\./);
});

test('skillMd: no frontmatter => wraps with name + stub description', () => {
  const out = skillMd('deploy', 'Just the instructions.');
  assert.match(out, /^---\nname: deploy\ndescription: deploy\n---\n/);
  assert.match(out, /Just the instructions\./);
});

test('buildSkillPlugin: scaffolds manifest + per-skill SKILL.md, skips unknown', () => {
  const lib = [
    { name: 'deploy', content: '---\ndescription: Ship it\n---\nDeploy steps.' },
    { name: 'audit', content: '---\ndescription: Audit\n---\nAudit steps.' },
  ];
  const out = buildSkillPlugin(['deploy', 'ghost'], lib);
  assert.strictEqual(out.manifest.name, 'clodex-skills');
  assert.strictEqual(out.skills.length, 1);
  assert.strictEqual(out.skills[0].name, 'deploy');
  assert.match(out.skills[0].skillMd, /name: deploy/);
});

test('buildSkillPlugin: empty / all-unknown => null', () => {
  assert.strictEqual(buildSkillPlugin([], []), null);
  assert.strictEqual(buildSkillPlugin(['x'], [{ name: 'y', content: '' }]), null);
});

test('unresolvedSubagentRefs: flags a subagent_type not in the enabled set', () => {
  const records = [{ name: 'grok', content: 'Spawn Task with subagent_type: "grok-synth" to synthesize.' }];
  const out = unresolvedSubagentRefs(records, new Set(['Explore', 'general-purpose']));
  assert.deepStrictEqual(out, [{ skill: 'grok', ref: 'grok-synth' }]);
});

test('unresolvedSubagentRefs: silent when every ref is enabled (accepts array)', () => {
  const records = [{ name: 'grok', content: 'subagent_type: "Explore" or subagent_type=general-purpose' }];
  assert.deepStrictEqual(unresolvedSubagentRefs(records, ['Explore', 'general-purpose']), []);
});

test('unresolvedSubagentRefs: extracts multiple refs on one line, only the unenabled flagged', () => {
  // Mirrors grok.md:54 — two refs on a line; deny Explore and only it warns.
  const records = [{ name: 'grok', content: '`subagent_type: "Explore"` or `"general-purpose"` — actually subagent_type: general-purpose' }];
  const out = unresolvedSubagentRefs(records, new Set(['general-purpose']));
  assert.deepStrictEqual(out, [{ skill: 'grok', ref: 'Explore' }]);
});

test('unresolvedSubagentRefs: dedupes repeated skill+ref pairs', () => {
  const records = [{ name: 'grok', content: 'subagent_type: worker ... later subagent_type=worker again' }];
  assert.deepStrictEqual(unresolvedSubagentRefs(records, new Set()), [{ skill: 'grok', ref: 'worker' }]);
});

test('unresolvedSubagentRefs: no records / no refs / bad input => []', () => {
  assert.deepStrictEqual(unresolvedSubagentRefs([], new Set(['x'])), []);
  assert.deepStrictEqual(unresolvedSubagentRefs([{ name: 'plain', content: 'no task refs here' }], new Set()), []);
  assert.deepStrictEqual(unresolvedSubagentRefs(null, null), []);
  assert.deepStrictEqual(unresolvedSubagentRefs([{ content: 'subagent_type: x' }], new Set()), [], 'record without a name is skipped');
});
