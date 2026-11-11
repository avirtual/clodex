'use strict';
// remote-auth.test.js — the RemoteServer operator-auth gate (remote-auth-plan.md [internal design doc, not in this repo]
// §2–3). Real HTTP requests against a port-0 server: the 401/200 matrix, the
// fail-closed 503 on a non-loopback bind with no token, the CLODEX_REMOTE_INSECURE
// escape hatch, the ?token= → HttpOnly cookie set + replay, and that SSE is gated
// like everything else.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

// A real remote.html exists in the repo — use it so the viewer-page path serves
// a 200 body (the gate runs before _page, which is what we're testing).
const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function minimal(extra) {
  return new RemoteServer({
    port: 0, pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...extra,
  });
}

// One request → { status, headers, body }. `opts` may carry headers.
function req(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

async function withServer(extra, fn) {
  const server = minimal(extra);
  await server.start();
  try { return await fn(server.port); } finally { server.stop(); }
}

// ── no token configured, loopback bind → localhost-trust (unchanged) ─────────

test('no token + loopback bind: everything serves (localhost-trust preserved)', async () => {
  await withServer({ host: '127.0.0.1' }, async (port) => {
    const page = await req(port, '/');
    assert.equal(page.status, 200, 'viewer page served');
    const sessions = await req(port, '/api/sessions');
    assert.equal(sessions.status, 200, 'api served');
  });
});

test('no token + loopback: a foreign-Origin dm POST is a 403 naming Origin; a non-loopback Host is a 403 naming Host', async () => {
  await withServer({ host: '127.0.0.1' }, async (port) => {
    const body = JSON.stringify({ text: 'hi' });
    const foreign = await req(port, '/api/sessions/alice/dm', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.match(foreign.body, /Origin/);
    const rebound = await req(port, '/api/sessions', { headers: { host: 'evil.example:7900' } });
    assert.equal(rebound.status, 403);
    assert.match(rebound.body, /Host/);
  });
});

test('dm POST: text/plain from a loopback Origin is a 415; application/json passes the gate', async () => {
  const sent = [];
  await withServer({ host: '127.0.0.1', send: (...a) => { sent.push(a); return { ok: true }; } }, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ text: 'hi' });
    const plain = await req(port, '/api/sessions/alice/dm', { method: 'POST', body, headers: { 'content-type': 'text/plain', origin } });
    assert.equal(plain.status, 415);
    assert.equal(sent.length, 0);
    const json = await req(port, '/api/sessions/alice/dm', { method: 'POST', body, headers: { 'content-type': 'application/json', origin } });
    assert.equal(json.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'alice');
  });
});

const JSON_ROUTES = [
  ['POST', '/api/sessions/alice/query'],
  ['POST', '/api/sessions/alice/dm'],
  ['POST', '/api/sessions/alice/restart'],
  ['POST', '/api/sessions/alice/control'],
  ['POST', '/api/sessions/alice/input'],
  ['POST', '/api/sessions/alice/resize'],
  ['PATCH', '/api/sessions/alice/args'],
  ['PATCH', '/api/sessions/alice/skills'],
  ['PUT', '/api/sessions/alice/client-token'],
  ['POST', '/api/import/begin'],
  ['POST', '/api/wterm-input/alice'],
  ['POST', '/api/wterm-resize/alice'],
  ['POST', '/api/sessions'],
  ['POST', '/api/dm'],
  ['POST', '/api/dm/claim'],
  ['POST', '/api/peer/roster'],
  ['POST', '/api/inbox/reply/n1'],
  ['POST', '/api/suite/jobs'],
  ['POST', '/api/suite/jobs/j1/commit'],
];

test('every JSON body route: text/plain is a 415, application/json is not', async () => {
  assert.equal(JSON_ROUTES.length, 19);
  const stub = () => Promise.resolve({ ok: true });
  const deps = {
    host: '127.0.0.1', query: stub, restartSession: stub, sendInput: stub, resizePty: stub,
    setSessionArgs: stub, setSessionSkills: stub, setClientToken: stub,
    seatImport: { begin: () => ({ ok: true }) }, importCreate: stub,
    wtermInput: stub, wtermResize: stub, createSession: stub,
    deliverDm: stub, claimDms: stub, receiveRoster: stub,
    notifications: { page: () => [], unreadCount: () => 0, get: () => null }, replyNote: stub,
    suiteRunner: { submit: stub, commit: stub },
  };
  await withServer(deps, async (port) => {
    const origin = `http://127.0.0.1:${port}`;
    for (const [method, pathname] of JSON_ROUTES) {
      const plain = await req(port, pathname, { method, body: '{}', headers: { 'content-type': 'text/plain', origin } });
      assert.equal(plain.status, 415, `${method} ${pathname} text/plain`);
      const json = await req(port, pathname, { method, body: '{}', headers: { 'content-type': 'application/json', origin } });
      assert.notEqual(json.status, 415, `${method} ${pathname} application/json`);
    }
  });
});

// ── fail-closed: non-loopback + no token → 503 ───────────────────────────────

test('non-loopback bind with no token → 503 naming CLODEX_REMOTE_TOKEN', async () => {
  await withServer({ host: '0.0.0.0' }, async (port) => {
    const r = await req(port, '/');
    assert.equal(r.status, 503, 'refuses to serve');
    assert.match(r.body, /CLODEX_REMOTE_TOKEN/, 'names the env var to set');
    // The API is refused too, not just the page.
    const api = await req(port, '/api/sessions');
    assert.equal(api.status, 503);
  });
});

test('escape hatch: non-loopback + no token + insecure → serves a loopback or IP-literal Host, refuses a hostname, still refuses a foreign Origin', async () => {
  await withServer({ host: '0.0.0.0', insecure: true }, async (port) => {
    const r = await req(port, '/api/sessions');
    assert.equal(r.status, 200, 'insecure override serves with no token');
    const lan = await req(port, '/api/sessions', { headers: { host: `192.168.1.20:${port}` } });
    assert.equal(lan.status, 200, 'insecure override lifts the loopback Host rule');
    const lanSame = await req(port, '/api/sessions', { headers: { host: `192.168.1.20:${port}`, origin: `http://192.168.1.20:${port}` } });
    assert.equal(lanSame.status, 200, 'insecure override serves a matching Origin');
    const cross = await req(port, '/api/sessions', { headers: { host: `192.168.1.20:${port}`, origin: 'http://evil.example' } });
    assert.equal(cross.status, 403, 'insecure override keeps the Origin comparison');
    assert.match(cross.body, /Origin header does not match this host/);
    const rebound = await req(port, '/api/sessions', { headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` } });
    assert.equal(rebound.status, 403, 'insecure override refuses a DNS-rebound hostname');
    assert.match(rebound.body, /Host header does not match this host/);
  });
});

test('loopback + no token + no insecure: a LAN Host/Origin is still a 403', async () => {
  await withServer({ host: '127.0.0.1' }, async (port) => {
    const lan = await req(port, '/api/sessions', { headers: { host: `192.168.1.20:${port}`, origin: `http://192.168.1.20:${port}` } });
    assert.equal(lan.status, 403);
  });
});

// ── token configured: 401/200 matrix across query / bearer / cookie ──────────

test('token configured: no credential → 401 + WWW-Authenticate', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    const r = await req(port, '/api/sessions');
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  });
});

test('token configured: wrong token → 401, correct token → 200 (query, bearer, cookie)', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    assert.equal((await req(port, '/api/sessions?token=nope')).status, 401, 'wrong query token');
    assert.equal((await req(port, '/api/sessions?token=sekret')).status, 200, 'right query token');
    assert.equal((await req(port, '/api/sessions', { headers: { authorization: 'Bearer sekret' } })).status, 200, 'right bearer');
    assert.equal((await req(port, '/api/sessions', { headers: { authorization: 'Bearer nope' } })).status, 401, 'wrong bearer');
    assert.equal((await req(port, '/api/sessions', { headers: { cookie: 'clodex_remote_token=sekret' } })).status, 200, 'right cookie');
    assert.equal((await req(port, '/api/sessions', { headers: { cookie: 'clodex_remote_token=nope' } })).status, 401, 'wrong cookie');
  });
});

test('token configured + cookie: a cross-port Origin on the bodyless POST /api/restart is a 403 and never restarts; same-origin and Origin-less pass', async () => {
  let restarts = 0;
  await withServer({ host: '127.0.0.1', token: 'sekret', restartApp: () => { restarts += 1; } }, async (port) => {
    const cookie = 'clodex_remote_token=sekret';
    const cross = await req(port, '/api/restart', { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:9999' } });
    assert.equal(cross.status, 403);
    assert.match(cross.body, /Origin header does not match this host/);
    assert.equal(restarts, 0, 'the restart handler never ran');
    const same = await req(port, '/api/restart', { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${port}` } });
    assert.equal(same.status, 200);
    assert.equal(restarts, 1);
    const bare = await req(port, '/api/restart', { method: 'POST', headers: { cookie } });
    assert.equal(bare.status, 200);
    assert.equal(restarts, 2);
  });
});

// ── cookie set on the ?token= bookmark hit, then replayed ────────────────────

test('valid ?token= sets an HttpOnly SameSite=Strict cookie; a later cookie-only request authenticates', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    const first = await req(port, '/?token=sekret');
    assert.equal(first.status, 200, 'bookmark hit serves the page');
    const setCookie = first.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length, 'a cookie was issued');
    const cookie = setCookie[0];
    assert.match(cookie, /clodex_remote_token=sekret/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    // No TLS at the edge here → no Secure flag.
    assert.doesNotMatch(cookie, /Secure/);
    // The viewer's later XHR carries only the cookie and is accepted.
    const replay = await req(port, '/api/sessions', { headers: { cookie: 'clodex_remote_token=sekret' } });
    assert.equal(replay.status, 200);
  });
});

test('cookie gains Secure when x-forwarded-proto is https', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    const r = await req(port, '/?token=sekret', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(r.headers['set-cookie'][0], /Secure/);
  });
});

test('a bearer/cookie request does NOT re-issue the cookie (only the ?token= bookmark seeds it)', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    const bearer = await req(port, '/api/sessions', { headers: { authorization: 'Bearer sekret' } });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.headers['set-cookie'], undefined, 'no cookie on the bearer path');
  });
});

// ── SSE is gated too ─────────────────────────────────────────────────────────

test('SSE stream is gated: 401 without a token, connects with one', async () => {
  await withServer({ host: '0.0.0.0', token: 'sekret' }, async (port) => {
    const denied = await req(port, '/api/events');
    assert.equal(denied.status, 401, 'SSE refused without a token');

    // With a token the stream opens (200, event-stream). Read the first frame
    // then hang up — the server keeps it open otherwise.
    const opened = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/events?token=sekret' }, (res) => {
        res.once('data', () => { r.destroy(); resolve({ status: res.statusCode, ctype: res.headers['content-type'] }); });
      });
      r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      r.end();
    });
    assert.equal(opened.status, 200);
    assert.match(opened.ctype, /text\/event-stream/);
  });
});

test('the suite token reaches hello and /api/suite/* only: every other route family is 403', async () => {
  const fs = require('node:fs');
  const stub = () => Promise.resolve({ ok: true });
  const deps = {
    host: '127.0.0.1', token: 'op-secret', suiteToken: 'suite-secret',
    suiteRunner: { info: () => Promise.resolve({ ok: true, bootId: 'b' }) },
    createSession: stub, deliverDm: stub, seatImport: { begin: () => ({ ok: true }) }, importCreate: stub,
    restartApp: stub, nodeLogFile: () => '/nonexistent', notifications: { page: () => [], unreadCount: () => 0, get: () => null },
  };
  const rows = [
    ['GET', '/'],
    ['GET', '/api/sessions'],
    ['GET', '/api/events'],
    ['GET', '/api/resources'],
    ['POST', '/api/sessions'],
    ['POST', '/api/dm'],
    ['POST', '/api/import/begin'],
    ['POST', '/api/restart'],
    ['GET', '/api/node/logs'],
    ['GET', '/api/inbox'],
  ];
  await withServer(deps, async (port) => {
    const auth = { authorization: 'Bearer suite-secret', 'content-type': 'application/json' };
    const enter = await req(port, '/api/suite/info', { headers: auth });
    assert.equal(enter.status, 200, 'ENTER: the suite token is admitted to /api/suite/info');
    const got = [];
    for (const [method, pathname] of rows) {
      const r = await req(port, pathname, { method, headers: auth, body: method === 'POST' ? '{}' : undefined });
      got.push([method, pathname, r.status, r.status === 403 ? JSON.parse(r.body).error : r.body.slice(0, 40)]);
    }
    assert.deepStrictEqual(got, rows.map(([m, p]) => [m, p, 403, 'this token is scoped to suite jobs']));
    const hello = await req(port, '/api/peer/hello', { headers: auth });
    assert.equal(hello.status, 200);
    assert.equal(hello.headers['set-cookie'], undefined);
    const viaQuery = await req(port, '/api/sessions?token=suite-secret');
    assert.equal(viaQuery.status, 403);
    assert.equal(viaQuery.headers['set-cookie'], undefined, 'a scoped token never seeds the cookie');
    const operator = await req(port, '/api/suite/info', { headers: { authorization: 'Bearer op-secret' } });
    assert.equal(operator.status, 200, 'the operator token is also accepted on suite routes');
    const wrong = await req(port, '/api/suite/info', { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf8');
  const body = src.slice(src.indexOf('  _route(req, res) {'));
  const scope = body.indexOf('if (req.suiteScoped &&');
  const firstMatch = body.search(/if \(req\.method === '[A-Z]+' && \(?p ===/);
  assert.ok(scope > 0 && firstMatch > 0, 'ENTER: both the scope check and a route match are in _route');
  assert.ok(scope < firstMatch, 'the scope check precedes the first route match');
  assert.ok(scope < body.indexOf("p.startsWith('/api/suite/')) return this._handleSuite"), 'and the suite dispatch');
});

test('the operator fail-closed rule stays keyed on the operator token: a suite token alone does not open a non-loopback bind', async () => {
  await withServer({ host: '0.0.0.0', suiteToken: 'suite-secret' }, async (port) => {
    const r = await req(port, '/api/peer/hello', { headers: { authorization: 'Bearer suite-secret' } });
    assert.equal(r.status, 503);
  });
});
