'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

async function withServer(opts, fn) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...opts,
  });
  await server.start();
  try { return await fn(server); } finally {
    for (const r of inflight) r.destroy();
    inflight.clear();
    server.stop();
  }
}

const inflight = new Set();

function request(server, method, p, raw) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: server.port, path: p, method,
      headers: raw == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    inflight.add(r);
    r.on('close', () => inflight.delete(r));
    r.on('error', reject);
    r.end(raw == null ? undefined : raw);
  });
}

function trapUncaught() {
  let onErr;
  const tripped = new Promise((_, reject) => { onErr = (e) => reject(new Error(`uncaught: ${e && e.message}`)); });
  process.on('uncaughtException', onErr);
  return { tripped, release: () => process.removeListener('uncaughtException', onErr) };
}

function fakeReq() { return new EventEmitter(); }
function fakeRes() {
  return {
    writes: [], ended: false, writableEnded: false,
    writeHead() { return this; }, setHeader() {}, flushHeaders() {},
    write(s) { this.writes.push(String(s)); return true; },
    end() { this.ended = true; this.writableEnded = true; },
    on() {}, once() {},
  };
}

test('a JSON null body is a 400 on every body route, never an uncaught throw', async () => {
  const ok = () => ({ ok: true });
  await withServer({
    deliverDm: ok, claimDms: () => [], receiveRoster: ok,
    sendInput: ok, resizePty: ok, getAttachInfo: () => ({ ok: true }),
    wtermOpen: ok, wtermInput: ok, wtermResize: ok,
  }, async (server) => {
    server._wterm.set('seat', new Set([{}]));
    const rows = [
      '/api/dm', '/api/dm/claim', '/api/peer/roster',
      '/api/sessions/alpha/control', '/api/sessions/alpha/input', '/api/sessions/alpha/resize',
      '/api/wterm-input/seat', '/api/wterm-resize/seat',
    ];
    const trap = trapUncaught();
    try {
      for (const p of rows) {
        const r = await Promise.race([request(server, 'POST', p, 'null'), trap.tripped]);
        assert.equal(r.status, 400, p);
      }
      const after = await request(server, 'GET', '/api/sessions');
      assert.equal(after.status, 200);
    } finally { trap.release(); }
  });
});

test('a malformed percent-escape in a route segment is a 400 and the server keeps answering', async () => {
  await withServer({
    wtermOpen: () => ({ ok: true }), listPeers: () => [], getPeer: () => null,
    notifications: { list: () => [], markRead: () => false, remove: () => false },
  }, async (server) => {
    for (const p of ['/api/wterm/%E0%A4%A', '/api/peers/%E0%A4%A']) {
      const r = await request(server, 'GET', p);
      assert.equal(r.status, 400, p);
    }
    const r = await request(server, 'POST', '/api/inbox/read/%zz');
    assert.equal(r.status, 400);
    const after = await request(server, 'GET', '/api/sessions');
    assert.equal(after.status, 200);
  });
});

test('a body whose UTF-8 sequence straddles a chunk boundary is delivered intact', () => {
  const server = new RemoteServer({ port: 0, pagePath: PAGE, getSessions: () => [], getTranscript: () => ({ ok: true }), send: () => ({ ok: true }) });
  const buf = Buffer.from(JSON.stringify({ body: 'café' }));
  const k = buf.indexOf(0xc3) + 1;
  const req = fakeReq();
  let got = null;
  server._readBody(req, fakeRes(), (body) => { got = body; });
  req.emit('data', buf.subarray(0, k));
  req.emit('data', buf.subarray(k));
  req.emit('end');
  assert.equal(JSON.parse(got).body, 'café');
});

test('the body cap counts bytes, not UTF-16 units', () => {
  const server = new RemoteServer({ port: 0, pagePath: PAGE, getSessions: () => [], getTranscript: () => ({ ok: true }), send: () => ({ ok: true }) });
  const req = fakeReq();
  req.destroy = () => {};
  const res = fakeRes();
  let status = null;
  server._json = (_res, code) => { status = code; };
  let called = false;
  server._readBody(req, res, () => { called = true; }, 10);
  req.emit('data', Buffer.from('éééééé'));
  req.emit('end');
  assert.equal(status, 413);
  assert.equal(called, false);
});

test('stopping the server releases every control holder through onControlChange', async () => {
  const changes = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true }), send: () => ({ ok: true }),
    onControlChange: (name, holder) => changes.push([name, holder]),
  });
  await server.start();
  server._setControl('alpha', { token: 't', client: 'peer' });
  server.stop();
  assert.deepStrictEqual(changes[changes.length - 1], ['alpha', null]);
});

test('a stale attach feed closing after re-attach leaves the new feed registered', () => {
  const server = new RemoteServer({
    port: 0, pagePath: PAGE, getSessions: () => [], getTranscript: () => ({ ok: true }), send: () => ({ ok: true }),
    getAttachInfo: () => ({ ok: true, cols: 80, rows: 24 }),
  });
  const reqA = fakeReq(), resA = fakeRes();
  server._handleAttach('alpha', reqA, resA);
  server.notifyExit('alpha', 0);
  const reqB = fakeReq(), resB = fakeRes();
  server._handleAttach('alpha', reqB, resB);
  server._setControl('alpha', { token: 'tb', client: 'peer' });
  reqA.emit('close');
  assert.equal(server._attach.get('alpha').has(resB), true);
  assert.equal(server._controlToken('alpha'), 'tb');
});

test('a resize back to the pre-detach geometry reaches a viewer that re-attached in between', () => {
  const server = new RemoteServer({
    port: 0, pagePath: PAGE, getSessions: () => [], getTranscript: () => ({ ok: true }), send: () => ({ ok: true }),
    getAttachInfo: () => ({ ok: true, cols: 120, rows: 40 }),
  });
  const reqC = fakeReq(), resC = fakeRes();
  server._handleAttach('n', reqC, resC);
  server.notifyResize('n', 100, 30);
  clearTimeout(server._resizePending.get('n').timer);
  server._flushResize('n');
  assert.ok(resC.writes.some((w) => w.includes('event: resize')));
  reqC.emit('close');
  const reqD = fakeReq(), resD = fakeRes();
  server._handleAttach('n', reqD, resD);
  server.notifyResize('n', 100, 30);
  clearTimeout(server._resizePending.get('n').timer);
  server._flushResize('n');
  assert.ok(resD.writes.some((w) => w.includes('event: resize') && w.includes('{"cols":100,"rows":30}')));
});

test('a negative transcript limit is clamped to at least 1', async () => {
  let seen = null;
  await withServer({
    getTranscript: (n, limit) => { seen = limit; return { ok: true, messages: [] }; },
  }, async (server) => {
    const r = await request(server, 'GET', '/api/sessions/x/transcript?limit=-5');
    assert.equal(r.status, 200);
    assert.equal(seen, 1);
  });
});
