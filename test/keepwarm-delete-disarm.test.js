'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { mk } = require('./lib/session-fixtures');
const { createRemoteWiring } = require('../remote-wiring');

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });

function fakeKeeper(sids) {
  const held = new Set(sids);
  const disarmed = [];
  return {
    disarmed,
    holds() { return Object.fromEntries([...held].map((s) => [s, { always: true }])); },
    disarm(sid) { disarmed.push(sid); held.delete(sid); return { armed: false, disarmed: true, session: sid }; },
    endSession(sid) { throw new Error(`endSession(${sid}) is not the operator stop`); },
    arm() { throw new Error('arm must not be called'); },
  };
}

function rig({ records, gitWorktree } = {}) {
  const recs = new Map(Object.entries(records || {}).map(([k, v]) => [k, { name: k, ...v }]));
  const persistence = {
    list: () => [...recs.values()],
    get: (n) => recs.get(n) || null,
    remove: (n) => { recs.delete(n); },
    upsert: (e) => { recs.set(e.name, { ...(recs.get(e.name) || {}), ...e }); },
    setArchived: (n, v) => { const r = recs.get(n); if (r) r.archivedAt = v ? Date.now() : null; },
  };
  const m = mk({ getPersistence: () => persistence, log: QUIET, ...(gitWorktree ? { gitWorktree } : {}) });
  return { m, recs, persistence };
}

function live(m, name, sid, extra = {}) {
  m.sessions.set(name, { name, sessionId: sid, pty: { pid: 0, kill: () => { m.sessions.delete(name); } }, ...extra });
}

function enter(keeper, sid) {
  assert.ok(keeper.holds()[sid], `ENTER: the keeper held ${sid} before the call`);
}

test('destroy of a live seat disarms its hold by the live sessionId', async () => {
  const { m } = rig({ records: { a: { cwd: '/p', sessionId: SID_B } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A, SID_B]);
  live(m, 'a', SID_A);
  enter(keeper, SID_A);
  assert.deepStrictEqual(await m.destroy('a'), { ok: true, live: true });
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('destroy of a record-only seat disarms by the persisted sessionId', async () => {
  const { m } = rig({ records: { ghost: { cwd: '/p', sessionId: SID_B } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_B]);
  enter(keeper, SID_B);
  assert.deepStrictEqual(await m.destroy('ghost'), { ok: true, live: false });
  assert.deepStrictEqual(keeper.disarmed, [SID_B]);
});

test('destroy whose worktree removal fails still disarms', async () => {
  const wt = { path: '/wt/t1', branch: 't1' };
  const { m, recs } = rig({
    records: { w: { cwd: '/wt/t1', sessionId: SID_A, worktree: wt } },
    gitWorktree: { removeWorktree: async () => ({ ok: false, error: 'busy' }) },
  });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'w', SID_A);
  enter(keeper, SID_A);
  const r = await m.destroy('w');
  assert.deepStrictEqual(r, { ok: true, worktreeRemoved: false, error: 'busy', path: '/wt/t1', live: true },
    'ENTER: the removal-failed arm was taken');
  assert.strictEqual(recs.get('w').worktree.path, '/wt/t1', 'ENTER: the record naming the kept tree survives');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('destroy whose process outlives the wait still disarms', async () => {
  const wt = { path: '/wt/t2', branch: 't2' };
  const { m } = rig({ records: { s: { cwd: '/wt/t2', sessionId: SID_A, worktree: wt } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  m.sessions.set('s', { name: 's', sessionId: SID_A, pty: { pid: 0, kill: () => {} } });
  m._waitForExit = async () => false;
  enter(keeper, SID_A);
  const r = await m.destroy('s');
  assert.strictEqual(r.ok, false, 'ENTER: the timeout arm was taken');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('archive disarms the live seat\'s hold', async () => {
  const { m, recs } = rig({ records: { a: { cwd: '/p', sessionId: SID_A } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A);
  enter(keeper, SID_A);
  await m.archive('a');
  assert.ok(recs.get('a').archivedAt > 0, 'ENTER: the record was archived');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('a fork that has not rotated off its parent\'s sid leaves the parent\'s hold armed', async () => {
  const { m } = rig({ records: { parent: { cwd: '/p', sessionId: SID_A }, kid: { cwd: '/p', sessionId: SID_A } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'kid', SID_A, { forked: true });
  enter(keeper, SID_A);
  await m.destroy('kid');
  assert.ok(!m.sessions.has('kid'), 'ENTER: the fork was killed');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('kill() alone, the first half of every in-place restart, never disarms', async () => {
  const { m, recs } = rig({ records: { a: { cwd: '/p', sessionId: SID_A } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A);
  enter(keeper, SID_A);
  await m.kill('a');
  assert.strictEqual(recs.get('a'), undefined, 'ENTER: kill dropped the record, as a restart does');
  assert.deepStrictEqual(keeper.disarmed, []);
});

function peerKillSession(manager, persistence) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  let srv = null;
  const known = {
    path, fs, os, log: QUIET, manager,
    DEFAULT_WORKSPACE_ID: 'default', AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: path.join(os.tmpdir(), 'clx-kwd-reg'), OUTBOX_DIR: path.join(os.tmpdir(), 'clx-kwd-outbox'), SELF_LABEL: 't',
    ensureDir: () => {}, claimOutbox: () => [], listOutboxOrigins: () => [],
    getPersistence: () => persistence,
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '0.0.0', isPackaged: () => false,
  };
  const deps = new Proxy(known, { get: (t, k) => (k in t ? t[k] : () => ({ list: () => [], get: () => ({}) })) });
  try {
    createRemoteWiring(deps).syncRemoteServer();
  } finally {
    remoteMod.RemoteServer = orig;
  }
  return opts.killSession;
}

test('the peer killSession of a plain seat disarms its hold', async () => {
  const { m, recs, persistence } = rig({ records: { w1: { cwd: '/p', sessionId: SID_A } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'w1', SID_A);
  const killSession = peerKillSession(m, persistence);
  enter(keeper, SID_A);
  assert.deepStrictEqual(await killSession('w1'), { ok: true, name: 'w1' });
  assert.strictEqual(recs.get('w1'), undefined, 'ENTER: the peer path dropped the record');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});
