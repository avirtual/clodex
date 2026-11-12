'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { run } = require('../src/main');
const { mkTmpRoot } = require('../../test/lib/tmp-roots');

const TOKEN = 'sekret';
const NO_CTX_ROOT = mkTmpRoot('offers-noctx-');

const OWN = {
  scope: 'discovery', boxes: 2, open: true, kinds: ['container'],
  facts: { os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] } },
};
const HELLO_ROW = {
  route: 'r1', provenance: 'hello', name: 'murmur', at: 1,
  offer: { scope: 'discovery', boxes: 4, open: false, kinds: ['container'], facts: { os: 'linux', arch: 'x64', cpus: 16, memMb: 65536, runtime: { platforms: ['linux/amd64'] } } },
};
const ANNOUNCE_ROW = {
  route: 'r2', provenance: 'announce', name: 'laptop', at: 2,
  offer: { scope: 'discovery', boxes: 1, open: true, kinds: ['container'], facts: { os: 'win32', arch: 'x64', cpus: 8, memMb: 512, runtime: null } },
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
        return send(200, { ok: true, version: 5, resources: [{ name: 'offers', singular: 'offers', scope: 'node', verbs: ['list'] }] });
      }
      if (req.url === '/api/offers') return send(200, body);
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

test('get offers prints the own offer, a hello row and an announce row', async () => {
  await withNode({ ok: true, own: OWN, offers: [HELLO_ROW, ANNOUNCE_ROW] }, async (port, seen) => {
    const { code, stdout, stderr } = await cli(['get', 'offers'], port);
    assert.strictEqual(stderr, '');
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, [
      'SOURCE    PEER    BOXES  OPEN  OS/ARCH       CPUS  MEMORY  RUNTIME',
      'self      -       2      yes   darwin/arm64  10    32G     linux/arm64',
      'hello     murmur  4      no    linux/x64     16    64G     linux/amd64',
      'announce  laptop  1      yes   win32/x64     8     512M    none',
      '',
    ].join('\n'));
    assert.deepStrictEqual(seen, ['/api/resources', '/api/offers']);
  });
});

test('get offers on an empty directory with no own offer prints the header alone', async () => {
  await withNode({ ok: true, own: null, offers: [] }, async (port) => {
    const { code, stdout } = await cli(['get', 'offers'], port);
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout, 'SOURCE  PEER  BOXES  OPEN  OS/ARCH  CPUS  MEMORY  RUNTIME\n');
  });
});

test('get offers -o json prints the route body', async () => {
  const body = { ok: true, own: OWN, offers: [HELLO_ROW] };
  await withNode(body, async (port) => {
    const { code, stdout } = await cli(['get', 'offers', '-o', 'json'], port);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(JSON.parse(stdout), body);
  });
});
