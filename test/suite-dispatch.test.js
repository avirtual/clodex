'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { RemoteServer } = require('../remote');
const { suiteDispatch, SUITE_VERBS } = require('../suite-dispatch');

const OP_TOKEN = 'operator-token-dispatch';

function stubEngine() {
  const calls = [];
  const rec = (name, out) => (...args) => { calls.push([name, ...args]); return Promise.resolve(out); };
  const engine = {
    info: rec('info', { ok: true, bootId: 'boot-1', env: { envKey: 'e1' } }),
    submit: rec('submit', { ok: true, id: 'job-1', state: 'queued', position: 1 }),
    putPack: rec('putPack', { ok: false, status: 409, have: 12 }),
    commit: rec('commit', { ok: true, id: 'job-1', state: 'queued', position: 1 }),
    poll: rec('poll', { ok: true, bootId: 'boot-1', jobs: [] }),
    output: rec('output', { ok: true, total: 3, offset: 1, text: 'bc' }),
    cancel: rec('cancel', { ok: true }),
  };
  return { engine, calls };
}

async function startServer(t, engine) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'runner-box', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteRunner: engine,
  });
  await server.start();
  t.after(() => server.stop());
  return server.port;
}

function httpAsk(port, { method, path, headers = {}, body, bytes }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, Authorization: `Bearer ${OP_TOKEN}` };
    let payload = null;
    if (body != null) { payload = Buffer.from(body); h['content-type'] = 'application/json'; }
    if (bytes != null) payload = bytes;
    if (payload) h['content-length'] = payload.length;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const ROWS = [
  { verb: 'info', method: 'GET', path: '/api/suite/info',
    call: ['info'], status: 200 },
  { verb: 'poll', method: 'GET', path: '/api/suite/jobs?ids=job-1,job-2&wait=250',
    call: ['poll', ['job-1', 'job-2'], { wait: 250 }], status: 200 },
  { verb: 'submit', method: 'POST', path: '/api/suite/jobs', body: '{"id":"job-1","treeHash":"abc"}',
    call: ['submit', { id: 'job-1', treeHash: 'abc' }, { origin: null }], status: 200 },
  { verb: 'cancel', method: 'DELETE', path: '/api/suite/jobs/job-1',
    call: ['cancel', 'job-1'], status: 200 },
  { verb: 'putPack', method: 'PUT', path: '/api/suite/jobs/job-1/pack', headers: { 'content-range': 'bytes 12-15/*' }, bytes: Buffer.from('PACK'),
    call: ['putPack', 'job-1', 12, Buffer.from('PACK')], status: 409 },
  { verb: 'commit', method: 'POST', path: '/api/suite/jobs/job-1/commit', body: '{"bytes":16,"sha256":"ff","extra":1}',
    call: ['commit', 'job-1', { bytes: 16, sha256: 'ff' }], status: 200 },
  { verb: 'output', method: 'GET', path: '/api/suite/jobs/job-1/output?stream=stderr&offset=1&length=2',
    call: ['output', 'job-1', { stream: 'stderr', offset: 1, length: 2 }], status: 200 },
];

test('the verb table is exactly the seven suite verbs', () => {
  assert.deepStrictEqual(SUITE_VERBS.map((r) => `${r.method} ${r.path.join('/')} ${r.body}`), [
    'GET info none',
    'GET jobs none',
    'POST jobs json',
    'DELETE jobs/:id none',
    'PUT jobs/:id/pack raw',
    'POST jobs/:id/commit json',
    'GET jobs/:id/output none',
  ]);
  assert.deepStrictEqual(ROWS.map((r) => r.verb), SUITE_VERBS.map((r) => r.verb), 'one table row per verb');
});

for (const row of ROWS) {
  test(`${row.verb}: suiteDispatch answers what the HTTP route sends, and makes the same engine call`, async (t) => {
    const viaHttp = stubEngine();
    const port = await startServer(t, viaHttp.engine);
    const wire = await httpAsk(port, row);
    const direct = stubEngine();
    const answer = await suiteDispatch(direct.engine, {
      method: row.method, path: row.path, headers: row.headers || {}, body: row.body, bytes: row.bytes,
    });
    assert.strictEqual(wire.status, row.status);
    assert.deepStrictEqual(answer, wire);
    assert.deepStrictEqual(viaHttp.calls, [row.call]);
    assert.deepStrictEqual(direct.calls, [row.call]);
  });
}

test('anything off the table is 404 on both transports and reaches no engine method', async (t) => {
  const viaHttp = stubEngine();
  const port = await startServer(t, viaHttp.engine);
  const direct = stubEngine();
  const served = await suiteDispatch(direct.engine, { method: 'GET', path: '/api/suite/info' });
  assert.strictEqual(served.status, 200, 'ENTER: a table row is served');
  direct.calls.length = 0;
  const NOT_FOUND = { status: 404, body: { ok: false, error: 'not found' } };
  const off = [
    { method: 'POST', path: '/api/suite/info' },
    { method: 'GET', path: '/api/suite/info/extra' },
    { method: 'GET', path: '/api/suite/jobs/job-1' },
    { method: 'PUT', path: '/api/suite/jobs/job-1' },
    { method: 'DELETE', path: '/api/suite/jobs/job-1/pack' },
    { method: 'GET', path: '/api/suite/jobs/job-1/commit' },
    { method: 'POST', path: '/api/suite/jobs/job-1/output' },
    { method: 'GET', path: '/api/suite/jobs/job-1/output/more' },
    { method: 'GET', path: '/api/suite/nope' },
  ];
  for (const ask of off) {
    assert.deepStrictEqual(await suiteDispatch(direct.engine, ask), NOT_FOUND, `${ask.method} ${ask.path}`);
    assert.deepStrictEqual(await httpAsk(port, ask), NOT_FOUND, `HTTP ${ask.method} ${ask.path}`);
  }
  for (const ask of [{ method: 'GET', path: '/api/sessions' }, { method: 'GET', path: '/api/suite' }, { method: 'GET', path: '//api/suite/info' }]) {
    assert.deepStrictEqual(await suiteDispatch(direct.engine, ask), NOT_FOUND, `${ask.method} ${ask.path}`);
  }
  assert.deepStrictEqual(direct.calls, []);
  assert.deepStrictEqual(viaHttp.calls, []);
});

test('a direct call is held to the row body kind and cap', async () => {
  const { engine, calls } = stubEngine();
  const ask = (extra) => suiteDispatch(engine, extra);
  const ok = await ask({ method: 'POST', path: '/api/suite/jobs', body: { id: 'job-1' } });
  assert.strictEqual(ok.status, 200, 'ENTER: an object body is accepted');
  assert.deepStrictEqual(await ask({ method: 'POST', path: '/api/suite/jobs', body: { pad: 'x'.repeat(256 * 1024) } }),
    { status: 413, body: { ok: false, error: 'message too large' } });
  assert.deepStrictEqual(await ask({ method: 'POST', path: '/api/suite/jobs/job-1/commit', body: 'nope' }),
    { status: 400, body: { ok: false, error: 'bad JSON' } });
  assert.deepStrictEqual(await ask({ method: 'GET', path: '/api/suite/info', body: { a: 1 } }),
    { status: 400, body: { ok: false, error: 'unexpected body' } });
  assert.deepStrictEqual(await ask({ method: 'PUT', path: '/api/suite/jobs/job-1/pack', headers: { 'content-range': 'bytes 0-1/*' }, body: { a: 1 } }),
    { status: 400, body: { ok: false, error: 'expected a byte body' } });
  assert.deepStrictEqual(await ask({ method: 'DELETE', path: '/api/suite/jobs/bad%20id' }),
    { status: 400, body: { ok: false, error: 'bad job id' } });
  assert.deepStrictEqual(await ask({ method: 'PUT', path: '/api/suite/jobs/job-1/pack', bytes: Buffer.from('x') }),
    { status: 400, body: { ok: false, error: 'bad Content-Range (expected bytes <start>-<end>/*)' } });
  assert.deepStrictEqual(await suiteDispatch(null, { method: 'GET', path: '/api/suite/info' }),
    { status: 501, body: { ok: false, error: 'this node is not a test runner' } });
  assert.deepStrictEqual(calls, [['submit', { id: 'job-1' }, { origin: null }]]);
});
