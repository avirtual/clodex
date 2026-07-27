'use strict';
// peer-client-backoff-open.test.js — t50: not every successful open is a good one.
//
// THE DEFECT. Both SSE consumers reset their reconnect backoff to the 1s floor
// inside onOpen — i.e. on the arrival of a 200. A 200 costs the producer nothing
// to emit, so it proves nothing about the stream behind it: a producer that
// overflows the residue bound reaches 200 first and dies inside one pass, and so
// does one that closes at byte zero. Either put the reconnect loop on the floor
// FOREVER, moving up to a megabyte per pass in the overflow case. Bandwidth-bound
// rather than a CPU spin, so nothing would ever have announced it.
//
// WHAT IS PINNED, and none of it is "onStable exists":
//   1. A stream that opens 200 and dies immediately makes the backoff GROW.
//      Asserted at a value the pre-fix code CANNOT reach: resetting on open
//      pins the backoff at exactly one doubling no matter how many cycles run.
//   2. The same, driven by the residue OVERFLOW specifically — the case that
//      motivated the ticket, as opposed to the general shape in (1).
//   3. An idle-but-healthy stream — one emitting nothing but `: ping` comments —
//      DOES reset. This is the false positive that would get the whole fix
//      reverted, and it is why the criterion is "the open lasted" and not "an
//      event was decoded": a healthy quiet peer decodes nothing for as long as
//      nothing happens.
//   4. The ATTACH stream gets the identical treatment. It had the same reset and
//      is the worse of the two — one stream per attached session, so a malformed
//      box ran N cycles on the floor rather than one.
//   5. A dead stream's stability timer does not survive it: no reset lands for a
//      connection that has already closed, and nothing stays armed.
//
// HOW GROWTH IS OBSERVED. By reading the backoff field, not by timing the
// reconnect gaps. The gaps are real timers (onClose's setTimeout is deliberately
// NOT on the injected seam), so a timing assertion would be measuring the
// machine's load as much as the policy — and on a slow box a wall-clock bound
// would be satisfied by the wrong thing. Every test below also anchors on the
// server-side reconnect COUNT, so "the backoff grew" can never pass vacuously
// without the reconnects that grew it having actually happened.
//
// The staleness bound and the residue ceiling are overridden per connection only
// so these move virtual seconds and kilobytes; production takes STALE_MS and
// sse-frame's MAX_BUFFER_BYTES.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PeerConnection } = require('../peer-client');
const { STALE_MS } = require('../cli/src/sse-guard');

// The reconnect floor and one doubling off it (peer-client's RECONNECT_MIN_MS).
// Named here because the pre-fix ceiling is exactly ONE doubling: resetting on
// open means every cycle runs floor -> floor*2 and never further, so FLOOR * 2 is
// the value that separates the two implementations.
const FLOOR_MS = 1000;
const ONE_DOUBLING_MS = FLOOR_MS * 2;

const CHUNK = 64 * 1024;         // what Node actually hands a res 'data' handler
const TEST_LIMIT = 128 * 1024;   // small enough to trip in a couple of chunks

// A virtual clock behind { setTimeout, clearTimeout } — the same seam
// peer-client-sse-watchdog.test.js drives. Since t50 a live stream arms TWO
// timers on it (the staleness watchdog and the stability timer), which is what
// `pending` counts below.
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

// A box whose SSE behaviour is switchable mid-test: `mode` decides what every
// subsequent stream does. 'die' is the defect's shape — a live 200 with zero
// body bytes, closed at once; 'hold' is the healthy idle shape — a live 200 held
// open, silent but for whatever the test writes into it.
function box({ mode = 'die', limit = null } = {}) {
  const state = { mode, streams: [], events: 0, attaches: 0 };
  const serve = (res, kind) => {
    if (kind === 'events') state.events++; else state.attaches++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // flushHeaders and no preamble: Node holds headers back until the first body
    // write, so without this a "silent" response would never reach 200 on the
    // client at all — the request would be PENDING, not open-and-bad, and every
    // test here would pass for a reason that has nothing to do with the fix.
    res.flushHeaders();
    if (state.mode === 'die') {
      // Open, then nothing, then gone. The producer emitted a perfectly good
      // status line and zero usable bytes.
      res.end();
      return;
    }
    if (state.mode === 'overflow') {
      // Unframed bytes past the residue ceiling, in the sizes Node really
      // delivers. No `\n\n` anywhere: this is the case the bound exists for.
      const junk = 'x'.repeat(CHUNK);
      for (let sent = 0; sent < (limit || TEST_LIMIT) + CHUNK * 2; sent += CHUNK) {
        try { res.write(junk); } catch { break; }
      }
    }
    state.streams.push(res);
  };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/api/peer/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'clodex', host: 'h', caps: [], version: '1' }));
    } else if (p === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    } else if (p === '/api/events') {
      serve(res, 'events');
    } else if (p.startsWith('/api/attach/')) {
      serve(res, 'attach');
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

// Every wait carries a label: for a backoff test the difference between "never
// reconnected" and "never reset" is the whole diagnosis, and a bare timeout
// would report neither.
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

function connect(port, clock, extra = {}) {
  return new PeerConnection({
    id: 'box', label: 'box', url: `http://127.0.0.1:${port}`,
    emit: () => {},
    helloIntervalMs: 10000,   // slow: prove the SSE machinery acts, not a hello tick
    timers: clock.timers,
    ...extra,
  });
}

// Servers here hold SSE responses open, and an open response makes server.close()
// wait forever — a failing test would then HANG instead of reporting (t48).
function teardown(conn, server, state) {
  conn.stop();
  for (const s of state.streams) { try { s.end(); } catch {} }
  try { server.closeAllConnections(); } catch {}
  server.close();
}

// WINDOW: two full reconnect cycles of a stream that reaches 200 and carries
// nothing. The clock is never advanced, so the stability timer CANNOT fire —
// which is the point: the only way the backoff reaches a second doubling is if
// nothing reset it in between.
//
// Why the assertion is `> ONE_DOUBLING_MS` and not merely `> FLOOR_MS`: with the
// reset in onOpen the backoff is not stuck at the floor, it oscillates
// floor -> floor*2 on every single cycle. So `> FLOOR_MS` would be satisfied by
// the pre-fix code at any moment after the first close, and the test would be
// green over the defect. Only the SECOND doubling is unreachable pre-fix.
test('a stream that opens 200 and dies at byte zero backs off instead of cycling on the floor', async () => {
  const { server, state } = box({ mode: 'die' });
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    // Three opens = two completed close→backoff cycles. Driven by the SERVER's
    // count, so the backoff cannot be read before the reconnects that move it
    // have actually happened.
    await waitFor('the events stream to open, die and reconnect twice (3 opens)',
      () => state.events >= 3);
    assert.ok(conn._eventsBackoff > ONE_DOUBLING_MS,
      `backoff grew past one doubling across repeated bad opens (was ${conn._eventsBackoff}ms; `
      + `resetting on open pins it at ${ONE_DOUBLING_MS}ms forever)`);
  } finally {
    teardown(conn, server, state);
  }
});

// WINDOW: the motivating instance rather than the general shape — a producer
// whose stream is killed by the residue bound. It reaches 200, moves real bytes,
// and is destroyed from inside the decoder. Distinct from the test above because
// the death path is different (onOverflow's req.destroy, not a server end) and
// because "it carried a lot of bytes" is exactly the reason a chunk-counting
// criterion would have called this a good open.
test('a stream killed by the residue bound backs off (bytes moved are not evidence of a good open)', async () => {
  const { server, state } = box({ mode: 'overflow' });
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock, { sseMaxBufferBytes: TEST_LIMIT });
  conn.start();
  try {
    await waitFor('the overflowing events stream to be torn down and retried twice (3 opens)',
      () => state.events >= 3);
    assert.ok(conn._eventsBackoff > ONE_DOUBLING_MS,
      `an overflowing producer backs off (was ${conn._eventsBackoff}ms)`);
  } finally {
    teardown(conn, server, state);
  }
});

// WINDOW: a healthy peer with nothing to say. This is the opposite error — the
// one that would make the fix worse than the defect — and it is why the
// criterion is lifetime rather than decoded traffic: everything this stream
// emits is a comment frame, which yields no SSE event by design.
//
// The backoff is driven UP by a real bad cycle first rather than assigned, so
// the reset is observed happening, not assumed from a starting value.
test('an idle-but-healthy stream resets the backoff (heartbeats alone count as a good open)', async () => {
  const { server, state } = box({ mode: 'die' });
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    // Phase 1: one genuine bad cycle, so there is something to reset.
    await waitFor('one bad open to raise the backoff off the floor', () => state.events >= 2);
    assert.ok(conn._eventsBackoff > FLOOR_MS, 'precondition: the backoff is off the floor');

    // Phase 2: the box starts behaving. The next open is held open and silent.
    state.mode = 'hold';
    await waitFor('a stream to be held open and fully armed',
      () => state.streams.length === 1 && clock.pending() === 2);
    // Which open number the held one turned out to be is a race with the
    // in-flight reconnect cycle, so it is READ rather than assumed — the property
    // under test is that this stream survives, not that it was the Nth.
    const heldAt = state.events;

    // Just under the staleness bound, then remote.js's exact heartbeat frame.
    // Without the ping the watchdog would kill this stream at STALE_MS and the
    // stability timer would never be reached — so the ping is load-bearing here,
    // not decoration.
    clock.advance(STALE_MS - 1);
    const armsBefore = clock.arms();
    state.streams[0].write(': ping\n\n');
    // Synchronise on the re-arm itself: a fresh setTimeout on this clock is the
    // observable proof the chunk reached the data handler. Sleeping instead would
    // race it.
    await waitFor('the heartbeat to re-arm the watchdog', () => clock.arms() > armsBefore);

    // Past the stability deadline (STALE_MS + margin), still short of the
    // re-armed watchdog (which now fires at 2*STALE_MS - 1).
    clock.advance(FLOOR_MS + 2);
    assert.strictEqual(state.events, heldAt, 'the healthy stream was not torn down');
    assert.strictEqual(conn._eventsBackoff, FLOOR_MS,
      'a stream that merely LASTED — no decoded events at all — reset the backoff');
  } finally {
    teardown(conn, server, state);
  }
});

// WINDOW: the attach call site. It carried the identical reset and is the worse
// of the two, since there is one attach stream per attached session: a malformed
// box put N cycles on the floor, not one. Asserted separately because the two
// call sites are separate code — fixing only the events feed would leave this
// green nowhere else.
test('the attach stream backs off on repeated bad opens too', async () => {
  const { server, state } = box({ mode: 'die' });
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    await waitFor('the peer to come online', () => conn.online);
    conn.attach('sess');
    await waitFor('the attach stream to open, die and reconnect twice (3 opens)',
      () => state.attaches >= 3);
    const att = conn._attachments.get('sess');
    assert.ok(att, 'the attachment survived its reconnects');
    assert.ok(att.backoff > ONE_DOUBLING_MS,
      `the attach backoff grew past one doubling (was ${att.backoff}ms)`);
  } finally {
    teardown(conn, server, state);
  }
});

// WINDOW: the stability timer of a stream that has already closed. Two failures
// live here and they are different — a timer that fires would reset the backoff
// of a connection that is dead or has already moved on (undoing the very growth
// the tests above pin), and a timer that merely stays armed keeps the event loop
// alive after teardown. Both are covered by clearing it on the one close door,
// which is why it is cleared there rather than anywhere else.
test('a closed stream leaves no stability timer armed and resets nothing after the fact', async () => {
  const { server, state } = box({ mode: 'hold' });
  const port = await listen(server);
  const clock = fakeClock();
  const conn = connect(port, clock);
  conn.start();
  try {
    await waitFor('a stream to be held open and fully armed',
      () => state.streams.length === 1 && clock.pending() === 2);

    // Kill it from the box side, and stop the client before it can reconnect —
    // so whatever is left on the clock belongs to the dead stream and nothing
    // else. `pending` is unambiguous here: the hello loop and the reconnect
    // backoff are on real timers, never this one.
    state.streams[0].end();
    await waitFor('the client to see the close', () => conn._eventsReq === null);
    conn.stop();
    assert.strictEqual(clock.pending(), 0,
      'the dead stream left neither its watchdog nor its stability timer armed');

    // And nothing fires late: advancing well past the stability deadline must not
    // touch the backoff the failed cycle left behind.
    const before = conn._eventsBackoff;
    clock.advance((STALE_MS + FLOOR_MS) * 2);
    assert.strictEqual(conn._eventsBackoff, before,
      'no reset arrived from a stream that had already closed');
  } finally {
    teardown(conn, server, state);
  }
});
