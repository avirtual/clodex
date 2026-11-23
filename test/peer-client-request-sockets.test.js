'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PeerConnection, PeerManager } = require('../peer-client');

const cleanups = [];
test.afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function serve(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 60000;
  const sockets = new Set();
  let connections = 0;
  server.on('connection', (s) => { connections += 1; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
  cleanups.push(close);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    connections: () => connections,
    open: () => sockets.size,
    close,
  };
}

function connect(url, extra = {}) {
  let t = 1000;
  const logs = [];
  const conn = new PeerConnection({
    id: 'p-lead', label: 'lead', url, token: 'tok-secret', emit: () => {}, selfLabel: 'laptop',
    helloIntervalMs: 600000, log: (m) => logs.push(m), clock: () => t, ...extra,
  });
  cleanups.push(async () => conn.stop());
  return { conn, logs, setTime: (v) => { t = v; } };
}

const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

function call(conn, method, path, payload = null, timeout) {
  return new Promise((resolve) => {
    let calls = 0;
    conn._request(method, path, payload, (err, body) => { calls += 1; resolve({ calls: () => calls, err, body }); }, timeout);
  });
}

test('claim, reply and blob each open their own connection', async () => {
  const srv = await serve((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('/blob')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from('abc')); return; }
      json(res, { ok: true, calls: [] });
    });
  });
  const { conn } = connect(srv.url);
  const a = await conn.suiteDeskClaim('sess-00000001');
  await ticks();
  const b = await conn.suiteDeskClaim('sess-00000001');
  assert.deepStrictEqual([a.status, b.status, srv.connections()], [200, 200, 2]);
  await ticks();
  const r1 = await conn.suiteDeskReply('c1', 'k1', { status: 200, body: {} });
  await ticks();
  const r2 = await conn.suiteDeskReply('c1', 'k1', { status: 200, body: {} });
  await ticks();
  assert.deepStrictEqual([r1.status, r2.status, srv.connections()], [200, 200, 4]);
  const blob1 = await conn.suiteDeskBlob('c1', 'k1');
  await ticks();
  const blob2 = await conn.suiteDeskBlob('c1', 'k1');
  assert.deepStrictEqual([blob1.status, String(blob2.bytes), srv.connections()], [200, 'abc', 6]);
});

test('a keep-alive route still reuses its socket for back-to-back requests', async () => {
  const srv = await serve((req, res) => { req.resume(); req.on('end', () => json(res, { ok: true })); });
  const { conn } = connect(srv.url);
  await call(conn, 'GET', '/api/sessions');
  await ticks();
  const second = await call(conn, 'GET', '/api/sessions');
  assert.deepStrictEqual([second.body, srv.connections()], [{ ok: true }, 1]);
});

test('a request on a socket the server has closed logs reused=true with its idle time, and settles once', async () => {
  let n = 0;
  const srv = await serve((req, res) => {
    n += 1;
    if (n === 2) { req.socket.destroy(); return; }
    req.resume();
    req.on('end', () => json(res, { ok: true }));
  });
  const { conn, logs, setTime } = connect(srv.url);
  await call(conn, 'GET', '/api/sessions');
  await ticks();
  setTime(1250);
  const failed = await call(conn, 'GET', '/api/sessions');
  await ticks();
  assert.deepStrictEqual([failed.calls(), failed.err.code, srv.connections()], [1, 'ECONNRESET', 1]);
  assert.deepStrictEqual(logs, ['lead: request failed: GET /api/sessions ECONNRESET reused=true idle=250 after=0 timeout=5000']);
});

test('a claim whose socket dies after the server acted on it fails once and is not replayed', async () => {
  let effects = 0;
  const srv = await serve((req, res) => {
    req.resume();
    req.on('end', () => { effects += 1; req.socket.destroy(); });
  });
  const { conn, logs } = connect(srv.url);
  let resolved = 0;
  const out = await conn.suiteDeskClaim('sess-00000001').then((v) => { resolved += 1; return v; });
  await ticks(10);
  assert.deepStrictEqual([out.status, out.error, resolved, effects], [0, 'socket hang up', 1, 1]);
  assert.deepStrictEqual(logs, ['lead: request failed: POST /api/suite-desk/claim ECONNRESET reused=false idle=- after=0 timeout=5000']);
});

test('a timeout logs the configured timeout and an after at or beyond it', async () => {
  let arrived;
  const got = new Promise((r) => { arrived = r; });
  const srv = await serve((req) => { req.resume(); arrived(); });
  const { conn, logs, setTime } = connect(srv.url);
  const pending = call(conn, 'GET', '/api/catalogs', null, 7000);
  await got;
  setTime(1000 + 7003);
  for (const list of Object.values(conn._reqAgent.sockets)) for (const s of list) s.emit('timeout');
  const failed = await pending;
  await ticks();
  assert.deepStrictEqual([failed.calls(), failed.err.message], [1, 'timeout']);
  assert.deepStrictEqual(logs, ['lead: request failed: GET /api/catalogs timeout reused=false idle=- after=7003 timeout=7000']);
});

test('the line names the route class only: no call id, claim token or query value', async () => {
  const srv = await serve((req) => { req.socket.destroy(); });
  const { conn, logs, setTime } = connect(srv.url);
  await conn.suiteDeskReply('call-zz9', 'claim-qq7', { status: 200, body: {} }, 9000);
  setTime(20000);
  await call(conn, 'GET', '/api/peer/hello?origin=s3cretq');
  assert.deepStrictEqual(logs, [
    'lead: request failed: POST /api/suite-desk/calls/:id/reply ECONNRESET reused=false idle=- after=0 timeout=9000',
    'lead: request failed: GET /api/peer/hello ECONNRESET reused=false idle=- after=0 timeout=5000',
  ]);
  for (const secret of ['call-zz9', 'claim-qq7', 's3cretq', 'tok-secret']) assert.ok(!logs.join('\n').includes(secret), secret);
});

test('five failures of one class inside 10 s print one line; the next carries +4 more', async () => {
  const srv = await serve(() => {});
  const url = srv.url;
  await srv.close();
  const { conn, logs, setTime } = connect(url);
  for (let i = 0; i < 5; i++) { setTime(1000 + i * 2000); await conn.suiteDeskClaim('sess-00000001'); }
  assert.deepStrictEqual(logs, ['lead: request failed: POST /api/suite-desk/claim ECONNREFUSED reused=false idle=- after=0 timeout=5000']);
  setTime(11000);
  await conn.suiteDeskClaim('sess-00000001');
  assert.deepStrictEqual(logs.slice(1), ['lead: request failed: POST /api/suite-desk/claim ECONNREFUSED reused=false idle=- after=0 timeout=5000 +4 more']);
});

test('PeerManager hands its log to each connection', () => {
  const log = () => {};
  const mgr = new PeerManager({ emit: () => {}, log });
  mgr.sync([{ id: 'p1', label: 'lead', url: 'http://127.0.0.1:1', token: 't' }]);
  const [conn] = mgr.connections();
  assert.strictEqual(conn._log, log);
  mgr.sync([]);
});


test('stop destroys every agent: pooled sockets close and an in-flight claim settles without a failure line', async () => {
  let held = 0;
  const srv = await serve((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/suite-desk/claim') { held += 1; return; }
      json(res, { ok: true });
    });
  });
  const { conn, logs } = connect(srv.url);
  await call(conn, 'GET', '/api/sessions');
  await conn.suiteAsk('GET', '/api/suite/jobs');
  let claimed = null;
  conn.suiteDeskClaim('sess-00000001').then((v) => { claimed = v; });
  for (let i = 0; i < 200 && !held; i++) await ticks(1);
  assert.deepStrictEqual([held, srv.open()], [1, 3], 'ENTER: two pooled sockets and one held claim are open');
  conn.stop();
  for (let i = 0; i < 200 && (srv.open() || !claimed); i++) await ticks(1);
  assert.deepStrictEqual([srv.open(), claimed && claimed.status, logs], [0, 0, []]);
});

test('a callback that throws on success is not called again', async () => {
  const srv = await serve((req, res) => { req.resume(); req.on('end', () => json(res, { ok: true })); });
  const { conn } = connect(srv.url);
  let calls = 0;
  conn._request('GET', '/api/sessions', null, () => { calls += 1; throw new Error('boom'); });
  for (let i = 0; i < 200 && !calls; i++) await ticks(1);
  await ticks();
  assert.strictEqual(calls, 1);
});

test('a log function that throws does not stop the callback', async () => {
  const srv = await serve(() => {});
  const url = srv.url;
  await srv.close();
  const { conn } = connect(url, { log: () => { throw new Error('log down'); } });
  const out = await conn.suiteDeskClaim('sess-00000001');
  assert.deepStrictEqual([out.status, out.error], [0, 'connect ECONNREFUSED 127.0.0.1:' + url.split(':').pop()]);
});
