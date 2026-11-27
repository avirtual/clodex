'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { run } = require('../src/main');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

const TOKEN = 'sekret';
const NO_CTX_ROOT = mkTmpRoot('testjobs-slots-noctx-');
const SLOTS_ROW = { name: 'testjobs/slots', singular: 'testjobs/slots', scope: 'node', verbs: ['post'] };

function node(answer, { rows = [SLOTS_ROW] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push([req.method, req.url, raw]);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/resources') return send(200, { ok: true, version: 7, resources: rows });
      if (req.url === '/api/peer/hello') return send(200, { ok: true, host: 'runner', version: '1.0.0' });
      if (req.method === 'POST' && req.url === '/api/testjobs/slots') return send(answer.status, answer.body);
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return { server, seen };
}

async function withNode(answer, fn, opts) {
  const { server, seen } = node(answer, opts);
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

test('patch testjobs --slots posts the number and prints the applied-now line', async () => {
  await withNode({ status: 200, body: { ok: true, slots: 2, applied: 'now', running: 0 } }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['patch', 'testjobs', '--slots', '2'], port);
    assert.deepStrictEqual([code, stderr], [0, '']);
    assert.strictEqual(stdout, 'test runner slots set to 2 — applied now\n');
    assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), [['POST', '/api/testjobs/slots', '{"slots":2}']]);
  });
});

test('patch testjobs --slots prints the wait for running jobs', async () => {
  for (const [running, line] of [
    [1, 'test runner slots set to 1 — applies when 1 running job finishes\n'],
    [3, 'test runner slots set to 1 — applies when 3 running jobs finish\n'],
  ]) {
    await withNode({ status: 200, body: { ok: true, slots: 1, applied: 'after-drain', running } }, async (port) => {
      const { code, stdout } = await cli(['patch', 'testjobs', '--slots', '1'], port);
      assert.deepStrictEqual([code, stdout], [0, line]);
    });
  }
});

test('patch testjobs exits non-zero with the node refusal', async () => {
  await withNode({ status: 409, body: { ok: false, error: 'the test runner is off on this node' } }, async (port) => {
    const { code, stdout, stderr } = await cli(['patch', 'testjobs', '--slots', '3'], port);
    assert.notStrictEqual(code, 0);
    assert.strictEqual(stdout, '');
    assert.match(stderr, /the test runner is off on this node/);
  });
});

test('patch testjobs refuses a missing or non-numeric --slots before the wire', async () => {
  await withNode({ status: 200, body: { ok: true } }, async (port, seen) => {
    const missing = await cli(['patch', 'testjobs'], port);
    assert.deepStrictEqual([missing.code, missing.stderr], [2, 'clodexctl: patch testjobs needs --slots N\n']);
    const word = await cli(['patch', 'testjobs', '--slots', 'two'], port);
    assert.deepStrictEqual([word.code, word.stderr], [2, 'clodexctl: --slots must be a whole number, not "two"\n']);
    const extra = await cli(['patch', 'testjobs', 'x', '--slots', '1'], port);
    assert.deepStrictEqual([extra.code, extra.stderr], [2, 'clodexctl: patch testjobs: unexpected argument "x"\n']);
    assert.deepStrictEqual(seen, []);
  });
});

test('a node that does not serve testjobs/slots is told to upgrade, and nothing is posted', async () => {
  const rows = [{ name: 'testjobs', singular: 'testjobs', scope: 'node', verbs: ['list'] }];
  await withNode({ status: 200, body: { ok: true } }, async (port, seen) => {
    const { code, stderr } = await cli(['patch', 'testjobs', '--slots', '1'], port);
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /does not serve testjobs\/slots post/);
    assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), []);
  }, { rows });
});
