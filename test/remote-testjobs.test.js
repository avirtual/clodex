'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { RemoteServer } = require('../remote');

const OP_TOKEN = 'operator-token-testjobs-1';
const SUITE_TOKEN = 'suite-token-testjobs-PLANTED';

const SNAPSHOT = {
  at: 1700000100000,
  slots: { total: 1, inUse: 1 },
  running: [{
    id: 'j1', team: 'clodex', ticket: 't7', kind: 'verify', origin: 'laptop', isolation: 'container',
    image: 'abc123def456', definition: null, phase: 'run', queuedAt: 1700000000000, startedAt: 1700000040000,
  }],
  waiting: [],
  recent: [],
  box: { state: 'ready', image: 'abc123def456' },
};

function req(port, pathname, { token = OP_TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function startNode(t, extra) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'murmur', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteToken: SUITE_TOKEN, suiteRunner: null, ...extra,
  });
  await server.start();
  t.after(() => server.stop());
  return server.port;
}

test('GET /api/testjobs with the operator token returns the activity source unchanged', async (t) => {
  let calls = 0;
  const port = await startNode(t, { listTestjobs: async () => { calls++; return { enabled: true, snapshot: SNAPSHOT }; } });
  const r = await req(port, '/api/testjobs');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, enabled: true, snapshot: SNAPSHOT });
  assert.strictEqual(calls, 1);
  const names = (await req(port, '/api/resources')).json.resources.map((x) => x.name);
  assert.ok(names.includes('testjobs'), `resources lack testjobs: ${names}`);
});

test('GET /api/testjobs on a disabled runner reports enabled false and a null snapshot', async (t) => {
  const port = await startNode(t, { listTestjobs: () => ({ enabled: false, snapshot: null }) });
  const r = await req(port, '/api/testjobs');
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true, enabled: false, snapshot: null }]);
});

test('a suite token gets 403 on GET /api/testjobs and the source is not read', async (t) => {
  let calls = 0;
  const port = await startNode(t, { listTestjobs: () => { calls++; return { enabled: true, snapshot: SNAPSHOT }; } });
  assert.strictEqual((await req(port, '/api/testjobs')).status, 200, 'ENTER: the operator token reaches the route');
  const r = await req(port, '/api/testjobs', { token: SUITE_TOKEN });
  assert.deepStrictEqual([r.status, r.json], [403, { ok: false, error: 'this token is scoped to suite jobs' }]);
  assert.strictEqual(calls, 1);
});

test('no listTestjobs dep: 501 and testjobs absent from /api/resources', async (t) => {
  const port = await startNode(t, {});
  const r = await req(port, '/api/testjobs');
  assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: 'testjobs not available' }]);
  const names = (await req(port, '/api/resources')).json.resources.map((x) => x.name);
  assert.ok(names.includes('sessions'), 'ENTER: the resource document lists the node');
  assert.ok(!names.includes('testjobs'));
});

test('a throwing source answers 500 with its message', async (t) => {
  const port = await startNode(t, { listTestjobs: async () => { throw new Error('runner gone'); } });
  const r = await req(port, '/api/testjobs');
  assert.deepStrictEqual([r.status, r.json], [500, { ok: false, error: 'runner gone' }]);
});

const OUTPUT = {
  ok: true, id: 'j1', stream: 'stderr', phase: 'run', live: true, at: 1700000100000, queuedAt: 1700000000000,
  startedAt: 1700000040000, endedAt: null, lastOutputAt: 1700000095000, expired: false,
  total: 12, offset: 4, next: 12, text: 'npm ERR!\n',
};

test('GET /api/testjobs/<id>/output with the operator token returns the runner read unchanged', async (t) => {
  const calls = [];
  const port = await startNode(t, {
    listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }),
    readTestjobOutput: async (id, opts) => { calls.push([id, opts]); return OUTPUT; },
  });
  const r = await req(port, '/api/testjobs/j1/output?stream=stderr&offset=4&length=100');
  assert.deepStrictEqual([r.status, r.json], [200, OUTPUT]);
  const tail = await req(port, '/api/testjobs/j1/output');
  assert.strictEqual(tail.status, 200);
  assert.deepStrictEqual(calls, [['j1', { stream: 'stderr', offset: 4, length: 100 }], ['j1', { stream: 'stdout', offset: null }]]);
  const doc = (await req(port, '/api/resources')).json.resources.find((x) => x.name === 'testjobs');
  assert.deepStrictEqual(doc, { name: 'testjobs', singular: 'testjobs', scope: 'node', verbs: ['list'], subresources: { output: ['get'] } });
});

test('a suite token gets 403 on the output route and the source is not read', async (t) => {
  let calls = 0;
  const port = await startNode(t, { listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }), readTestjobOutput: () => { calls++; return OUTPUT; } });
  assert.strictEqual((await req(port, '/api/testjobs/j1/output')).status, 200, 'ENTER: the operator token reaches the route');
  const r = await req(port, '/api/testjobs/j1/output', { token: SUITE_TOKEN });
  assert.deepStrictEqual([r.status, r.json], [403, { ok: false, error: 'this token is scoped to suite jobs' }]);
  assert.strictEqual(calls, 1);
});

test('the output route: unknown job 404, bad stream, offset or id 400, source status passed through', async (t) => {
  const asked = [];
  const port = await startNode(t, {
    listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }),
    readTestjobOutput: (id) => { asked.push(id); return id === 'nope' ? { ok: false, status: 404, error: 'no such job' } : OUTPUT; },
  });
  const rows = [
    ['/api/testjobs/nope/output', 404, { ok: false, error: 'no such job' }],
    ['/api/testjobs/j1/output?stream=both', 400, { ok: false, error: 'bad stream' }],
    ['/api/testjobs/j1/output?offset=-1', 400, { ok: false, error: 'bad offset' }],
    ['/api/testjobs/j1/output?length=1e9', 400, { ok: false, error: 'bad length' }],
    ['/api/testjobs/..%2Fx/output', 400, { ok: false, error: 'bad job id' }],
    ['/api/testjobs/j1/stdout', 404, { ok: false, error: 'not found' }],
  ];
  for (const [p, status, body] of rows) {
    const r = await req(port, p);
    assert.deepStrictEqual([r.status, r.json], [status, body], p);
  }
  assert.deepStrictEqual(asked, ['nope']);
});

test('no readTestjobOutput dep: the output route answers 501 and testjobs advertises no output', async (t) => {
  const port = await startNode(t, { listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }) });
  const r = await req(port, '/api/testjobs/j1/output');
  assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: 'testjobs not available' }]);
  const doc = (await req(port, '/api/resources')).json.resources.find((x) => x.name === 'testjobs');
  assert.deepStrictEqual(doc, { name: 'testjobs', singular: 'testjobs', scope: 'node', verbs: ['list'], subresources: {} });
});

function post(port, pathname, raw, { token = OP_TOKEN, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}), 'content-length': Buffer.byteLength(raw) };
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: text.startsWith('{') ? JSON.parse(text) : text }));
    });
    r.on('error', reject);
    r.end(raw);
  });
}

test('t2417: POST /api/testjobs/slots hands the body slots to the setter and returns its answer', async (t) => {
  const asked = [];
  const answers = {
    2: { ok: true, slots: 2, applied: 'after-drain', running: 1 },
    0: { ok: false, status: 400, error: 'slots must be from 1 to 4, not 0' },
    3: { ok: false, status: 409, error: 'the test runner is off on this node' },
  };
  const port = await startNode(t, {
    listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }),
    setTestjobSlots: (n) => { asked.push(n); return answers[n]; },
  });
  const rows = [
    ['{"slots":2}', 200, { ok: true, slots: 2, applied: 'after-drain', running: 1 }],
    ['{"slots":0}', 400, { ok: false, error: 'slots must be from 1 to 4, not 0' }],
    ['{"slots":3}', 409, { ok: false, error: 'the test runner is off on this node' }],
    ['not json', 400, { ok: false, error: 'bad JSON' }],
  ];
  for (const [raw, status, body] of rows) {
    const r = await post(port, '/api/testjobs/slots', raw);
    assert.deepStrictEqual([r.status, r.json], [status, body], raw);
  }
  assert.deepStrictEqual(asked, [2, 0, 3]);
  const names = (await req(port, '/api/resources')).json.resources.map((x) => x.name);
  assert.deepStrictEqual(names.filter((n) => n.startsWith('testjobs')), ['testjobs', 'testjobs/slots']);
});

test('t2417: POST /api/testjobs/slots refuses the suite token, a missing token and a non-JSON content type before the setter', async (t) => {
  let calls = 0;
  const port = await startNode(t, { listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }), setTestjobSlots: () => { calls++; return { ok: true, slots: 1, applied: 'now', running: 0 }; } });
  assert.strictEqual((await post(port, '/api/testjobs/slots', '{"slots":1}')).status, 200, 'ENTER: the operator token reaches the route');
  const scoped = await post(port, '/api/testjobs/slots', '{"slots":1}', { token: SUITE_TOKEN });
  assert.deepStrictEqual([scoped.status, scoped.json], [403, { ok: false, error: 'this token is scoped to suite jobs' }]);
  assert.strictEqual((await post(port, '/api/testjobs/slots', '{"slots":1}', { token: null })).status, 401);
  assert.strictEqual((await post(port, '/api/testjobs/slots', '{"slots":1}', { type: 'text/plain' })).status, 415);
  assert.strictEqual(calls, 1);
});

test('t2417: no setTestjobSlots dep: the slots route answers 501', async (t) => {
  const port = await startNode(t, { listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }) });
  const r = await post(port, '/api/testjobs/slots', '{"slots":1}');
  assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: 'testjobs not available' }]);
});

test('t2428: POST /api/testjobs/exclusive hands the body exclusive to its own setter, never the slots one, and returns its answer', async (t) => {
  const asked = [];
  let slotCalls = 0;
  const port = await startNode(t, {
    listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }),
    setTestjobSlots: () => { slotCalls++; return { ok: true }; },
    setTestjobExclusive: (v) => { asked.push(v); return v === 'ignore' ? { ok: true, exclusive: 'ignore', applied: 'now', running: 0 } : { ok: false, status: 400, error: 'exclusive must be honour or ignore' }; },
  });
  const rows = [
    ['{"exclusive":"ignore"}', 200, { ok: true, exclusive: 'ignore', applied: 'now', running: 0 }],
    ['{"exclusive":"maybe"}', 400, { ok: false, error: 'exclusive must be honour or ignore' }],
    ['not json', 400, { ok: false, error: 'bad JSON' }],
  ];
  for (const [raw, status, body] of rows) {
    const r = await post(port, '/api/testjobs/exclusive', raw);
    assert.deepStrictEqual([r.status, r.json], [status, body], raw);
  }
  assert.deepStrictEqual([asked, slotCalls], [['ignore', 'maybe'], 0]);
  const scoped = await post(port, '/api/testjobs/exclusive', '{"exclusive":"ignore"}', { token: SUITE_TOKEN });
  assert.strictEqual(scoped.status, 403);
});

test('t2428: no setTestjobExclusive dep: the exclusive route answers 501', async (t) => {
  const port = await startNode(t, { listTestjobs: () => ({ enabled: true, snapshot: SNAPSHOT }), setTestjobSlots: () => ({ ok: true }) });
  const r = await post(port, '/api/testjobs/exclusive', '{"exclusive":"ignore"}');
  assert.deepStrictEqual([r.status, r.json], [501, { ok: false, error: 'testjobs not available' }]);
});
