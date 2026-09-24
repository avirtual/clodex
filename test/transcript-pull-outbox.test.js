'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');

test('transcript:pull on a stream seat with no transcript yet still carries its queued outbox rows', (t) => {
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'tpull-'));
  t.after(() => fs.rmSync(reg, { recursive: true, force: true }));
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
