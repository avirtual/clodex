'use strict';
// peer-client-auth.test.js — the consumer side of the operator-auth wire
// (remote-auth-plan.md [internal design doc, not in this repo] §4). A tokened PeerConnection must present
// `Authorization: Bearer <token>` on BOTH transport paths: _request (hello,
// sessions, control, …) and the _sse streams (events, attach). An untokened
// peer sends no Authorization header, so the wire to an untokened box is
// byte-for-byte unchanged.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');

// A bare capturing server: records the Authorization header seen per path, and
// answers just enough (hello → online, events → an open SSE) to exercise both
// a request and a stream.
function captureServer() {
  const seen = {}; // path (no query) → authorization header (or undefined)
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    // `?? null` so a hit with no Authorization header is observable (null),
    // distinct from a path not yet reached (undefined).
    seen[p] = req.headers['authorization'] ?? null;
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '', sessions: [] }));
    } else if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n'); // keep it open; conn.stop() tears down
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

// ── _authHeaders() unit ──────────────────────────────────────────────────────

test('_authHeaders: Bearer for a tokened peer, empty for an untokened one', () => {
  const tokened = new PeerConnection({ id: 'a', label: 'a', url: 'http://127.0.0.1:1', token: 'sekret', emit: () => {} });
  const bare = new PeerConnection({ id: 'b', label: 'b', url: 'http://127.0.0.1:1', emit: () => {} });
  try {
    assert.deepStrictEqual(tokened._authHeaders(), { Authorization: 'Bearer sekret' });
    assert.deepStrictEqual(bare._authHeaders(), {});
    // A blank/whitespace token is treated as no token.
    const blank = new PeerConnection({ id: 'c', label: 'c', url: 'http://127.0.0.1:1', token: '', emit: () => {} });
    assert.deepStrictEqual(blank._authHeaders(), {});
  } finally {
    tokened.stop(); bare.stop();
  }
});

// ── on the wire: request path AND SSE path both carry the Bearer ─────────────

test('a tokened PeerConnection sends Bearer on the hello request AND the events SSE', async () => {
  const { server, seen } = captureServer();
  const port = await listen(server);
  const conn = new PeerConnection({
    id: 'p', label: 'p', url: `http://127.0.0.1:${port}`, token: 'wire-tok',
    emit: () => {}, helloIntervalMs: 10000,
  });
  conn.start();
  try {
    // hello (a _request) then, once online, the events stream (a _sse).
    await waitFor(() => seen['/api/peer/hello'] !== undefined);
    await waitFor(() => seen['/api/events'] !== undefined);
    assert.strictEqual(seen['/api/peer/hello'], 'Bearer wire-tok', 'request path carries Bearer');
    assert.strictEqual(seen['/api/events'], 'Bearer wire-tok', 'SSE path carries Bearer');
  } finally {
    conn.stop();
    server.close();
  }
});

test('an untokened PeerConnection sends NO Authorization header (wire unchanged)', async () => {
  const { server, seen } = captureServer();
  const port = await listen(server);
  const conn = new PeerConnection({
    id: 'p', label: 'p', url: `http://127.0.0.1:${port}`,
    emit: () => {}, helloIntervalMs: 10000,
  });
  conn.start();
  try {
    await waitFor(() => seen['/api/peer/hello'] !== undefined);
    await waitFor(() => seen['/api/events'] !== undefined);
    assert.strictEqual(seen['/api/peer/hello'], null, 'no Authorization on the request path');
    assert.strictEqual(seen['/api/events'], null, 'no Authorization on the SSE path');
  } finally {
    conn.stop();
    server.close();
  }
});
