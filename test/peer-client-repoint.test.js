'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const { PeerConnection } = require('../peer-client');

function fixture() {
  const conn = new PeerConnection({ id: 'box', label: 'box', url: 'http://127.0.0.1:9', emit: () => {} });
  const calls = [];
  const sse = [];
  conn._request = (method, p, body, cb) => { calls.push({ method, p, body, cb }); };
  conn._sse = (p, handlers) => { sse.push({ p, handlers }); };
  const hellos = () => calls.filter((c) => c.p === '/api/peer/hello');
  const attachOpens = () => sse.filter((s) => s.p === '/api/sessions/sess/attach');
  const helloOk = { ok: true, app: 'clodex', host: 'h', version: '1', caps: ['resources'] };
  return { conn, hellos, attachOpens, helloOk };
}

test('repoint keeps a wanted attachment without its stream and the next hello reopens it', () => {
  const { conn, hellos, attachOpens, helloOk } = fixture();
  try {
    conn.attach('sess');
    conn.start();
    hellos()[0].cb(null, helloOk);
    assert.equal(attachOpens().length, 1, 'ENTER: the first hello opened the attachment');
    let destroyed = false;
    attachOpens()[0].handlers.onOpen({ destroy() { destroyed = true; } });
    const att = conn._attachments.get('sess');
    assert.ok(att.req, 'ENTER: the attachment holds a live stream');

    conn.repoint('http://127.0.0.1:10');

    assert.strictEqual(conn._attachments.get('sess'), att);
    assert.equal(att.wanted, true);
    assert.equal(att.req, null);
    assert.equal(destroyed, true);
    assert.equal(conn.url, 'http://127.0.0.1:10');
    assert.equal(conn.online, false);
    assert.equal(hellos().length, 2, 'repoint kicked a fresh hello');

    hellos()[1].cb(null, helloOk);
    assert.equal(conn.online, true);
    assert.equal(attachOpens().length, 2, 'the hello after the repoint reopened the wanted attachment');
  } finally {
    conn.stop();
  }
});

test('a hello in flight across a repoint is ignored: no offline flip and no second hello loop', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const conn = new PeerConnection({ id: 'box', label: 'box', url: 'http://127.0.0.1:9', emit: () => {}, helloIntervalMs: 1000 });
  const calls = [];
  conn._request = (method, p, body, cb) => { calls.push({ method, p, body, cb }); };
  conn._sse = () => {};
  const hellos = () => calls.filter((c) => c.p === '/api/peer/hello');
  const helloOk = { ok: true, app: 'clodex', host: 'h', version: '1', caps: ['resources'] };
  try {
    conn.start();
    assert.equal(hellos().length, 1, 'ENTER: the first hello is in flight');
    conn.repoint('http://127.0.0.1:10');
    assert.equal(hellos().length, 2);
    hellos()[1].cb(null, helloOk);
    assert.equal(conn.online, true, 'ENTER: the re-pointed hello succeeded');
    hellos()[0].cb(new Error('socket hang up'));
    assert.equal(conn.online, true, 'the stale hello error did not flip the connection offline');

    mock.timers.tick(1000);
    assert.equal(hellos().length, 3, 'exactly one hello loop is armed');
  } finally {
    conn.stop();
    mock.timers.reset();
  }
});
