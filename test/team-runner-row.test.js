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

const fs = require('node:fs');
const path = require('node:path');
const { paintRunnerState } = require('../renderer/lib/team-runner-row');

const POPOVER = fs.readFileSync(path.join(__dirname, '..', 'renderer/popovers/team-roles-popover.js'), 'utf8');

function slice(start, end) {
  const a = POPOVER.indexOf(start);
  assert.ok(a >= 0, `ENTER: found ${JSON.stringify(start)}`);
  const b = POPOVER.indexOf(end, a + start.length);
  assert.ok(b >= 0, `ENTER: found ${JSON.stringify(end)} after it`);
  return POPOVER.slice(a, b + end.length);
}

const STORED = { ok: true, peer: 'runner-1', hands: 'all', gate: 'shadow', invalid: false, setup: true, env: false, tally: { envKey: '0123456789ab', agree: 1, disagree: 2 } };
const PROBED = { ok: true, online: true, suite: true, reachable: true, reach: SET.reach, tally: { envKey: '0123456789ab', agree: 1, disagree: 2 } };
const tick = () => new Promise(setImmediate);

function compileRefresh() {
  const runnerSrc = slice('  let runnerInfo = null;\n', "    paintRunnerState(listEl.querySelector('.team-runner'), runnerInfo);\n  }\n");
  const refreshSrc = slice('  async function refresh(teamName, isCurrent = () => popover.dataset.name === teamName) {', '\n  }\n');
  const doc = fakeDocument();
  const noop = () => {};
  const rendered = [];
  const reaches = [];
  const list = { runner: null, querySelector: (sel) => (sel === '.team-runner' ? list.runner : null) };
  const popover = { dataset: { name: 'team' } };
  let info = () => null;
  const env = {
    window: { api: {
      teamGet: async (n) => ({ ok: true, team: { name: n, root: '/r', roles: { lead: {} } } }),
      teamRunner: async () => ({ ...STORED }),
      teamRunnerReach: () => new Promise((resolve) => reaches.push(resolve)),
    } },
    popover, listEl: list, teamName: () => popover.dataset.name || null, paintRunnerState,
    setStatus: noop, nameEl: { textContent: '' }, watchdogInput: {}, formatDuration: String,
    renderRows: (team) => { rendered.push(team.name); list.runner = buildRunnerField(doc, info()); },
    loadPreflight: async () => noop, loadStockRoles: async () => noop, loadActivity: async () => noop,
    loadUses: async () => noop, loadLeadSeats: async () => noop, loadTrunk: async () => noop,
  };
  const names = Object.keys(env);
  const out = new Function(...names, `let currentRoot = '';\n${runnerSrc}\n${refreshSrc}\nreturn { refresh, info: () => runnerInfo };`)(...names.map((n) => env[n]));
  info = out.info;
  const stateLine = () => textOf(list.runner.childNodes.find((n) => n.dataset.runner === 'state'));
  const fieldOf = (f) => walk(list.runner).find((n) => n.dataset && n.dataset.f === f);
  return { refresh: out.refresh, rendered, reaches, popover, stateLine, fieldOf };
}

test('t2266: the popover renders at once with the stored runner setting while the reach probe is still out', async () => {
  const r = compileRefresh();
  assert.strictEqual(await r.refresh('team'), true, 'refresh finishes with the probe unresolved');
  assert.deepStrictEqual(r.rendered, ['team'], 'the other rows are rendered');
  assert.strictEqual(r.reaches.length, 1, 'ENTER: one probe is out');
  assert.strictEqual(r.fieldOf('runner-peer').value, 'runner-1');
  assert.strictEqual(r.fieldOf('runner-hands').value, 'all');
  assert.strictEqual(r.fieldOf('runner-gate').value, 'shadow');
  assert.strictEqual(r.stateLine(), 'checking reachability…; shadow comparisons: 1 agree, 2 disagree');
  r.reaches[0](PROBED);
  await tick();
  assert.strictEqual(r.stateLine(), `${SET.reach}; shadow comparisons: 1 agree, 2 disagree`);
});

test('t2266: a reach probe that lands after a newer refresh, or after the popover closed, changes nothing', async () => {
  const r = compileRefresh();
  await r.refresh('team');
  await r.refresh('team');
  assert.strictEqual(r.reaches.length, 2, 'ENTER: two probes are out');
  r.reaches[0]({ ...PROBED, reach: 'stale answer' });
  await tick();
  assert.strictEqual(r.stateLine(), 'checking reachability…; shadow comparisons: 1 agree, 2 disagree');
  r.reaches[1]({ ...PROBED, reach: 'offline', reachable: false });
  await tick();
  assert.strictEqual(r.stateLine(), 'offline; shadow comparisons: 1 agree, 2 disagree', 'the current probe does paint the row');

  const closed = compileRefresh();
  await closed.refresh('team');
  closed.popover.dataset.name = '';
  closed.reaches[0](PROBED);
  await tick();
  assert.strictEqual(closed.stateLine(), 'checking reachability…; shadow comparisons: 1 agree, 2 disagree');
});

test('t2266: a runner set retires the reach probe in flight before it writes', () => {
  const at = POPOVER.indexOf("    if (act === 'set-runner-peer' || act === 'set-runner-hands' || act === 'set-runner-gate') {");
  assert.ok(at >= 0, 'ENTER: found the runner set branch');
  const branch = POPOVER.slice(at, POPOVER.indexOf('      return;\n    }\n', at));
  const bump = branch.indexOf('runnerProbeSeq += 1;');
  assert.ok(bump >= 0 && bump < branch.indexOf('window.api.teamSetRunner('), 'the probe sequence moves before the set call');
});

test('t2266: paintRunnerState rewrites only the state line', () => {
  const v = view({ ...SET, reach: undefined });
  assert.deepStrictEqual(v.hints[0], ['state', 'checking reachability…; shadow comparisons: 1 agree, 2 disagree']);
  paintRunnerState(v.wrap, SET);
  assert.strictEqual(textOf(v.wrap.childNodes.find((n) => n.dataset.runner === 'state')), `${SET.reach}; shadow comparisons: 1 agree, 2 disagree`);
  assert.strictEqual(v.field('runner-peer').value, 'runner-1');
});

test('t2303: the state line of a pull runner names the wire and whether it is attached', () => {
  const { runnerStateLine } = require('../renderer/lib/team-runner-row');
  assert.strictEqual(runnerStateLine({ peer: 'laptop', wire: 'pull', reach: 'not attached (last claim never)', tally: null }),
    'dials in (wire pull, shadow only): not attached (last claim never)');
  assert.strictEqual(runnerStateLine({ peer: 'runner-1', wire: 'push', reach: 'offline', tally: null }), 'offline');
});
