'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { RemoteServer } = require('../remote');

async function withServer(restartApp, fn) {
  const server = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }), hostLabel: 'flags', version: '0.0.0-test',
    restartApp,
  });
  await server.start();
  try { return await fn(server.port); } finally { server.stop(); }
}

function post(port, body, type = 'application/json') {
  return new Promise((resolve, reject) => {
    const headers = body == null ? {} : { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/restart', method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('t2407: POST /api/restart hands the body booleans to restartApp and answers with its plan', async () => {
  const seen = [];
  const busy = { status: 409, body: { ok: false, code: 'runner-busy', jobs: 2, error: 'busy sentence' } };
  await withServer((opts) => { seen.push(opts); return busy; }, async (port) => {
    assert.deepStrictEqual(await post(port, '{}'), { status: 409, body: busy.body });
    assert.deepStrictEqual(await post(port, null), { status: 409, body: busy.body });
    await post(port, '{"wait":true}');
    await post(port, '{"cutJobs":true}');
    await post(port, '{"wait":"yes","cutJobs":1}');
  });
  assert.deepStrictEqual(seen, [
    { wait: false, cutJobs: false },
    { wait: false, cutJobs: false },
    { wait: true, cutJobs: false },
    { wait: false, cutJobs: true },
    { wait: false, cutJobs: false },
  ]);
});

test('t2407: the plan runs only after its reply is written', async () => {
  const order = [];
  const server = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }),
    send: () => ({ ok: true }), hostLabel: 'flags', version: '0.0.0-test',
    restartApp: () => ({ status: 202, body: { ok: true, waiting: true, jobs: 1 }, go: () => order.push('go') }),
  });
  const json = server._json.bind(server);
  server._json = (res, code, obj) => { order.push(`reply:${code}`); return json(res, code, obj); };
  await server.start();
  try {
    assert.deepStrictEqual(await post(server.port, '{"wait":true}'), { status: 202, body: { ok: true, waiting: true, jobs: 1 } });
  } finally { server.stop(); }
  assert.deepStrictEqual(order, ['reply:202', 'go']);
});

test('t2407: wait with cutJobs, bad JSON and a non-JSON body are refused before restartApp', async () => {
  let called = 0;
  await withServer(() => { called += 1; return { status: 200, body: { ok: true } }; }, async (port) => {
    assert.deepStrictEqual(await post(port, '{"wait":true,"cutJobs":true}'), { status: 400, body: { ok: false, error: 'wait and cutJobs cannot both be set' } });
    assert.deepStrictEqual(await post(port, '{nope'), { status: 400, body: { ok: false, error: 'bad JSON' } });
    assert.strictEqual((await post(port, '{"cutJobs":true}', 'text/plain')).status, 415);
  });
  assert.strictEqual(called, 0);
});
