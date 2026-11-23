'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { InjectQueue } = require('../inject-queue');
const { createSessionManager } = require('../session-manager');
const { isDraftOpen } = require('../proxy-util');
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const T0 = 1_700_000_000_000;

class NoSleepQueue extends InjectQueue {
  constructor(opts) { super({ ...opts, sleep: () => Promise.resolve() }); }
}

function boot(type) {
  const PENDING_DIR = mkTmpRoot('clodex-cdraft-');
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    InjectQueue: NoSleepQueue,
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen, countPending,
    INJECT_QUIET_MS: 2000,
    INJECT_QUIET_MAXWAIT: 3_600_000,
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_SPEAKING_STALE_MS: 0,
    INJECT_VOICE_DRAFT_STALE_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    bootDrainSettleMs: 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    hintArm: { holding: () => false },
    getPersistence: () => ({ get: () => null, list: () => [] }),
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const writes = [];
  const s = {
    name: 'hand', agentType: type, _dead: false, activityState: 'idle',
    _bootReadySeen: true, _bootReadyAt: 0,
    lastUserInputTs: 0, lastUserSubmitTs: 0,
    pty: { write: (b) => writes.push(b) },
  };
  m.sessions = new Map([['hand', s]]);
  return { m, s, writes, PENDING_DIR };
}

function cleanup(h) {
  for (const k of ['_parkCapTimer', '_bootNudgeTimer', '_submitStuckTimer']) clearTimeout(h.s[k]);
  h.s._dead = true;
  try { fs.rmSync(h.PENDING_DIR, { recursive: true, force: true }); } catch {}
}

async function drained(h) {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  return h.writes.slice();
}

function stored(h) {
  let files = [];
  try { files = fs.readdirSync(`${h.PENDING_DIR}/hand`).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => (f.includes('.passive.') ? 'passive' : 'active'));
}

function withClock(fn) {
  return async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    try { await fn(); } finally { mock.timers.reset(); }
  };
}

const TYPED_NOW = (text) => ['\x15', text, '\r'];

test('busy/typing park (_maybeParkDelivery): action per seat type and condition', withClock(async () => {
  const rows = [
    ['claude', 'typed 1000 ms ago', { lastUserInputTs: T0 - 1000 }, 'parked'],
    ['clodent', 'typed 1000 ms ago', { lastUserInputTs: T0 - 1000 }, 'parked'],
    ['codex', 'typed 1000 ms ago', { lastUserInputTs: T0 - 1000 }, 'typed now'],
    ['claude', 'mid-turn', { activityState: 'thinking' }, 'parked'],
    ['clodent', 'mid-turn', { activityState: 'thinking' }, 'parked'],
    ['codex', 'mid-turn', { activityState: 'thinking' }, 'typed now'],
    ['claude', 'idle, typed 60000 ms ago and submitted', { lastUserInputTs: T0 - 60_000, lastUserSubmitTs: T0 - 60_000 }, 'typed now'],
    ['clodent', 'idle, typed 60000 ms ago and submitted', { lastUserInputTs: T0 - 60_000, lastUserSubmitTs: T0 - 60_000 }, 'typed now'],
  ];
  const got = [];
  for (const [type, label, cond] of rows) {
    const h = boot(type);
    Object.assign(h.s, cond);
    try {
      const parked = h.m._maybeParkDelivery(h.s, '[agent:from lead] hi');
      got.push([type, label, parked ? 'parked' : 'typed now', stored(h)]);
    } finally { cleanup(h); }
  }
  assert.deepStrictEqual(got, rows.map(([type, label, , want]) => [type, label, want, want === 'parked' ? ['active'] : []]));
}));

test('fire-time divert (_parkDivertFor, _turnStartPending): action per seat type and condition', withClock(async () => {
  const rows = [
    ['claude', 'draft open, typed 60000 ms ago', { lastUserInputTs: T0 - 60_000, lastUserSubmitTs: 0 }, 'diverted'],
    ['clodent', 'draft open, typed 60000 ms ago', { lastUserInputTs: T0 - 60_000, lastUserSubmitTs: 0 }, 'diverted'],
    ['codex', 'draft open, typed 60000 ms ago', { lastUserInputTs: T0 - 60_000, lastUserSubmitTs: 0 }, 'typed now'],
    ['claude', 'previous unit submitted 1000 ms ago, no turn yet', { _awaitingTurnSince: T0 - 1000 }, 'diverted'],
    ['clodent', 'previous unit submitted 1000 ms ago, no turn yet', { _awaitingTurnSince: T0 - 1000 }, 'diverted'],
    ['codex', 'previous unit submitted 1000 ms ago, no turn yet', { _awaitingTurnSince: T0 - 1000 }, 'typed now'],
    ['clodent', 'previous unit submitted 6000 ms ago, no turn yet', { _awaitingTurnSince: T0 - 6000 }, 'typed now'],
    ['clodent', 'no draft, no pending turn', {}, 'typed now'],
  ];
  const got = [];
  for (const [type, label, cond] of rows) {
    const h = boot(type);
    Object.assign(h.s, cond);
    try {
      h.m._injectText(h.s, '[agent:from lead] hi', { parkable: true });
      const w = await drained(h);
      const action = w.length === 0 && stored(h).length === 1 ? 'diverted'
        : JSON.stringify(w) === JSON.stringify(TYPED_NOW('[agent:from lead] hi')) ? 'typed now' : `other ${JSON.stringify(w)}`;
      got.push([type, label, action]);
    } finally { cleanup(h); }
  }
  assert.deepStrictEqual(got, rows.map(([type, label, , want]) => [type, label, want]));
}));

test('a pty write into an idle clodent seat stamps the turn-start window that holds the next divert', withClock(async () => {
  const h = boot('clodent');
  try {
    h.m._injectText(h.s, 'first', { parkable: true });
    assert.deepStrictEqual(await drained(h), TYPED_NOW('first'));
    assert.strictEqual(h.s._awaitingTurnSince, T0, 'ENTER: the submit stamped the window');
    h.m._injectText(h.s, 'second', { parkable: true });
    assert.deepStrictEqual([await drained(h), stored(h)], [TYPED_NOW('first'), ['active']]);
  } finally { cleanup(h); }
}));

test('operator flush (flushPending): action per seat type', withClock(async () => {
  const rows = [
    ['claude', 'one parked entry, idle', { ok: true, count: 1 }, TYPED_NOW('[agent:from lead] hi')],
    ['clodent', 'one parked entry, idle', { ok: true, count: 1 }, TYPED_NOW('[agent:from lead] hi')],
    ['codex', 'one parked entry, idle', { ok: false, reason: 'no-such-agent' }, []],
    ['clodent', 'one parked entry, mid-turn', { ok: false, reason: 'busy', count: 1 }, []],
  ];
  const got = [];
  for (const [type, label] of rows) {
    const h = boot(type);
    if (label.endsWith('mid-turn')) h.s.activityState = 'thinking';
    parkDelivery(h.PENDING_DIR, 'hand', '[agent:from lead] hi', '1');
    try {
      const r = h.m.flushPending('hand');
      got.push([type, label, r, await drained(h)]);
    } finally { cleanup(h); }
  }
  assert.deepStrictEqual(got, rows);
}));

test('passive notice (_injectTextPassive): action per seat type', withClock(async () => {
  const rows = [
    ['claude', 'idle seat', 'parked passive'],
    ['clodent', 'idle seat', 'parked passive'],
    ['codex', 'idle seat', 'typed now'],
  ];
  const got = [];
  for (const [type, label] of rows) {
    const h = boot(type);
    try {
      h.m._injectTextPassive(h.s, '[agent:exec] run 3 ok');
      const w = await drained(h);
      const action = w.length === 0 && JSON.stringify(stored(h)) === '["passive"]' ? 'parked passive'
        : JSON.stringify(w) === JSON.stringify(TYPED_NOW('[agent:exec] run 3 ok')) ? 'typed now' : `other ${JSON.stringify(w)}`;
      got.push([type, label, action]);
    } finally { cleanup(h); }
  }
  assert.deepStrictEqual(got, rows.map(([type, label, want]) => [type, label, want]));
}));

async function typedThenDm(h) {
  h.m.write('hand', 'fix the');
  assert.deepStrictEqual([h.s.lastUserInputTs, isDraftOpen(h.s)], [T0, true], 'ENTER: the keystroke stamped the seat and opened a draft');
  h.writes.length = 0;
  mock.timers.tick(1000);
  h.m._deliverMessage('hand', 'lead', 'please review', 'dm');
  assert.deepStrictEqual([await drained(h), stored(h)], [[], ['active']], 'no byte reaches the pty; the dm is parked');
  mock.timers.tick(1000);
  h.m.write('hand', '\r');
  assert.strictEqual(isDraftOpen(h.s), false, 'ENTER: the Enter submitted the draft');
  h.writes.length = 0;
}

test('typed 1 s ago into a clodent seat: a dm writes nothing, and is typed at the Stop of the turn the operator started', withClock(async () => {
  const h = boot('clodent');
  try {
    await typedThenDm(h);
    h.m._routeAttnEntry(h.s, { turn_hook: 'UserPromptSubmit' });
    mock.timers.tick(10_000);
    assert.deepStrictEqual([h.s.activityState, await drained(h), stored(h)], ['thinking', [], ['active']]);
    h.m._routeAttnEntry(h.s, { turn_hook: 'Stop' });
    const w = await drained(h);
    assert.deepStrictEqual([w.length, w[0], w[2], stored(h)], [3, '\x15', '\r', []]);
    assert.match(w[1], /^\[agent:from lead\] please review/);
  } finally { cleanup(h); }
}));

test('a clodent session that never fires the turn hooks: the parked dm is typed at the transcript-driven idle edge', withClock(async () => {
  const h = boot('clodent');
  try {
    await typedThenDm(h);
    const emit = h.m._gateTranscriptActivity(h.s, (st, end) => h.m._emitActivity('hand', st, end));
    emit('thinking', false);
    mock.timers.tick(10_000);
    assert.deepStrictEqual([h.s.activityState, await drained(h), stored(h)], ['thinking', [], ['active']]);
    emit('idle', true);
    const w = await drained(h);
    assert.deepStrictEqual([w.length, w[0], w[2], stored(h)], [3, '\x15', '\r', []]);
    assert.match(w[1], /^\[agent:from lead\] please review/);
  } finally { cleanup(h); }
}));
