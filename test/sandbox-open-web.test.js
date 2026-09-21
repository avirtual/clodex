'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

function fixture(boxes) {
  const opened = [];
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager: {},
    persistence: {},
    openExternal: (url) => opened.push(url),
    getSandbox: (id) => boxes[id] || null,
    log: { info() {}, error() {} },
  });
  return { opened, openWeb: (id) => handlers.get('sandbox:openWeb')(null, id) };
}

test('sandbox:openWeb opens the box console with its own web token, and the token never crosses IPC', async () => {
  const statusCalls = [];
  const boxes = {
    b1: {
      async status() { statusCalls.push('b1'); return { state: 'running', ports: { web: 7812, wirescope: 7813, wire: 7820 } }; },
      webToken: () => 'ab cd&ef',
    },
    legacy: {
      async status() { return { state: 'running', ports: { web: 7830 } }; },
      webToken: () => null,
    },
    stopped: {
      async status() { return { state: 'exited' }; },
      webToken: () => 'never-used',
    },
  };
  const { opened, openWeb } = fixture(boxes);

  const r = await openWeb('b1');
  assert.deepStrictEqual(r, { ok: true }, 'the reply carries no url and no token');
  assert.deepStrictEqual(opened, ['http://localhost:7812?token=ab%20cd%26ef']);
  assert.deepStrictEqual(statusCalls, ['b1'], 'the port comes from the box\'s live status, not the renderer');

  await openWeb('legacy');
  assert.strictEqual(opened[1], 'http://localhost:7830', 'a box minted before the web token existed opens plain');

  const off = await openWeb('stopped');
  assert.strictEqual(off.ok, false);
  assert.match(off.error, /not serving a web UI/);
  assert.strictEqual(opened.length, 2, 'nothing opened for a box with no web port');

  const missing = await openWeb('nope');
  assert.deepStrictEqual(missing, { ok: false, error: 'no such sandbox: nope' });
  assert.strictEqual(opened.length, 2);
});
