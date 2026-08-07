'use strict';

// A REFUSED peer-terminal stream is a decision, not a dropped tunnel (t219 MF3).
//
// `_sse`'s one close door exists to reconnect: every death goes through it and
// comes back on backoff. That is right for a stream that BROKE and wrong for one
// that was answered "no" — a box with the grant off answers 501 to every open,
// forever, so the door turns a refusal into a knock every ≤20s on someone else's
// machine, and the operator sees a terminal that is merely blank rather than one
// that says why. `onRefused` is the seam that tells the two apart.
//
// What is pinned here:
//   1. a refused open emits `peer-wterm-closed` carrying the operator-facing
//      refusal TEXT, so the reason reaches a human;
//   2. it does NOT come back — measured as the serving box's request count over
//      a window in which a merely-broken stream reconnects several times, so
//      "did not retry" can never pass because nothing had time to;
//   3. the STATUS chooses the sentence: 501 and 404 say different things, which
//      is the whole reason remote.js was made to answer 501 for both of its
//      config-bit refusals rather than 404.
//
// Real HTTP and real reconnect timers: onClose's setTimeout is deliberately NOT
// on the injected `_timers` seam (see peer-client-backoff-open.test.js), so the
// retry this test is about can only be observed by letting it happen.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');
const { peerShellRefusal } = require('../peer-shell');

const FLOOR_MS = 1000;   // peer-client's RECONNECT_MIN_MS

// Two seats with deliberately different behaviour on the SAME box, so the
// refusal and the control are measured against one clock and one server:
//   'refused' — answers `status` and nothing else;
//   'broken'  — a healthy-looking 200 that dies at byte zero, i.e. the shape the
//               close door is FOR. Its retries are what make the refused seat's
//               silence mean something.
function box({ status = 501, caps = ['shell'] } = {}) {
  const state = { refused: 0, broken: 0, streams: [] };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps, version: '1' }));
    } else if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      state.streams.push(res);
    } else if (p === '/api/wterm/refused') {
      state.refused++;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no' }));
    } else if (p === '/api/wterm/broken') {
      state.broken++;
      // Node holds headers until the first body write, so without flushHeaders
      // this would never reach 200 on the client — it would be a PENDING
      // request, not an open-and-bad stream, and the control would prove
      // nothing about the close door.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      res.end();
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(label, pred, ms = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v; try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function connect(port, emit) {
  return new PeerConnection({
    id: 'p1', label: 'box', url: `http://127.0.0.1:${port}`,
    emit,
    helloIntervalMs: 60000,   // slow: no hello tick may reopen anything mid-window
  });
}

function teardown(conn, server, state) {
  conn.stop();
  for (const s of state.streams) { try { s.end(); } catch {} }
  try { server.closeAllConnections(); } catch {}
  server.close();
}

// WINDOW: one refused open and one broken open, started together, observed over
// the same stretch of wall clock. The broken seat's reconnect count is the
// ENTER control — it proves the window really was long enough for a retry, so
// `refused === 1` is silence rather than impatience.
test('a refused stream reports the reason and does not come back; a broken one does', async () => {
  const { server, state } = box({ status: 501 });
  const port = await listen(server);
  const closed = [];
  const conn = connect(port, (ch, id, seat, text) => {
    if (ch === 'peer-wterm-closed') closed.push({ id, seat, text });
  });
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);

    conn.wtermOpen('refused', () => {});
    conn.wtermOpen('broken', () => {});

    await waitFor('the refused open to be answered', () => state.refused >= 1);
    await waitFor('the broken stream to reconnect at least twice', () => state.broken >= 3);

    assert.deepStrictEqual(closed, [{ id: 'p1', seat: 'refused', text: peerShellRefusal('off', 'box') }],
      'the refusal reached the operator as a sentence, and nothing else emitted a closure');
    assert.strictEqual(state.refused, 1,
      `the refused seat was asked exactly once (was ${state.refused}) — a 501 is an answer, not an outage`);

    // The entry must not linger wanting a stream either: a later hello that
    // finds the peer offline-then-online walks `_wterms` and reopens everything
    // still `wanted`, which would resurrect the retry the close door was talked
    // out of.
    const w = conn._wterms.get('refused');
    assert.ok(!w || w.wanted === false, 'the refused seat is no longer wanted');
  } finally {
    teardown(conn, server, state);
  }
});

// WINDOW: the same refusal path with a different status. The SSE path discards
// the body of a non-200, so the status is the entire refusal — if it stopped
// choosing the sentence, every "no" would read as "the operator has to enable
// it" and send someone to change a setting that was never the problem.
test('the status chooses the sentence — 404 is a missing seat, not a disabled feature', async () => {
  const { server, state } = box({ status: 404 });
  const port = await listen(server);
  const closed = [];
  const conn = connect(port, (ch, id, seat, text) => {
    if (ch === 'peer-wterm-closed') closed.push(text);
  });
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    conn.wtermOpen('refused', () => {});
    await waitFor('the refusal to be reported', () => closed.length >= 1);
    assert.deepStrictEqual(closed, [peerShellRefusal('no-seat', 'box')], 'reported as a missing seat');
    assert.notStrictEqual(peerShellRefusal('no-seat', 'box'), peerShellRefusal('off', 'box'),
      'ENTER: the two sentences really are different, so the assertion above discriminates');
  } finally {
    teardown(conn, server, state);
  }
});

// A status with no entry in the map still has to say SOMETHING. The fallback is
// `failed`, and the property is that no refusal is silent: a blank pane with no
// explanation is the failure this whole seam exists to prevent.
test('an unmapped status still refuses out loud', async () => {
  const { server, state } = box({ status: 500 });
  const port = await listen(server);
  const closed = [];
  const conn = connect(port, (ch, id, seat, text) => {
    if (ch === 'peer-wterm-closed') closed.push(text);
  });
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    conn.wtermOpen('refused', () => {});
    await waitFor('the refusal to be reported', () => closed.length >= 1);
    assert.deepStrictEqual(closed, [peerShellRefusal('failed', 'box')], 'fell back to a generic refusal');
    assert.strictEqual(state.refused, 1, 'and still did not retry an unrecognised "no"');
  } finally {
    teardown(conn, server, state);
  }
});
