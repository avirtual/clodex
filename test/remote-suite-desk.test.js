'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { RemoteServer } = require('../remote');
const { createSuiteDesk } = require('../suite-desk');

const SUITE_TOKEN = 'suite-token-desk-4e1f';
const OP_TOKEN = 'operator-token-desk-9a2b';
const SESSION = 'claimer-session-01';

function req(port, pathname, { method = 'GET', token = OP_TOKEN, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (body != null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, type: res.headers['content-type'], raw, json });
      });
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

function fakeClock() {
  let t = 5000;
  const armed = new Set();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + ms, fn }; armed.add(h); return h; },
      clearTimeout(h) { armed.delete(h); },
    },
    advance(ms) {
      t += ms;
      for (const h of [...armed]) if (h.at <= t) { armed.delete(h); h.fn(); }
    },
  };
}

async function startServer(t, extra = {}) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'lead-box', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteToken: SUITE_TOKEN, ...extra,
  });
  await server.start();
  t.after(() => server.stop());
  return { server, port: server.port };
}

async function withDesk(t) {
  const clock = fakeClock();
  let server = null;
  const desk = createSuiteDesk({ now: clock.now, timers: clock.timers, notify: (o) => server && server.notifySuiteMail(o) });
  const started = await startServer(t, { suiteDesk: desk });
  server = started.server;
  return { ...started, desk, clock };
}

const claim = (port, extra = {}) => req(port, '/api/suite-desk/claim', { method: 'POST', body: JSON.stringify({ v: 1, origin: 'laptop', session: SESSION, ...extra }) });
const reply = (port, id, msg) => req(port, `/api/suite-desk/calls/${id}/reply`, { method: 'POST', body: JSON.stringify({ v: 1, ...msg }) });

test('hello carries suite-pull only when a desk is wired', async (t) => {
  const without = await startServer(t);
  const a = await req(without.port, '/api/peer/hello');
  assert.ok(a.json.caps.includes('send'), 'ENTER: a non-scoped hello');
  assert.strictEqual(a.json.caps.includes('suite-pull'), false);
  const { port } = await withDesk(t);
  const b = await req(port, '/api/peer/hello');
  assert.ok(b.json.caps.includes('suite-pull'));
  const scoped = await req(port, '/api/peer/hello', { token: SUITE_TOKEN });
  assert.deepStrictEqual(scoped.json.caps, []);
});

test('a suite-scoped token is 403 on all three desk routes', async (t) => {
  const { port } = await withDesk(t);
  const enter = await req(port, '/api/suite/info', { token: SUITE_TOKEN });
  assert.strictEqual(enter.status, 501, 'ENTER: the scoped token passes on /api/suite/');
  const id = '0123456789abcdef';
  for (const [p, method, body] of [
    ['/api/suite-desk/claim', 'POST', JSON.stringify({ v: 1, origin: 'laptop', session: SESSION })],
    [`/api/suite-desk/calls/${id}/blob?claim=x`, 'GET', null],
    [`/api/suite-desk/calls/${id}/reply`, 'POST', JSON.stringify({ v: 1, claim: 'x', status: 200, body: {} })],
  ]) {
    const r = await req(port, p, { method, token: SUITE_TOKEN, body });
    assert.deepStrictEqual([p, r.status, r.json], [p, 403, { ok: false, error: 'this token is scoped to suite jobs' }]);
  }
});

test('without a desk the routes answer 501', async (t) => {
  const { port } = await startServer(t);
  const r = await claim(port);
  assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: 'suite desk not available' }]);
});

test('claim, blob, reply over HTTP: blob bytes equal the queued buffer and the caller gets the literal answer', async (t) => {
  const { port, desk, server } = await withDesk(t);
  const rung = [];
  const broadcast = server._broadcast.bind(server);
  server._broadcast = (ev, data) => { rung.push([ev, data]); return broadcast(ev, data); };
  const first = await claim(port);
  assert.deepStrictEqual([first.status, first.json], [200, { ok: true, v: 1, calls: [] }]);
  const buf = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
  const p = desk.conn('laptop').suitePut('/api/suite/jobs/job1/pack', buf, { 'content-range': 'bytes 0-7/*' }, 30000);
  assert.deepStrictEqual(rung, [['suite-mail', { origin: 'laptop' }]]);
  const got = await claim(port);
  assert.strictEqual(got.json.calls.length, 1);
  const [call] = got.json.calls;
  assert.deepStrictEqual({ ...call, id: null, claim: null }, {
    id: null, claim: null, ttlMs: 30000, method: 'PUT', path: '/api/suite/jobs/job1/pack',
    headers: { 'content-range': 'bytes 0-7/*' }, body: null, blob: { bytes: 8 },
  });
  const blob = await req(port, `/api/suite-desk/calls/${call.id}/blob?claim=${call.claim}`);
  assert.strictEqual(blob.status, 200);
  assert.strictEqual(blob.type, 'application/octet-stream');
  assert.ok(blob.raw.equals(buf));
  const r = await reply(port, call.id, { claim: call.claim, status: 200, body: { ok: true, size: 8 } });
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepStrictEqual(await p, { status: 200, body: { ok: true, size: 8 }, error: null });
  assert.deepStrictEqual(desk.retained('laptop'), { unsettled: 0, bytes: 0 });
});

test('route refusals: wrong token 409, unknown 404, late 410, bad id, version, origin and session 400, competing session 409', async (t) => {
  const { port, desk, clock } = await withDesk(t);
  await claim(port);
  const p = desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 1000);
  const [call] = (await claim(port)).json.calls;
  const wrong = 'e'.repeat(32);
  const rows = [
    ['blob wrong token', await req(port, `/api/suite-desk/calls/${call.id}/blob?claim=${wrong}`), 409],
    ['reply wrong token', await reply(port, call.id, { claim: wrong, status: 200, body: {} }), 409],
    ['unknown call', await reply(port, 'abcdefabcdef0123', { claim: call.claim, status: 200, body: {} }), 404],
    ['bad call id', await req(port, '/api/suite-desk/calls/NOT-AN-ID/blob?claim=x'), 400],
    ['bad version', await claim(port, { v: 2 }), 400],
    ['bad origin', await claim(port, { origin: '../x' }), 400],
    ['bad session', await claim(port, { session: 'x' }), 400],
    ['competing session', await claim(port, { session: 'another-session-02' }), 409],
    ['reply bad version', await req(port, `/api/suite-desk/calls/${call.id}/reply`, { method: 'POST', body: JSON.stringify({ v: 0, claim: call.claim, status: 200, body: {} }) }), 400],
  ];
  assert.deepStrictEqual(rows.map(([n, r]) => [n, r.status]), rows.map(([n, , s]) => [n, s]));
  clock.advance(20000);
  assert.strictEqual((await p).status, 0);
  const late = await reply(port, call.id, { claim: call.claim, status: 200, body: { ok: true } });
  assert.deepStrictEqual([late.status, late.json], [410, { ok: false, error: 'call expired' }]);
});

test('a malformed reply is 400 at the route and 502 to the caller', async (t) => {
  const { port, desk } = await withDesk(t);
  await claim(port);
  const p = desk.conn('laptop').suiteAsk('GET', '/api/suite/info', null, 30000);
  const [call] = (await claim(port)).json.calls;
  const r = await reply(port, call.id, { claim: call.claim, status: 'two hundred', body: {} });
  assert.deepStrictEqual([r.status, r.json], [400, { ok: false, error: 'bad reply' }]);
  assert.deepStrictEqual(await p, { status: 502, body: null, error: 'runner sent a malformed reply' });
});

test('a claim token with other bytes is 409 on reply and blob, and the server keeps answering', async (t) => {
  const { port, desk } = await withDesk(t);
  await claim(port);
  const p = desk.conn('laptop').suitePut('/api/suite/jobs/j/pack', Buffer.from('xyz'), {}, 30000);
  const [call] = (await claim(port)).json.calls;
  const forged = 'é' + '0'.repeat(31);
  const r = await reply(port, call.id, { claim: forged, status: 200, body: { ok: true } });
  assert.deepStrictEqual([r.status, r.json], [409, { ok: false, error: 'wrong claim token' }]);
  const b = await req(port, `/api/suite-desk/calls/${call.id}/blob?claim=${encodeURIComponent(forged)}`);
  assert.deepStrictEqual([b.status, b.json], [409, { ok: false, error: 'wrong claim token' }]);
  const ok = await reply(port, call.id, { claim: call.claim, status: 200, body: { ok: true, size: 3 } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await p, { status: 200, body: { ok: true, size: 3 }, error: null });
});
