'use strict';
// integration.test.js — the HTTP verbs end-to-end through main.run against a
// stub node:http server that plays remote.js's routes. Asserts method/path/
// headers(Bearer)/body, the read/write reshaping, -o json passthrough, the
// kill-confirm gate, the input control acquire/release dance, and the auth
// (401) / not-found (404) exit codes.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/main');
const { RESOURCES_DOC, docWithout, docWithoutVerb } = require('./fixtures/resources-doc');

const TOKEN = 'sekret';

// Build a stub server. `routes` maps "METHOD /path" (path may end in a name
// segment matched loosely) to a handler(req,res,body,recorded). Records every
// request for assertions.
function stub(handler, resourcesOverride = {}) {
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
      if (req.method === 'GET' && req.url.split('?')[0] === '/api/resources' && !resourcesOverride.skip) {
        res.writeHead(200); return res.end(JSON.stringify(resourcesOverride.doc || RESOURCES_DOC));
      }
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

test('get sessions -o json: raw payload passthrough', async () => {
  const payload = { ok: true, sessions: [{ name: 'a', type: 'claude', cwd: '/w', activity: 'idle' }] };
  const { server } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify(payload)); });
  const port = await listen(server);
  const { code, stdout } = await cli(['get', 'sessions', '-o', 'json'], port);
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
  assert.strictEqual(seen[0].url, '/api/resources', 'the capability check precedes the first request');
  assert.match(seen[1].url, /^\/api\/sessions\/builder\/transcript\?limit=5$/);
  assert.match(stdout, /\[user\] hi/);
  assert.match(stdout, /\[assistant\] yo/);
  server.close();
});

test('query: POST /api/sessions/:name/query with kind+args, JSON out', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, report: { usd: 1 } })); });
  const port = await listen(server);
  const { code } = await cli(['query', 'builder', 'report', '--detail'], port);
  assert.strictEqual(code, 0);
  assert.strictEqual(seen[0].url, '/api/resources', 'the capability check precedes the first request');
  assert.strictEqual(seen[1].method, 'POST');
  assert.strictEqual(seen[1].url, '/api/sessions/builder/query');
  assert.deepStrictEqual(seen[1].body, { kind: 'report', args: { detail: true } });
  server.close();
});

test('query: a node whose sessions row carries no query subresource is the D.5 line, exit 1', async () => {
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['query'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc: docWithout('query') });
  const port = await listen(server);
  const { code, stderr } = await cli(['query', 'builder', 'report'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions/query post; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'POST'), 'the check ran BEFORE the first request');
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
  const { code, stdout } = await cli(['spawn', 'w2', '--type', 'claude', '-o', 'json'], port, NOSLEEP);
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

// --- T46: spawn --env KEY=VALUE + the old-box ack-echo warning ---------------
test('spawn --env: repeatable KEY=VALUE tokens ride body.env; ack echo matches → no warning', async () => {
  const { server, seen } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') {
      return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'w', type: 'claude' }] }));
    }
    // A current box applies both keys and echoes them back sorted.
    res.end(JSON.stringify({ ok: true, name: 'w', type: 'claude', pid: 9, envKeys: ['AWS_PROFILE', 'AWS_ROLE_SESSION_NAME'] }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(
    ['spawn', 'w', '--cwd', '/w', '--type', 'claude', '--env', 'AWS_PROFILE=acct', '--env', 'AWS_ROLE_SESSION_NAME=w'],
    port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen[0].body.env, { AWS_PROFILE: 'acct', AWS_ROLE_SESSION_NAME: 'w' });
  assert.match(stdout, /spawned w \(claude\) pid=9/);
  assert.doesNotMatch(stdout, /WARNING/); // full echo → nothing dropped
  server.close();
});

test('spawn --env: a value may contain "=" (split on the FIRST equals only)', async () => {
  const { server, seen } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'w', type: 'bash' }] }));
    res.end(JSON.stringify({ ok: true, name: 'w', type: 'bash', pid: 3, envKeys: ['TOKEN'] }));
  });
  const port = await listen(server);
  const { code } = await cli(['spawn', 'w', '--cwd', '/w', '--type', 'bash', '--env', 'TOKEN=a=b=c'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen[0].body.env, { TOKEN: 'a=b=c' });
  server.close();
});

test('spawn --env: an OLD box (no envKeys in the ack) warns loudly that env was NOT applied', async () => {
  const { server } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'w', type: 'claude' }] }));
    // Box predates env support: the ack carries NO envKeys field.
    res.end(JSON.stringify({ ok: true, name: 'w', type: 'claude', pid: 9 }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(['spawn', 'w', '--cwd', '/w', '--type', 'claude', '--env', 'AWS_PROFILE=acct'], port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.match(stdout, /WARNING: env NOT applied — this node predates env support/);
  assert.match(stdout, /AWS_PROFILE/);
  server.close();
});

test('spawn --env: a box that DROPPED a key (sanitize/deny) warns naming just the missing key', async () => {
  const { server } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'w', type: 'claude' }] }));
    // Applied OK but dropped CLODEX_REMOTE_TOKEN (deny-listed server-side).
    res.end(JSON.stringify({ ok: true, name: 'w', type: 'claude', pid: 9, envKeys: ['OK'] }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(
    ['spawn', 'w', '--cwd', '/w', '--type', 'claude', '--env', 'OK=1', '--env', 'CLODEX_REMOTE_TOKEN=leak'],
    port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.match(stdout, /WARNING: some env vars were NOT applied by the node \(rejected\/denied\): CLODEX_REMOTE_TOKEN/);
  assert.doesNotMatch(stdout, /predates env support/); // the field WAS present → not an old box
  server.close();
});

test('spawn --env --json: the mismatch warning is SUPPRESSED (raw-payload stdout stays clean JSON)', async () => {
  // Review SHOULD-FIX 2: printer.line contaminates the --json wire-payload
  // contract. Even a DROPPED key (which loudly warns in human mode) must not print
  // a warning line to stdout under --json — the JSON already carries envKeys.
  const { server } = stub((req, res, rec) => {
    res.writeHead(200);
    if (rec.method === 'GET' && rec.url === '/api/sessions') return res.end(JSON.stringify({ ok: true, sessions: [{ name: 'w', type: 'claude' }] }));
    res.end(JSON.stringify({ ok: true, name: 'w', type: 'claude', pid: 9, envKeys: ['OK'] }));
  });
  const port = await listen(server);
  const { code, stdout } = await cli(
    ['spawn', 'w', '--cwd', '/w', '--type', 'claude', '-o', 'json', '--env', 'OK=1', '--env', 'CLODEX_REMOTE_TOKEN=leak'],
    port, NOSLEEP);
  assert.strictEqual(code, 0);
  assert.doesNotMatch(stdout, /WARNING/, 'no human warning line under --json');
  const parsed = JSON.parse(stdout); // stdout is parseable JSON, uncontaminated
  assert.deepStrictEqual(parsed.envKeys, ['OK'], 'the payload still carries the applied keys');
  server.close();
});

test('spawn --env: a shapeless token (no "=") is a usage error before any request', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const { code, stderr } = await cli(['spawn', 'w', '--cwd', '/w', '--type', 'claude', '--env', 'JUSTAKEY'], port, NOSLEEP);
  assert.strictEqual(code, 2);
  assert.match(stderr, /--env must be KEY=VALUE/);
  assert.strictEqual(seen.length, 0); // rejected before the POST
  server.close();
});

test('send: fire-and-forget POST /api/sessions/:name/dm — the name rides the path, not the body', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true })); });
  const port = await listen(server);
  const { code } = await cli(['send', 'b', 'fix', 'the', 'tests'], port);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen.map((x) => `${x.method} ${x.url}`), ['GET /api/resources', 'POST /api/sessions/b/dm']);
  assert.deepStrictEqual(seen[1].body, { text: 'fix the tests' });
  server.close();
});

test('send: a node whose sessions row carries no dm subresource is the D.5 line, exit 1', async () => {
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['send'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc: docWithout('dm') });
  const port = await listen(server);
  const { code, stderr } = await cli(['send', 'b', 'hi'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions/dm post; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'POST'), 'the check ran BEFORE the send');
  server.close();
});

test('restart: a node whose sessions row carries no restart subresource is the D.5 line, exit 1', async () => {
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['create'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc: docWithout('restart') });
  const port = await listen(server);
  const { code, stderr } = await cli(['restart', 'b'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions/restart post; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'POST'), 'the check ran BEFORE the restart');
  server.close();
});

test('args set: a node whose args subresource carries no patch verb is the D.5 line, exit 1', async () => {
  const doc = docWithout('args');
  doc.resources[0].subresources.args = ['get'];
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['args'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc });
  const port = await listen(server);
  const { code, stderr } = await cli(['args', 'set', 'b', '--arg', '--x'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions/args patch; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'PATCH'), 'the check ran BEFORE the write');
  server.close();
});

test('kill: a node whose sessions row carries no delete verb is the D.5 line, exit 1', async () => {
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['create'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc: docWithoutVerb('delete') });
  const port = await listen(server);
  const { code, stderr } = await cli(['kill', 'doomed', '--force'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions delete; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'DELETE'), 'the check ran BEFORE the delete');
  server.close();
});

test('input: acquire → input → release, in order, token threaded, Enter appended', async () => {
  const { server, seen } = stub((req, res) => {
    if (/^\/api\/sessions\/[^/]+\/control(\?|$)/.test(req.url)) {
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
    'GET /api/resources',
    'POST /api/sessions/b/control', 'POST /api/sessions/b/input', 'POST /api/sessions/b/control',
  ], 'one capability check, then the acquire/input/release thread');
  assert.strictEqual(seen[1].body.action, 'acquire');
  assert.strictEqual(seen[2].body.token, 'ctl-1');
  // default: Enter appended so the command actually runs
  assert.strictEqual(seen[2].body.data, 'hello\r');
  assert.strictEqual(seen[3].body.action, 'release');
  server.close();
});

test('input --no-enter: posts the text verbatim, no trailing CR', async () => {
  const { server, seen } = stub((req, res) => {
    if (/^\/api\/sessions\/[^/]+\/control(\?|$)/.test(req.url)) {
      const body = seen[seen.length - 1].body;
      if (body.action === 'acquire') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, token: 'ctl-1' })); }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const { code } = await cli(['input', 'b', 'partial', '--no-enter'], port);
  assert.strictEqual(code, 0);
  const sent = seen.find((x) => /\/input$/.test(x.url));
  assert.strictEqual(sent.body.data, 'partial');
  assert.ok(!sent.body.data.endsWith('\r'));
  server.close();
});

test('input: a node whose sessions row carries no control subresource is the D.5 line, exit 1', async () => {
  const { server, seen } = stub((req, res, rec) => {
    if (rec.url === '/api/peer/hello') { res.writeHead(200); return res.end(JSON.stringify({ ok: true, host: 'oldbox', version: '5.69.0', caps: ['control'] })); }
    res.writeHead(200); res.end('{}');
  }, { doc: docWithout('control') });
  const port = await listen(server);
  const { code, stderr } = await cli(['input', 'b', 'hello'], port);
  assert.strictEqual(code, 1, 'D.5 says exit 1 (EXIT.SERVER)');
  assert.strictEqual(stderr.trim(), 'clodexctl: node oldbox (5.69.0) does not serve sessions/control post; run: clodexctl upgrade node http://127.0.0.1:' + port);
  assert.ok(!seen.some((s) => s.method === 'POST'), 'the check ran BEFORE the acquire');
  server.close();
});

test('kill: confirm prompt gate — matching name proceeds; mismatch aborts', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, name: 'doomed' })); });
  const port = await listen(server);
  // matching answer → proceeds
  const ok = await cli(['kill', 'doomed'], port, { prompt: async () => 'doomed' });
  assert.strictEqual(ok.code, 0);
  assert.deepStrictEqual(seen.map((x) => `${x.method} ${x.url}`), ['GET /api/resources', 'DELETE /api/sessions/doomed']);
  // mismatched answer → aborts with usage error; only the capability check rode the wire
  const bad = await cli(['kill', 'doomed'], port, { prompt: async () => 'nope' });
  assert.strictEqual(bad.code, 2);
  assert.match(bad.stderr, /confirmation did not match/);
  assert.deepStrictEqual(seen.slice(2).map((x) => `${x.method} ${x.url}`), ['GET /api/resources'], 'the abort sent no delete');
  server.close();
});

test('kill --force: no prompt, hard-delete message', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, name: 'doomed' })); });
  const port = await listen(server);
  const { code, stdout } = await cli(['kill', 'doomed', '--force'], port);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen.map((x) => `${x.method} ${x.url}`), ['GET /api/resources', 'DELETE /api/sessions/doomed']);
  assert.match(stdout, /hard delete/);
  server.close();
});

test('kill --json without --force is a usage error (no request)', async () => {
  const { server, seen } = stub((req, res) => { res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const { code, stderr } = await cli(['kill', 'doomed', '-o', 'json'], port);
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
