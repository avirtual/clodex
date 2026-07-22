'use strict';
// integration.test.js — the HTTP verbs end-to-end through main.run against a
// stub node:http server that plays remote.js's routes. Asserts method/path/
// headers(Bearer)/body, the read/write reshaping, --json passthrough, the
// kill-confirm gate, the input control acquire/release dance, and the auth
// (401) / not-found (404) exit codes.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/main');

const TOKEN = 'sekret';

// Build a stub server. `routes` maps "METHOD /path" (path may end in a name
// segment matched loosely) to a handler(req,res,body,recorded). Records every
// request for assertions.
function stub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers['authorization'] || '';
      // enforce the token like remote.js's gate
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      }
      const rec = { method: req.method, url: req.url, auth, body: body ? JSON.parse(body) : null };
      seen.push(rec);
      handler(req, res, rec);
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

// Run main.run with captured stdout/stderr and a direct-URL context via flags.
async function cli(argv, port, extra = {}) {
  let stdout = '', stderr = '';
  const code = await run([...argv, '--url', `http://127.0.0.1:${port}`, '--token', TOKEN], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    contextsFile: path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...extra,
  });
  return { code, stdout, stderr };
}

test('info: GET /api/peer/hello, Bearer header, human render', async () => {
  const { server, seen } = stub((req, res, rec) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'box', version: '3.4.0', caps: ['transcript', 'send'] }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['info'], port);
  assert.strictEqual(code, 0);
  assert.match(stdout, /host      box/);
  assert.strictEqual(seen[0].method, 'GET');
  assert.strictEqual(seen[0].url, '/api/peer/hello');
  assert.strictEqual(seen[0].auth, `Bearer ${TOKEN}`);
  server.close();
});

test('sessions --json: raw payload passthrough', async () => {
  const payload = { ok: true, sessions: [{ name: 'a', type: 'claude', cwd: '/w', activity: 'idle' }] };
  const { server } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify(payload)); });
  const port = await listen(server);
  const { code, stdout } = await cli(['sessions', '--json'], port);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(stdout), payload);
  server.close();
});

test('logs --tail maps to ?limit and renders role-prefixed lines', async () => {
  const { server, seen } = stub((req, res) => {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['logs', 'builder', '--tail', '5'], port);
  assert.strictEqual(code, 0);
  assert.match(seen[0].url, /\/api\/transcript\/builder\?limit=5/);
  assert.match(stdout, /\[user\] hi/);
  assert.match(stdout, /\[assistant\] yo/);
  server.close();
});

test('query: POST /api/query/:name with kind+args, JSON out', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, report: { usd: 1 } })); });
  const port = await listen(server);
  const { code } = await cli(['query', 'builder', 'report', '--detail'], port);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[0].url, '/api/query/builder');
  assert.deepStrictEqual(seen[0].body, { kind: 'report', args: { detail: true } });
  server.close();
});

test('query: bad kind is a usage error (exit 2), no request made', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const { code, stderr } = await cli(['query', 'builder', 'wat'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /query kind must be one of/);
  assert.strictEqual(seen.length, 0);
  server.close();
});

// A no-op sleep so the post-spawn liveness check adds no wall-clock wait.
const NOSLEEP = { sleepFn: async () => {} };

test('spawn: model rides extraArgs, not a top-level field', async () => {
  const { server, seen } = stub((req, res, rec) => {
    res.writeHead(200);
    // POST creates; the follow-up liveness GET must see the session alive.
    if (rec.method === 'GET' && rec.url === '/api/sessions') {
      return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'b', type: 'claude' }] }));
    }
    res.end(JSON.stringify({ ok: true, name: 'b', type: 'claude', pid: 9 }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['spawn', 'b', '--cwd', '/w', '--type', 'claude', '--model', 'opus', '--arg', '--foo'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[0].url, '/api/sessions');
  assert.strictEqual(seen[0].body.model, undefined);
  assert.deepStrictEqual(seen[0].body.extraArgs, ['--model', 'opus', '--foo']);
  assert.match(stdout, /spawned b \(claude\) pid=9/);
  server.close();
});

test('spawn: dead-on-arrival child (gone from the live list) reports WHY, not a bare pid', async () => {
  const { server, seen } = stub((req, res, rec) => {
    res.writeHead(200);
    // Spawn returns a pid, but the liveness GET shows the session already gone.
    if (rec.method === 'GET' && rec.url === '/api/sessions') {
      return res.end(JSON.stringify({ ok: true, sessions: [] }));
    }
    res.end(JSON.stringify({ ok: true, name: 'w2', type: 'claude', pid: 4242 }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['spawn', 'w2', '--cwd', '/w', '--type', 'claude'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.match(stdout, /exited immediately/);
  assert.match(stdout, /claude` CLI isn't installed on the node/);
  assert.match(stdout, /deploy/);
  // We still ran exactly the spawn POST then the liveness GET.
  assert.strictEqual(seen[0].method, 'POST');
  assert.strictEqual(seen[1].method, 'GET');
  assert.strictEqual(seen[1].url, '/api/sessions');
  server.close();
});

test('spawn --json: carries alive:false when the child is dead on arrival', async () => {
  const { server } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') return res.end(JSON.stringify({ ok: true, sessions: [] }));
    res.end(JSON.stringify({ ok: true, name: 'w2', type: 'claude', pid: 4242 }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['spawn', 'w2', '--type', 'claude', '--json'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  const obj = JSON.parse(stdout);
  assert.strictEqual(obj.alive, false);
  assert.strictEqual(obj.pid, 4242);
  server.close();
});

test('spawn: a liveness read failure stays optimistic (alive unknown → normal line)', async () => {
  let n = 0;
  const { server } = stub((req, res, rec) => {
    if (rec.method === 'GET' && rec.url === '/api/sessions') {
      // Simulate a transient read failure on the liveness probe.
      res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: 'boom' }));
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true, name: 'w3', type: 'claude', pid: 7 }));
    n++;
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['spawn', 'w3', '--type', 'claude'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  // Unknown liveness → we do NOT cry wolf; the normal spawned line stands.
  assert.match(stdout, /spawned w3 \(claude\) pid=7/);
  assert.doesNotMatch(stdout, /exited immediately/);
  server.close();
});

test('send: fire-and-forget POST /api/send', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true })); });
  const port = await listen(server);
  const { code } = await cli(['send', 'b', 'fix', 'the', 'tests'], port);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[0].url, '/api/send');
  assert.deepStrictEqual(seen[0].body, { name: 'b', text: 'fix the tests' });
  server.close();
});

test('input: acquire → input → release, in order, token threaded, Enter appended', async () => {
  const { server, seen } = stub((req, res) => {
    if (req.url.startsWith('/api/control/')) {
      const body = seen[seen.length - 1].body;
      if (body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const { code } = await cli(['input', 'b', 'hello'], port);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
    'POST /api/control/b', 'POST /api/input/b', 'POST /api/control/b',
  ]);
  assert.strictEqual(seen[0].body.action, 'acquire');
  assert.strictEqual(seen[1].body.token, 'ctl-1');
  // default: Enter appended so the command actually runs
  assert.strictEqual(seen[1].body.data, 'hello\r');
  assert.strictEqual(seen[2].body.action, 'release');
  server.close();
});

test('input --no-enter: posts the text verbatim, no trailing CR', async () => {
  const { server, seen } = stub((req, res) => {
    if (req.url.startsWith('/api/control/')) {
      const body = seen[seen.length - 1].body;
      if (body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const { code } = await cli(['input', 'b', 'partial', '--no-enter'], port);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[1].body.data, 'partial');
  assert.ok(!seen[1].body.data.endsWith('\r'));
  server.close();
});

test('kill: confirm prompt gate — matching name proceeds; mismatch aborts', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, name: 'doomed' })); });
  const port = await listen(server);
  // matching answer → proceeds
  const ok = await cli(['kill', 'doomed'], port, { prompt: async () => 'doomed' });
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(seen[0].url, '/api/kill/doomed');
  // mismatched answer → aborts with usage error, no further request
  const before = seen.length;
  const bad = await cli(['kill', 'doomed'], port, { prompt: async () => 'nope' });
  assert.strictEqual(bad.code, 2);
  assert.match(bad.stderr, /confirmation did not match/);
  assert.strictEqual(seen.length, before);
  server.close();
});

test('kill --force: no prompt, hard-delete message', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, name: 'doomed' })); });
  const port = await listen(server);
  const { code, stdout } = await cli(['kill', 'doomed', '--force'], port);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[0].url, '/api/kill/doomed');
  assert.match(stdout, /hard delete/);
  server.close();
});

test('kill --json without --force is a usage error (no request)', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const { code, stderr } = await cli(['kill', 'doomed', '--json'], port);
  assert.strictEqual(code, 2);
  assert.match(stderr, /--force/);
  assert.strictEqual(seen.length, 0);
  server.close();
});

test('auth: 401 → exit 4', async () => {
  const { server } = stub((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  let stdout = '', stderr = '';
  const code = await run(['info', '--url', `http://127.0.0.1:${port}`, '--token', 'wrong'], {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {},
    contextsFile: path.join(os.tmpdir(), 'nope', 'c.json'),
  });
  assert.strictEqual(code, 4);
  assert.match(stderr, /unauthorized/);
  server.close();
});

test('not-found: 404 → exit 5', async () => {
  const { server } = stub((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no such session' })); });
  const port = await listen(server);
  const { code, stderr } = await cli(['logs', 'ghost'], port);
  assert.strictEqual(code, 5);
  assert.match(stderr, /no such session/);
  server.close();
});

test('connect failure: unreachable port → exit 3', async () => {
  const { code, stderr } = await cli(['info'], 1); // port 1: refused
  assert.strictEqual(code, 3);
  assert.match(stderr, /cannot reach the engine/);
});
