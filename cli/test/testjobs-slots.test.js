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
      if (req.method === 'POST' && (req.url === '/api/testjobs/slots' || req.url === '/api/testjobs/exclusive' || req.url === '/api/testjobs/box-args')) return send(answer.status, answer.body);
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
    assert.deepStrictEqual([missing.code, missing.stderr], [2, 'clodexctl: patch testjobs needs --slots N, --exclusive honour|ignore, or --box-arg / --no-box-args / --box-args-label\n']);
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

const EXCLUSIVE_ROW = { name: 'testjobs/exclusive', singular: 'testjobs/exclusive', scope: 'node', verbs: ['post'] };

test('t2428: patch testjobs --exclusive posts the mode to its own route and prints the applied line', async () => {
  for (const [body, line] of [
    [{ ok: true, exclusive: 'ignore', applied: 'now', running: 0 }, 'test runner exclusive requests set to ignore — applied now\n'],
    [{ ok: true, exclusive: 'honour', applied: 'after-drain', running: 2 }, 'test runner exclusive requests set to honour — applies when 2 running jobs finish\n'],
  ]) {
    await withNode({ status: 200, body }, async (port, seen) => {
      const { code, stdout, stderr } = await cli(['patch', 'testjobs', '--exclusive', body.exclusive], port);
      assert.deepStrictEqual([code, stderr, stdout], [0, '', line]);
      assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), [['POST', '/api/testjobs/exclusive', `{"exclusive":"${body.exclusive}"}`]]);
    }, { rows: [SLOTS_ROW, EXCLUSIVE_ROW] });
  }
});

test('t2428: patch testjobs refuses a bad --exclusive and --slots with --exclusive before the wire', async () => {
  await withNode({ status: 200, body: { ok: true } }, async (port, seen) => {
    const bad = await cli(['patch', 'testjobs', '--exclusive', 'maybe'], port);
    assert.deepStrictEqual([bad.code, bad.stderr], [2, 'clodexctl: --exclusive must be honour or ignore, not "maybe"\n']);
    const both = await cli(['patch', 'testjobs', '--slots', '1', '--exclusive', 'ignore'], port);
    assert.deepStrictEqual([both.code, both.stderr], [2, 'clodexctl: patch testjobs takes --slots, --exclusive or the box options flags, one per call\n']);
    assert.deepStrictEqual(seen, []);
  }, { rows: [SLOTS_ROW, EXCLUSIVE_ROW] });
});

test('t2428: a node that does not serve testjobs/exclusive is told to upgrade, and nothing is posted', async () => {
  await withNode({ status: 200, body: { ok: true } }, async (port, seen) => {
    const { code, stderr } = await cli(['patch', 'testjobs', '--exclusive', 'ignore'], port);
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /does not serve testjobs\/exclusive post/);
    assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), []);
  });
});

const BOX_ARGS_ROW = { name: 'testjobs/box-args', singular: 'testjobs/box-args', scope: 'node', verbs: ['post'] };

test('t2483: patch testjobs --box-arg posts the repeated options and the label to their own route and prints the fingerprint, never the options', async () => {
  const body = { ok: true, count: 2, custom: { fingerprint: '0b334ad4c4a0', label: 'gpu' }, applied: 'after-drain', running: 1 };
  await withNode({ status: 200, body }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['patch', 'testjobs', '--box-arg', '--device=/dev/dri', '--box-arg=--group-add=993', '--box-args-label', 'gpu'], port);
    assert.deepStrictEqual([code, stderr, stdout], [0, '', 'test runner set to 2 box options (gpu, fingerprint 0b334ad4c4a0) — applies when 1 running job finishes\n']);
    assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), [['POST', '/api/testjobs/box-args', '{"boxArgs":["--device=/dev/dri","--group-add=993"],"boxArgsLabel":"gpu"}']]);
  }, { rows: [SLOTS_ROW, BOX_ARGS_ROW] });
  await withNode({ status: 200, body: { ok: true, count: 0, custom: null, applied: 'now', running: 0 } }, async (port, seen) => {
    const { code, stdout } = await cli(['patch', 'testjobs', '--no-box-args'], port);
    assert.deepStrictEqual([code, stdout], [0, 'test runner set to no box options — applied now\n']);
    assert.deepStrictEqual(seen.filter(([m]) => m === 'POST'), [['POST', '/api/testjobs/box-args', '{"boxArgs":[]}']]);
  }, { rows: [SLOTS_ROW, BOX_ARGS_ROW] });
});

test('t2483: patch testjobs refuses --box-arg with --no-box-args, and with --slots, before the wire', async () => {
  await withNode({ status: 200, body: { ok: true } }, async (port, seen) => {
    const both = await cli(['patch', 'testjobs', '--box-arg=--privileged', '--no-box-args'], port);
    assert.deepStrictEqual([both.code, both.stderr], [2, 'clodexctl: patch testjobs takes --box-arg or --no-box-args, not both\n']);
    const mixed = await cli(['patch', 'testjobs', '--slots', '1', '--box-arg=--privileged'], port);
    assert.deepStrictEqual([mixed.code, mixed.stderr], [2, 'clodexctl: patch testjobs takes --slots, --exclusive or the box options flags, one per call\n']);
    assert.deepStrictEqual(seen, []);
  }, { rows: [SLOTS_ROW, BOX_ARGS_ROW] });
});
