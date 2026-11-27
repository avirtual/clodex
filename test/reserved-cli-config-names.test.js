'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RemoteServer } = require('../remote');
const { createSeatImport } = require('../seat-import');
const { run: cliRun } = require('../cli/src/main');
const nameValidity = require('../renderer/lib/name-validity');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');

const RESERVED = ['.claude', 'CLAUDE.md', '.mcp.json', 'claude.md', '.MCP.JSON'];
const NEAR_MISS = ['.claudex', 'CLAUDE.mdx'];
const AGENT_NAME_RE_T = /^[a-zA-Z0-9._-]{1,64}$/;
const SID = '11111111-2222-3333-4444-555555555555';

function entriesNamed(root, name) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name.toLowerCase() === name.toLowerCase()) hits.push(p);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return hits;
}

function req(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function withRemote(fn) {
  const created = [];
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: path.join(__dirname, '..', 'renderer', 'remote.html'),
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    createSession: async (msg) => { created.push(msg.name); return { ok: true, name: msg.name, type: 'claude', pid: 9 }; },
  });
  await server.start();
  try { return await fn(server, created); } finally { server.stop(); }
}

function mkImport() {
  const root = mkTmpRoot('clodex-rsv-imp-');
  const claudeProjects = mkTmpRoot('clodex-rsv-cp-');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', '.migrated'),
    `${JSON.stringify({ kinds: { messages: 'x', notices: 'x', promptcache: 'x', memory: 'x', spill: 'x', monitors: 'x', run: 'x' } })}\n`);
  const imp = createSeatImport({ root, claudeProjects, reminders: { add: (r) => ({ id: 'r1', ...r }) }, fs });
  return { root, imp };
}

const CWD = path.join(mkTmpRoot('clodex-rsv-proj-'), 'app');

test('the main and renderer reserved lists are the same literal set', () => {
  const { RESERVED_SEAT_NAMES } = require('../pending-store');
  assert.deepStrictEqual([...RESERVED_SEAT_NAMES].sort(), ['.claims', '.claude', '.mcp.json', 'claude.md']);
  assert.deepStrictEqual([...nameValidity.RESERVED_SEAT_NAMES].sort(), [...RESERVED_SEAT_NAMES].sort());
});

for (const name of RESERVED) {
  test(`create refuses ${name} and leaves nothing of that name under the registry`, async () => {
    const reg = mkTmpRoot('clodex-rsv-reg-');
    const m = mk({ REGISTRY_DIR: reg });
    await assert.rejects(() => m.create(name, 'claude', null), { message: `"${name}" is a reserved name` });
    assert.strictEqual(m.sessions.has(name), false);
    assert.deepStrictEqual(entriesNamed(reg, name), []);
  });

  test(`rename refuses ${name} as the new name`, async () => {
    const m = mk({});
    assert.deepStrictEqual(await m.rename('alpha', name), { ok: false, error: `"${name}" is a reserved name` });
  });

  test(`spawn refuses ${name}`, () => {
    const m = mk({ AGENT_NAME_RE: AGENT_NAME_RE_T });
    assert.deepStrictEqual(m._validateSeatName(name), { ok: false, error: `"${name}" is a reserved name` });
  });

  test(`the renderer name field refuses ${name}`, () => {
    assert.strictEqual(nameValidity.nameFieldState(name).kind, 'reserved');
  });

  test(`seat-import begin and commit refuse ${name} and stage nothing of that name`, () => {
    const { root, imp } = mkImport();
    assert.strictEqual(imp.begin({ name, record: { type: 'claude', sessionId: SID, cwd: CWD } }).error, `"${name}" is a reserved name`);
    assert.ok(!fs.existsSync(path.join(root, 'import')) || fs.readdirSync(path.join(root, 'import')).length === 0, 'begin staged nothing');
    const { id } = imp.begin({ name: 'ana', record: { type: 'claude', sessionId: SID, cwd: CWD } });
    assert.ok(id, 'ENTER: a legal begin stages');
    imp.putFile({ id, relPath: 'transcript.jsonl', bytes: Buffer.from('{"t":1}\n') });
    const mf = path.join(root, 'import', id, 'manifest.json');
    fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), name }));
    assert.strictEqual(imp.commit({ id }).error, `"${name}" is a reserved name`);
    assert.deepStrictEqual(entriesNamed(root, name), []);
  });

  test(`the peer API create refuses ${name} with the shared text`, async () => {
    await withRemote(async (server, created) => {
      const r = await req(server.port, '/api/sessions', {
        method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' },
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(JSON.parse(r.body).error, `"${name}" is a reserved name`);
      assert.deepStrictEqual(created, []);
    });
  });

  test(`clodexctl create session ${name} passes the server refusal through`, async () => {
    await withRemote(async (server, created) => {
      let stderr = '';
      const code = await cliRun(['create', 'session', name, '--type', 'claude', '--url', `http://127.0.0.1:${server.port}`, '--token', 't'], {
        stdout: () => {}, stderr: (s) => { stderr += s; }, env: {},
        contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
        sleepFn: async () => {},
      });
      assert.notStrictEqual(code, 0);
      assert.ok(stderr.includes(`"${name}" is a reserved name`), stderr);
      assert.deepStrictEqual(created, []);
    });
  });

  test(`a persisted seat named ${name} still restores, renames away and is served by the per-session routes`, async () => {
    const m = mk({ getPersistence: () => ({ list: () => [], get: (n) => (n === name ? { name } : null) }) });
    await assert.rejects(() => m.create(name, 'claude', null), (err) => !/is a reserved name/.test(err.message));
    const r = await m.rename(name, 'renamed-away');
    assert.ok(!(r && /is a reserved name/.test(r.error || '')), JSON.stringify(r));
    await withRemote(async (server) => {
      const get = await req(server.port, `/api/sessions/${encodeURIComponent(name)}`);
      assert.doesNotMatch(get.body, /bad session name/);
    });
  });
}

for (const name of NEAR_MISS) {
  test(`the near-miss ${name} is accepted by spawn, the name field, seat-import and the peer API`, async () => {
    const m = mk({ AGENT_NAME_RE: AGENT_NAME_RE_T });
    assert.deepStrictEqual(m._validateSeatName(name), { ok: true });
    assert.strictEqual(nameValidity.nameFieldState(name).ok, true);
    await assert.rejects(() => mk({}).create(name, 'claude', null), (err) => !/is a reserved name/.test(err.message));
    const { imp } = mkImport();
    assert.strictEqual(imp.begin({ name, record: { type: 'claude', sessionId: SID, cwd: CWD } }).ok, true);
    await withRemote(async (server, created) => {
      const r = await req(server.port, '/api/sessions', {
        method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' },
      });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(created, [name]);
    });
  });
}
