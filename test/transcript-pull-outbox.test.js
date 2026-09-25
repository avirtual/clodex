'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { pathFor } = require('../clodex-paths');
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
      seatInterrupt: (...a) => { calls.push(['interrupt', ...a]); return { ok: true }; },
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

test('seat:interrupt refuses a non-desktop surface and a foreign workspace, else answers with seatInterrupt', () => {
  const f = pullFixture(null);
  const interrupt = f.handlers.get('seat:interrupt');
  assert.deepStrictEqual(interrupt({ surface: 'web', ws: 'ws-1' }, 'st'), { ok: false, error: 'seat:interrupt is local only' });
  assert.deepStrictEqual(interrupt({ surface: 'desktop', ws: 'ws-2' }, 'st'), { ok: false, error: 'no such session in this workspace' });
  assert.deepStrictEqual(interrupt({ surface: 'desktop', ws: 'ws-1' }, 'ghost'), { ok: false, error: 'no such session in this workspace' });
  assert.deepStrictEqual(f.calls, []);
  assert.deepStrictEqual(interrupt({ surface: 'desktop', ws: 'ws-1' }, 'st'), { ok: true });
  assert.deepStrictEqual(f.calls, [['interrupt', 'st']]);
});

function seatPull(seat, transcriptText = null) {
  const handlers = new Map();
  const reg = mkTmpRoot('ipc-tpull-');
  if (transcriptText != null) {
    const link = pathFor(reg, seat.name, 'transcript');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(link, transcriptText);
  }
  const item = { id: 'r1', toolName: 'commandExecution', displayName: 'Shell command', description: null, preview: 'ls', input: null, choices: [], ts: 1 };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {}, debug() {} },
    REGISTRY_DIR: reg,
    manager: {
      sessions: new Map([[seat.name, seat]]),
      seatOutbox: () => ({ rev: 2, items: [{ text: 'q', origin: 'operator', images: 0 }] }),
      seatPermissions: () => ({ rev: 4, items: [item] }),
      compactNoticesFor: () => null,
      _sendToSession() {},
    },
  });
  const res = handlers.get('transcript:pull')(null, seat.name);
  const live = seat._dead;
  seat._dead = true;
  handlers.get('transcript:pull')(null, seat.name);
  seat._dead = live;
  return { res, item };
}

test('transcript:pull on a codex stream seat with no transcript link carries its outbox and permission cards with no records', () => {
  const { res, item } = seatPull({ name: 'cx', agentType: 'codex', io: 'stream', _dead: false });
  assert.deepStrictEqual(res, {
    ok: false, reason: 'unavailable', rev: '-:o2:p4', records: [],
    outbox: [{ text: 'q', origin: 'operator', images: 0 }], permissions: [item],
  });
});

test('transcript:pull on a codex pty seat with no transcript link carries its outbox and permission cards with no records', () => {
  const { res, item } = seatPull({ name: 'cp', agentType: 'codex', io: 'pty', _dead: false });
  assert.deepStrictEqual(res, {
    ok: false, reason: 'unavailable', rev: '-:o2:p4', records: [],
    outbox: [{ text: 'q', origin: 'operator', images: 0 }], permissions: [item],
  });
});

const MUSE_TURN = ['muse-intent', 'muse-reply']
  .map((f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript-records', `${f}.jsonl`), 'utf8')).join('');

test('transcript:pull on a muse stream seat with a readable transcript serves its records beside the outbox', () => {
  const { res } = seatPull({ name: 'muse', agentType: 'muse', io: 'stream', _dead: false }, MUSE_TURN);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rev, '1:o2:p4');
  assert.deepStrictEqual(res.records.map((r) => [r.kind, r.text]), [['prompt', 'what model are you?'], ['assistant', "I'm Muse Code powered by Meta Muse Spark."]]);
});

test('transcript:pull on a muse pty seat with a readable transcript serves its records beside the outbox', () => {
  const { res } = seatPull({ name: 'mp', agentType: 'muse', io: 'pty', _dead: false }, MUSE_TURN);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rev, '1:o2:p4');
  assert.deepStrictEqual(res.records.map((r) => [r.kind, r.text]), [['prompt', 'what model are you?'], ['assistant', "I'm Muse Code powered by Meta Muse Spark."]]);
});

test('transcript:pull on a seat that is not an agent type is the bare not-agent result', () => {
  const { res } = seatPull({ name: 'sh', agentType: 'shell', io: 'pty', _dead: false });
  assert.deepStrictEqual(res, { ok: false, reason: 'not-agent' });
});
