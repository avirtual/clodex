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
const { parseSseBlock, makeSseDecoder, MAX_BUFFER_BYTES } = require('../src/sse-frame');

// Collect (event, data) pairs from a decoder driven by a list of chunks.
function drive(chunks, opts = {}) {
  const seen = [];
  const overflows = [];
  const dec = makeSseDecoder({
    onEvent: (name, data) => seen.push([name, data]),
    onOverflow: (bytes) => overflows.push(bytes),
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
// t48 REWROTE THE THREE TESTS THAT WERE HERE, and each one was pinning
// behaviour the ticket exists to remove — recorded rather than quietly edited:
//
//   · "fires onOverflow and stops the decoder" asserted the triggering frame
//     was NOT delivered. That was an artefact of the drain-loop placement: the
//     check aborted mid-drain, so a COMPLETE, well-framed frame was thrown away
//     because unrelated residue followed it. Now it is delivered and the
//     overflow fires on the residue, which is the correct split.
//   · "an overflowed decoder stays dead" carried the same assertion for the
//     same reason; the liveness half of it is kept.
//   · "maxBufferBytes=0 (the CLI default) is unbounded" pinned the ABSENCE of a
//     CLI bound as intended. That absence is half 1 of the defect. 0 still
//     disables — the escape hatch survives — but it is no longer the default,
//     and the test now says so.
test('D5: overflow fires on unframed residue, and complete frames still arrive', () => {
  const { seen, overflows, results } = drive(
    [`data: {"a":1}\n\ndata: ${'x'.repeat(200)}`],
    { maxBufferBytes: 100 },
  );
  assert.deepStrictEqual(seen, [['message', { a: 1 }]],
    'the complete frame was delivered — it is well-formed, and the residue behind it is not its fault');
  // 206 = the residue's real length: 'data: ' (6) + 200 x's.
  assert.deepStrictEqual(overflows, [206], 'overflow fired once, reporting the residue size');
  assert.deepStrictEqual(results, [false], 'push reports the decoder is dead');
});

test('D5: an overflowed decoder stays dead (no re-entry mid-teardown)', () => {
  const seen = [];
  const overflows = [];
  const dec = makeSseDecoder({
    onEvent: (n, d) => seen.push([n, d]),
    onOverflow: (n) => overflows.push(n),
    maxBufferBytes: 50,
  });
  dec.push(`data: {"a":1}\n\n${'x'.repeat(100)}`);
  assert.strictEqual(dec.push('data: {"a":2}\n\n'), false, 'later pushes are no-ops');
  assert.deepStrictEqual(seen, [['message', { a: 1 }]], 'only the pre-overflow frame, nothing after');
  assert.deepStrictEqual(overflows, [100], 'and onOverflow fired exactly once');
});

// WINDOW: the CLI's own default, which is half 1 of the t48 defect. Before this
// ticket a decoder built with no options was UNBOUNDED and `logs -f` could grow
// its buffer until the process died. Reverting the default to 0 fails this.
test('D5: the default is BOUNDED — an unbounded decoder is not constructible by accident', () => {
  const overflows = [];
  const dec = makeSseDecoder({ onEvent: () => {}, onOverflow: (n) => overflows.push(n) });
  // One byte over, in realistic chunks. No frame terminator anywhere.
  const chunk = 'x'.repeat(64 * 1024);
  let pushes = 0;
  for (let sent = 0; sent <= MAX_BUFFER_BYTES; sent += chunk.length) {
    pushes += 1;
    if (dec.push(chunk) === false) break;
  }
  assert.strictEqual(overflows.length, 1, 'the default bound fired');
  assert.ok(overflows[0] > MAX_BUFFER_BYTES, 'and it fired on residue past the limit');
  assert.ok(pushes > 1, 'it took many chunks to get there — i.e. the bound is checked ACROSS pushes, not within one');
});

test('D5: maxBufferBytes=0 still disables the bound (the escape hatch survives)', () => {
  const overflows = [];
  const dec = makeSseDecoder({ onEvent: () => {}, onOverflow: (n) => overflows.push(n), maxBufferBytes: 0 });
  dec.push('x'.repeat(4 * MAX_BUFFER_BYTES));
  assert.deepStrictEqual(overflows, [], 'explicitly opting out is still possible');
  assert.ok(dec.buffered() > MAX_BUFFER_BYTES, 'and the buffer really did pass the limit');
});

// ── the two windows that decide whether the bound is real (t48) ─────────────
//
// The pre-t48 bound was checked inside the drain loop and was UNREACHABLE over
// a real socket: firing needed one push carrying both a frame terminator and
// >limit of residue, and Node delivers response bytes in 64KB chunks (measured:
// 12MB arrived as 194 chunks, max 65536). So the two tests below are the ones
// that say whether this ticket did anything at all. Both feed bytes in the
// measured 64KB shape rather than one giant string, because the giant string is
// exactly the unrealistic case the old test used and the old bound survived.

const CHUNK = 64 * 1024;   // what Node actually hands a res 'data' handler

// WINDOW: an unterminated line arriving in realistic chunks. THIS IS THE CASE
// THE BOUND EXISTS FOR and the case the old placement could not catch. Against
// pre-t48 code (check inside the drain loop) no chunk here ever enters the loop
// — there is no frame terminator in the whole stream — so onOverflow never
// fires and this fails by message.
test('t48: an unterminated stream in 64KB chunks trips the bound (the old placement could not)', () => {
  const overflows = [];
  const dec = makeSseDecoder({
    onEvent: () => {},
    onOverflow: (n) => overflows.push(n),
    maxBufferBytes: 256 * 1024,       // small so the test moves ~256KB, not 1MB
  });
  const chunk = 'x'.repeat(CHUNK);
  let sent = 0;
  for (let i = 0; i < 100 && overflows.length === 0; i++) { sent += chunk.length; dec.push(chunk); }
  assert.strictEqual(overflows.length, 1, 'the bound fired on an unterminated stream');
  assert.ok(sent > 256 * 1024, 'and it took more than one chunk to trip — the accumulation is what is bounded');
  assert.ok(overflows[0] > 256 * 1024, `reported residue ${overflows[0]} exceeds the limit`);
});

// WINDOW: the FALSE POSITIVE that would make someone delete this bound. A busy
// session legitimately moves far more than the limit — it just arrives as
// frames. If total volume tripped the bound, every healthy long-lived attach
// would be killed, which is worse than having no bound at all.
//
// 4x the limit, in 64KB chunks, with frames straddling every chunk boundary
// (the frame size is deliberately not a divisor of the chunk size) so the
// residue is continuously non-empty — the hardest shape for an accumulation
// check to get right.
test('t48: a large WELL-FRAMED stream never trips the bound, however much it carries', () => {
  const overflows = [];
  let events = 0;
  const dec = makeSseDecoder({
    onEvent: () => { events++; },
    onOverflow: (n) => overflows.push(n),
    maxBufferBytes: 256 * 1024,
  });
  // ~7KB frames: not a divisor of 64KB, so boundaries never align.
  const frame = `data: {"pad":"${'y'.repeat(7000)}"}\n\n`;
  let stream = '';
  while (stream.length < 4 * 256 * 1024) stream += frame;
  for (let i = 0; i < stream.length; i += CHUNK) dec.push(stream.slice(i, i + CHUNK));
  assert.deepStrictEqual(overflows, [], 'a megabyte of well-framed traffic is not an overflow');
  assert.ok(events > 100, `and every frame was delivered (${events})`);
  assert.ok(dec.buffered() < frame.length, 'only a partial frame is ever held');
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
