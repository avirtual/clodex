'use strict';
// peer-client-sse-watchdog.test.js — the half-open-socket fix (t41).
//
// THE DEFECT. peer-client's _sse reconnected only on res 'end' / res 'error' /
// req 'error'. A socket that stops DELIVERING BYTES raises none of those: it is
// open at the TCP layer and silent above it, so a severed feed read as live
// indefinitely and both consumers (the events feed and every attach) kept
// believing it. cli/src/sse-guard.js:1-7 names this file as the reason that
// module exists; the fix was written on the CLI side and never came back.
//
// WHAT IS PINNED HERE, and it is deliberately not "the watchdog exists":
//   1. A live-but-silent stream is torn down and reconnected. (makeWatchdog's
//      own timing is sse-guard's to test; what is untested elsewhere is that
//      peer-client ARMS it, and that firing reaches the reconnect path.)
//   2. A HEARTBEAT COMMENT re-arms it. remote.js:163-172 writes `: ping\n\n`
//      every 25s and it yields no SSE event — if only parsed frames petted the
//      watchdog, an idle-but-healthy session would be killed every 60s. This is
//      the test that would fail on the obvious wrong implementation.
//   3. Firing produces exactly ONE reconnect. A watchdog destroy also raises a
//      socket error, so without the one-shot close door the stream would take
//      two doors and leave two live streams for one consumer.
//
// The staleness deadline runs on an INJECTED virtual clock, so these advance
// 60+ virtual seconds without sleeping. Only the watchdog uses that seam — the
// hello loop and the reconnect backoff stay on real timers, which is what makes
// the reconnect assertions real rather than simulated.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');
const { STALE_MS } = require('../cli/src/sse-guard');

// Timers a single live SSE stream arms on the injected clock: the staleness
// watchdog, and (since t50) the stability timer whose fire resets the reconnect
// backoff. These tests count pending timers to prove a stream is armed, so the
// count is named rather than written as a literal 2 — it is a property of
// peer-client's _sse, not a magic number belonging to any one assertion.
const TIMERS_PER_STREAM = 2;

// A virtual clock behind { setTimeout, clearTimeout }. advance(ms) runs every
// timer due within the window, in due order. `arms` counts setTimeout calls —
// the observable that says a pet() landed, which is how a test can synchronise
// on "the chunk was received" without sleeping on a guess.
function fakeClock() {
  let now = 0;
  let seq = 0;
  let arms = 0;
  const pending = new Map();      // id -> { at, fn }
  return {
    timers: {
      setTimeout: (fn, ms) => { arms++; const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of pending) if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
        if (!pick) break;
        now = pick.t.at;
        pending.delete(pick.id);
        pick.t.fn();
      }
      now = target;
    },
    arms: () => arms,
    pending: () => pending.size,
  };
}

// A box that answers hello with a STABLE identity (so no offline dip and no
// identityChanged can refresh anything — the SSE path is the only thing under
// test) and holds every /api/events response open forever. Holding it open with
// no bytes IS the half-open condition: the client's socket is fine, the feed is
// dead, and nothing on the wire says so.
function silentServer() {
  const state = { streams: [], connects: 0, attaches: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1' }));
    } else if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      state.connects++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // flushHeaders, and NOT a ': connected' preamble. Node holds headers back
      // until the first body write, so a truly silent response would never reach
      // 200 on the client at all — the stream would be pending, not half-open,
      // and the test would pass for the wrong reason. Flushing gives a live 200
      // with ZERO body bytes: the client's data handler never fires, which is
      // precisely the condition the watchdog exists for.
      res.flushHeaders();
      state.streams.push(res);
    } else if (p.startsWith('/api/attach/')) {
      state.attaches++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();     // live 200, zero body bytes — same half-open shape
      state.streams.push(res);
    } else if (p.startsWith('/api/control/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: 't' }));
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Every wait carries a label. A bare 'timeout' would tell a future reader that
// something did not happen but not WHAT — and for a watchdog test the difference
// between "never armed" and "never reconnected" is the whole diagnosis.
function waitFor(label, pred, ms = 4000) {
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

function connect(port, clock) {
  return new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: () => {},
    helloIntervalMs: 10000,   // slow: prove the SSE machinery acts, not a hello tick
    timers: clock.timers,
  });
}

// WINDOW: a stream that is open and delivering NOTHING, past the deadline.
// Unreachable by any pre-fix code path — 'end' and 'error' never fire here, which
// is precisely why the bug survived. Reverting the arm leaves this test hanging
// at the first waitFor (connects === 2) and failing by message, not by crash.
test('a silent SSE stream is torn down and reconnected once the staleness bound lapses', async () => {
  const { server, state } = silentServer();
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    // Wait for the ARM, not merely for the server-side accept: connects++ runs
    // when the box receives the request, while the watchdog arms when the client
    // sees the 200. Synchronising on the server's counter would race the client.
    await waitFor('the first events stream to open and arm its staleness timer',
      () => conn.online && state.connects === 1 && clock.pending() === TIMERS_PER_STREAM);
    // The hello loop and the reconnect backoff use real timers, so this clock
    // holds only per-stream timers and `pending` stays unambiguous — but since
    // t50 a live stream arms TWO of them (see TIMERS_PER_STREAM).
    assert.strictEqual(clock.pending(), TIMERS_PER_STREAM,
      'exactly one live stream is armed (its watchdog and its stability timer)');

    // No bytes for the full bound. Pre-fix this was survivable forever.
    clock.advance(STALE_MS);

    // Firing must land in the SAME door a socket error uses: onClose → backoff →
    // _openEvents → a real new request to the box.
    await waitFor('the stale stream to be torn down and reconnected (connects === 2)',
      () => state.connects === 2);
  } finally {
    conn.stop();
    server.close();
    for (const s of state.streams) { try { s.end(); } catch {} }
  }
});

// WINDOW: bytes that carry NO parsed event, arriving inside the bound, twice
// over. Total virtual time is 2x(STALE_MS-1) — comfortably past the deadline —
// so the stream can only survive if the comment frame re-armed it. An
// implementation that petted on parsed events instead of on chunks fails here
// while passing the test above, which is the whole reason this one exists.
test('a heartbeat comment re-arms the watchdog (an idle healthy session is not killed)', async () => {
  const { server, state } = silentServer();
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    await waitFor('the events stream to open and arm its staleness timer',
      () => conn.online && state.connects === 1 && clock.pending() === TIMERS_PER_STREAM);

    // Just under the bound: still alive, nothing reconnected.
    clock.advance(STALE_MS - 1);
    assert.strictEqual(state.connects, 1, 'no reconnect before the bound lapses');

    // remote.js's exact heartbeat frame. It yields no SSE event by design.
    const armsBefore = clock.arms();
    state.streams[0].write(': ping\n\n');
    // Synchronise on the re-arm itself rather than a sleep: a new setTimeout on
    // this clock is the observable proof the chunk reached the data handler.
    await waitFor('the heartbeat chunk to re-arm the watchdog (a fresh setTimeout on the clock)',
      () => clock.arms() > armsBefore);

    // Another near-full bound. Cumulatively way past STALE_MS.
    clock.advance(STALE_MS - 1);
    assert.strictEqual(state.connects, 1, 'the heartbeat kept the stream alive past the raw bound');
    assert.ok(conn.online, 'peer stayed online');
  } finally {
    conn.stop();
    server.close();
    for (const s of state.streams) { try { s.end(); } catch {} }
  }
});

// WINDOW: the ATTACH call site, and the two death paths racing on one stream.
// req.destroy() inside the watchdog also raises a socket error, so 'error' →
// close and the watchdog's own close() both want the door.
//
// This asserts on the attach path rather than the events path for a measured
// reason. A double close is INVISIBLE in a reconnect count: both _openEvents
// (:223) and _openAttach (:288) re-entry-guard themselves, so the second close's
// scheduled reconnect finds a live request and returns. What is not absorbed is
// everything onClose does BEFORE scheduling — _openAttach emits
// `peer-control null` (the UI's "you lost control" signal) and doubles the
// backoff. So a missing guard shows up as a spurious control-loss emit at the
// renderer and a reconnect delay that advanced twice for one drop. Verified by
// instrumenting onClose directly: with the guard removed the door is walked
// twice; the events path merely hides it.
test('a watchdog fire on an attach stream opens the close door exactly once', async () => {
  const { server, state } = silentServer();
  const port = await listen(server);
  const clock = fakeClock();
  const emits = [];
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: (channel, ...args) => { emits.push([channel, ...args]); },
    helloIntervalMs: 10000,
    timers: clock.timers,
  });
  conn.start();
  try {
    // Two streams now share the clock: the events feed and this attachment. Wait
    // for BOTH to be armed, else advancing would fire a half-set-up pair.
    await waitFor('the events stream to open', () => conn.online && state.connects === 1);
    conn.attach('sess');
    await waitFor('the attach stream to open and both staleness timers to arm',
      () => state.attaches === 1 && clock.pending() === 2 * TIMERS_PER_STREAM);

    const before = emits.filter((e) => e[0] === 'peer-control').length;
    clock.advance(STALE_MS);
    await waitFor('the attach stream to reconnect after going stale',
      () => state.attaches === 2);
    // Settle past the 1s reconnect backoff a second close would have scheduled.
    await new Promise((r) => setTimeout(r, 1500));

    const controlEmits = emits.filter((e) => e[0] === 'peer-control').length - before;
    assert.strictEqual(controlEmits, 1,
      'one stale attach stream produced exactly one peer-control(null) emit');
    assert.strictEqual(state.attaches, 2, 'and exactly one reconnect');
  } finally {
    conn.stop();
    server.close();
    for (const s of state.streams) { try { s.end(); } catch {} }
  }
});
