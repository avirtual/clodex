'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

test('transcript:pull on a stream seat with no transcript yet still carries its queued outbox rows', () => {
  const reg = mkTmpRoot('ipc-tpull-');
  const handlers = new Map();
  const seat = { name: 'fresh', agentType: 'claude', io: 'stream', _dead: false };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {}, debug() {} },
    REGISTRY_DIR: reg,
    manager: {
      sessions: new Map([['fresh', seat]]),
      seatOutbox: (n) => (n === 'fresh' ? { rev: 3, items: [{ text: 'queued', origin: 'operator', images: 0 }] } : null),
      seatPermissions: () => null,
      compactNoticesFor: () => null,
      _sendToSession() {},
    },
  });
  const pull = handlers.get('transcript:pull');
  assert.strictEqual(typeof pull, 'function', 'ENTER: transcript:pull registered');
  const res = pull(null, 'fresh');
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.records, []);
  assert.deepStrictEqual(res.outbox, [{ text: 'queued', origin: 'operator', images: 0 }]);
  assert.strictEqual(res.rev, '-:o3');
});

function pullFixture(perms) {
  const handlers = new Map();
  const seat = { name: 'st', agentType: 'claude', io: 'stream', _dead: false, workspaceId: 'ws-1' };
  const calls = [];
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {}, debug() {} },
    REGISTRY_DIR: mkTmpRoot('ipc-tpull-'),
    surfaceOfSender: (e) => e.surface,
    workspaceOfSender: (e) => e.ws,
    manager: {
      sessions: new Map([['st', seat]]),
      seatOutbox: () => ({ rev: 3, items: [] }),
      seatPermissions: () => perms,
      seatPermission: (...a) => { calls.push(a); return { ok: true }; },
      compactNoticesFor: () => null,
      _sendToSession() {},
    },
  });
  return { handlers, calls };
}

test('transcript:pull carries pending stream permissions and folds their rev into the pull rev', () => {
  const item = { id: 'r1', toolName: 'Bash', displayName: 'Run', description: null, preview: 'ls', input: null, choices: [], ts: 1 };
  const f = pullFixture({ rev: 7, items: [item] });
  const res = f.handlers.get('transcript:pull')(null, 'st');
  assert.strictEqual(res.rev, '-:o3:p7');
  assert.deepStrictEqual(res.permissions, [item]);
  const none = pullFixture(null).handlers.get('transcript:pull')(null, 'st');
  assert.strictEqual(none.rev, '-:o3');
  assert.strictEqual('permissions' in none, false);
});

test('seat:permission refuses a non-desktop surface and a foreign workspace, and passes ids through as strings', () => {
  const f = pullFixture(null);
  const answer = f.handlers.get('seat:permission');
  assert.deepStrictEqual(answer({ surface: 'web', ws: 'ws-1' }, 'st', 'r1', 'y'), { ok: false, error: 'seat:permission is local only' });
  assert.deepStrictEqual(answer({ surface: 'desktop', ws: 'ws-2' }, 'st', 'r1', 'y'), { ok: false, error: 'no such session in this workspace' });
  assert.deepStrictEqual(f.calls, []);
  assert.deepStrictEqual(answer({ surface: 'desktop', ws: 'ws-1' }, 'st', 5, 'y'), { ok: true });
  assert.deepStrictEqual(f.calls, [['st', '5', 'y']]);
});

function seatPull(seat) {
  const handlers = new Map();
  const item = { id: 'r1', toolName: 'commandExecution', displayName: 'Shell command', description: null, preview: 'ls', input: null, choices: [], ts: 1 };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {}, debug() {} },
    REGISTRY_DIR: mkTmpRoot('ipc-tpull-'),
    manager: {
      sessions: new Map([[seat.name, seat]]),
      seatOutbox: () => ({ rev: 2, items: [{ text: 'q', origin: 'operator', images: 0 }] }),
      seatPermissions: () => ({ rev: 4, items: [item] }),
      compactNoticesFor: () => null,
      _sendToSession() {},
    },
  });
  return { res: handlers.get('transcript:pull')(null, seat.name), item };
}

test('transcript:pull on a codex stream seat carries its outbox and permission cards with no records', () => {
  const { res, item } = seatPull({ name: 'cx', agentType: 'codex', io: 'stream', _dead: false });
  assert.deepStrictEqual(res, {
    ok: false, reason: 'not-claude', rev: '-:o2:p4', records: [],
    outbox: [{ text: 'q', origin: 'operator', images: 0 }], permissions: [item],
  });
});

test('transcript:pull on a codex pty seat is the bare not-claude result', () => {
  const { res } = seatPull({ name: 'cp', agentType: 'codex', io: 'pty', _dead: false });
  assert.deepStrictEqual(res, { ok: false, reason: 'not-claude' });
});
