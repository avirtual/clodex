'use strict';
// sse-guard.test.js — the shared staleness watchdog + bounded reconnect. Pure
// decision functions (backoffSchedule, makeWatchdog) with injected timers, and
// openGuarded's reconnect loop against a fake client whose openEventStream we
// drive by hand (no real sockets — this is the reconnect POLICY, tested apart
// from the wire).
const { test } = require('node:test');
const assert = require('node:assert');
const { EXIT, CliError } = require('../src/errors');
const G = require('../src/sse-guard');

test('backoffSchedule: exponential from base, N attempts', () => {
  assert.deepStrictEqual(G.backoffSchedule(3, 1000), [1000, 2000, 4000]);
  assert.deepStrictEqual(G.backoffSchedule(4, 500), [500, 1000, 2000, 4000]);
  assert.deepStrictEqual(G.backoffSchedule(), [1000, 2000, 4000]);
});

// A controllable fake clock: setTimeout records callbacks with their delay;
// advance(ms) fires everything due.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pend = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; pend.set(id, { fn, at: now + (ms || 0) }); return id; },
      clearTimeout: (id) => { pend.delete(id); },
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pend.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { pend.delete(id); t.fn(); }
      }
    },
    pending: () => pend.size,
  };
}

test('makeWatchdog: fires onStale after staleMs without a pet', () => {
  const clk = fakeTimers();
  let fired = 0;
  const wd = G.makeWatchdog(60000, () => { fired++; }, clk.timers);
  wd.pet();
  clk.advance(59000);
  assert.strictEqual(fired, 0);
  clk.advance(2000);
  assert.strictEqual(fired, 1);
});

test('makeWatchdog: pets reset the countdown — heartbeat traffic never fires it', () => {
  const clk = fakeTimers();
  let fired = 0;
  const wd = G.makeWatchdog(60000, () => { fired++; }, clk.timers);
  wd.pet();
  // A heartbeat every 25s keeps petting; total 100s but never 60s idle.
  for (let i = 0; i < 4; i++) { clk.advance(25000); wd.pet(); }
  assert.strictEqual(fired, 0);
  // Now go silent → fires once.
  clk.advance(60000);
  assert.strictEqual(fired, 1);
});

test('makeWatchdog: fires at most once; stop() cancels', () => {
  const clk = fakeTimers();
  let fired = 0;
  const wd = G.makeWatchdog(1000, () => { fired++; }, clk.timers);
  wd.pet();
  clk.advance(2000);
  assert.strictEqual(fired, 1);
  wd.pet(); // ignored after fire
  clk.advance(2000);
  assert.strictEqual(fired, 1);

  const wd2 = G.makeWatchdog(1000, () => { fired++; }, clk.timers);
  wd2.pet(); wd2.stop();
  clk.advance(2000);
  assert.strictEqual(fired, 1);
});

// A fake WireClient.openEventStream: hands the caller's callbacks back to the
// test via a shared list so it can drive onOpen/onEvent/onChunk/onError and see
// close() calls. Each connect appends a new "connection".
function fakeClient() {
  const conns = [];
  return {
    conns,
    openEventStream(path, verb, cbs) {
      const c = { path, verb, cbs, closed: false };
      conns.push(c);
      return { close() { c.closed = true; } };
    },
  };
}

// A wait() that records the delay and resolves on the next microtask so the
// reconnect proceeds deterministically without real time.
function instantWait(log) {
  return (ms) => { log.push(ms); return Promise.resolve(); };
}

test('openGuarded: transient CONNECT drop → reconnects with backoff', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  const notices = [];
  const g = G.openGuarded(client, '/api/events', 'x', {
    onNotice: (n) => notices.push(n),
    onGiveUp: () => {},
    timers: clk.timers,
    wait: instantWait(waits),
  });
  assert.strictEqual(client.conns.length, 1);
  // First connection lives, then dies with a CONNECT error.
  client.conns[0].cbs.onOpen();
  client.conns[0].cbs.onError(new CliError(EXIT.CONNECT, 'dropped'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(waits, [1000]);
  assert.deepStrictEqual(notices, [1]);
  assert.strictEqual(client.conns.length, 2, 'reconnected');
  assert.ok(client.conns[0].closed, 'old stream closed on drop');
  g.close();
});

test('openGuarded: definitive non-CONNECT error (404) → give up, no reconnect', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  let gaveUp = null;
  G.openGuarded(client, '/api/attach/x', 'x', {
    onGiveUp: (e) => { gaveUp = e; },
    timers: clk.timers,
    wait: instantWait([]),
  });
  client.conns[0].cbs.onError(new CliError(EXIT.NOTFOUND, 'no such session'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(client.conns.length, 1, 'did NOT reconnect on a 404');
  assert.strictEqual(gaveUp.exitCode, EXIT.NOTFOUND);
});

test('openGuarded: exhausts the backoff → gives up with CONNECT', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  let gaveUp = null;
  G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: (e) => { gaveUp = e; },
    timers: clk.timers,
    wait: instantWait(waits),
  });
  // Drop 4 times (3 backoff slots). Each drop reconnects until the budget runs.
  for (let i = 0; i < 4; i++) {
    const c = client.conns[client.conns.length - 1];
    c.cbs.onError(new CliError(EXIT.CONNECT, 'dropped'));
    await new Promise((r) => setImmediate(r));
  }
  assert.deepStrictEqual(waits, [1000, 2000, 4000]);
  assert.strictEqual(client.conns.length, 4, '3 reconnects then give up');
  assert.ok(gaveUp && gaveUp.exitCode === EXIT.CONNECT);
  assert.match(gaveUp.message, /reconnect attempts failed/);
});

test('openGuarded: a good reconnect resets the attempt budget', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: () => {}, timers: clk.timers, wait: instantWait(waits),
  });
  // Two drops (backoff 1s, 2s), then a healthy onOpen resets, then one more drop
  // should start again at 1s — proving the counter reset.
  client.conns[0].cbs.onError(new CliError(EXIT.CONNECT, 'd'));
  await new Promise((r) => setImmediate(r));
  client.conns[1].cbs.onError(new CliError(EXIT.CONNECT, 'd'));
  await new Promise((r) => setImmediate(r));
  client.conns[2].cbs.onOpen();                 // healthy → reset budget
  client.conns[2].cbs.onError(new CliError(EXIT.CONNECT, 'd'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(waits, [1000, 2000, 1000]);
});

test('openGuarded: watchdog stale fires a reconnect via petting', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: () => {}, timers: clk.timers, wait: instantWait(waits),
  });
  client.conns[0].cbs.onOpen();
  // No chunk pets for 60s → watchdog fires → treated as a CONNECT drop.
  clk.advance(60000);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(waits, [1000]);
  assert.strictEqual(client.conns.length, 2, 'stale stream reconnected');
});

test('openGuarded: onChunk pets the watchdog (no false stale under heartbeats)', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: () => {}, timers: clk.timers, wait: instantWait(waits),
  });
  client.conns[0].cbs.onOpen();
  for (let i = 0; i < 4; i++) { clk.advance(25000); client.conns[0].cbs.onChunk(': ping\n\n'); }
  clk.advance(30000);              // 130s total, but never 60s idle
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(waits, [], 'no reconnect while heartbeats arrive');
  assert.strictEqual(client.conns.length, 1);
});

test('openGuarded: a throw from onOpen is a retryable drop', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  G.openGuarded(client, '/api/events', 'x', {
    onOpen: () => { throw new Error('re-acquire failed'); },
    onGiveUp: () => {}, timers: clk.timers, wait: instantWait(waits),
  });
  client.conns[0].cbs.onOpen();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(waits, [1000]);
  assert.strictEqual(client.conns.length, 2);
});

test('openGuarded: close() during a backoff wait clears the pending timer (no leak past detach)', async () => {
  // No injected `wait` → the DEFAULT backoff sleep runs on the (fake) clock, so
  // its timer handle is real and trackable. Detaching mid-backoff must clear it,
  // or the process hangs up to backoff[n] after "detached" (bin uses exitCode).
  const client = fakeClient();
  const clk = fakeTimers();
  const g = G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: () => {}, timers: clk.timers,   // no `wait` → default path
  });
  client.conns[0].cbs.onOpen();
  client.conns[0].cbs.onError(new CliError(EXIT.CONNECT, 'dropped'));
  // handleDrop ran synchronously: watchdog cleared, one backoff timer pending.
  assert.strictEqual(clk.pending(), 1, 'a backoff sleep is pending');
  g.close();
  assert.strictEqual(clk.pending(), 0, 'close() cleared the pending backoff timer');
  // And even if the clock is advanced past the window, nothing reconnects.
  clk.advance(10000);
  assert.strictEqual(client.conns.length, 1, 'no reconnect after close');
});

test('openGuarded: default backoff wait reconnects when the clock advances', async () => {
  // Guards the wait-seam refactor: with no injected `wait`, a CONNECT drop still
  // reconnects once the (fake) backoff timer fires.
  const client = fakeClient();
  const clk = fakeTimers();
  const g = G.openGuarded(client, '/api/events', 'x', {
    onGiveUp: () => {}, timers: clk.timers,
  });
  client.conns[0].cbs.onOpen();
  client.conns[0].cbs.onError(new CliError(EXIT.CONNECT, 'dropped'));
  clk.advance(1000);                       // backoff[0]
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(client.conns.length, 2, 'default wait reconnected');
  g.close();
});

test('openGuarded: close() suppresses further reconnects + callbacks', async () => {
  const client = fakeClient();
  const clk = fakeTimers();
  const waits = [];
  let events = 0;
  const g = G.openGuarded(client, '/api/events', 'x', {
    onEvent: () => { events++; }, onGiveUp: () => {}, timers: clk.timers, wait: instantWait(waits),
  });
  g.close();
  assert.ok(client.conns[0].closed);
  client.conns[0].cbs.onEvent('activity', {});   // ignored after close
  client.conns[0].cbs.onError(new CliError(EXIT.CONNECT, 'd'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(events, 0);
  assert.deepStrictEqual(waits, []);
  assert.strictEqual(client.conns.length, 1);
});
