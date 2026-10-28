'use strict';

const { test, after } = require('node:test');
require('./lib/engine-isolation');
const assert = require('node:assert');
const path = require('path');
const { mkTmpRoot } = require('./lib/tmp-roots');

let engine = null;
let stub = null;
let deps = null;
let tmp = null;

function boot() {
  if (engine) return engine;
  const dp = require('../drawer-pty');
  const orig = dp.createDrawerPtys;
  stub = { killed: [], killSeat(ws, seat) { stub.killed.push([ws, seat]); return true; }, dispose() {} };
  dp.createDrawerPtys = (d) => { deps = d; return stub; };
  tmp = mkTmpRoot('clx-drawer-teardown-');
  try {
    engine = require('./lib/engine-isolation').createEngine({
      userDataPath: tmp,
      seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
      log: { info() {}, warn() {}, error() {} },
    });
  } finally { dp.createDrawerPtys = orig; }
  engine.manager._broadcast = () => {};
  return engine;
}

function seat(name, extra = {}) {
  boot().stores.persistence.upsert({ name, type: 'claude', cwd: tmp, workspaceId: 'ws-7', ...extra });
  assert.ok(engine.stores.persistence.get(name), `ENTER: ${name} is persisted`);
  stub.killed = [];
}

test('destroy reaps the seat\'s drawer shell in the seat\'s own workspace', async () => {
  seat('gone');
  const r = await engine.manager.destroy('gone');
  assert.deepStrictEqual(r, { ok: true, live: false });
  assert.deepStrictEqual(stub.killed, [['ws-7', 'gone']]);
});

test('archive reaps the seat\'s drawer shell', async () => {
  seat('shelved');
  await engine.manager.archive('shelved');
  assert.deepStrictEqual(stub.killed, [['ws-7', 'shelved']]);
});

test('a rename reaps the OLD name\'s shell; a refused rename keeps it', async () => {
  seat('before');
  engine.manager.create = async () => {};
  const r = await engine.manager.rename('before', 'after');
  assert.strictEqual(r.ok, true, `ENTER: the rename went through (${r.error})`);
  assert.deepStrictEqual(stub.killed, [['ws-7', 'before']]);

  seat('pinned', { worktree: { path: path.join(tmp, 'wt'), branch: 'b' } });
  const refused = await engine.manager.rename('pinned', 'moved');
  assert.strictEqual(refused.ok, false, 'ENTER: a worktree seat cannot be renamed');
  assert.deepStrictEqual(stub.killed, []);
});

test('the drawer reads a seat\'s incarnation from its createdAt', () => {
  seat('born', { createdAt: 4242 });
  assert.strictEqual(typeof deps.incarnationFor, 'function', 'ENTER: engine wired incarnationFor');
  assert.strictEqual(deps.incarnationFor('ws-7', 'born'), 4242);
  assert.strictEqual(deps.incarnationFor('ws-7', 'nobody'), null);
});

test('a stale exec result is dropped, not delivered to the successor', () => {
  boot();
  const delivered = [];
  engine.manager._gatedDeliver = (s, tag, text) => { delivered.push(text); return { queued: true }; };
  deps.onExecResult('alpha', { status: 'shell-gone', reason: 'the seat was replaced', command: 'make', stale: true });
  assert.deepStrictEqual(delivered, []);
  deps.onExecResult('alpha', { status: 'shell-gone', reason: 'the terminal was closed', command: 'make' });
  assert.strictEqual(delivered.length, 1, 'the same result without the flag is delivered');
});

after(() => { if (engine && engine.shutdown) { try { engine.shutdown(); } catch {} } });
