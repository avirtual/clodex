// Run: node --test
// Behavioral test for the restore-on-launch core (session-restore.js), the
// electron-free leaf lifted out of the app:restore-sessions IPC handler (Phase 2
// of the engine extraction). Drives it with fake manager/persistence so the three
// load-bearing behaviors are pinned without an Electron host:
//   * a MISSING session is spawned (manager.create) and returned with its badges;
//   * an ALREADY-RUNNING session is reported as-is (no re-spawn) with its buffered
//     replay flushed;
//   * a FAILING spawn is NOT removed from persistence and comes back `failed:true`
//     in the RETURN VALUE (what the retry/forget UI renders from) — the pre-v0.5.3
//     "upgrade kills my agents" regression guard.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { restoreSessionsForWorkspace } = require('../session-restore');

// A persistence fake that records every method touched, so a test can assert the
// failure path never mutates the store (only listForWorkspace is legitimate here).
function fakePersistence(entries) {
  const calls = [];
  return {
    calls,
    listForWorkspace(wsId) { calls.push(['listForWorkspace', wsId]); return entries; },
    // Any mutation the code should NOT perform on a restore — present so a stray
    // call is observable rather than a silent undefined-is-not-a-function.
    upsert(e) { calls.push(['upsert', e && e.name]); },
    remove(n) { calls.push(['remove', n]); },
    delete(n) { calls.push(['delete', n]); },
  };
}

const noopDeps = {
  proxyPoller: { snapshot: () => null },
  maybeCompactBeforeResume: async () => {},
  readCtxFor: () => ({ ctx: null, ctxTok: null, ctxSize: null, ctxCost: null, ctxModel: null }),
  log: { error: () => {} },
};

test('restores a missing session — spawns it and returns its row', async () => {
  const created = [];
  const manager = {
    sessions: new Map(),
    async create(name, type, cwd, ...rest) {
      created.push({ name, type, cwd, rest });
      manager.sessions.set(name, { backend: 'claude-code' });
    },
    pendingCountFor: () => 0,
  };
  const persistence = fakePersistence([
    { name: 'alpha', type: 'claude', cwd: '/w/a', label: 'A', sessionId: 'sid-1' },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager,
    proxyPoller: { snapshot: () => ({ pct: 12 }) },
    maybeCompactBeforeResume: async () => {},
    readCtxFor: () => ({ ctx: 5 }),
    log: { error: () => {} },
  });

  assert.strictEqual(created.length, 1, 'create called exactly once for the missing session');
  assert.strictEqual(created[0].name, 'alpha');
  assert.deepStrictEqual(out, [{
    name: 'alpha', type: 'claude', cwd: '/w/a', label: 'A',
    backend: 'claude-code', createdAt: null, ctx: 5, proxy: { pct: 12 },
  }]);
  // No persistence mutation on the happy path.
  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']]);
});

test('skips an already-running session — no re-spawn, flushes buffered replay', async () => {
  const running = { backend: 'codex', pendingOutput: 'buffered-while-detached',
    activityState: 'thinking', needsAttention: 'permission' };
  const created = [];
  const manager = {
    sessions: new Map([['beta', running]]),
    async create(name) { created.push(name); },
    pendingCountFor: () => 3,
  };
  const persistence = fakePersistence([
    { name: 'beta', type: 'codex', cwd: '/w/b', label: null },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager, ...noopDeps,
  });

  assert.strictEqual(created.length, 0, 'a running session is never re-created');
  assert.strictEqual(running.pendingOutput, '', 'buffered output is flushed on reattach');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].replay, 'buffered-while-detached');
  assert.strictEqual(out[0].activity, 'thinking', 'current activity seeds the sidebar dot');
  assert.strictEqual(out[0].attention, 'permission');
  assert.strictEqual(out[0].pendingCount, 3);
  assert.strictEqual(out[0].backend, 'codex');
  assert.ok(!('failed' in out[0]));
});

test('archived session is NOT spawned and comes back archived:true', async () => {
  const created = [];
  const manager = {
    sessions: new Map(),
    async create(name) { created.push(name); },
    pendingCountFor: () => 0,
  };
  const persistence = fakePersistence([
    { name: 'zed', type: 'claude', cwd: '/w/z', label: 'Z', archivedAt: 1234, createdAt: 1000 },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager, ...noopDeps,
  });

  assert.strictEqual(created.length, 0, 'an archived session is never spawned');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].archived, true);
  assert.strictEqual(out[0].archivedAt, 1234);
  assert.strictEqual(out[0].createdAt, 1000);
  assert.ok(!('replay' in out[0]), 'no PTY, no replay');
  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']], 'store untouched');
});

test('keeps a failed spawn in persistence and returns failed:true', async () => {
  const manager = {
    sessions: new Map(),
    async create() { throw new Error('boom: spawn refused'); },
    pendingCountFor: () => 0,
  };
  const persistence = fakePersistence([
    { name: 'gamma', type: 'claude', cwd: '/w/g', label: 'G', sessionId: 'sid-g' },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager, ...noopDeps,
  });

  // The RETURN VALUE marks it failed — this is what the retry/forget UI renders.
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], {
    name: 'gamma', type: 'claude', cwd: '/w/g', label: 'G',
    failed: true, error: 'boom: spawn refused',
  });
  // And the store was NEVER mutated — no upsert/remove/delete. Silently wiping a
  // failed entry was the "agents vanish after upgrade" bug (CLAUDE.md gotcha).
  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']]);
});

test('mixed batch — one running, one restored, one failed — order preserved', async () => {
  const running = { backend: 'claude-code', pendingOutput: null, activityState: 'idle' };
  const manager = {
    sessions: new Map([['run', running]]),
    async create(name) {
      if (name === 'bad') throw new Error('nope');
      manager.sessions.set(name, { backend: 'claude-code' });
    },
    pendingCountFor: () => 0,
  };
  const persistence = fakePersistence([
    { name: 'run', type: 'claude', cwd: '/w/r' },
    { name: 'ok', type: 'claude', cwd: '/w/o' },
    { name: 'bad', type: 'claude', cwd: '/w/x' },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager, ...noopDeps,
  });

  assert.deepStrictEqual(out.map((e) => e.name), ['run', 'ok', 'bad'], 'return order matches persistence order');
  assert.ok(!('failed' in out[0]) && 'replay' in out[0], 'first is the running one');
  assert.ok(!('failed' in out[1]), 'second restored cleanly');
  assert.strictEqual(out[2].failed, true, 'third is the failure');
  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']]);
});
