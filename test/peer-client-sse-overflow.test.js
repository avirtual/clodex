'use strict';
// peer-client-sse-overflow.test.js — the GUI half of t48: what happens when a
// peer sends unframed bytes past the residue bound.
//
// THE DEFECT THIS CLOSES. peer-client has had an 8MB residue bound since long
// before t47, and it COULD NEVER FIRE: the check sat inside the drain loop, so
// tripping it needed one push carrying both a frame terminator and >8MB behind
// it. Node delivers response bytes in 64KB chunks (measured in t47: 12MB
// arrived as 194 chunks, max 65536), so the one case the bound exists for — an
// unterminated multi-megabyte line — never entered the loop at all. The bytes
// simply accumulated.
//
// WHAT IS PINNED, over a real socket with bytes in realistic sizes:
//   1. the stream is torn down and RECONNECTED (the chosen policy: transient
//      causes self-heal, and giving up would strand a stale session list behind
//      a peer that still reads online),
//   2. and it SAYS SO — an ipc-message names the peer, the path and the size.
//      t45's lesson: a bound that fires silently is one nobody can diagnose,
//      and here the symptom would be a peer that flaps for no visible reason,
//      indistinguishable from a flaky network.
//   3. a legitimately LARGE but well-framed stream is untouched — the false
//      positive that would get the bound deleted.
//
// The limit is overridden per-connection ONLY so these move kilobytes instead
// of megabytes; production takes sse-frame's MAX_BUFFER_BYTES.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');

const CHUNK = 64 * 1024;         // what Node actually hands a res 'data' handler
const TEST_LIMIT = 128 * 1024;   // small enough to trip in a couple of chunks

function overflowServer() {
  const state = { streams: [], eventConnects: 0, sessionFetches: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1' }));
    } else if (p === '/api/sessions') {
      state.sessionFetches++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      state.eventConnects++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      state.streams.push(res);
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function waitFor(label, pred, ms = 5000) {
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

// Connecting refetches the session list TWICE: once from _helloLoop's wasOffline
// branch, once from the events stream's onOpen. The tests below measure DELTAS in
// that counter, so the gate must not release while either is still in flight —
// the server registers the stream before the client's onOpen fires, so "the
// stream is open" does not mean connect is finished. Waiting on the count waits
// on the causal event; a settle delay cannot work here, because the second fetch
// is a socket round trip with no bound.
//
// The two directions are NOT symmetric, and the assertion below covers the
// dangerous one. A connect that fetches FEWER times fails loudly by label,
// because the gate never releases. A connect that fetches MORE would slip past a
// `>=` gate with the extra still on the wire, so the count is pinned exactly.
const CONNECT_SESSION_FETCHES = 2;

async function withStream(fn, connOpts = {}) {
  const { server, state } = overflowServer();
  const port = await listen(server);
  const emits = [];
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: (channel, ...args) => { emits.push([channel, ...args]); },
    helloIntervalMs: 10000,
    sseMaxBufferBytes: TEST_LIMIT,
    ...connOpts,
  });
  conn.start();
  try {
    await waitFor('the events stream to open', () => conn.online && state.streams.length === 1);
    await waitFor(`all ${CONNECT_SESSION_FETCHES} connect-time session refetches to land`,
      () => state.sessionFetches >= CONNECT_SESSION_FETCHES);
    assert.strictEqual(state.sessionFetches, CONNECT_SESSION_FETCHES,
      'the connect fetch count moved — bump CONNECT_SESSION_FETCHES, or every delta below is measured '
      + 'against a baseline that is still moving');
    await fn(state.streams[0], emits, state, conn);
  } finally {
    conn.stop();
    server.close();
    for (const s of state.streams) { try { s.end(); } catch {} }
  }
}

const systemLines = (emits) =>
  emits.filter((e) => e[0] === 'ipc-message' && e[1] && e[1].type === 'system').map((e) => e[1].body);

// WINDOW: unterminated bytes, in the size Node really delivers, past the limit.
// Unreachable by the pre-t48 drain-loop check — there is no frame terminator in
// this stream at ALL, so no chunk ever enters the loop and no bound ever
// evaluates. Against pre-t48 code this fails by message at the first waitFor.
test('an unterminated stream past the bound is torn down and reconnected', async () => {
  await withStream(async (stream, emits, state) => {
    const before = state.eventConnects;
    // No terminator, ever. Written in 64KB pieces like a real producer.
    for (let sent = 0; sent <= TEST_LIMIT + CHUNK; sent += CHUNK) {
      try { stream.write('x'.repeat(CHUNK)); } catch { break; }
    }
    await waitFor('the oversized stream to be dropped and a new one opened',
      () => state.eventConnects > before);
  });
});

// WINDOW: the diagnosis. A tear-down that says nothing looks exactly like a
// flaky network, and would be debugged as one for as long as it takes someone
// to read peer-client's source. The line must name the size and the path.
test('the overflow is reported on the IPC log, naming the stream and the size', async () => {
  await withStream(async (stream, emits, state) => {
    for (let sent = 0; sent <= TEST_LIMIT + CHUNK; sent += CHUNK) {
      try { stream.write('x'.repeat(CHUNK)); } catch { break; }
    }
    await waitFor('a system line explaining the drop', () => systemLines(emits).length >= 1);
    const line = systemLines(emits).find((b) => /no frame terminator/.test(b));
    assert.ok(line, `expected an overflow line, got: ${JSON.stringify(systemLines(emits))}`);
    assert.match(line, /\/api\/events/, 'names WHICH stream');
    assert.match(line, /MB/, 'names how much arrived');
    assert.match(line, /reconnecting/, 'says what happens next');
  });
});

// WINDOW: the false positive. A busy peer legitimately pushes far more than the
// limit — as frames. If total volume tripped the bound, every healthy
// long-lived feed would be killed, which is worse than no bound at all. Frames
// are sized so they straddle chunk boundaries (7KB into 64KB writes), keeping
// the residue continuously non-empty.
test('a large WELL-FRAMED stream is never dropped, however much it carries', async () => {
  await withStream(async (stream, emits, state) => {
    const before = state.eventConnects;
    const frame = `event: sessions\ndata: {"pad":"${'y'.repeat(7000)}"}\n\n`;
    let bytes = '';
    while (bytes.length < 4 * TEST_LIMIT) bytes += frame;
    // Baselined BEFORE the writes: connecting refetches the session list twice on
    // its own, so a bare `>= 2` here is satisfied by connect traffic and this wait
    // can resolve having observed not one of the frames it claims to be waiting for.
    const beforeFetches = state.sessionFetches;
    for (let i = 0; i < bytes.length; i += CHUNK) stream.write(bytes.slice(i, i + CHUNK));
    // The frames are `sessions` events, so arrival is observable as refetches.
    await waitFor('the well-framed traffic to be consumed',
      () => state.sessionFetches >= beforeFetches + 2);
    await new Promise((r) => setTimeout(r, 300));   // a drop would have landed by now
    assert.strictEqual(state.eventConnects, before, 'half a megabyte of valid frames did not trip the bound');
    assert.deepStrictEqual(systemLines(emits).filter((b) => /no frame terminator/.test(b)), [],
      'and nothing was reported');
  });
});
