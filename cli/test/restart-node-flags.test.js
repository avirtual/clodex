'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { run } = require('../src/main');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

const TOKEN = 'sekret';
const NO_CTX_ROOT = mkTmpRoot('restart-node-noctx-');
const BUSY = 'Not restarted: 2 suite jobs this machine is running for other teams would be cut — send wait (clodexctl restart node --wait) to restart once they finish, or cutJobs (--cut-jobs) to cut them now.';

async function withNode(answer, fn) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/api/restart') {
        const body = JSON.parse(raw || '{}');
        posts.push(body);
        return send(...answer(body));
      }
      return send(404, { ok: false, error: 'not found' });
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try { return await fn(port, posts); } finally { server.close(); }
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

test('restart node: --wait and --cut-jobs become the body booleans, and no flag sends an empty body', async () => {
  await withNode((body) => (body.wait ? [202, { ok: true, waiting: true, jobs: 3 }] : [200, { ok: true }]), async (port, posts) => {
    const plain = await cli(['restart', 'node', '--force'], port);
    const wait = await cli(['restart', 'node', '--force', '--wait'], port);
    const cut = await cli(['restart', 'node', '--force', '--cut-jobs'], port);
    assert.deepStrictEqual([plain.code, wait.code, cut.code], [0, 0, 0], plain.stderr + wait.stderr + cut.stderr);
    assert.deepStrictEqual(posts, [{}, { wait: true }, { cutJobs: true }]);
    assert.strictEqual(wait.stdout, 'engine restart armed — waits for 3 suite jobs and for idle sessions\n');
    assert.strictEqual(cut.stdout, 'engine restart requested\n');
  });
});

test('restart node: --wait with --cut-jobs is a usage error and posts nothing', async () => {
  await withNode(() => [200, { ok: true }], async (port, posts) => {
    const r = await cli(['restart', 'node', '--force', '--wait', '--cut-jobs'], port);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /restart node takes --wait or --cut-jobs, not both/);
    assert.deepStrictEqual(posts, []);
  });
});

test('restart node: a 409 runner-busy prints the server sentence and exits non-zero', async () => {
  await withNode(() => [409, { ok: false, code: 'runner-busy', jobs: 2, error: BUSY }], async (port, posts) => {
    const r = await cli(['restart', 'node', '--force'], port);
    assert.strictEqual(r.code, 2);
    assert.ok(r.stderr.includes(BUSY), r.stderr);
    assert.deepStrictEqual(posts, [{}]);
  });
});
