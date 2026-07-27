'use strict';
// sse-frame.test.js — the shared SSE decoder (t47).
//
// These are the framing tests NEITHER side had. peer-client's framing was only
// ever exercised through a live socket (peer-client-sse-watchdog.test.js), and
// cli/src/client.js tested parseSseBlock on whole blocks — so the stateful part,
// the part that actually differed between the two copies, was untested on both
// sides. Every case below is written against the DRIFT it would have caught:
// each D-number names the divergence documented in sse-frame.js's header.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseSseBlock, makeSseDecoder } = require('../src/sse-frame');

// Collect (event, data) pairs from a decoder driven by a list of chunks.
function drive(chunks, opts = {}) {
  const seen = [];
  const overflows = [];
  const dec = makeSseDecoder({
    onEvent: (name, data) => seen.push([name, data]),
    onOverflow: () => overflows.push(true),
    ...opts,
  });
  const results = chunks.map((c) => dec.push(c));
  return { seen, overflows, results, buffered: dec.buffered() };
}

// ── the stateful case: a frame split across chunk boundaries ────────────────
//
// WINDOW: bytes arriving in pieces that are individually not a frame. TCP has
// no obligation to align a write to a frame, and remote.js writes frames larger
// than an MTU routinely (a `replay` frame carries base64 scrollback). Both old
// copies buffered correctly, but neither TESTED it, so the buffering was free
// to be broken by the very move this ticket performs.
test('a frame split across chunks is buffered and delivered once complete', () => {
  const { seen, buffered } = drive(['event: out', 'put\ndata: {"b6', '4":"aGk="}\n\n']);
  assert.deepStrictEqual(seen, [['output', { b64: 'aGk=' }]]);
  assert.strictEqual(buffered, 0, 'nothing left over once the frame closed');
});

test('the separator itself may be split across chunks', () => {
  // The nastiest alignment: the blank line arrives one byte at a time.
  const { seen } = drive(['data: {"a":1}\n', '\n', 'data: {"a":2}\n\n']);
  assert.deepStrictEqual(seen, [['message', { a: 1 }], ['message', { a: 2 }]]);
});

test('a partial frame is held, not delivered, and not lost', () => {
  const seen = [];
  const dec = makeSseDecoder({ onEvent: (n, d) => seen.push([n, d]) });
  dec.push('event: activity\ndata: {"name":"a"}');   // no terminator yet
  assert.deepStrictEqual(seen, [], 'nothing delivered on an unterminated frame');
  assert.ok(dec.buffered() > 0, 'and it is still buffered');
  dec.push('\n\n');
  assert.deepStrictEqual(seen, [['activity', { name: 'a' }]]);
});

test('several frames in one chunk all drain', () => {
  const { seen } = drive(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n']);
  assert.strictEqual(seen.length, 3);
});

// ── the heartbeat ───────────────────────────────────────────────────────────
//
// WINDOW: remote.js:165's exact bytes. A comment-only frame must yield NO event
// (it carries nothing) while still being consumed — it is the liveness signal
// the watchdog reads, and a decoder that choked on it or emitted a bogus event
// would break either the feed or the idle-session watchdog. This is the case
// t41 turned on.
test('a comment-only heartbeat yields no event and leaves no residue', () => {
  const { seen, buffered } = drive([': ping\n\n']);
  assert.deepStrictEqual(seen, [], 'the heartbeat is not an event');
  assert.strictEqual(buffered, 0, 'and it did not accumulate');
});

test('a heartbeat interleaved with real frames does not disturb them', () => {
  const { seen } = drive([': ping\n\nevent: activity\ndata: {"state":"busy"}\n\n: ping\n\n']);
  assert.deepStrictEqual(seen, [['activity', { state: 'busy' }]]);
});

// ── D1: CRLF ────────────────────────────────────────────────────────────────
//
// WINDOW: a CRLF-framed stream. peer-client's `buf.indexOf('\n\n')` finds NO
// boundary in `\r\n\r\n` — every byte accumulates until the 8MB bound destroys
// the socket, which reads as a dead peer with no explanation. The CLI's copy
// handled it. Reverting to indexOf('\n\n') fails this by message (0 events).
test('D1: CRLF frame separators are tolerated (the GUI copy could not find them)', () => {
  const { seen, buffered } = drive(['event: output\r\ndata: {"b64":"aGk="}\r\n\r\n']);
  assert.deepStrictEqual(seen, [['output', { b64: 'aGk=' }]]);
  assert.strictEqual(buffered, 0, 'the CRLF separator was consumed WHOLE — a \\n\\n-length slice would leave a stray \\r');
});

test('D1: mixed LF and CRLF in one stream', () => {
  const { seen } = drive(['data: {"a":1}\n\ndata: {"a":2}\r\n\r\ndata: {"a":3}\n\n']);
  assert.strictEqual(seen.length, 3, 'a stray \\r left behind would corrupt the NEXT frame, not this one');
});

// ── D2: space-less fields ───────────────────────────────────────────────────
//
// WINDOW: `event:X` / `data:{...}` with no space. Legal SSE; the space is
// OPTIONAL in the spec. peer-client matched the literal 7- and 6-char prefixes
// 'event: ' / 'data: ', so a space-less event silently became 'message' (a name
// no peer consumer handles) and a space-less data dropped the whole frame.
test('D2: fields parse without the optional space after the colon', () => {
  const { seen } = drive(['event:activity\ndata:{"state":"idle"}\n\n']);
  assert.deepStrictEqual(seen, [['activity', { state: 'idle' }]],
    'a prefix-matching parser yields ["message", null] here — the frame is lost');
});

test('D2: exactly ONE leading space is stripped, not all whitespace', () => {
  // Not a nicety: `data:  "x"` must yield the string ' "x"', so a payload whose
  // own first character is a space survives. Over-trimming corrupts data.
  assert.deepStrictEqual(parseSseBlock('event:activity\ndata:  x'), { event: 'activity', data: ' x' });
});

// ── D3: multi-line data ─────────────────────────────────────────────────────
//
// WINDOW: repeated `data:` lines in one frame. The SSE spec joins them with a
// newline; peer-client OVERWROTE, keeping only the last. Latent against
// remote.js (which writes single-line JSON) but it is the shape of the bug that
// bites the first time a frame carries an embedded newline.
test('D3: multiple data lines join with a newline (the GUI copy kept only the last)', () => {
  assert.deepStrictEqual(parseSseBlock('data: a\ndata: b\ndata: c'), { event: null, data: 'a\nb\nc' });
});

test('D3: a JSON payload split over data lines still parses', () => {
  const { seen } = drive(['event: replay\ndata: {"cols":80,\ndata: "rows":24}\n\n']);
  assert.deepStrictEqual(seen, [['replay', { cols: 80, rows: 24 }]],
    'overwrite semantics would leave an unparseable fragment');
});

// ── D4: unparseable data, the PRESERVED divergence ─────────────────────────
//
// Not resolved — this is real policy and each head keeps its own. The two
// assertions below are the two heads' contracts, side by side, which is the
// only place they can be compared.
test('D4: dropUnparsableData=false (CLI) delivers the raw string', () => {
  const { seen } = drive(['event: log\ndata: not json\n\n']);
  assert.deepStrictEqual(seen, [['log', 'not json']]);
});

test('D4: dropUnparsableData=true (GUI) drops the frame entirely', () => {
  const { seen } = drive(['event: log\ndata: not json\n\n'], { dropUnparsableData: true });
  assert.deepStrictEqual(seen, [], 'the peer consumers dereference the payload — a raw string would throw at them');
});

test('D4: dropping one bad frame does not stop the stream', () => {
  const { seen } = drive(['data: nope\n\ndata: {"a":1}\n\n'], { dropUnparsableData: true });
  assert.deepStrictEqual(seen, [['message', { a: 1 }]]);
});

// ── D5: the buffer bound, the OTHER preserved divergence ───────────────────
//
// peer-client bounds the residual buffer at 8MB (peer-client.js's
// SSE_MAX_BUFFER_BYTES); cli/src/client.js has NO equivalent and never did.
// Preserved rather than reconciled: this is a behaviour-preserving ticket.
test('D5: maxBufferBytes fires onOverflow and stops the decoder', () => {
  const big = 'x'.repeat(200);
  // One complete frame, then residue past the bound. The bound is checked
  // inside the drain loop AFTER a frame is sliced off — peer-client's exact
  // placement, preserved.
  const { seen, overflows, results } = drive(
    [`data: {"a":1}\n\ndata: ${big}`],
    { maxBufferBytes: 100 },
  );
  assert.deepStrictEqual(overflows, [true], 'overflow fired once');
  assert.deepStrictEqual(seen, [], 'and the frame that triggered the check was NOT delivered');
  assert.deepStrictEqual(results, [false], 'push reports the decoder is dead');
});

test('D5: an overflowed decoder stays dead (no re-entry mid-teardown)', () => {
  const seen = [];
  const overflows = [];
  const dec = makeSseDecoder({
    onEvent: (n, d) => seen.push([n, d]),
    onOverflow: () => overflows.push(true),
    maxBufferBytes: 50,
  });
  dec.push(`data: {"a":1}\n\n${'x'.repeat(100)}`);
  assert.strictEqual(dec.push('data: {"a":2}\n\n'), false, 'later pushes are no-ops');
  assert.deepStrictEqual(seen, [], 'nothing delivered after overflow');
  assert.deepStrictEqual(overflows, [true], 'and onOverflow fired exactly once');
});

test('D5: maxBufferBytes=0 (the CLI default) is unbounded', () => {
  // The CLI has no bound. Pinning the ABSENCE so a future "tidy-up" that adds
  // one has to do it deliberately, as a decision with its own evidence.
  const seen = [];
  const overflows = [];
  const dec = makeSseDecoder({ onEvent: (n, d) => seen.push([n, d]), onOverflow: () => overflows.push(true) });
  dec.push(`data: {"a":1}\n\n${'x'.repeat(20 * 1024 * 1024)}`);
  assert.deepStrictEqual(seen, [['message', { a: 1 }]], 'the frame delivered normally');
  assert.deepStrictEqual(overflows, [], 'and 20MB of residue triggered nothing');
  assert.ok(dec.buffered() > 8 * 1024 * 1024, 'the buffer really did exceed the GUI-side bound');
});

// ── grammar edges that both copies shared, pinned so the move cannot lose them ──

test('a dataless frame yields nothing', () => {
  const { seen } = drive(['event: x\n\n']);
  assert.deepStrictEqual(seen, [], 'an event: with no data: is not deliverable');
});

test('an absent event: name defaults to message', () => {
  const { seen } = drive(['data: {"a":1}\n\n']);
  assert.deepStrictEqual(seen, [['message', { a: 1 }]]);
});

test('a comment line inside a real frame is ignored, not treated as data', () => {
  assert.deepStrictEqual(parseSseBlock(': ping\ndata: a\ndata: b'), { event: null, data: 'a\nb' });
});
