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

test('escape hatch: non-loopback + no token + insecure → serves (localhost-trust)', async () => {
  await withServer({ host: '0.0.0.0', insecure: true }, async (port) => {
    const r = await req(port, '/api/sessions');
    assert.equal(r.status, 200, 'insecure override serves with no token');
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
