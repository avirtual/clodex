'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
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
    listForWorkspace: (ws) => [...recs.values()].filter((r) => r.workspaceId === ws),
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
  const { m } = rig();
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'kid', SID_A, { forked: true });
  enter(keeper, SID_A);
  await m.destroy('kid');
  assert.ok(!m.sessions.has('kid'), 'ENTER: the fork was killed');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('destroying an unforked seat whose sid a live seat shares leaves the hold armed', async () => {
  const { m } = rig();
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'parent', SID_A);
  live(m, 'kid', SID_A);
  enter(keeper, SID_A);
  await m.destroy('kid');
  assert.ok(!m.sessions.has('kid') && m.sessions.has('parent'), 'ENTER: only the seat was killed');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('destroying the parent while a live unrotated fork shares its sid leaves the hold armed', async () => {
  const { m, recs } = rig({ records: { parent: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'parent', SID_A);
  live(m, 'kid', SID_A, { forked: true });
  enter(keeper, SID_A);
  await m.destroy('parent');
  assert.strictEqual(recs.get('parent'), undefined, 'ENTER: the parent was destroyed');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('destroying the parent disarms past an archived fork record that shares its sid', async () => {
  const { m, recs } = rig({ records: {
    parent: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true },
    kid: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true, archivedAt: 1 },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'parent', SID_A);
  enter(keeper, SID_A);
  await m.destroy('parent');
  assert.strictEqual(recs.get('kid').sessionId, SID_A, 'ENTER: the archived fork record still shares the sid');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('destroying the parent disarms past an exited non-Always fork record that shares its sid', async () => {
  const { m, recs } = rig({ records: {
    parent: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true },
    kid: { cwd: '/p', sessionId: SID_A, exitedAt: 1 },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'parent', SID_A);
  enter(keeper, SID_A);
  await m.destroy('parent');
  assert.strictEqual(recs.get('kid').sessionId, SID_A, 'ENTER: the exited fork record still shares the sid');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('destroying the parent leaves the hold a non-archived Always record shares', async () => {
  const { m, recs } = rig({ records: {
    parent: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true },
    kid: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'parent', SID_A);
  enter(keeper, SID_A);
  await m.destroy('parent');
  assert.strictEqual(recs.get('parent'), undefined, 'ENTER: the parent was destroyed');
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

test('_holdSidFor prefers the live sid and _disarmHoldFor survives a throwing keeper', () => {
  const { m } = rig({ records: { a: { cwd: '/p', sessionId: SID_B } } });
  assert.strictEqual(m._holdSidFor('a'), SID_B, 'a record-only seat answers by its persisted sid');
  live(m, 'a', SID_A);
  assert.strictEqual(m._holdSidFor('a'), SID_A, 'a live seat answers by its live sid');
  const logged = [];
  m._shadowLog = (rec) => logged.push(rec);
  m._holdKeeper = { disarm() { throw new Error('boom'); } };
  m._disarmHoldFor('a', SID_A);
  assert.deepStrictEqual(logged, [{ type: 'wire-hold-disarm-error', agent: 'a', error: 'boom' }]);
});

test('session:forget of a record-only seat disarms by the persisted sessionId', () => {
  const { registerIpcHandlers } = require('../ipc-handlers');
  const { m, recs, persistence } = rig({ records: { ghost: { cwd: '/p', sessionId: SID_B } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_B]);
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager: m,
    persistence,
    log: QUIET,
  });
  enter(keeper, SID_B);
  assert.strictEqual(handlers.get('session:forget')(null, 'ghost'), true);
  assert.strictEqual(recs.get('ghost'), undefined, 'ENTER: forget dropped the record');
  assert.deepStrictEqual(keeper.disarmed, [SID_B]);
});

test('purgeWorkspace disarms a live seat and a record-only seat of the workspace', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
    ghost: { cwd: '/p', sessionId: SID_B, workspaceId: 'ws-1' },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A, SID_B]);
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  enter(keeper, SID_A);
  enter(keeper, SID_B);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: ['ghost'] });
  assert.strictEqual(recs.size, 0, 'ENTER: both records were dropped');
  assert.deepStrictEqual(keeper.disarmed.sort(), [SID_A, SID_B]);
});

test('purgeWorkspace disarms a sid its live seat and its record-only seat share', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1', keepWarmAlways: true },
    ghost: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1', keepWarmAlways: true },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  enter(keeper, SID_A);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: ['ghost'] });
  assert.strictEqual(recs.size, 0, 'ENTER: both records were dropped');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('purgeWorkspace leaves a sid a live seat outside the workspace shares', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
    out: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-2' },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  live(m, 'out', SID_A, { cwd: '/p', workspaceId: 'ws-2' });
  enter(keeper, SID_A);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: [] });
  assert.ok(recs.has('out') && m.sessions.has('out'), 'ENTER: the outside seat survived');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('purgeWorkspace leaves a sid an Always record-only seat outside the workspace shares', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
    out: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-2', keepWarmAlways: true },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  enter(keeper, SID_A);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: [] });
  assert.ok(recs.has('out') && !m.sessions.has('out'), 'ENTER: the outside record-only seat survived');
  assert.deepStrictEqual(keeper.disarmed, []);
});

test('purgeWorkspace disarms past a non-Always record-only seat outside the workspace', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
    out: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-2' },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  enter(keeper, SID_A);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: [] });
  assert.ok(recs.has('out'), 'ENTER: the outside record-only seat survived');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('purgeWorkspace leaves a sid whose ws-1 record names a seat live in another workspace', async () => {
  const { m, recs } = rig({ records: {
    a: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
    x: { cwd: '/p', sessionId: SID_A, workspaceId: 'ws-1' },
  } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A]);
  const forgotten = [];
  m.forgetSeatFiles = (name) => { forgotten.push(name); };
  live(m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  live(m, 'x', SID_A, { cwd: '/p', workspaceId: 'ws-2' });
  enter(keeper, SID_A);
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: [] });
  assert.ok(m.sessions.has('x'), 'ENTER: the seat live in ws-2 survived');
  assert.ok(recs.has('x'), 'the live ws-2 seat kept its record');
  assert.deepStrictEqual(forgotten, ['a']);
  assert.deepStrictEqual(keeper.disarmed, []);
});

function seatRig(records) {
  const root = mkTmpRoot('clx-purge-seat-');
  const seat = (n) => path.join(root, 'sessions', n);
  const plant = (n, files) => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(seat(n), f)), { recursive: true });
      fs.writeFileSync(path.join(seat(n), f), 'x');
    }
  };
  const recs = new Map(Object.entries(records).map(([k, v]) => [k, { name: k, ...v }]));
  const persistence = {
    list: () => [...recs.values()],
    get: (n) => recs.get(n) || null,
    remove: (n) => { recs.delete(n); },
    listForWorkspace: (ws) => [...recs.values()].filter((r) => r.workspaceId === ws),
  };
  const m = mk({ getPersistence: () => persistence, log: QUIET, REGISTRY_DIR: root, fs });
  return { m, recs, seat, plant };
}

test('purgeWorkspace unlinks the client-token of a live plain seat it kills; the seat dir keeps its other files', () => {
  const r = seatRig({ a: { cwd: '/p', type: 'claude', workspaceId: 'ws-1' } });
  r.plant('a', ['client-token', 'brief.md']);
  live(r.m, 'a', SID_A, { cwd: '/p', workspaceId: 'ws-1' });
  assert.deepStrictEqual(r.m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: [] });
  assert.strictEqual(r.recs.size, 0, 'ENTER: the live seat\'s record was dropped');
  assert.deepStrictEqual(fs.readdirSync(r.seat('a')), ['brief.md']);
});

test('purgeWorkspace removes the seat dir of a live assistant seat it kills', () => {
  const r = seatRig({ asst: { cwd: '/p', class: 'assistant', workspaceId: 'ws-1' } });
  r.plant('asst', ['client-token', 'brief.md', 'memory/unit.md']);
  live(r.m, 'asst', SID_A, { cwd: '/p', workspaceId: 'ws-1', _assistant: true });
  assert.ok(fs.existsSync(path.join(r.seat('asst'), 'memory', 'unit.md')), 'ENTER: the seat dir holds memory');
  assert.deepStrictEqual(r.m.purgeWorkspace('ws-1'), { killed: ['asst'], dropped: [] });
  assert.strictEqual(fs.existsSync(r.seat('asst')), false);
});

test('purgeWorkspace leaves the seat files of a seat live in another workspace', () => {
  const r = seatRig({ x: { cwd: '/p', type: 'claude', workspaceId: 'ws-1' } });
  r.plant('x', ['client-token']);
  live(r.m, 'x', SID_A, { cwd: '/p', workspaceId: 'ws-2' });
  assert.deepStrictEqual(r.m.purgeWorkspace('ws-1'), { killed: [], dropped: [] });
  assert.deepStrictEqual(fs.readdirSync(r.seat('x')), ['client-token']);
});

test('_maybeRearmHold arms an Always seat, and never one that is archiving', () => {
  const { m } = rig({ records: { a: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true } } });
  const armed = [];
  m._holdKeeper = { arm(sid, hours, opts) { armed.push([sid, hours, opts]); return { armed: true, always: true }; } };
  const fresh = { name: 'a', sessionId: SID_A };
  m._maybeRearmHold(fresh, 'a');
  assert.deepStrictEqual(armed, [[SID_A, 0, { always: true }]], 'ENTER: the same fixture arms a seat that is not archiving');
  armed.length = 0;
  const archiving = { name: 'a', sessionId: SID_A, _archived: true };
  m._maybeRearmHold(archiving, 'a');
  assert.deepStrictEqual(armed, []);
});

test('endHold disarms a seat by its own sid and leaves a sid another record shares', () => {
  const { m } = rig({ records: { a: { cwd: '/p', sessionId: SID_A }, b: { cwd: '/p', sessionId: SID_B }, c: { cwd: '/p', sessionId: SID_B, keepWarmAlways: true } } });
  const keeper = m._holdKeeper = fakeKeeper([SID_A, SID_B]);
  enter(keeper, SID_A);
  enter(keeper, SID_B);
  m.endHold('a');
  m.endHold('b');
  assert.deepStrictEqual(keeper.disarmed, [SID_A]);
});

test('_holdSharedOutside counts live seats and Always unarchived records, never a name it excludes', () => {
  const { m } = rig({ records: {
    always: { cwd: '/p', sessionId: SID_A, keepWarmAlways: true },
    plain: { cwd: '/p', sessionId: SID_B },
    gone: { cwd: '/p', sessionId: SID_B, keepWarmAlways: true, archived: true },
  } });
  assert.strictEqual(m._holdSharedOutside(SID_A, new Set()), true, 'ENTER: the Always record counts');
  assert.strictEqual(m._holdSharedOutside(SID_A, new Set(['always'])), false);
  assert.strictEqual(m._holdSharedOutside(SID_B, new Set()), false);
  live(m, 'plain', SID_B);
  assert.strictEqual(m._holdSharedOutside(SID_B, new Set()), true);
});

test('purgeWorkspace drops the reminders of both the live seat it kills and the record-only seat', () => {
  const recs = new Map([['a', { name: 'a', cwd: '/p', workspaceId: 'ws-1' }], ['ghost', { name: 'ghost', cwd: '/p', workspaceId: 'ws-1' }]]);
  const removed = [];
  const m = mk({
    getPersistence: () => ({ list: () => [...recs.values()], get: (n) => recs.get(n) || null, remove: (n) => { recs.delete(n); } }),
    getRemindScheduler: () => ({ removeForAgent: (n) => { removed.push(n); return 1; } }),
    log: QUIET,
  });
  live(m, 'a', null, { cwd: '/p', workspaceId: 'ws-1' });
  assert.deepStrictEqual(m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: ['ghost'] });
  assert.deepStrictEqual(removed.sort(), ['a', 'ghost']);
});
