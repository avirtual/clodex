'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';
const YAML = 'game:\n  name: Bob\n  level: 4\nnotes:\n  tip: carrots\n';
const PROFILE = { game: { name: 'Bob', level: 4 }, notes: { tip: 'carrots' } };
const DOC = {
  ok: true, version: 1,
  resources: [{
    name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get', 'delete'],
    subresources: { 'memory/profile': ['get', 'put', 'patch', 'delete'] },
  }],
};

function node({ empty = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/resources') return send(200, DOC);
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'] || null, body });
      if (req.url.startsWith('/api/sessions/asst/memory/profile')) {
        if (req.method === 'DELETE') return send(200, { ok: true, existed: !empty });
        if (empty) return send(200, { ok: true, name: 'asst', profile: null, yaml: null, bytes: 0, updatedAt: null });
        return send(200, { ok: true, name: 'asst', profile: PROFILE, yaml: YAML, bytes: YAML.length, updatedAt: '2026-10-29T00:00:00.000Z' });
      }
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return { server, seen };
}

async function withNode(opts, fn) {
  const { server, seen } = node(opts);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try { return await fn(port, seen); } finally { server.close(); }
}

async function cli(argv, port) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl-t2078', 'contexts.json'),
    spawnFn: () => { throw new Error('spawnFn called'); },
  });
  return { code, stdout, stderr };
}

function tmpFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-profile-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('get session X --subresource profile prints the YAML as-is; -o json the body; none prints (no profile)', async () => {
  await withNode({}, async (port, seen) => {
    const r = await cli(['get', 'session', 'asst', '--subresource', 'profile'], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, YAML);
    assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), ['GET /api/sessions/asst/memory/profile']);
    const j = await cli(['get', 'session', 'asst', '--subresource', 'profile', '-o', 'json'], port);
    assert.deepStrictEqual(JSON.parse(j.stdout).profile, PROFILE);
  });
  await withNode({ empty: true }, async (port) => {
    const r = await cli(['get', 'session', 'asst', '--subresource', 'profile'], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, '(no profile)\n');
  });
});

test('patch session X --subresource profile -f file.yaml sends text/yaml with merge=1; --replace sends merge=0', async () => {
  const file = tmpFile('p.yaml', YAML);
  await withNode({}, async (port, seen) => {
    const r = await cli(['patch', 'session', 'asst', '--subresource', 'profile', '-f', file], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, YAML);
    assert.deepStrictEqual(seen[0], { method: 'PATCH', url: '/api/sessions/asst/memory/profile?merge=1', type: 'text/yaml', body: YAML });
    const rep = await cli(['patch', 'session', 'asst', '--subresource', 'profile', '--filename', file, '--replace'], port);
    const lead = await run(['--url', `http://127.0.0.1:${port}`, '--token', TOKEN, 'patch', 'session', 'asst', '--subresource', 'profile', '-f', file], {
      stdout: () => {}, stderr: () => {}, env: {},
      contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl-t2078', 'contexts.json'),
      spawnFn: () => { throw new Error('spawnFn called'); },
    });
    assert.strictEqual(lead, 0, 'global flags before patch still make -f the filename');
    assert.strictEqual(rep.code, 0, rep.stderr);
    assert.strictEqual(seen[1].url, '/api/sessions/asst/memory/profile?merge=0');
  });
});

test('patch session X --subresource profile -f file.json sends the parsed JSON body', async () => {
  const file = tmpFile('p.json', JSON.stringify({ game: { level: 5 } }));
  await withNode({}, async (port, seen) => {
    const r = await cli(['patch', 'session', 'asst', '--subresource', 'profile', '-f', file, '-o', 'json'], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(seen[0], { method: 'PATCH', url: '/api/sessions/asst/memory/profile?merge=1', type: 'application/json', body: '{"game":{"level":5}}' });
    assert.strictEqual(JSON.parse(r.stdout).yaml, YAML);
  });
});

test('patch without a file and an unknown subresource are usage errors that send nothing', async () => {
  await withNode({}, async (port, seen) => {
    const nofile = await cli(['patch', 'session', 'asst', '--subresource', 'profile'], port);
    assert.strictEqual(nofile.code, 2);
    assert.match(nofile.stderr, /needs -f/);
    const other = await cli(['delete', 'session', 'asst', '--subresource', 'args'], port);
    assert.strictEqual(other.code, 2);
    assert.match(other.stderr, /takes only profile/);
    assert.deepStrictEqual(seen, []);
  });
});

test('delete session X --subresource profile deletes only the profile, without the hard-delete confirm', async () => {
  await withNode({}, async (port, seen) => {
    const r = await cli(['delete', 'session', 'asst', '--subresource', 'profile'], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stdout, 'profile of asst deleted\n');
    assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), ['DELETE /api/sessions/asst/memory/profile']);
  });
  await withNode({ empty: true }, async (port) => {
    const r = await cli(['delete', 'session', 'asst', '--subresource', 'profile', '-o', 'json'], port);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, existed: false });
  });
});
