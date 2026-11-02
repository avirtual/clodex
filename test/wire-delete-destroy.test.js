'use strict';

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createRemoteWiring } = require('../remote-wiring');

const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });

function listing(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${r}/` : r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(root, '');
  return out;
}

function rig(records) {
  const root = mkTmpRoot('clx-wdd-');
  const REGISTRY_DIR = path.join(root, 'reg');
  const PENDING_DIR = path.join(root, 'pending');
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const recs = new Map(Object.entries(records).map(([k, v]) => [k, { name: k, ...v }]));
  const persistence = {
    list: () => [...recs.values()],
    get: (n) => recs.get(n) || null,
    remove: (n) => { recs.delete(n); },
    upsert: (e) => { recs.set(e.name, { ...(recs.get(e.name) || {}), ...e }); },
    setArchived: (n, v) => { const r = recs.get(n); if (r) r.archivedAt = v ? Date.now() : null; },
    listForWorkspace: (ws) => [...recs.values()].filter((r) => r.workspaceId === ws),
  };
  const removed = [];
  const gitWorktree = {
    removeWorktree: async (p) => { removed.push(p); fs.rmSync(p, { recursive: true, force: true }); return { ok: true }; },
  };
  const m = mk({ getPersistence: () => persistence, log: QUIET, fs, REGISTRY_DIR, PENDING_DIR, gitWorktree });
  return { m, recs, persistence, root, REGISTRY_DIR, PENDING_DIR, removed };
}

function seed({ root, REGISTRY_DIR, PENDING_DIR }, name) {
  fs.mkdirSync(path.join(REGISTRY_DIR, 'sessions', name), { recursive: true });
  fs.writeFileSync(path.join(REGISTRY_DIR, 'sessions', name, 'client-token'), 'old-token');
  fs.mkdirSync(path.join(PENDING_DIR, name), { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR, name, '0001.json'), '{}');
  const wt = path.join(root, 'wt', name);
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

function live(m, name) {
  m.sessions.set(name, { name, sessionId: SID, pty: { pid: 0, kill: () => { m.sessions.delete(name); } } });
}

function peerKillSession(manager, persistence, REGISTRY_DIR) {
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
    REGISTRY_DIR, OUTBOX_DIR: path.join(REGISTRY_DIR, 'outbox'), SELF_LABEL: 't',
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

test('the wire delete of a live plain seat removes its seat dir, parked mail and worktree record', async () => {
  const r = rig({});
  const wt = seed(r, 'w1');
  r.recs.set('w1', { name: 'w1', cwd: wt, sessionId: SID, worktree: { path: wt, branch: 'w1' } });
  live(r.m, 'w1');
  const killSession = peerKillSession(r.m, r.persistence, r.REGISTRY_DIR);
  assert.deepStrictEqual(listing(r.root), [
    'pending/', 'pending/w1/', 'pending/w1/0001.json',
    'reg/', 'reg/sessions/', 'reg/sessions/w1/', 'reg/sessions/w1/client-token',
    'wt/', 'wt/w1/',
  ], 'ENTER: the seat files exist before the delete');
  assert.deepStrictEqual(await killSession('w1'), { ok: true, name: 'w1' });
  assert.deepStrictEqual(listing(r.root), ['pending/', 'reg/', 'reg/sessions/', 'wt/']);
  assert.deepStrictEqual(r.removed, [wt]);
  assert.strictEqual(r.recs.get('w1'), undefined);
  assert.strictEqual(r.m.sessions.has('w1'), false);
});

test('the wire delete of an archived plain seat succeeds and removes its record', async () => {
  const r = rig({ old: { cwd: '/p', sessionId: SID, archivedAt: 1 } });
  const killSession = peerKillSession(r.m, r.persistence, r.REGISTRY_DIR);
  assert.ok(r.recs.get('old'), 'ENTER: the record exists before the delete');
  assert.deepStrictEqual(await killSession('old'), { ok: true, name: 'old' });
  assert.strictEqual(r.recs.get('old'), undefined);
});

test('the wire delete of an assistant still routes to destroyAssistant', async () => {
  const r = rig({ avh: { class: 'assistant', sessionId: SID, archivedAt: 1 } });
  const killSession = peerKillSession(r.m, r.persistence, r.REGISTRY_DIR);
  assert.deepStrictEqual(await killSession('avh'), { ok: true, name: 'avh', destroyed: true, transcripts: 0 });
  assert.strictEqual(r.recs.get('avh'), undefined);
});

test('the wire delete of an unknown name is no such session', async () => {
  const r = rig({});
  const killSession = peerKillSession(r.m, r.persistence, r.REGISTRY_DIR);
  assert.deepStrictEqual(await killSession('nobody'), { ok: false, error: 'no such session "nobody"' });
});

test('the wire delete of a seat whose worktree cannot be removed reports the kept worktree', async () => {
  const r = rig({ w2: { cwd: '/w', sessionId: SID } });
  r.m.destroy = async () => ({ ok: true, worktreeRemoved: false, path: '/w', error: 'busy' });
  const killSession = peerKillSession(r.m, r.persistence, r.REGISTRY_DIR);
  assert.deepStrictEqual(await killSession('w2'), { ok: true, name: 'w2', worktreeRemoved: false, kept: true, path: '/w', error: 'busy' });
});
