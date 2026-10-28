'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { parkDelivery } = require('../pending-store');

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });

function rig({ records, removeWorktree } = {}) {
  const recs = new Map(Object.entries(records || {}).map(([k, v]) => [k, { name: k, ...v }]));
  const persistence = {
    list: () => [...recs.values()],
    get: (n) => recs.get(n) || null,
    remove: (n) => { recs.delete(n); },
    upsert: (e) => { recs.set(e.name, { ...(recs.get(e.name) || {}), ...e }); },
    setArchived: (n, v) => { const r = recs.get(n); if (r) r.archivedAt = v ? Date.now() : null; },
    listForWorkspace: (ws) => [...recs.values()].filter((r) => r.workspaceId === ws),
  };
  const calls = [];
  const lines = [];
  const log = { info: (c, m) => lines.push(m), warn: (c, m) => lines.push(m), error: (c, m) => lines.push(m), debug() {} };
  const PENDING_DIR = mkTmpRoot('clx-purge-pend-');
  const m = mk({
    getPersistence: () => persistence, log, PENDING_DIR, parkDelivery,
    DEFAULT_WORKSPACE_ID: 'default',
    gitWorktree: { removeWorktree: async (p) => { calls.push(p); return removeWorktree ? removeWorktree(p) : { ok: true }; } },
  });
  return { m, recs, calls, lines, PENDING_DIR };
}

function live(m, name, extra = {}) {
  m.sessions.set(name, {
    name, createdAt: 1, pty: { pid: 0, kill: () => { m._cleanup(name); m.sessions.delete(name); } }, ...extra,
  });
}

const WT = { path: '/wt/t1', branch: 't1' };

function wsRecords() {
  return {
    plain: { cwd: '/p', workspaceId: 'ws-1' },
    a: { cwd: '/p', workspaceId: 'ws-1' },
    wt: { cwd: '/wt/t1', workspaceId: 'ws-1', worktree: WT },
  };
}

test('purgeWorkspace routes a worktree record through destroy: the tree is removed and the record dropped', async () => {
  const { m, recs, calls } = rig({ records: wsRecords() });
  live(m, 'a', { cwd: '/p', workspaceId: 'ws-1' });
  assert.ok(m.savedForWorkspace('ws-1').some((e) => e.name === 'wt'), 'ENTER: the worktree record is in the workspace');
  assert.deepStrictEqual(await m.purgeWorkspace('ws-1'), { killed: ['a'], dropped: ['plain', 'wt'], kept: [] });
  assert.deepStrictEqual(calls, ['/wt/t1']);
  assert.strictEqual(recs.size, 0);
});

test('purgeWorkspace keeps a worktree record archived in the default workspace when removal fails', async () => {
  const { m, recs, calls } = rig({ records: wsRecords(), removeWorktree: () => ({ ok: false, error: 'busy' }) });
  live(m, 'a', { cwd: '/p', workspaceId: 'ws-1' });
  assert.ok(m.savedForWorkspace('ws-1').some((e) => e.name === 'wt'), 'ENTER: the worktree record is in the workspace');
  assert.deepStrictEqual(await m.purgeWorkspace('ws-1'), {
    killed: ['a'], dropped: ['plain'],
    kept: [{ name: 'wt', worktreeRemoved: false, path: '/wt/t1', error: 'busy' }],
  });
  assert.deepStrictEqual(calls, ['/wt/t1']);
  assert.deepStrictEqual([...recs.keys()], ['wt']);
  assert.strictEqual(recs.get('wt').workspaceId, 'default');
  assert.ok(recs.get('wt').archivedAt, 'kept record is archived');
  assert.deepStrictEqual(recs.get('wt').worktree, WT);
});

test('purgeWorkspace destroys a live worktree seat and keeps its record when removal fails', async () => {
  const { m, recs } = rig({
    records: { w: { cwd: '/wt/t1', workspaceId: 'ws-1', worktree: WT } },
    removeWorktree: () => ({ ok: false, error: 'busy' }),
  });
  live(m, 'w', { cwd: '/wt/t1', workspaceId: 'ws-1' });
  assert.deepStrictEqual(await m.purgeWorkspace('ws-1'), {
    killed: [], dropped: [],
    kept: [{ name: 'w', worktreeRemoved: false, path: '/wt/t1', error: 'busy' }],
  });
  assert.strictEqual(recs.get('w').workspaceId, 'default');
  assert.ok(recs.get('w').archivedAt);
});

test('destroy of a live seat drops its held injects instead of re-parking them, and removes its pending dir', async () => {
  const { m, lines, PENDING_DIR } = rig({ records: { a: { cwd: '/p', workspaceId: 'ws-1' } } });
  live(m, 'a', { _injectQueue: ['one', 'two'] });
  await m.destroy('a');
  assert.ok(lines.includes('dropped 2 held inject(s) for a: seat deleted'));
  assert.strictEqual(fs.existsSync(path.join(PENDING_DIR, 'a')), false);
});

test('purgeWorkspace drops a live plain seat\'s held injects and its parked mail', async () => {
  const { m, lines, PENDING_DIR } = rig({ records: { a: { cwd: '/p', workspaceId: 'ws-1' } } });
  parkDelivery(PENDING_DIR, 'a', 'parked earlier', 1, null, false, null, null);
  assert.ok(fs.readdirSync(path.join(PENDING_DIR, 'a')).length, 'ENTER: mail is parked for a');
  live(m, 'a', { cwd: '/p', workspaceId: 'ws-1', _injectQueue: ['one'] });
  await m.purgeWorkspace('ws-1');
  for (let i = 0; i < 20 && m.sessions.has('a'); i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(m.sessions.has('a'), false, 'ENTER: the pty exited');
  assert.ok(lines.includes('dropped 1 held inject(s) for a: seat deleted'));
  assert.strictEqual(fs.existsSync(path.join(PENDING_DIR, 'a')), false);
});

test('a plain kill of the same seat re-parks its held injects', async () => {
  const { m, lines, PENDING_DIR } = rig({ records: { a: { cwd: '/p', workspaceId: 'ws-1' } } });
  live(m, 'a', { _injectQueue: ['one', 'two'] });
  await m.kill('a');
  assert.ok(!lines.some((l) => l.includes('seat deleted')));
  assert.strictEqual(fs.readdirSync(path.join(PENDING_DIR, 'a')).filter((f) => f.endsWith('.json')).length, 2);
});
