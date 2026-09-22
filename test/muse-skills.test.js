'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseSkillsList, resolveOffSkills, activationBlock, activationSettings, createSkillLister, skillDirName, skillAliases,
} = require('../muse-skills');
const { ADAPTERS } = require('../cli-adapters');

const BUNDLED_GIT = { id: 'bundled:git', scope: 'bundled', path: 'bundled://muse-core/skills/git/SKILL.md', activation: 'on' };
const BUNDLED_WA = { id: 'bundled:workflow-authoring', scope: 'bundled', path: 'bundled://muse-core/skills/workflow-authoring/SKILL.md', activation: 'on' };
const PLUGIN_THREE = { id: 'plugin:threejs:threejs', scope: 'plugin', path: 'plugin://threejs/skills/threejs/SKILL.md', activation: 'on' };
const USER_FOO = { id: 'foo', scope: 'user', path: '$CONFIG_DIR/skills/foo/SKILL.md', activation: 'on' };
const PROJECT_BAR = { id: 'bar', scope: 'project', path: '.agents/skills/bar/SKILL.md', activation: 'on' };
const ROSTER = [BUNDLED_GIT, BUNDLED_WA, PLUGIN_THREE, USER_FOO, PROJECT_BAR];

test('parseSkillsList keeps id/scope/path/activation and nothing else, from text or an object', () => {
  const doc = {
    skills: [
      { ...BUNDLED_GIT, name: 'git', description: 'x', context_cost: { startup_bytes: 1 } },
      { id: 'no-path', scope: 'bundled' },
      'junk',
      null,
    ],
    diagnostics: [],
  };
  assert.deepStrictEqual(parseSkillsList(JSON.stringify(doc)), [BUNDLED_GIT]);
  assert.deepStrictEqual(parseSkillsList(doc), [BUNDLED_GIT]);
});

test('parseSkillsList is tolerant: bad JSON, non-objects and a missing skills array read as []', () => {
  for (const input of ['not json', '', null, undefined, 42, {}, { skills: 'x' }, { skills: null }, []]) {
    assert.deepStrictEqual(parseSkillsList(input), [], `${JSON.stringify(input)} must read as []`);
  }
});

test('skillDirName is the directory holding SKILL.md, for every URI shape', () => {
  const rows = [
    ['bundled://muse-core/skills/workflow-authoring/SKILL.md', 'workflow-authoring'],
    ['plugin://threejs/skills/threejs/SKILL.md', 'threejs'],
    ['$CONFIG_DIR/skills/foo/SKILL.md', 'foo'],
    ['.agents/skills/bar/SKILL.md', 'bar'],
    ['SKILL.md', ''],
    ['', ''],
  ];
  for (const [uri, want] of rows) assert.strictEqual(skillDirName(uri), want, uri);
});

test('activationBlock: one row per scope, keyed by the path URI, project never emitted', () => {
  const rows = [
    ['bundled by id', ['bundled:git'], { bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'off' } }],
    ['bundled by directory name', ['workflow-authoring'], { bundled: { 'bundled://muse-core/skills/workflow-authoring/SKILL.md': 'off' } }],
    ['plugin by id', ['plugin:threejs:threejs'], { plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' } }],
    ['plugin by directory name', ['threejs'], { plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' } }],
    ['user by bare name keeps $CONFIG_DIR literal', ['foo'], { user: { '$CONFIG_DIR/skills/foo/SKILL.md': 'off' } }],
    ['project is dropped', ['bar'], null],
    ['an unknown name is ignored, no throw', ['nope'], null],
    ['nothing asked', [], null],
    ['two scopes at once', ['git', 'threejs'], {
      bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'off' },
      plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' },
    }],
  ];
  for (const [label, offNames, want] of rows) {
    assert.deepStrictEqual(activationBlock(ROSTER, offNames), want, label);
  }
});

test('activationBlock writes the value the caller names', () => {
  assert.deepStrictEqual(activationBlock(ROSTER, ['git'], { off: 'user-invocable-only' }),
    { bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'user-invocable-only' } });
});

test('resolveOffSkills: explicit names, the * sweep, its !keep exemptions and injected skills', () => {
  const ids = (list) => list.map((s) => s.id);
  const rows = [
    ['explicit id', ['bundled:git'], [], ['bundled:git']],
    ['explicit directory name', ['workflow-authoring'], [], ['bundled:workflow-authoring']],
    ['unknown name ignored', ['nope'], [], []],
    ['sweep is every listed skill', ['*'], [], ['bundled:git', 'bundled:workflow-authoring', 'plugin:threejs:threejs', 'foo', 'bar']],
    ['sweep minus injected (bare name)', ['*'], ['foo'], ['bundled:git', 'bundled:workflow-authoring', 'plugin:threejs:threejs', 'bar']],
    ['sweep minus injected (directory name of a bundled skill)', ['*'], ['git'], ['bundled:workflow-authoring', 'plugin:threejs:threejs', 'foo', 'bar']],
    ['sweep minus !keep', ['*', '!threejs'], [], ['bundled:git', 'bundled:workflow-authoring', 'foo', 'bar']],
    ['sweep plus an explicit name is still the sweep', ['*', 'git'], [], ['bundled:git', 'bundled:workflow-authoring', 'plugin:threejs:threejs', 'foo', 'bar']],
    ['!keep without the sweep is a directive, not a name', ['!git'], [], []],
    ['not an array', 'git', [], []],
  ];
  for (const [label, disabled, inject, want] of rows) {
    assert.deepStrictEqual(ids(resolveOffSkills(ROSTER, disabled, { injectSkills: inject })), want, label);
  }
});

test('activationSettings nests the block under the adapter key and answers null when nothing is off', () => {
  const rows = [
    ['names', ['git', 'foo'], [], {
      skills: { activation: {
        bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'off' },
        user: { '$CONFIG_DIR/skills/foo/SKILL.md': 'off' },
      } },
    }],
    ['sweep minus injected foo, project dropped', ['*'], ['foo'], {
      skills: { activation: {
        bundled: {
          'bundled://muse-core/skills/git/SKILL.md': 'off',
          'bundled://muse-core/skills/workflow-authoring/SKILL.md': 'off',
        },
        plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' },
      } },
    }],
    ['empty list', [], [], null],
    ['only an unknown name', ['nope'], [], null],
    ['only a project skill', ['bar'], [], null],
  ];
  for (const [label, disabled, inject, want] of rows) {
    assert.deepStrictEqual(activationSettings(ADAPTERS.muse.skills, ROSTER, disabled, { injectSkills: inject }), want, label);
  }
  assert.strictEqual(activationSettings(null, ROSTER, ['git']), null, 'an adapter with no skills field writes nothing');
  assert.strictEqual(activationSettings(ADAPTERS.claude.skills, ROSTER, ['git']), null);
});

function mkLister({ answer = JSON.stringify({ skills: [BUNDLED_GIT, PLUGIN_THREE], diagnostics: [] }), fail = false, failures = [] } = {}) {
  const calls = [];
  const warns = [];
  const lister = createSkillLister({
    execFileSync: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (fail) throw new Error('muse exited 1');
      const failure = failures.shift();
      if (failure) throw failure;
      return answer;
    },
    scratchDir: '/scratch/data',
    env: { HOME: '/h', XDG_CONFIG_HOME: '/h/.config', XDG_DATA_HOME: '/h/.local/share' },
    log: { warn: (_s, m) => warns.push(m) },
  });
  return { lister, calls, warns };
}

test('the lister spawns the adapter command with the source config dir and a scratch data home, once per (platform, configDir)', () => {
  const { lister, calls, warns } = mkLister();
  const first = lister.list(ADAPTERS.muse, { configDir: '/acct' });
  assert.deepStrictEqual(first, [BUNDLED_GIT, PLUGIN_THREE]);
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), first, 'second read is the cache');
  lister.list(ADAPTERS.muse, { configDir: '/other' });
  assert.strictEqual(calls.length, 2, 'one spawn per configDir');
  assert.strictEqual(calls[0].cmd, 'muse');
  assert.deepStrictEqual(calls[0].args, ['skills', 'list', '--json']);
  assert.deepStrictEqual(calls[0].opts.env, {
    HOME: '/h', XDG_CONFIG_HOME: '/acct', XDG_DATA_HOME: '/scratch/data', MUSE_NO_AUTO_UPDATE: '1',
  });
  assert.strictEqual(calls[0].opts.timeout, 30000);
  assert.strictEqual(calls[0].opts.encoding, 'utf8');
  assert.deepStrictEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.strictEqual(calls[1].opts.env.XDG_CONFIG_HOME, '/other');
  assert.deepStrictEqual(warns, []);
});

test('a failing list is an empty roster and a warn line per call, never cached; no spawn for an adapter without list or without a configDir', () => {
  const { lister, calls, warns } = mkLister({ fail: true });
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), []);
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), []);
  assert.strictEqual(calls.length, 2, 'a failure is re-run, not cached');
  assert.deepStrictEqual(warns, [
    'muse skills list --json failed for /acct: muse exited 1',
    'muse skills list --json failed for /acct: muse exited 1',
  ]);
  assert.deepStrictEqual(lister.list(ADAPTERS.claude, { configDir: '/acct' }), []);
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, {}), []);
  assert.deepStrictEqual(lister.list(null, { configDir: '/acct' }), []);
  assert.strictEqual(calls.length, 2, 'neither reached the spawn');
});

test('t1094: a failed list is retried — the next call after a miss yields the roster and caches it', () => {
  const { lister, calls, warns } = mkLister({ failures: [new Error('spawn muse ENOENT')] });
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), []);
  assert.strictEqual(warns.length, 1, 'the miss warned');
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), [BUNDLED_GIT, PLUGIN_THREE]);
  assert.deepStrictEqual(lister.list(ADAPTERS.muse, { configDir: '/acct' }), [BUNDLED_GIT, PLUGIN_THREE]);
  assert.strictEqual(calls.length, 2, 'the success is cached');
  assert.strictEqual(warns.length, 1);
});

test('t1094: the warn carries the command\'s stderr, trimmed and capped at 200 chars', () => {
  const noisy = Object.assign(new Error('Command failed: muse skills list --json'), { stderr: '  boom: no config\n' });
  const long = Object.assign(new Error('Command failed: muse skills list --json'), { stderr: 'x'.repeat(500) });
  const quiet = Object.assign(new Error('Command failed: muse skills list --json'), { stderr: '' });
  const shaped = Object.assign(new Error('Command failed: muse skills list --json\nboom: no config'), { stderr: 'boom: no config\n' });
  const enoent = Object.assign(new Error('spawn muse ENOENT'), { stderr: '' });
  const { lister, warns } = mkLister({ failures: [noisy, long, quiet, shaped, enoent] });
  for (let i = 0; i < 5; i++) lister.list(ADAPTERS.muse, { configDir: '/acct' });
  assert.deepStrictEqual(warns, [
    'muse skills list --json failed for /acct: Command failed: muse skills list --json: boom: no config',
    `muse skills list --json failed for /acct: Command failed: muse skills list --json: ${'x'.repeat(200)}`,
    'muse skills list --json failed for /acct: Command failed: muse skills list --json',
    'muse skills list --json failed for /acct: Command failed: muse skills list --json: boom: no config',
    'muse skills list --json failed for /acct: spawn muse ENOENT',
  ]);
  assert.strictEqual(warns[3].split('boom: no config').length, 2, 'a Node-shaped error carries its stderr once');
  assert.ok(!warns[3].includes('\n'), 'one line');
});

test('t1094: skillAliases maps each SKILL.md directory name to its roster id, and the resolved off set is what the checklist compares against', () => {
  const { applySkillAliases, skillOffSetFor } = require('../skills-off');
  const aliases = skillAliases(ROSTER);
  assert.strictEqual(aliases.git, 'bundled:git');
  assert.strictEqual(aliases.threejs, 'plugin:threejs:threejs');
  assert.ok(!('bundled:git' in aliases), 'ids are not aliases of themselves');
  assert.deepStrictEqual(skillAliases([]), {});
  const names = ROSTER.map((s) => s.id).sort();
  assert.deepStrictEqual(applySkillAliases(['git', '*', '!threejs', 'nope'], aliases), ['bundled:git', '*', '!plugin:threejs:threejs', 'nope']);
  assert.deepStrictEqual(applySkillAliases(new Set(['git']), undefined), ['git']);
  assert.ok(skillOffSetFor(names, applySkillAliases(['git'], aliases)).has('bundled:git'));
  assert.ok(!skillOffSetFor(names, applySkillAliases(['*', '!git'], aliases)).has('bundled:git'));
  assert.ok(skillOffSetFor(names, applySkillAliases(['*', '!git'], aliases)).has('plugin:threejs:threejs'));
});
