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
    teamNameFor: (cwd) => (cwd === '/w/a' ? 'shop' : null), // cwd-in-team resolves
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
    backend: 'claude-code', team: 'shop', createdAt: null, ctx: 5, proxy: { pct: 12 },
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
    teamNameFor: (cwd) => (cwd === '/w/b' ? 'shop' : null),
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
  assert.strictEqual(out[0].team, 'shop', 'a reattached row carries its team key');
  assert.ok(!('failed' in out[0]));
});

test('archived session is NOT spawned and comes back archived:true', async () => {
  const created = [];
  const manager = {
    sessions: new Map(),
    async create(name) { created.push(name); },
    pendingCountFor: () => 0,
    teamNameFor: (cwd) => (cwd === '/w/z' ? 'shop' : null),
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
  assert.strictEqual(out[0].team, 'shop', 'an archived row still carries its team key');
  assert.ok(!('replay' in out[0]), 'no PTY, no replay');
  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']], 'store untouched');
});

test('keeps a failed spawn in persistence and returns failed:true', async () => {
  const manager = {
    sessions: new Map(),
    async create() { throw new Error('boom: spawn refused'); },
    pendingCountFor: () => 0,
    teamNameFor: () => null, // teamless failed entry
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
    team: null, failed: true, error: 'boom: spawn refused',
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
    teamNameFor: () => null,
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

// t189 — wire-off is persisted config, and the sidebar needs it on EVERY row
// shape this loop emits, not just the freshly-spawned one. The four pushes are
// separate literals, so a per-push stamp drifts the first time one is touched;
// the flag is applied once after the loop, and this pins that it reaches all of
// them. The archived and failed rows matter as much as the live ones: a wire-off
// seat that fails to spawn must still render as wire-off in the retry row, or
// the operator retries it not knowing what they are restarting.
test('t189: noWire reaches every row shape — running, restored, archived and failed', async () => {
  const createArgs = new Map();
  const manager = {
    sessions: new Map([['run', { backend: null, pendingOutput: '' }]]),
    async create(name, ...rest) {
      createArgs.set(name, rest);
      if (name === 'bad') throw new Error('spawn refused');
      manager.sessions.set(name, { backend: null, noWire: true });
      return { name };
    },
    pendingCountFor: () => 0,
    teamNameFor: () => null,
  };
  const persistence = fakePersistence([
    { name: 'run', type: 'claude', cwd: '/w/r', noWire: true },
    { name: 'ok', type: 'claude', cwd: '/w/o', noWire: true },
    { name: 'arch', type: 'claude', cwd: '/w/a', noWire: true, archivedAt: 123 },
    { name: 'bad', type: 'claude', cwd: '/w/x', noWire: true },
    { name: 'wired', type: 'claude', cwd: '/w/w' },
  ]);

  const out = await restoreSessionsForWorkspace({
    workspaceId: 'ws1', persistence, manager, ...noopDeps,
  });

  // ENTER: all five rows survived, and each is the shape its name claims. Every
  // assertion below is a per-row lookup, so a loop that dropped one would leave
  // the flag check inspecting `undefined` and reporting a difference that is
  // really an absence.
  assert.deepStrictEqual(out.map((e) => e.name), ['run', 'ok', 'arch', 'bad', 'wired'],
    'ENTER: every row shape is present to be checked');
  assert.ok('replay' in out[0], 'ENTER: "run" is the already-running shape');
  assert.strictEqual(out[2].archived, true, 'ENTER: "arch" is the archived shape');
  assert.strictEqual(out[3].failed, true, 'ENTER: "bad" is the failed shape');

  assert.deepStrictEqual(out.map((e) => e.noWire), [true, true, true, true, undefined],
    'the flag rides all four wire-off shapes, and a wired seat carries no key at all');

  // The RETURN row is only the sidebar's copy. The respawn itself must carry the
  // flag as create()'s 21st positional, or the process comes back wired while the
  // row still claims otherwise — the failure that would look like a UI bug.
  // Indexed, not read off the tail: create() grew a 22nd positional (`plugins`)
  // and a tail read would then assert about the wrong argument entirely. The spy
  // captures `...rest`, so `name` is not in this array and every index is one
  // below create()'s own.
  const NOWIRE_IDX = 19;
  const okArgs = createArgs.get('ok');
  assert.ok(okArgs, 'ENTER: the restored seat was actually spawned, so there are arguments to inspect');
  assert.strictEqual(okArgs.length, 21, 'ENTER: every positional past name was passed, so the index below is the flag');
  assert.strictEqual(okArgs[NOWIRE_IDX], true,
    'the restore respawn passes noWire through to create()');
  const wiredArgs = createArgs.get('wired');
  assert.strictEqual(wiredArgs[NOWIRE_IDX], false,
    'control: an ordinary seat respawns with the flag explicitly off, not merely absent');

  assert.deepStrictEqual(persistence.calls, [['listForWorkspace', 'ws1']],
    'and the restore path still mutates nothing');
});
