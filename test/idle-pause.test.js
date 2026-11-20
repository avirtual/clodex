'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { idleCandidates, shouldAsk, createIdlePauseAsker } = require('../idle-pause');

const H = 3600000;
const NOW = 1_800_000_000_000;
const T48 = 48 * H;

const row = (name, extra = {}) => ({ name, type: 'claude', activityTs: NOW - 50 * H, operatorInputAt: 0, ...extra });

test('idle exactly at the threshold counts, one ms under does not, over does', () => {
  const out = idleCandidates({
    now: NOW, thresholdMs: T48,
    sessions: [
      row('at', { activityTs: NOW - T48 }),
      row('under', { activityTs: NOW - T48 + 1 }),
      row('over', { activityTs: NOW - 72 * H }),
    ],
  });
  assert.deepStrictEqual(out, [
    { name: 'over', type: 'claude', idleMs: 72 * H, idle: '3 days', reason: null },
    { name: 'at', type: 'claude', idleMs: 48 * H, idle: '2 days', reason: null },
  ]);
});

test('idle runs from the later of activityTs and the operator input clock', () => {
  const out = idleCandidates({
    now: NOW, thresholdMs: T48,
    sessions: [
      row('typed-recently', { activityTs: NOW - 100 * H, operatorInputAt: NOW - 1 * H }),
      row('turn-recently', { activityTs: NOW - 1 * H, operatorInputAt: NOW - 100 * H }),
      row('both-old', { activityTs: NOW - 60 * H, operatorInputAt: NOW - 49 * H }),
    ],
  });
  assert.deepStrictEqual(out.map((r) => [r.name, r.idleMs]), [['both-old', 49 * H]]);
});

test('archived and exited sessions are not candidates', () => {
  const out = idleCandidates({
    now: NOW, thresholdMs: T48,
    sessions: [row('live'), row('archived', { archived: true }), row('exited', { exited: true })],
  });
  assert.deepStrictEqual(out.map((r) => r.name), ['live']);
});

for (const [flag, reason] of [
  ['bash', 'a shell session cannot be resumed'],
  ['assistant', 'an assistant sleeps on its own'],
  ['lead', 'leads a team'],
  ['working', 'working'],
  ['dialog', 'a dialog is open'],
  ['pending', 'has messages waiting'],
  ['inFlight', 'a reload or compact is in flight'],
  ['ticket', 'holds an open ticket'],
]) {
  test(`exempt: ${flag} → "${reason}"`, () => {
    const out = idleCandidates({ now: NOW, thresholdMs: T48, sessions: [row('s', { [flag]: true })] });
    assert.deepStrictEqual(out.map((r) => [r.name, r.reason]), [['s', reason]]);
  });
}

test('a keep-warm hold is not an exemption', () => {
  const out = idleCandidates({ now: NOW, thresholdMs: T48, sessions: [row('warm', { hold: true, keepWarm: true })] });
  assert.deepStrictEqual(out.map((r) => [r.name, r.reason]), [['warm', null]]);
});

test('threshold 0 yields no candidates', () => {
  assert.deepStrictEqual(idleCandidates({ now: NOW, thresholdMs: 0, sessions: [row('a')] }), []);
});

const five = ['a', 'b', 'c', 'd', 'e'];

test('shouldAsk: five pausable asks, four does not, threshold 0 never asks', () => {
  assert.strictEqual(shouldAsk({ pausable: five, thresholdMs: T48, declined: null, now: NOW }), true);
  assert.strictEqual(shouldAsk({ pausable: ['a', 'b', 'c', 'd'], thresholdMs: T48, declined: null, now: NOW }), false);
  assert.strictEqual(shouldAsk({ pausable: five, thresholdMs: 0, declined: null, now: NOW }), false);
});

test('shouldAsk: "Not now" holds until five new pausable sessions or seven days', () => {
  const declined = { at: NOW - 1 * H, names: five };
  assert.strictEqual(shouldAsk({ pausable: [...five, 'f', 'g', 'h', 'i'], thresholdMs: T48, declined, now: NOW }), false,
    'four new sessions are not enough');
  assert.strictEqual(shouldAsk({ pausable: [...five, 'f', 'g', 'h', 'i', 'j'], thresholdMs: T48, declined, now: NOW }), true,
    'five new sessions re-ask');
  assert.strictEqual(shouldAsk({ pausable: five, thresholdMs: T48, declined: { at: NOW - 7 * 24 * H + 1, names: five }, now: NOW }), false,
    'one ms short of seven days');
  assert.strictEqual(shouldAsk({ pausable: five, thresholdMs: T48, declined: { at: NOW - 7 * 24 * H, names: five }, now: NOW }), true,
    'seven days re-ask');
});

test('shouldAsk: a declined set that shrinks does not re-ask', () => {
  const declined = { at: NOW - 1 * H, names: [...five, 'f', 'g'] };
  assert.strictEqual(shouldAsk({ pausable: ['a', 'b', 'c', 'd', 'e'], thresholdMs: T48, declined, now: NOW }), false);
});

function mkAsker({ rows, settings = { idlePauseHours: 48, idlePauseDeclined: null } } = {}) {
  const calls = { broadcast: [], saved: [], paused: [] };
  let clock = NOW;
  const timers = [];
  const asker = createIdlePauseAsker({
    survey: (now, thresholdMs) => idleCandidates({ sessions: rows(), now, thresholdMs }),
    pause: async (names, opts) => { calls.paused.push([names, opts]); return { paused: names.length - 1, skipped: 1 }; },
    getSettings: () => settings,
    saveSettings: (p) => { calls.saved.push(p); Object.assign(settings, p); },
    broadcast: (ch, payload) => calls.broadcast.push([ch, payload]),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: () => {},
  });
  return { asker, calls, settings, timers, advance: (ms) => { clock += ms; } };
}

const sixRows = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => row(n)).concat([row('lead1', { lead: true })]);

test('asker: first check five minutes after start, then hourly', () => {
  const { asker, timers } = mkAsker({ rows: sixRows });
  asker.start();
  assert.deepStrictEqual(timers.map((t) => t.ms), [300000]);
  timers[0].fn();
  assert.deepStrictEqual(timers.map((t) => t.ms), [300000, 3600000]);
});

test('asker: one question per batch, not repeated while open; "Not now" stores the offered set', async () => {
  const { asker, calls, settings } = mkAsker({ rows: sixRows });
  const ask = asker.check();
  assert.ok(ask, 'ENTER: six pausable sessions asked');
  assert.deepStrictEqual(ask.pausable.map((r) => r.name), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepStrictEqual(ask.exempt.map((r) => [r.name, r.reason]), [['lead1', 'leads a team']]);
  asker.check();
  assert.deepStrictEqual(calls.broadcast.map((b) => b[0]), ['idle-pause:ask']);
  const res = await asker.answer(ask.id, { decline: true });
  assert.deepStrictEqual(res, { ok: true, paused: 0, skipped: 0 });
  assert.deepStrictEqual(settings.idlePauseDeclined, { at: NOW, names: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.deepStrictEqual(calls.broadcast.map((b) => b[0]), ['idle-pause:ask', 'idle-pause:closed']);
  assert.strictEqual(asker.check(), null, 'the declined set does not re-ask');
});

test('asker: the first answer wins; a second window gets a refusal', async () => {
  const { asker, calls } = mkAsker({ rows: sixRows });
  const ask = asker.check();
  const first = await asker.answer(ask.id, { pause: ['a', 'b', 'zz'] });
  assert.deepStrictEqual(first, { ok: true, paused: 1, skipped: 1 });
  assert.deepStrictEqual(calls.paused, [[['a', 'b'], { thresholdMs: T48 }]], 'only offered names are paused');
  const second = await asker.answer(ask.id, { decline: true });
  assert.deepStrictEqual(second, { ok: false, error: 'this question was already answered' });
});

test('asker: unticked sessions are remembered as declined', async () => {
  const { asker, settings } = mkAsker({ rows: sixRows });
  const ask = asker.check();
  await asker.answer(ask.id, { pause: ['a', 'b', 'c'] });
  assert.deepStrictEqual(settings.idlePauseDeclined, { at: NOW, names: ['d', 'e', 'f'] });
});

test('asker: threshold 0 never surveys', () => {
  let surveyed = 0;
  const asker = createIdlePauseAsker({
    survey: () => { surveyed++; return []; }, pause: async () => ({}),
    getSettings: () => ({ idlePauseHours: 0 }), saveSettings: () => {}, broadcast: () => {},
  });
  assert.strictEqual(asker.check(), null);
  assert.strictEqual(surveyed, 0);
});

function memAsker({ rows, sample }) {
  const calls = { broadcast: [], sampled: [] };
  const asker = createIdlePauseAsker({
    survey: (now, thresholdMs) => idleCandidates({ sessions: rows(), now, thresholdMs }),
    pause: async () => ({ paused: 0, skipped: 0 }),
    getSettings: () => ({ idlePauseHours: 48, idlePauseDeclined: null }),
    saveSettings: () => {},
    broadcast: (ch, payload) => calls.broadcast.push([ch, payload]),
    sample: (pids) => { calls.sampled.push(pids); return sample(pids); },
    now: () => NOW,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { asker, calls };
}

const pidRows = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => row(n, { pid: 100 + i }))
  .concat([row('lead1', { lead: true, pid: 200 }), row('nopid')]);
const MB = 1024 * 1024;

test('asker: one sample per ask; memBytes on every row and memBytesTotal over the pausable ones', () => {
  const bytes = new Map([[100, 300 * MB], [101, 200 * MB], [102, 0], [200, 50 * MB]]);
  const { asker, calls } = memAsker({ rows: pidRows, sample: () => bytes });
  const ask = asker.check();
  assert.ok(ask, 'ENTER: asked');
  assert.deepStrictEqual(calls.sampled, [[100, 101, 102, 103, 104, 105, 200]]);
  assert.deepStrictEqual(ask.pausable.map((r) => [r.name, r.memBytes]), [
    ['a', 314572800], ['b', 209715200], ['c', null], ['d', null], ['e', null], ['f', null], ['nopid', null],
  ]);
  assert.deepStrictEqual(ask.exempt.map((r) => [r.name, r.memBytes]), [['lead1', 52428800]]);
  assert.strictEqual(ask.memBytesTotal, 524288000);
  assert.strictEqual('pid' in ask.pausable[0], false);
  asker.check();
  assert.strictEqual(calls.sampled.length, 1, 'an open question is not re-sampled');
});

test('asker: no ask, no sample', () => {
  const { asker, calls } = memAsker({ rows: () => [row('a', { pid: 1 })], sample: () => new Map() });
  assert.strictEqual(asker.check(), null);
  assert.deepStrictEqual(calls.sampled, []);
});

test('asker: a sample that throws or returns nothing still asks, with null figures', () => {
  for (const sample of [() => { throw new Error('ps died'); }, () => new Map()]) {
    const { asker } = memAsker({ rows: pidRows, sample });
    const ask = asker.check();
    assert.ok(ask, 'ENTER: asked');
    assert.deepStrictEqual(ask.pausable.concat(ask.exempt).map((r) => r.memBytes), [null, null, null, null, null, null, null, null]);
    assert.strictEqual(ask.memBytesTotal, null);
  }
});
