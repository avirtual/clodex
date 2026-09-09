'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveModelId, deriveModelTemplate } = require('../team-template-derive');

const SHIPPED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'library', 'templates', 'clodex-team-hand.json'), 'utf-8',
));

test('deriveModelTemplate on the shipped clodex-team-hand: the WHOLE object, not a key or two', () => {
  // Fed as templates.list() really returns it — decorated — because that is the
  // shape the library fallback hands the deriver.
  const base = { ...JSON.parse(JSON.stringify(SHIPPED)), id: 'clodex-team-hand', shadowedBy: ['other'] };
  const out = deriveModelTemplate(base, 'hand', 'claude-opus-5');
  assert.deepStrictEqual(out, { ...SHIPPED, name: 'hand', extraArgs: ['--model', 'claude-opus-5'] });
  assert.deepStrictEqual(base, { ...SHIPPED, id: 'clodex-team-hand', shadowedBy: ['other'] }, 'the base is never mutated');
});

test('deriveModelTemplate drops an existing --model pair and keeps the other tokens in order', () => {
  const base = { type: 'claude', extraArgs: ['--model', 'x', '--dangerously-skip-permissions'] };
  const out = deriveModelTemplate(base, 'hand', 'claude-opus-5');
  assert.deepStrictEqual(out.extraArgs, ['--model', 'claude-opus-5', '--dangerously-skip-permissions']);
  assert.deepStrictEqual(base.extraArgs, ['--model', 'x', '--dangerously-skip-permissions']);
});

test('deriveModelTemplate drops a --model=<x> token too', () => {
  const out = deriveModelTemplate({ type: 'claude', extraArgs: ['--model=x', '-v'] }, 'hand', 'claude-opus-5');
  assert.deepStrictEqual(out.extraArgs, ['--model', 'claude-opus-5', '-v']);
  assert.strictEqual(out.extraArgs.filter((t) => t === '--model').length, 1, 'exactly one --model pair survives');
});

// The library fallback base is a LISTING ROW, not the file on disk: stores.js
// adds `id`, engine.js adds `shadowedBy` for a template another team shadows, and
// plugin-prompt-refs.js adds `plugin`/`pluginName`. Persisting any of them into
// the team's own copy mis-files the row in the drawers — a `plugin` key groups
// the team's own template under the plugin, and a stale `shadowedBy` labels it
// shadowed by a team that has nothing to do with it.
test('deriveModelTemplate strips the listing decoration, not just id', () => {
  const out = deriveModelTemplate({
    type: 'claude', id: 'lib-stem', name: 'lib-stem', env: { A: '1' },
    shadowedBy: ['other-team'], plugin: 'some-plugin', pluginName: 'Some Plugin',
  }, 'worker', 'claude-haiku-4-5-20251001');
  for (const k of ['id', 'shadowedBy', 'plugin', 'pluginName']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(out, k), false, `${k} must not reach the saved template`);
  }
  assert.strictEqual(out.name, 'worker');
  assert.deepStrictEqual(out.env, { A: '1' }, 'a real template key is untouched');
});

test('resolveModelId: the four aliases', () => {
  assert.strictEqual(resolveModelId('opus'), 'claude-opus-5');
  assert.strictEqual(resolveModelId('sonnet'), 'claude-sonnet-5');
  assert.strictEqual(resolveModelId('haiku'), 'claude-haiku-4-5-20251001');
  assert.strictEqual(resolveModelId('fable'), 'claude-fable-5-1');
});

test('resolveModelId: a plain id passes through, a bracketed or pathy one does not', () => {
  assert.strictEqual(resolveModelId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.strictEqual(resolveModelId('claude-opus-5[1m]'), null);
  assert.strictEqual(resolveModelId('../x'), null);
  assert.strictEqual(resolveModelId(''), null);
  assert.strictEqual(resolveModelId(null), null);
});
