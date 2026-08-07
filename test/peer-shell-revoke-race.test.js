'use strict';

// The revoke-mid-body window on the peer-terminal wire (t219 MF2).
//
// `_readBody` calls its callback from `req.on('end')`, which runs OUTSIDE
// `_route`'s try/catch, and main.js rethrows an uncaughtException rather than
// swallowing it. So a handler nulled by revocation while a request body is in
// flight is not a caught 500 — it is a crash of the whole desktop app, and the
// caller who dribbles the body chooses how long that window stays open.
//
// The fix is to re-read the handler INSIDE the callback. The tempting
// alternative — capture it before `_readBody` — closes the crash and reopens a
// worse hole: keystrokes would keep reaching the shell after the grant was
// withdrawn. These tests pin both halves, so a future "simplification" to the
// captured form fails rather than trading one bug for the other.
//
// Real HTTP against a port-0 server, because the property lives in node's
// request lifecycle and a fake `req` would prove nothing about when `end` fires.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

const WTERM_CBS = () => ({
  wtermOpen: () => ({ ok: true, scrollback: Buffer.alloc(0), cols: 80, rows: 24 }),
  wtermInput: () => ({ ok: true }),
  wtermResize: () => ({ ok: true }),
  wtermClose: () => ({ ok: true }),
});

function serve(extra) {
  return new RemoteServer({
    port: 0, pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    ...WTERM_CBS(), ...extra,
  });
}

// An SSE GET held open, resolved once the replay frame lands — that is the
// point at which the server has the stream in its Map, which is what the input
// routes require. Same shape as peer-shell-attached's.
function openStream(port, seat) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/wterm/${seat}`, method: 'GET',
      headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.setEncoding('utf8');
      res.once('data', () => resolve({ req, res }));
    });
    req.on('error', reject);
    req.end();
  });
}

// POST whose body arrives in two chunks with a caller-controlled pause between
// them — the window an attacker holds open by dribbling. `duringBody` runs after
// the server has certainly seen the first chunk and before `end`.
function dribble(port, pathname, first, rest, duringBody) {
  return new Promise((resolve, reject) => {
    const full = Buffer.byteLength(first) + Buffer.byteLength(rest);
    const r = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': full },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.write(first);
    // A macrotask after the write flushes: the socket data event has landed on
    // the server and `_readBody`'s 'data' handler has run, but 'end' has not.
    setTimeout(() => {
      try { duringBody(); } catch (e) { reject(e); return; }
      r.end(rest);
    }, 30);
  });
}

// Any uncaughtException during these tests IS the bug — node's default would
// also fail the run, but catching it here names what happened instead of
// leaving a bare stack.
function watchCrashes() {
  const seen = [];
  const onErr = (e) => seen.push(e);
  process.on('uncaughtException', onErr);
  return { seen, stop: () => process.removeListener('uncaughtException', onErr) };
}

test('a revoke landing INSIDE the body window answers 501 instead of crashing', async () => {
  const server = serve();
  await server.start();
  const crashes = watchCrashes();
  try {
    let revoked = false;
    const res = await dribble(server.port, '/api/wterm-input/bob', '{"data":"l', 's\\r"}', () => {
      // The grant is withdrawn while the body is still arriving — the exact
      // interleaving an operator produces by unticking the box at a bad moment,
      // and that a caller can hold open indefinitely.
      server.setWtermCallbacks(null);
      revoked = true;
    });
    assert.strictEqual(revoked, true, 'ENTER: the revoke really ran mid-body');
    assert.strictEqual(res.status, 501, 'refused as a config bit, not a crash and not a 200');
    assert.match(res.body, /terminal sharing is not enabled/, 'and says so');
  } finally {
    crashes.stop();
    server.stop();
  }
  assert.deepStrictEqual(crashes.seen.map((e) => e.message), [],
    'nothing was thrown from the end-of-body callback — main.js would rethrow it and take the app down');
});

test('the same window on wterm-resize — the second deferred handler', async () => {
  const server = serve();
  await server.start();
  const crashes = watchCrashes();
  try {
    const res = await dribble(server.port, '/api/wterm-resize/bob', '{"cols":100,', '"rows":30}', () => {
      server.setWtermCallbacks(null);
    });
    assert.strictEqual(res.status, 501, 'refused, not crashed');
  } finally {
    crashes.stop();
    server.stop();
  }
  assert.deepStrictEqual(crashes.seen.map((e) => e.message), [], 'no throw from the end callback');
});

// The other half, and the reason the fix is a re-read rather than a capture. A
// captured handler would answer 200 here and the keystroke would reach a shell
// whose grant is gone — a silent authorization failure, strictly worse than the
// loud crash it replaced.
test('the revoked keystroke does not reach the shell', async () => {
  const typed = [];
  const server = serve({ wtermInput: (seat, data) => { typed.push([seat, data]); return { ok: true }; } });
  await server.start();
  // Input now requires a live stream for the seat, so the control below needs
  // one open or it would answer 409 and prove nothing about the revoke. The
  // revoke tears this down itself (setWtermCallbacks(null) drops every stream),
  // which is why the refusal it produces is still the 501 and not the 409 —
  // both are refusals, but only the 501 says the grant is what stopped it.
  let s = null;
  try {
    s = await openStream(server.port, 'bob');
    // Control: before any revoke, a whole-body POST DOES reach the handler.
    const ok = await dribble(server.port, '/api/wterm-input/bob', '{"data":"a', '"}', () => {});
    assert.strictEqual(ok.status, 200, 'ENTER: the handler is reachable in the normal case');
    assert.deepStrictEqual(typed, [['bob', 'a']], 'ENTER: and the bytes arrive');

    const res = await dribble(server.port, '/api/wterm-input/bob', '{"data":"r', 'm -rf /"}', () => {
      server.setWtermCallbacks(null);
    });
    assert.strictEqual(res.status, 501, 'refused');
    assert.deepStrictEqual(typed, [['bob', 'a']],
      'no second write — the revoked keystroke never reached the PTY');
  } finally {
    if (s) { try { s.req.destroy(); } catch {} }
    server.stop();
  }
});

// A revoke that lands BEFORE the request is the easy case, and it must keep
// working: the top-of-handler check is still there, and the re-read inside the
// callback did not replace it.
test('a revoke before the request still refuses at the door', async () => {
  const server = serve();
  await server.start();
  try {
    server.setWtermCallbacks(null);
    const res = await dribble(server.port, '/api/wterm-input/bob', '{"data":"x', '"}', () => {});
    assert.strictEqual(res.status, 501, 'refused before the body was ever read');
  } finally { server.stop(); }
});
