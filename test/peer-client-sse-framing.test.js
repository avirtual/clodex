'use strict';
// peer-client-sse-framing.test.js — that peer-client's SSE path really runs on
// the SHARED decoder, driven by real bytes over a real socket (t47).
//
// WHY THIS EXISTS SEPARATELY FROM cli/test/sse-frame.test.js. That file proves
// the decoder is correct. It cannot prove peer-client USES it, nor that
// peer-client passes the two options that are its preserved divergences — a
// call site that built a default decoder, or one that still hand-rolled its own
// framing, would leave every unit test green. So each case below is chosen to
// be one the OLD inline framing would answer differently:
//
//   · a CRLF-separated frame: the old `buf.indexOf('\n\n')` found no boundary
//     at all, so the event never arrived. Arriving proves the shared decoder.
//   · a space-less `event:`/`data:`: the old literal-prefix match yielded
//     ['message', null] and the frame was dropped.
//   · a frame split across TCP writes: pins the buffering the move could break.
//   · an unparseable `data:`: must still be DROPPED here (dropUnparsableData
//     is true on this side) even though the shared decoder's default is to
//     deliver it raw. This is the one that fails if the option is not wired.
//
// A HOLE THIS TEST HAD, AND HOW IT WAS CLOSED. The drop cases were first
// written against the `activity` event — and they PASSED with the option
// reverted, because `activity` guards on `data && data.name`, so a delivered
// raw string produces no emit for a reason that has nothing to do with
// dropping. A guard that cannot fail for the reason it exists is not a guard.
// They now ride `sessions` (peer-client.js:252), the one branch that acts on
// arrival ALONE and never looks at the payload: a delivered frame triggers a
// session refetch, a dropped one does not. Confirmed by running the revert.
//
// These ride the ACTIVITY event because it is the one peer-client turns
// straight into an observable emit ('peer-activity') without needing a session
// list, a control token or a base64 payload.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');

// A box that answers hello and then holds /api/events open so the test can
// write arbitrary bytes into a live stream.
function frameServer() {
  // `sessionFetches` is the observable for the drop cases: peer-client answers
  // a `sessions` event by GETting the list, so the counter rises exactly when a
  // frame was DELIVERED, whatever its payload.
  const state = { streams: [], sessionFetches: 0 };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1' }));
    } else if (p === '/api/sessions') {
      state.sessionFetches++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [{ name: 'alpha', activity: 'idle' }] }));
    } else if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      state.streams.push(res);
    } else {
      res.writeHead(404).end();
    }
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

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

// Connecting refetches the session list TWICE: once from _helloLoop's wasOffline
// branch, once from the events stream's onOpen. The drop cases below measure a
// DELTA in that same counter, so the gate must not release while either is still
// in flight — the server registers the stream before the client's onOpen fires,
// so "the stream is open" does not mean connect is finished. Waiting on the
// count waits on the causal event; a settle delay cannot work here, because the
// second fetch is a socket round trip with no bound. If a future connect
// sequence fetches a different number of times this gate times out by label
// instead of silently handing the tests a moving baseline.
const CONNECT_SESSION_FETCHES = 2;

// Bring up a box + a connected peer, hand the caller the live stream, and tear
// everything down afterwards. `emits` collects every emit for assertions.
async function withStream(fn) {
  const { server, state } = frameServer();
  const port = await listen(server);
  const emits = [];
  const conn = new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: (channel, ...args) => { emits.push([channel, ...args]); },
    helloIntervalMs: 10000,   // slow: no hello tick can confuse an assertion
  });
  conn.start();
  try {
    await waitFor('the events stream to open', () => conn.online && state.streams.length === 1);
    await waitFor(`all ${CONNECT_SESSION_FETCHES} connect-time session refetches to land`,
      () => state.sessionFetches >= CONNECT_SESSION_FETCHES);
    await fn(state.streams[0], emits, state);
  } finally {
    conn.stop();
    server.close();
    for (const s of state.streams) { try { s.end(); } catch {} }
  }
}

const activity = (emits) => emits.filter((e) => e[0] === 'peer-activity');

// WINDOW: CRLF on the wire. Unreachable by the old inline framing — indexOf
// ('\n\n') never matches `\r\n\r\n`, so the bytes sat in the buffer forever and
// the event simply never happened. Reverting peer-client to its own framing
// fails this by message (0 peer-activity emits, not a crash).
test('a CRLF-separated frame reaches the consumer (the old inline framing could not see it)', async () => {
  await withStream(async (stream, emits) => {
    stream.write('event: activity\r\ndata: {"name":"alpha","state":"busy"}\r\n\r\n');
    await waitFor('the CRLF frame to be parsed and emitted', () => activity(emits).length === 1);
    assert.deepStrictEqual(activity(emits)[0], ['peer-activity', 'box', 'alpha', 'busy']);
  });
});

// WINDOW: the optional space omitted. The old copy matched the literal strings
// 'event: ' and 'data: ', so this yielded event='message' (no consumer) and
// data=null (dropped). Both failures at once.
test('a space-less event:/data: frame reaches the consumer', async () => {
  await withStream(async (stream, emits) => {
    stream.write('event:activity\ndata:{"name":"alpha","state":"busy"}\n\n');
    await waitFor('the space-less frame to be parsed and emitted', () => activity(emits).length === 1);
    assert.deepStrictEqual(activity(emits)[0], ['peer-activity', 'box', 'alpha', 'busy']);
  });
});

// WINDOW: a frame arriving in pieces. Real for any frame past an MTU (a
// `replay` carries base64 scrollback). The old copy buffered correctly and was
// never tested doing so — which is exactly what a move can silently break.
test('a frame split across separate writes is buffered and delivered once', async () => {
  await withStream(async (stream, emits) => {
    stream.write('event: activity\ndata: {"name":"alp');
    // Give the split a real chance to be observed as two data events.
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(activity(emits).length, 0, 'nothing emitted on the partial frame');
    stream.write('ha","state":"busy"}\n\n');
    await waitFor('the completed frame to be emitted', () => activity(emits).length === 1);
    assert.deepStrictEqual(activity(emits)[0], ['peer-activity', 'box', 'alpha', 'busy']);
  });
});

// WINDOW: the option wiring. The shared decoder's DEFAULT is to deliver an
// unparseable `data:` as a raw string (what the CLI wants); this side must drop
// it. Asserted on `sessions`, whose handler ignores the payload entirely — so
// "no refetch" can ONLY mean the frame never arrived. On `activity` this same
// revert passes, because that branch's own `data && data.name` guard absorbs a
// raw string; see the header note.
test('an unparseable data: line is dropped on this side (no consumer action at all)', async () => {
  await withStream(async (stream, emits, state) => {
    const before = state.sessionFetches;
    stream.write('event: sessions\ndata: not json at all\n\n');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(state.sessionFetches, before,
      'the bad frame triggered no refetch — it was dropped, not delivered as a raw string');
    // And the stream is still healthy: a good frame right after does act.
    stream.write('event: sessions\ndata: {}\n\n');
    await waitFor('a well-formed frame to still be acted on',
      () => state.sessionFetches === before + 1);
  });
});

// NO TEST HERE FOR THE 8MB BOUND, and the absence is a finding rather than a
// gap. peer-client passes maxBufferBytes (sse-frame.js D5) and the decoder's
// own tests pin that the bound works — but the bound is UNREACHABLE OVER A REAL
// SOCKET, and was before this refactor too (the check's placement is preserved
// verbatim). It is evaluated only INSIDE the drain loop, i.e. only once a
// complete frame has been sliced off, so firing needs a single push carrying a
// frame terminator PLUS more than 8MB of residue behind it. Node delivers
// response bytes in 64KB chunks (measured: 12MB arrived as 194 chunks, max
// 65536), so no single push can carry 8MB, and an unterminated multi-megabyte
// line never enters the loop at all. Writing a test that asserts the bound does
// NOT fire would pin a defect as intended behaviour; writing one that asserts it
// does would hang. So: named here, reported, and left for a ticket that is
// allowed to change behaviour.
//
// WINDOW: `data: null`. It PARSES, so dropUnparsableData does not catch it —
// the old code's `if (data !== null)` guard did, and that guard is preserved at
// the CALL SITE rather than in the decoder. It is the one piece of the old
// framing that did not move into the shared module, so it is the piece most
// likely to be dropped by the move. Same `sessions` observable, same reason.
test('a frame whose data is literally null is dropped at the call site', async () => {
  await withStream(async (stream, emits, state) => {
    const before = state.sessionFetches;
    stream.write('event: sessions\ndata: null\n\n');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(state.sessionFetches, before, 'the null frame produced no consumer action');
    stream.write('event: sessions\ndata: {}\n\n');
    await waitFor('a well-formed frame to still be acted on',
      () => state.sessionFetches === before + 1);
  });
});
