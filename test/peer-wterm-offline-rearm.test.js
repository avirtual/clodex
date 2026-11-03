'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PeerConnection } = require('../peer-client');
const { peerShellRefusal } = require('../peer-shell');

function harness() {
  const emitted = [];
  const opens = [];
  const conn = new PeerConnection({
    id: 'p1', label: 'box', url: 'http://127.0.0.1:1',
    emit: (...args) => emitted.push(args),
    helloIntervalMs: 1e9,
  });
  let helloUp = true;
  conn._request = (method, path, body, cb) => {
    if (path === '/api/peer/hello' && helloUp) {
      return cb(null, { ok: true, app: 'clodex', host: 'h', version: '1', caps: ['shell'] });
    }
    return cb(new Error('down'));
  };
  conn._refreshSessions = () => {};
  conn._openEvents = () => {};
  conn._probeDialect = () => {};
  conn._claimInboxIfBox = () => {};
  conn._sse = (path, handlers) => { opens.push({ path, handlers }); };
  const hello = (up) => { helloUp = up; clearTimeout(conn._helloTimer); conn._helloLoop(); };
  return { conn, emitted, opens, hello };
}

function restartCycle(reason) {
  const h = harness();
  const { conn, emitted, opens, hello } = h;
  hello(true);
  assert.strictEqual(conn.online, true, 'ENTER: the box is online before the open');
  conn.wtermOpen('bob', 'w1', () => {});
  assert.strictEqual(opens.length, 1, 'ENTER: the first open went out');
  const first = opens[0].handlers;
  first.onOpen({ destroy() {} });
  first.onEvent('closed', { reason });
  hello(false);
  assert.strictEqual(conn.online, false, 'ENTER: the box went offline');
  first.onClose();
  hello(true);
  return h;
}

test("a wterm closed with reason 'offline' stays wanted and re-opens on the next hello", () => {
  const { conn, emitted, opens } = restartCycle('offline');
  try {
    const closed = emitted.filter((e) => e[0] === 'peer-wterm-closed');
    assert.deepStrictEqual(closed, [
      ['peer-wterm-closed', 'p1', 'bob', peerShellRefusal('offline', 'box'), { reason: 'offline' }],
    ]);
    assert.strictEqual(opens.length, 2, 'the hello after the box came back re-opened the stream');
    assert.strictEqual(opens[1].path, '/api/wterm/bob');
    const second = opens[1].handlers;
    second.onOpen({ destroy() {} });
    second.onEvent('replay', { b64: Buffer.from('hi').toString('base64'), cols: 80, rows: 24 });
    const replay = emitted.filter((e) => e[0] === 'peer-wterm-replay');
    assert.deepStrictEqual(replay, [
      ['peer-wterm-replay', 'p1', 'bob', { data: Buffer.from('hi'), cols: 80, rows: 24 }],
    ]);
    assert.strictEqual(conn._wterms.get('bob').wanted, true);
  } finally {
    conn.stop();
  }
});

test("a wterm closed with reason 'revoked' is dropped and not re-opened", () => {
  const { conn, emitted, opens } = restartCycle('revoked');
  try {
    const closed = emitted.filter((e) => e[0] === 'peer-wterm-closed');
    assert.deepStrictEqual(closed, [
      ['peer-wterm-closed', 'p1', 'bob', peerShellRefusal('revoked', 'box'), { reason: 'revoked' }],
    ]);
    assert.strictEqual(opens.length, 1, 'no re-open after a revocation');
    assert.strictEqual(conn._wterms.has('bob'), false, 'the entry was dropped');
  } finally {
    conn.stop();
  }
});
