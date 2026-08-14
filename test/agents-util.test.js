// Run: node --test
// Covers the clodex subagent library helpers: frontmatter parsing (the YAML
// subset), the markdown->plugin-scaffold transform, enabled-set assembly, and
// the built-in deny rules.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseAgentFrontmatter, agentMd, buildAgentPlugin, qualifiedAgentName,
  denyAgentRules, AGENT_PLUGIN_NAME, PLUGIN_AGENT_FIELDS, DROPPED_AGENT_FIELDS,
} = require('../agents-util');

test('parseAgentFrontmatter: splits frontmatter from body, strips quotes', () => {
  const { meta, body } = parseAgentFrontmatter(
    '---\nname: lean-explore\ndescription: "Fast read-only search"\ntools: Read, Grep, Glob\nmodel: haiku\n---\nYou are a focused explorer.\nReturn conclusions only.');
  assert.strictEqual(meta.name, 'lean-explore');
  assert.strictEqual(meta.description, 'Fast read-only search');
  assert.strictEqual(meta.tools, 'Read, Grep, Glob');
  assert.strictEqual(meta.model, 'haiku');
  assert.strictEqual(body, 'You are a focused explorer.\nReturn conclusions only.');
});

test('parseAgentFrontmatter: no fence => all body, empty meta', () => {
  const { meta, body } = parseAgentFrontmatter('just a prompt, no frontmatter');
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, 'just a prompt, no frontmatter');
});

// Whole-string equality, not a field probe: the emitted file IS the contract
// with the CLI's loader, so a stray or missing line has to fail here.
test('agentMd: emits the loader-read fields, forces the canonical name', () => {
  const md = agentMd('lean',
    { name: 'authored-something-else', description: 'd', model: 'sonnet',
      tools: 'Read, Bash', disallowedTools: 'Write', skills: 'a, b',
      maxTurns: '5', color: 'blue', bogusField: 'x' },
    'the prompt\n');
  assert.strictEqual(md,
    '---\n' +
    'name: "lean"\n' +
    'description: "d"\n' +
    'tools: "Read, Bash"\n' +
    'disallowedTools: "Write"\n' +
    'skills: "a, b"\n' +
    'model: "sonnet"\n' +
    'color: "blue"\n' +
    'maxTurns: "5"\n' +
    '---\n' +
    'the prompt\n');
});

test('agentMd: the fields the plugin loader drops are never emitted', () => {
  // Emitting them would earn a per-spawn CLI warning for a field we cannot
  // honour — and for initialPrompt, a silent drop with no warning at all.
  const md = agentMd('a', { description: 'd', permissionMode: 'dontAsk', initialPrompt: 'go', hooks: 'h', mcpServers: 'm' }, 'p');
  for (const f of DROPPED_AGENT_FIELDS) {
    assert.ok(!md.includes(f), `${f} must not reach the scaffolded file`);
  }
  assert.ok(md.includes('description: "d"'), 'ENTER: a kept field still rides');
});

test('agentMd: a value holding YAML syntax is emitted as a quoted scalar', () => {
  // Unquoted, `Use when: x` re-parses as a nested map and the description is
  // lost — silently; the agent just stops being discoverable. The consumer is
  // the CLI's real YAML parser, NOT parseAgentFrontmatter (which is a
  // deliberate subset and does not unescape), so this asserts the emitted
  // BYTES are a valid double-quoted scalar rather than round-tripping through
  // the wrong reader. Verified end-to-end against the installed 2.1.232: this
  // exact description came back verbatim from a loaded probe agent.
  const desc = 'Use when: x #2 — "quoted" and a - dash';
  const md = agentMd('a', { description: desc }, 'p');
  const line = md.split('\n').find((l) => l.startsWith('description: '));
  assert.strictEqual(JSON.parse(line.slice('description: '.length)), desc);
});

test('agentMd: no frontmatter value can break out of the block', () => {
  // A body-fence injected through a value would end the frontmatter early and
  // the rest of the fields would read as prose.
  const md = agentMd('a', { description: 'x\n---\nmodel: opus' }, 'p');
  assert.strictEqual((md.match(/^---$/gm) || []).length, 2, 'exactly one frontmatter block');
  const { meta } = parseAgentFrontmatter(md);
  assert.ok(!('model' in meta), 'the injected key did not become a real field');
});

test('buildAgentPlugin: scaffolds manifest + per-agent md, skips unknown', () => {
  const lib = [
    { name: 'lean', meta: { description: 'l', tools: 'Read' }, body: 'pl' },
    { name: 'db', meta: { description: 'd', tools: 'Bash' }, body: 'pd' },
  ];
  const out = buildAgentPlugin(['lean', 'missing'], lib);
  assert.deepStrictEqual(out.manifest, {
    name: 'clodex-agents',
    version: '0.0.0',
    description: 'clodex session-injected subagents',
    author: { name: 'clodex' },
  });
  assert.deepStrictEqual(out.agents.map((a) => a.name), ['lean']);
  assert.strictEqual(out.agents[0].md, agentMd('lean', lib[0].meta, 'pl'));
});

test('buildAgentPlugin: null when nothing enabled or nothing matches', () => {
  assert.strictEqual(buildAgentPlugin([], [{ name: 'a', meta: {}, body: '' }]), null);
  assert.strictEqual(buildAgentPlugin(['nope'], [{ name: 'a', meta: {}, body: '' }]), null);
  assert.strictEqual(buildAgentPlugin(undefined, []), null);
});

test('the agent plugin never shares a manifest name with the skills plugin', () => {
  // Two --plugin-dir entries under one manifest name both load and collide
  // silently, last one wins, no warning. The distinct name IS the guard.
  const { buildSkillPlugin } = require('../skills-util');
  const skills = buildSkillPlugin(['s'], [{ name: 's', content: 'x' }]);
  const agents = buildAgentPlugin(['a'], [{ name: 'a', meta: {}, body: 'b' }]);
  assert.notStrictEqual(agents.manifest.name, skills.manifest.name);
  assert.strictEqual(agents.manifest.name, AGENT_PLUGIN_NAME);
});

test('qualifiedAgentName: the dispatch name is the namespaced one', () => {
  // The loader registers no bare-name alias, so this is the ONLY name that
  // dispatches — a bare `test-runner` is "Agent type not found".
  assert.strictEqual(qualifiedAgentName('test-runner'), 'clodex-agents:test-runner');
});

test('the kept and dropped field lists cannot both claim a field', () => {
  // They are read together at spawn: a field in both would be emitted AND
  // warned about, so the operator is told it was dropped when it was not.
  const overlap = PLUGIN_AGENT_FIELDS.filter((f) => DROPPED_AGENT_FIELDS.includes(f));
  assert.deepStrictEqual(overlap, []);
});

test('denyAgentRules: wraps built-in names as Agent(...) deny rules', () => {
  assert.deepStrictEqual(
    denyAgentRules(['general-purpose', 'Explore']),
    ['Agent(general-purpose)', 'Agent(Explore)']);
  assert.deepStrictEqual(denyAgentRules([]), []);
  assert.deepStrictEqual(denyAgentRules(null), []);
});
