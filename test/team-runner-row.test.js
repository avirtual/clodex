'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { fakeDocument, textOf } = require('./lib/fake-dom');
const { buildRunnerField, runnerPatchFor } = require('../renderer/lib/team-runner-row');

function walk(node, out = []) {
  out.push(node);
  for (const c of node.childNodes) walk(c, out);
  return out;
}

function view(info) {
  const wrap = buildRunnerField(fakeDocument(), info);
  const all = walk(wrap);
  const field = (f) => all.find((n) => n.dataset && n.dataset.f === f);
  const button = (act) => all.find((n) => n.dataset && n.dataset.act === act);
  const hints = all.filter((n) => n.dataset && n.dataset.runner).map((n) => [n.dataset.runner, textOf(n)]);
  const options = (f) => field(f).childNodes.map((o) => o.value);
  return { wrap, field, button, hints, options };
}

const NONE = { ok: true, peer: null, hands: 'off', gate: 'off', invalid: false, setup: false, env: false, online: false, suite: false, reachable: false, reach: null, tally: null };
const SET = {
  ok: true, peer: 'runner-1', hands: 'all', gate: 'shadow', invalid: false, setup: true, env: true, online: true, suite: true, reachable: true,
  reach: 'reachable, suite capability, queue 3, env box-1 linux/arm64 node v22.11.0 key 0123456789ab',
  tally: { envKey: '0123456789ab', agree: 1, disagree: 2 },
};
const INVALID = { ...NONE, invalid: true };

test('t2266: the runner row with no setting shows none and disables hands and gate', () => {
  const v = view(NONE);
  assert.strictEqual(v.wrap.className, 'team-runner');
  assert.strictEqual(v.field('runner-peer').value, '');
  assert.strictEqual(v.field('runner-peer').disabled, false);
  assert.strictEqual(v.button('set-runner-peer').disabled, false);
  for (const f of ['runner-hands', 'runner-gate']) assert.strictEqual(v.field(f).disabled, true, `${f} is disabled with no peer`);
  for (const a of ['set-runner-hands', 'set-runner-gate']) assert.strictEqual(v.button(a).disabled, true, `${a} is disabled with no peer`);
  assert.deepStrictEqual(v.hints, [['state', 'none: hand and gate suites run on this machine']]);
});

test('t2266: the runner row with a peer shows the modes, reachability, tally and the team.json-only keys', () => {
  const v = view(SET);
  assert.strictEqual(v.field('runner-peer').value, 'runner-1');
  assert.strictEqual(v.field('runner-hands').value, 'all');
  assert.strictEqual(v.field('runner-gate').value, 'shadow');
  for (const f of ['runner-hands', 'runner-gate']) assert.strictEqual(v.field(f).disabled, false);
  for (const a of ['set-runner-hands', 'set-runner-gate']) assert.strictEqual(v.button(a).disabled, false);
  assert.deepStrictEqual(v.options('runner-hands'), ['off', 'full', 'all']);
  assert.deepStrictEqual(v.options('runner-gate'), ['off', 'shadow'], 'gate:on is not offered');
  assert.deepStrictEqual(v.hints, [
    ['state', 'reachable, suite capability, queue 3, env box-1 linux/arm64 node v22.11.0 key 0123456789ab; shadow comparisons: 1 agree, 2 disagree'],
    ['manifest-only', 'setup and env set in team.json — edit them there'],
  ]);
});

test('t2266: the runner row for an invalid dropped setting says invalid, not none', () => {
  const v = view(INVALID);
  assert.strictEqual(v.field('runner-hands').disabled, true);
  assert.deepStrictEqual(v.hints, [['invalid', 'invalid: the testRunner in team.json is invalid and ignored — fix it there, or remove it to set a peer here']]);
});

test('t2266: the runner row set buttons send one key each, an empty peer as the empty string', () => {
  assert.deepStrictEqual(runnerPatchFor('set-runner-peer', ' runner-1 '), { peer: 'runner-1' });
  assert.deepStrictEqual(runnerPatchFor('set-runner-peer', ''), { peer: '' });
  assert.deepStrictEqual(runnerPatchFor('set-runner-hands', 'full'), { hands: 'full' });
  assert.deepStrictEqual(runnerPatchFor('set-runner-gate', 'shadow'), { gate: 'shadow' });
  assert.strictEqual(runnerPatchFor('save', 'x'), null);
});
