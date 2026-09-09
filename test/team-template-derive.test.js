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
  const base = JSON.parse(JSON.stringify(SHIPPED));
  const out = deriveModelTemplate(base, 'hand', 'claude-opus-5');
  assert.deepStrictEqual(out, { ...SHIPPED, name: 'hand', extraArgs: ['--model', 'claude-opus-5'] });
  assert.deepStrictEqual(base, SHIPPED, 'the base is never mutated');
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

test('deriveModelTemplate drops id and renames to the role', () => {
  const out = deriveModelTemplate({ type: 'claude', id: 'lib-stem', name: 'lib-stem', env: { A: '1' } }, 'worker', 'claude-haiku-4-5-20251001');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(out, 'id'), false);
  assert.strictEqual(out.name, 'worker');
  assert.deepStrictEqual(out.env, { A: '1' });
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
