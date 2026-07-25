'use strict';
// workbench-plugin.test.js — the workbench pilot's ENGINE half (plugins/workbench/
// engine.js), driven through the REAL plugin host engine (docs/plugin-plan.md §4
// W2/W5). No electron, no PTY: a fake manager, fake scm/fs/worktree leaves.
//
// What this pins, beyond "the rows exist":
//
//   1. MUST-FIX 5 — the locality refusal is HOST-SIDE. Every fs/scm/wt row that
//      takes a session name must go through host.sessions.fsScope FIRST, so a
//      peer session is refused with the exact `'remote'` string the renderer
//      renders as the remote notice, and a careless plugin cannot widen
//      locality. Asserted per row, not once: a single unguarded row is the whole
//      bug, and a spot-check would not find it.
//   2. The row set is COMPLETE and namespaced. Fourteen rows replace fourteen
//      window.api rows one-for-one; `wt.create` is the fifteenth (the workbench's
//      own Create Worktree button, which the plan left without a path).
//   3. `wt.remove` is deliberately NOT scoped — it takes a worktree PATH, exactly
//      as core's `worktree:remove` does (which likewise has no sessionCwd guard).
//      Pinned so a future "consistency" fix has to argue with a test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const workbenchEngine = require('../plugins/workbench/engine');

// Every leaf method the plugin can call, recording (method, args) instead of
// touching a real repo. Returning a tagged envelope lets each row's plumbing be
// checked end to end.
function makeLeaves(calls) {
  const rec = (leaf, method) => (...args) => {
    calls.push({ leaf, method, args });
    return { ok: true, from: `${leaf}.${method}`, args };
  };
  return {
    gitScm: {
      status: rec('scm', 'status'), fileDiff: rec('scm', 'fileDiff'),
      stage: rec('scm', 'stage'), unstage: rec('scm', 'unstage'),
      discard: rec('scm', 'discard'), commit: rec('scm', 'commit'),
      branches: rec('scm', 'branches'), checkout: rec('scm', 'checkout'),
      remoteOp: rec('scm', 'remoteOp'),
    },
    fsExplorer: {
      listDir: rec('fs', 'listDir'), readFile: rec('fs', 'readFile'),
      writeFile: rec('fs', 'writeFile'),
    },
    gitWorktree: {
      listWorktrees: rec('wt', 'listWorktrees'),
      removeWorktree: rec('wt', 'removeWorktree'),
      createWorktree: rec('wt', 'createWorktree'),
    },
  };
}

const local = { name: 'seat', type: 'claude', cwd: '/repo/seat', workspaceId: 'ws-1' };
const peered = { name: 'far', type: 'claude', peer: 'box', cwd: '/remote', workspaceId: 'ws-1' };
const nocwd = { name: 'bare', type: 'bash', cwd: null, workspaceId: 'ws-1' };

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-workbench-test-'));
  const calls = [];
  const leaves = makeLeaves(calls);
  const map = new Map([[local.name, local], [peered.name, peered], [nocwd.name, nocwd]]);
  const engine = createPluginHostEngine({
    manager: {
      sessions: map,
      list: () => [...map.values()],
      listForWorkspace(wsId) { return this.list().filter((s) => s.workspaceId === wsId); },
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {} },
    userDataPath: dir,
    fs, path,
    ...leaves,
  });
  engine.register('workbench', workbenchEngine, { hostApi: '0' });
  return { engine, calls, dir };
}

// The fourteen rows that replace core's fourteen window.api rows, plus wt.create.
const NAME_SCOPED_ROWS = [
  ['fs.list', ['seat', 'sub']],
  ['fs.read', ['seat', 'a.txt']],
  ['fs.write', ['seat', 'a.txt', 'body']],
  ['scm.status', ['seat']],
  ['scm.diff', ['seat', 'a.txt', {}]],
  ['scm.stage', ['seat', ['a.txt']]],
  ['scm.unstage', ['seat', ['a.txt']]],
  ['scm.discard', ['seat', 'a.txt', {}]],
  ['scm.commit', ['seat', 'msg', {}]],
  ['scm.branches', ['seat']],
  ['scm.checkout', ['seat', 'main', {}]],
  ['scm.remote', ['seat', 'fetch']],
  ['wt.list', ['seat']],
];

test('the plugin registers exactly the migrated row set, namespaced by plugin id', () => {
  const { engine, dir } = boot();
  assert.deepEqual(engine._dispatchKeys().sort(), [
    'workbench:fs.list', 'workbench:fs.read', 'workbench:fs.write',
    'workbench:scm.branches', 'workbench:scm.checkout', 'workbench:scm.commit',
    'workbench:scm.diff', 'workbench:scm.discard', 'workbench:scm.remote',
    'workbench:scm.stage', 'workbench:scm.status', 'workbench:scm.unstage',
    'workbench:wt.create', 'workbench:wt.list', 'workbench:wt.remove',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every session-scoped row resolves the cwd through the host and delegates', async () => {
  const { engine, calls, dir } = boot();
  for (const [method, args] of NAME_SCOPED_ROWS) {
    calls.length = 0;
    const res = await engine.dispatch('workbench', method, args);
    assert.equal(res.ok, true, `${method} should succeed for a local session`);
    assert.equal(calls.length, 1, `${method} should delegate exactly once`);
    assert.equal(calls[0].args[0], '/repo/seat',
      `${method} must pass the HOST-resolved cwd, never the session name`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MUST-FIX 5: EVERY session-scoped row refuses a peer session with "remote"', async () => {
  const { engine, calls, dir } = boot();
  for (const [method, args] of NAME_SCOPED_ROWS) {
    calls.length = 0;
    const res = await engine.dispatch('workbench', method, ['far', ...args.slice(1)]);
    assert.deepEqual(res, { ok: false, error: 'remote' },
      `${method} must refuse a peer session with the exact string the renderer renders`);
    assert.deepEqual(calls, [], `${method} must not touch the filesystem for a peer session`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the other two fsScope refusals reach the caller unchanged', async () => {
  const { engine, calls, dir } = boot();
  assert.deepEqual(await engine.dispatch('workbench', 'fs.list', ['nobody', '']),
    { ok: false, error: 'Session not found' });
  assert.deepEqual(await engine.dispatch('workbench', 'scm.status', ['bare']),
    { ok: false, error: 'Session has no working directory' });
  assert.deepEqual(calls, [], 'a refused scope never reaches a leaf');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scm.remote keeps the op allowlist on the ENGINE side', async () => {
  const { engine, calls, dir } = boot();
  for (const op of ['push', 'pull', 'fetch']) {
    assert.equal((await engine.dispatch('workbench', 'scm.remote', ['seat', op])).ok, true);
  }
  calls.length = 0;
  assert.deepEqual(await engine.dispatch('workbench', 'scm.remote', ['seat', 'reset --hard']),
    { ok: false, error: 'Bad op' });
  assert.deepEqual(calls, [], 'a refused op never reaches git');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wt.remove takes a PATH and is deliberately unscoped, like core\'s row', async () => {
  const { engine, calls, dir } = boot();
  const res = await engine.dispatch('workbench', 'wt.remove', ['/tmp/some-worktree']);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ leaf: 'wt', method: 'removeWorktree', args: ['/tmp/some-worktree'] }],
    'the path is passed straight through — core\'s worktree:remove has no sessionCwd guard either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wt.create reaches core\'s permanent gitWorktree leaf, opts defaulted to null', async () => {
  const { engine, calls, dir } = boot();
  await engine.dispatch('workbench', 'wt.create', ['/repo', 'feature', { base: 'main' }]);
  await engine.dispatch('workbench', 'wt.create', ['/repo', 'feature']);
  assert.deepEqual(calls.map((c) => c.args), [
    ['/repo', 'feature', { base: 'main' }],
    ['/repo', 'feature', null],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deactivating the plugin removes every row from the dispatch map', () => {
  const { engine, dir } = boot();
  engine.deactivate('workbench');
  assert.deepEqual(engine._dispatchKeys(), [],
    'host-driven teardown, not the plugin\'s own deactivate()');
  fs.rmSync(dir, { recursive: true, force: true });
});
