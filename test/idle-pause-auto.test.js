'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { idleCandidates, createIdlePauseAsker } = require('../idle-pause');

const H = 3600000;
const NOW = 1_800_000_000_000;

const row = (name, extra = {}) => ({ name, type: 'claude', activityTs: NOW - 50 * H, operatorInputAt: 0, ...extra });

function mkAsker({ rows, settings, sample }) {
  const calls = { broadcast: [], saved: [], paused: [], kept: [], surveyed: 0, logged: [], order: [] };
  const asker = createIdlePauseAsker({
    survey: (now, thresholdMs) => { calls.surveyed++; return idleCandidates({ sessions: rows(), now, thresholdMs }); },
    pause: async (names, opts) => {
      calls.paused.push([names, opts]);
      calls.order.push('pause');
      const ok = names.filter((n) => n !== 'flaky');
      return { paused: ok.length, skipped: names.length - ok.length };
    },
    keep: async (names) => { calls.kept.push(names); },
    getSettings: () => settings,
    saveSettings: (p) => { calls.saved.push(p); Object.assign(settings, p); },
    broadcast: (ch, payload) => calls.broadcast.push([ch, payload]),
    ...(sample ? { sample: (pids) => { calls.order.push('sample'); return sample(pids); } } : {}),
    log: { info: (tag, msg) => calls.logged.push([tag, msg]), warn() {} },
    now: () => NOW,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { asker, calls, settings };
}

const sixRows = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => row(n));

test('idleCandidates: a keepRunning row reads "you chose to keep it running", ahead of lead', () => {
  const out = idleCandidates({ now: NOW, thresholdMs: 48 * H, sessions: [row('k', { keep: true, lead: true }), row('p')] });
  assert.deepStrictEqual(out.map((r) => [r.name, r.reason]), [['k', 'you chose to keep it running'], ['p', null]]);
});

test('answer with auto: ticked rows paused, unticked rows kept running, auto saved on', async () => {
  const { asker, calls, settings } = mkAsker({ rows: sixRows, settings: { idlePauseHours: 48, idlePauseDeclined: { at: 1, names: ['z'] } } });
  const ask = asker.check();
  assert.ok(ask && ask.id, 'ENTER: six pausable sessions asked');
  const res = await asker.answer(ask.id, { pause: ['a', 'b'], auto: true });
  assert.deepStrictEqual(res, { ok: true, paused: 2, skipped: 0 });
  assert.deepStrictEqual(calls.paused, [[['a', 'b'], { thresholdMs: 48 * H }]]);
  assert.deepStrictEqual(calls.kept, [['c', 'd', 'e', 'f']]);
  assert.deepStrictEqual(calls.saved, [{ idlePauseAuto: true, idlePauseDeclined: null }]);
  assert.deepStrictEqual(settings, { idlePauseHours: 48, idlePauseDeclined: null, idlePauseAuto: true });
});

test('answer without auto leaves the setting alone and keeps nothing', async () => {
  const { asker, calls, settings } = mkAsker({ rows: sixRows, settings: { idlePauseHours: 48, idlePauseDeclined: null } });
  const ask = asker.check();
  await asker.answer(ask.id, { pause: ['a'] });
  assert.deepStrictEqual(calls.kept, []);
  assert.deepStrictEqual(settings, { idlePauseHours: 48, idlePauseDeclined: { at: NOW, names: ['b', 'c', 'd', 'e', 'f'] } });
});

test('auto on: one pausable row is paused without asking; exempt rows are skipped; one notice', async () => {
  const rows = () => [
    row('lone'),
    row('kept', { keep: true }),
    row('lead1', { lead: true }),
    row('busy', { working: true }),
    row('flaky'),
  ];
  const { asker, calls } = mkAsker({ rows, settings: { idlePauseHours: 24, idlePauseAuto: true, idlePauseDeclined: { at: NOW, names: ['lone'] } } });
  const res = await asker.check();
  assert.deepStrictEqual(res, { names: ['lone'] });
  assert.deepStrictEqual(calls.paused, [[['flaky'], { thresholdMs: 24 * H }], [['lone'], { thresholdMs: 24 * H }]],
    'one row at a time, exempt rows never offered to pause');
  assert.deepStrictEqual(calls.broadcast, [['idle-pause:auto', { names: ['lone'], hours: 24, memBytes: null }]]);
  assert.strictEqual(calls.broadcast.some((b) => b[0] === 'idle-pause:ask'), false);
  assert.deepStrictEqual(calls.logged, [['session', 'idle pause: paused 1 sessions idle over 24h automatically: lone']]);
  assert.strictEqual(asker.current(), null);
});

test('auto on: a check that pauses nothing is silent', async () => {
  const { asker, calls } = mkAsker({ rows: () => [row('flaky'), row('kept', { keep: true })], settings: { idlePauseHours: 48, idlePauseAuto: true } });
  const res = await asker.check();
  assert.deepStrictEqual(calls.paused, [[['flaky'], { thresholdMs: 48 * H }]], 'ENTER: the pausable row was tried');
  assert.deepStrictEqual(res, { names: [] });
  assert.deepStrictEqual(calls.broadcast, []);
  assert.deepStrictEqual(calls.logged, []);
});

test('auto on with no pausable row: no pause call, nothing broadcast', () => {
  const { asker, calls } = mkAsker({ rows: () => [row('kept', { keep: true })], settings: { idlePauseHours: 48, idlePauseAuto: true } });
  assert.strictEqual(asker.check(), null);
  assert.strictEqual(calls.surveyed, 1, 'ENTER: the survey ran');
  assert.deepStrictEqual([calls.paused, calls.broadcast], [[], []]);
});

test('auto on with idlePauseHours 0: no survey, no pause', () => {
  const { asker, calls } = mkAsker({ rows: sixRows, settings: { idlePauseHours: 0, idlePauseAuto: true } });
  assert.strictEqual(asker.check(), null);
  assert.deepStrictEqual([calls.surveyed, calls.paused, calls.broadcast], [0, [], []]);
});

test('an open question stays open when auto turns on, and its answer still works', async () => {
  const { asker, calls, settings } = mkAsker({ rows: sixRows, settings: { idlePauseHours: 48, idlePauseDeclined: null } });
  const ask = asker.check();
  assert.ok(ask && ask.id, 'ENTER: asked');
  settings.idlePauseAuto = true;
  assert.strictEqual(asker.check(), ask);
  assert.deepStrictEqual(calls.paused, []);
  const res = await asker.answer(ask.id, { pause: ['a'] });
  assert.deepStrictEqual(res, { ok: true, paused: 1, skipped: 0 });
});

test('auto on: one sample before the pauses; the notice carries the bytes freed by the sessions actually paused', async () => {
  const rows = () => [row('a', { pid: 11 }), row('flaky', { pid: 12 }), row('b', { pid: 13 }), row('kept', { keep: true, pid: 14 })];
  const bytes = new Map([[11, 1000], [12, 5000], [13, 300], [14, 9000]]);
  const { asker, calls } = mkAsker({ rows, settings: { idlePauseHours: 48, idlePauseAuto: true }, sample: () => bytes });
  const res = await asker.check();
  assert.deepStrictEqual(res, { names: ['a', 'b'] });
  assert.deepStrictEqual(calls.order, ['sample', 'pause', 'pause', 'pause']);
  assert.deepStrictEqual(calls.broadcast, [['idle-pause:auto', { names: ['a', 'b'], hours: 48, memBytes: 1300 }]]);
});
