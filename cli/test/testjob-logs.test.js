'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { run } = require('../src/main');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

const TOKEN = 'sekret';
const NO_CTX_ROOT = mkTmpRoot('testjob-logs-noctx-');

const BASE = {
  ok: true, id: 'j1', stream: 'stdout', phase: 'run', live: true, at: 1700000100000, queuedAt: 1700000000000,
  startedAt: 1700000040000, endedAt: null, lastOutputAt: 1700000095000, expired: false,
};

function node(outputs, { subresources = { output: ['get'] } } = {}) {
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
        return send(200, { ok: true, version: 6, resources: [{ name: 'testjobs', singular: 'testjobs', scope: 'node', verbs: ['list'], subresources }] });
      }
      const hit = outputs[req.url];
      if (hit) return send(hit[0], hit[1]);
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return { server, seen };
}

async function withNode(outputs, fn, opts) {
  const { server, seen } = node(outputs, opts);
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

const HOSTILE = [
  'line one',
  '\x1b[1;31mFAIL\x1b[0m test/a.js',
  '\x1b]8;;https://evil.example/\x1b\\click me\x1b]8;;\x1b\\',
  '\x1b]0;owned\x07<script>alert(1)</script>',
  'spin 50%\r60%',
  '',
].join('\n');

test('logs testjob prints the stdout tail as inert text', async () => {
  const outputs = { '/api/testjobs/j1/output?stream=stdout': [200, { ...BASE, total: 200, offset: 0, next: 200, text: HOSTILE }] };
  await withNode(outputs, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['logs', 'testjob', 'j1'], port);
    assert.deepStrictEqual([code, stderr], [0, '']);
    assert.strictEqual(stdout, [
      'line one',
      'FAIL test/a.js',
      'click me',
      '<script>alert(1)</script>',
      'spin 50%',
      '60%',
      '',
    ].join('\n'));
    assert.deepStrictEqual(seen, ['/api/resources', '/api/testjobs/j1/output?stream=stdout']);
  });
});

test('logs testjob --stderr --tail 2 reads stderr and keeps the last two lines under a marker', async () => {
  const outputs = { '/api/testjobs/j1/output?stream=stderr': [200, { ...BASE, stream: 'stderr', total: 9000, offset: 8000, next: 9000, text: 'a\nb\nc\n' }] };
  await withNode(outputs, async (port, seen) => {
    const { code, stdout } = await cli(['logs', 'testjob', 'j1', '--stderr', '--tail', '2'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, '… earlier output not shown …\nb\nc\n');
    assert.deepStrictEqual(seen, ['/api/resources', '/api/testjobs/j1/output?stream=stderr']);
  });
});

test('logs testjob says output expired, no output yet, or names the unknown job', async () => {
  const outputs = {
    '/api/testjobs/gone/output?stream=stdout': [200, { ...BASE, id: 'gone', phase: 'done', live: false, expired: true, total: 0, offset: 0, next: 0, text: '' }],
    '/api/testjobs/fresh/output?stream=stdout': [200, { ...BASE, id: 'fresh', total: 0, offset: 0, next: 0, text: '' }],
    '/api/testjobs/nope/output?stream=stdout': [404, { ok: false, error: 'no such job' }],
  };
  await withNode(outputs, async (port) => {
    const gone = await cli(['logs', 'testjob', 'gone'], port);
    assert.deepStrictEqual([gone.code, gone.stdout], [0, 'output expired\n']);
    const fresh = await cli(['logs', 'testjob', 'fresh'], port);
    assert.deepStrictEqual([fresh.code, fresh.stdout], [0, 'no output yet\n']);
    const nope = await cli(['logs', 'testjob', 'nope'], port);
    assert.notStrictEqual(nope.code, 0);
    assert.strictEqual(nope.stdout, '');
    assert.match(nope.stderr, /no such job/);
  });
});

test('logs testjob refuses follow and a missing id before any request', async () => {
  await withNode({}, async (port, seen) => {
    const follow = await cli(['logs', 'testjob', 'j1', '-f'], port);
    assert.strictEqual(follow.code, 2);
    assert.match(follow.stderr, /logs testjob does not follow/);
    const bare = await cli(['logs', 'testjob'], port);
    assert.strictEqual(bare.code, 2);
    assert.match(bare.stderr, /logs testjob needs a job id/);
    assert.deepStrictEqual(seen, []);
  });
});

test('logs testjob against a node that serves no testjobs output is the upgrade line', async () => {
  await withNode({}, async (port, seen) => {
    const r = await cli(['logs', 'testjob', 'j1'], port);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /testjobs\/output/);
    assert.deepStrictEqual(seen, ['/api/resources']);
  }, { subresources: {} });
});
