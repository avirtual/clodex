'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { resolveEffort, ADAPTERS } = require('../cli-adapters');
const { deriveEffortTemplate, deriveModelTemplate } = require('../team-template-derive');
const { formatRoster } = require('../team-manifest');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

test('t1222: resolveEffort — each CLI takes its own words, default/empty mean none, anything else is an error', () => {
  const rows = [
    ['claude', 'low', 'low'],
    ['claude', 'xhigh', 'xhigh'],
    ['claude', 'max', 'max'],
    ['claude', 'ultra', 'error'],
    ['claude', 'minimal', 'error'],
    ['codex', 'none', 'none'],
    ['codex', 'high', 'high'],
    ['codex', 'ultra', 'ultra'],
    ['codex', 'HIGH', 'error'],
    ['muse', 'minimal', 'minimal'],
    ['muse', 'xhigh', 'xhigh'],
    ['muse', 'extreme', 'error'],
    ['claude', 'default', null],
    ['codex', '', null],
    ['muse', null, null],
    ['bash', 'high', 'error'],
  ];
  for (const [type, v, want] of rows) {
    const got = resolveEffort(type, v);
    if (want === 'error') {
      assert.ok(got && typeof got === 'object' && typeof got.error === 'string', `${type} ${v} → error, got ${JSON.stringify(got)}`);
    } else {
      assert.strictEqual(got, want, `${type} ${v}`);
    }
  }
  assert.match(resolveEffort('claude', 'ultra').error, /effort "ultra" is not one of low, medium, high, xhigh, max \(Claude Code\), or default/);
});

test('t1222: the adapter rows name how each CLI takes the level', () => {
  assert.deepStrictEqual(ADAPTERS.claude.effort, { values: ['low', 'medium', 'high', 'xhigh', 'max'], apply: 'settings' });
  assert.deepStrictEqual(ADAPTERS.codex.effort, { values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], apply: 'config' });
  assert.strictEqual(ADAPTERS.muse.effort.apply, 'flag');
});

test('t1222: deriveEffortTemplate sets the field, clears it on default, and never touches extraArgs', () => {
  const base = { type: 'claude', name: 'x', id: 'x', shadowedBy: ['o'], extraArgs: ['--model', 'm', '--foo'], effort: 'low' };
  const set = deriveEffortTemplate(base, 'reviewer', 'xhigh');
  assert.deepStrictEqual(set, { type: 'claude', name: 'reviewer', extraArgs: ['--model', 'm', '--foo'], effort: 'xhigh' });
  assert.strictEqual(set.extraArgs, base.extraArgs, 'the very same array, not a rebuilt one');
  const cleared = deriveEffortTemplate(base, 'reviewer', 'default');
  assert.deepStrictEqual(cleared, { type: 'claude', name: 'reviewer', extraArgs: ['--model', 'm', '--foo'] });
  assert.ok(!('effort' in cleared));
  assert.deepStrictEqual(deriveEffortTemplate(base, 'reviewer', null), cleared);
  assert.strictEqual(base.effort, 'low', 'the base is never mutated');
  assert.strictEqual(deriveModelTemplate(set, 'reviewer', 'claude-opus-5').effort, 'xhigh', 'a later model derive carries the effort along');
});

test('t1222: the roster names a role\'s effort beside its template, and the reviewer\'s too', () => {
  const team = {
    name: 'shop', lead: 'boss',
    roles: { lead: {}, hand: { template: 'hand', brief: 'b' }, reviewer: {} },
  };
  const out = formatRoster(team, [], { efforts: { hand: 'high', reviewer: 'xhigh' } }).split('\n');
  assert.ok(out.includes('- hand (session, tmpl hand) · effort high — b · no live seat — role definition only, not addressable'), out.join('\n'));
  assert.ok(out.some((l) => l.startsWith('- reviewer (lead-only) · effort xhigh ·')), out.join('\n'));
  assert.ok(!formatRoster(team, []).includes('effort'), 'no efforts, no clause');
});

function hooks() {
  const root = mkTmpRoot('clodex-hooks-');
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  return { h, root };
}

test('t1222: the generated Claude settings carry effortLevel when set and lack the key when not', (t) => {
  const { h, root } = hooks();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  h.setupClaudeHook('e1', null, null, [], [], [], null, null, [], false, 'xhigh');
  const withEffort = JSON.parse(fs.readFileSync(pathFor(root, 'e1', 'settings'), 'utf-8'));
  assert.strictEqual(withEffort.effortLevel, 'xhigh');
  h.setupClaudeHook('e2', null, null, [], [], [], null, null, [], true, 'low');
  assert.strictEqual(JSON.parse(fs.readFileSync(pathFor(root, 'e2', 'settings'), 'utf-8')).effortLevel, 'low', 'the stream seat gets the same file');
  h.setupClaudeHook('e3');
  const without = JSON.parse(fs.readFileSync(pathFor(root, 'e3', 'settings'), 'utf-8'));
  assert.ok(!('effortLevel' in without));
});
