'use strict';
// client-sse-overflow.test.js — the CLI half of t48.
//
// THE DEFECT THIS CLOSES. cli/src/client.js had NO residue bound at all: a peer
// that never emitted a frame terminator grew `buf` without limit, and this is
// the side that runs unattended in `logs -f`. Half 1 of the ticket.
//
// WHAT IS PINNED, over a real socket with bytes in the size Node really
// delivers (64KB, measured in t47):
//   1. the overflow surfaces as a CliError the human can read — the failure is
//      never silent (t45's lesson),
//   2. it is EXIT.SERVER, NOT EXIT.CONNECT, and that is the whole design
//      decision on this side: sse-guard treats anything CONNECT-coded as
//      retryable and, on exhaustion, REPLACES the message with a generic "3
//      reconnect attempts failed" (sse-guard.js:105). So a CONNECT code would
//      move three more megabytes and then throw away the only sentence that
//      says what happened. EXIT.SERVER goes straight to onGiveUp carrying the
//      diagnosis (sse-guard.js:102) — right on a side a human is watching, and
//      the honest code besides: a malformed stream IS a server-side failure.
//   3. a legitimately large well-framed stream is untouched.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WireClient } = require('../src/client');
const { EXIT } = require('../src/errors');
const { openGuarded } = require('../src/sse-guard');
const { MAX_BUFFER_BYTES } = require('../src/sse-frame');

const CHUNK = 64 * 1024;
// ~7KB frames x 400 ≈ 2.8MB — comfortably past MAX_BUFFER_BYTES, so the
// well-framed case really does carry more than the limit.
const FRAMES = 400;

// A box whose /api/events writes whatever the test asks for. `mode` picks the
// shape: unterminated garbage, or a large well-framed stream.
function streamServer(mode) {
  const state = { connects: 0 };
  const server = http.createServer((req, res) => {
    state.connects++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    if (mode === 'unterminated') {
      // No frame terminator anywhere, delivered in realistic pieces. Enough to
      // pass the real MAX_BUFFER_BYTES — this test uses the production limit,
      // since the CLI's decoder is built inside openEventStream with no seam.
      const chunk = 'x'.repeat(CHUNK);
      let sent = 0;
      const pump = () => {
        while (sent <= MAX_BUFFER_BYTES + CHUNK) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
      };
      pump();
    } else {
      // FRAMES is the count the test asserts against, so the stream is built by
      // count rather than by byte target — a byte target lands on whatever
      // number the division happens to give and the assertion drifts off it.
      const frame = `event: activity\ndata: {"pad":"${'y'.repeat(7000)}"}\n\n`;
      const bytes = frame.repeat(FRAMES);
      let i = 0;
      const pump = () => {
        while (i < bytes.length) {
          const piece = bytes.slice(i, i + CHUNK);
          i += CHUNK;
          if (!res.write(piece)) return res.once('drain', pump);
        }
      };
      pump();
    }
  });
  return { server, state };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Teardown must be FORCEFUL. These servers hold an SSE response open by design,
// so a plain server.close() waits for a connection that will never end — and on
// the failure path that turns a named test failure into a hung suite, which is
// the least diagnosable outcome there is. closeAllConnections() first.
function shutdown(server) {
  try { server.closeAllConnections(); } catch {}
  try { server.close(); } catch {}
}

// WINDOW: an unterminated multi-megabyte stream reaching the CLI. Before t48
// this had NO bound — the buffer just grew — so the error below never existed
// and this fails by message (a timeout on the promise, with the label saying
// no error arrived).
test('an unterminated stream past the bound raises a readable error', async () => {
  const { server } = streamServer('unterminated');
  const port = await listen(server);
  const client = new WireClient(`http://127.0.0.1:${port}`, null);
  try {
    const err = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no overflow error arrived — the stream was never bounded')), 15000);
      client.openEventStream('/api/events', 'logs -f', {
        onEvent: () => {},
        onError: (e) => { clearTimeout(t); resolve(e); },
      });
    });
    assert.strictEqual(err.name, 'CliError');
    assert.match(err.message, /no frame terminator/, 'the message says WHAT went wrong');
    assert.match(err.message, /logs -f failed/, 'and which operation');
    assert.match(err.message, /MB/, 'and how much arrived');
  } finally { shutdown(server); }
});

// WINDOW: the exit code, which is the decision rather than a detail. CONNECT
// would be retried and then have its message replaced; SERVER is terminal and
// keeps the diagnosis. Flipping the code to EXIT.CONNECT fails this by message.
test('the overflow is EXIT.SERVER — terminal, not a retryable connect failure', async () => {
  const { server } = streamServer('unterminated');
  const port = await listen(server);
  const client = new WireClient(`http://127.0.0.1:${port}`, null);
  try {
    const err = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no overflow error arrived')), 15000);
      client.openEventStream('/api/events', 'logs -f', {
        onEvent: () => {},
        onError: (e) => { clearTimeout(t); resolve(e); },
      });
    });
    assert.strictEqual(err.exitCode, EXIT.SERVER,
      'EXIT.SERVER: a peer emitting unframed megabytes is a server-side failure, and the code is what makes openGuarded treat it as terminal');
    assert.notStrictEqual(err.exitCode, EXIT.CONNECT);
  } finally { shutdown(server); }
});

// WINDOW: the END-TO-END consequence of that code choice, through the real
// supervisor rather than by reading sse-guard's source. openGuarded must NOT
// reconnect — one connect, then onGiveUp carrying the original message. With
// EXIT.CONNECT this would reconnect 3 times and give up with a generic message,
// so this test fails on the code flip in a way the unit assertion cannot show.
test('openGuarded gives up immediately and keeps the diagnosis (no reconnect storm)', async () => {
  const { server, state } = streamServer('unterminated');
  const port = await listen(server);
  const client = new WireClient(`http://127.0.0.1:${port}`, null);
  const notices = [];
  try {
    const err = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('openGuarded never gave up')), 20000);
      openGuarded(client, '/api/events', 'logs -f', {
        onEvent: () => {},
        onNotice: (n) => notices.push(n),
        onGiveUp: (e) => { clearTimeout(t); resolve(e); },
      });
    });
    assert.deepStrictEqual(notices, [], 'no reconnect was attempted');
    assert.strictEqual(state.connects, 1, 'exactly one connection was made');
    assert.match(err.message, /no frame terminator/,
      'and the ORIGINAL diagnosis survived — a CONNECT code would have replaced it with "3 reconnect attempts failed"');
  } finally { shutdown(server); }
});

// WINDOW: the false positive. ~2.8MB of legitimate frames — well past the
// limit — must flow. If total VOLUME tripped the bound instead of unframed
// residue, every busy `logs -f` would die, and someone would rightly delete the
// bound. Frames straddle the 64KB write boundaries, so the residue is
// continuously non-empty: the hardest shape for the check to get right.
test('a large WELL-FRAMED stream is never bounded, however much it carries', async () => {
  const { server } = streamServer('framed');
  const port = await listen(server);
  const client = new WireClient(`http://127.0.0.1:${port}`, null);
  try {
    const outcome = await new Promise((resolve) => {
      let events = 0;
      const handle = client.openEventStream('/api/events', 'logs -f', {
        onEvent: () => {
          events++;
          if (events === FRAMES) { handle.close(); resolve({ events, err: null }); }
        },
        onError: (e) => resolve({ events, err: e }),
      });
    });
    assert.strictEqual(outcome.err, null,
      `${FRAMES} valid frames (~2.8MB) must not trip the bound (got: ${outcome.err && outcome.err.message})`);
    assert.strictEqual(outcome.events, FRAMES, 'and every frame was delivered');
  } finally { shutdown(server); }
});
