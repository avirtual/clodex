'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

function fixture(surface) {
  const calls = [];
  const handlers = new Map();
  const box = {
    bootstrapLog: () => { calls.push(['bootstrapLog']); return { text: 'apt-get ok\n', truncated: false }; },
    up: (opts) => { calls.push(['up', opts]); return { ok: true }; },
  };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager: {},
    persistence: {},
    getSandbox: (id) => (id === 'b1' ? box : null),
    ...(surface ? { surfaceOfSender: () => surface } : {}),
    log: { info() {}, error() {} },
  });
  return { calls, call: (ch, ...args) => handlers.get(ch)(null, ...args) };
}

test('sandbox:bootstrapLog answers the desktop and refuses the web and an unknown surface', () => {
  const desk = fixture('desktop');
  assert.deepStrictEqual(desk.call('sandbox:bootstrapLog', 'b1'), { text: 'apt-get ok\n', truncated: false });
  for (const surface of ['web', null]) {
    const f = fixture(surface);
    assert.deepStrictEqual(f.call('sandbox:bootstrapLog', 'b1'), { ok: false, error: 'the setup log is readable from the desktop app only' });
    assert.deepStrictEqual(f.calls, []);
  }
});

test('sandbox:up passes noHooks through only when the panel asks for it', () => {
  const f = fixture('desktop');
  f.call('sandbox:up', 'b1');
  f.call('sandbox:up', 'b1', { noHooks: true });
  f.call('sandbox:up', 'b1', { noHooks: 'yes' });
  assert.deepStrictEqual(f.calls, [['up', { noHooks: false }], ['up', { noHooks: true }], ['up', { noHooks: false }]]);
});
