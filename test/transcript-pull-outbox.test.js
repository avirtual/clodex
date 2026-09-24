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
