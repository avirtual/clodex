'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { run } = require('../src/main');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

const TOKEN = 'sekret';
const NO_CTX_ROOT = mkTmpRoot('testjobs-noctx-');

const RUNNING = {
  id: 'j2', team: 'clodex', ticket: 't7', kind: 'verify', origin: 'laptop', isolation: 'container',
  image: 'abc123def456', definition: null, phase: 'run', queuedAt: 1700000000000, startedAt: 1700000040000,
};
const WAITING = {
  id: 'j3', team: 'other', ticket: 't9', kind: 'hand', origin: null, isolation: 'native',
  image: null, definition: null, phase: 'queued', queuedAt: 1700000095000, startedAt: null,
};
const FINISHED = {
  id: 'j0', team: 'clodex', ticket: null, kind: 'post-merge', origin: null, isolation: 'native',
  image: null, definition: null, queuedAt: 1699999000000, startedAt: 1699999010000,
  outcome: 'pass', pass: 812, fail: 0, endedAt: 1699999135000, waitMs: 10000, runMs: 125000,
};
const SNAPSHOT = {
  at: 1700000100000,
  slots: { total: 1, inUse: 1 },
  running: [RUNNING],
  waiting: [WAITING],
  recent: [FINISHED],
  box: { state: 'ready', image: 'abc123def456' },
};

function node(body) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.url);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: 'unauthorized' });
      if (req.url === '/api/resources') {
        return send(200, { ok: true, version: 6, resources: [{ name: 'testjobs', singular: 'testjobs', scope: 'node', verbs: ['list'] }] });
      }
      if (req.url === '/api/testjobs') return send(200, body);
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return { server, seen };
}

async function withNode(body, fn) {
  const { server, seen } = node(body);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try { return await fn(port, seen); } finally { server.close(); }
}

async function cli(argv, port) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: path.join(NO_CTX_ROOT, 'contexts.json'),
    spawnFn: () => { throw new Error('spawnFn called'); },
  });
  return { code, stdout, stderr };
}

test('get testjobs prints the slot and box line, then running, waiting and recent rows in that order', async () => {
  await withNode({ ok: true, enabled: true, snapshot: SNAPSHOT }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['get', 'testjobs'], port);
    assert.strictEqual(stderr, '');
    assert.strictEqual(code, 0);
    const lines = stdout.split('\n');
    assert.ok(lines.some((l) => l.startsWith('run ') && l.includes('t7')), `ENTER: running row missing:\n${stdout}`);
    assert.ok(lines.some((l) => l.startsWith('queued ') && l.includes('t9')), `ENTER: waiting row missing:\n${stdout}`);
    assert.ok(lines.some((l) => l.startsWith('pass ') && l.includes('j0')), `ENTER: finished row missing:\n${stdout}`);
    assert.strictEqual(stdout, [
      'slots 1/1 in use, box image abc123def456',
      'STATE   TEAM    TICKET  KIND        ISOLATION  IMAGE         AGE    PASS/FAIL',
      'run     clodex  t7      verify      container  abc123def456  1m00s',
      'queued  other   t9      hand        native     -             5s',
      'pass    clodex  j0      post-merge  native     -             2m05s  812/0',
      '',
    ].join('\n'));
    assert.deepStrictEqual(seen, ['/api/resources', '/api/testjobs']);
  });
});

test('get testjobs on a disabled runner prints one line and exits 0', async () => {
  await withNode({ ok: true, enabled: false, snapshot: null }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['get', 'testjobs'], port);
    assert.strictEqual(stderr, '');
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, 'test runner: off on this node\n');
    assert.deepStrictEqual(seen, ['/api/resources', '/api/testjobs']);
  });
});

test('get testjobs -o json prints the route body', async () => {
  const body = { ok: true, enabled: true, snapshot: SNAPSHOT };
  await withNode(body, async (port) => {
    const { code, stdout } = await cli(['get', 'testjobs', '-o', 'json'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), body);
  });
});

test('describe testjobs is refused with a usage error and sends no request', async () => {
  await withNode({ ok: true, enabled: true, snapshot: SNAPSHOT }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['describe', 'testjobs'], port);
    assert.strictEqual(code, 2);
    assert.strictEqual(stdout, '');
    assert.match(stderr, /describe testjobs is not supported \(try: get testjobs\)/);
    assert.deepStrictEqual(seen, []);
  });
});
