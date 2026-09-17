'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');

const { createWebHost } = require('../web-host');

const silentLog = { info() {}, warn() {}, error() {} };

function mkHost(engine) {
  return createWebHost({
    engine: { stores: {}, ...engine },
    log: silentLog,
    port: 0,
    host: '127.0.0.1',
    userDataPath: os.tmpdir(),
    registerHandlers: () => {},
  });
}

test('app:restart refuses when the engine reports restart unavailable, and calls restartClodex when it does not', async () => {
  const refusedCalls = [];
  const refusing = mkHost({
    restartUnavailable: () => 'set CLODEX_SUPERVISED',
    restartClodex: () => { refusedCalls.push('restarted'); },
  });
  try {
    const handler = refusing._handlers.get('app:restart');
    assert.ok(handler, 'ENTER: web-host registers app:restart at all — otherwise both arms below are vacuous');
    const out = await handler();
    assert.deepStrictEqual(out, { ok: false, error: 'set CLODEX_SUPERVISED' },
      'the refusal carries the reason the renderer shows, not a bare ok:false');
    assert.deepStrictEqual(refusedCalls, [],
      'an unsupervised node must not be exited — restartClodex is process.exit(64) with nothing to relaunch it');
  } finally {
    refusing.close();
  }

  const allowedCalls = [];
  const allowing = mkHost({
    restartUnavailable: () => null,
    restartClodex: () => { allowedCalls.push('restarted'); },
  });
  try {
    const out = await allowing._handlers.get('app:restart')();
    assert.deepStrictEqual(out, { ok: true }, 'a supervised node answers ok');
    assert.deepStrictEqual(allowedCalls, ['restarted'],
      'and actually reaches the engine seam — the old handler answered ok:true while doing nothing');
  } finally {
    allowing.close();
  }
});

test('app:restart with no restartUnavailable seam still restarts', async () => {
  const calls = [];
  const host = mkHost({ restartClodex: () => { calls.push('restarted'); } });
  try {
    const out = await host._handlers.get('app:restart')();
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual(calls, ['restarted'], 'a seamless engine is not read as a refusal');
  } finally {
    host.close();
  }
});
