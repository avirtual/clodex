'use strict';

// tunnel-supervisor-overlap.test.js — t51, the REWORK on t49.
//
// One theme: `_spawnOn` starts a readiness loop PER CHILD, so two loops can be
// alive at once, and everything about a loop that lived in a per-INSTANCE slot
// was therefore taken from the older loop by the newer one. That is the same
// defect class as D2 (`bornAt` as a field), re-introduced by the merge in the
// new probe code — which is why it gets its own file rather than a paragraph in
// tunnel-supervisor.test.js.
//
// Plus the two guards the cold review found missing or vacuous: the stale
// `error` callback (D3 claims "every child callback" but only `exit` was
// pinned), and `giveUpMs: 0`, a behaviour that changed meaning in the move.
//
// spawn is faked throughout; no real ssh runs.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { EventEmitter } = require('events');

const { SupervisedTunnel } = require('../tunnel-supervisor');

function fakeChild({ syncExit = true } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; if (syncExit) child.emit('exit', 0); };
  return child;
}

function makeSpawnRecorder({ syncExit = true } = {}) {
  const calls = [];
  const children = [];
  const spawnFn = (cmd, args, opts) => {
    const child = fakeChild({ syncExit });
    calls.push({ cmd, args, opts });
    children.push(child);
    return child;
  };
  return { calls, children, spawnFn };
}

function waitFor(pred, what, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = pred();
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function settle(ms) { await new Promise((r) => setTimeout(r, ms)); }

// Is this promise still outstanding? Bounded, and never rejects — an assertion
// about something NOT having happened must not be able to hang the runner.
async function outcome(p, ms) {
  return Promise.race([p.then(() => 'resolved'), settle(ms).then(() => 'pending')]);
}

function peerish(over) {
  return {
    id: 'p1', sshHost: 'box', remotePort: 7900,
    backoffMinMs: 20, backoffMaxMs: 40, stableMs: 100_000,
    giveUpMs: null, pinPort: false, readiness: null,
    onState: () => {}, ...over,
  };
}

// ── MUST-FIX: two live probe loops, and the state each one owns ──────────────
//
// WINDOW, and the arithmetic that reaches it. `pollMs` is LONGER than the
// restart backoff, per the ticket: kill the first child mid-sleep and its loop
// L1 is still parked when the replacement child spawns and starts L2. L1 sleeps
// [0, POLL_MS] and then fails its ownership re-check and returns; L2 sleeps
// [BACKOFF_MS, BACKOFF_MS + POLL_MS]. So the window in which exactly one loop
// is finished and the other is ASLEEP is
//
//     (POLL_MS, BACKOFF_MS + POLL_MS)   — and its length is BACKOFF_MS.
//
// That length is the number that matters, and it is why BACKOFF_MS is 800 here
// rather than something small: the assertions below spend real time INSIDE the
// window (a "still pending" claim is only worth what you waited for it), so a
// window merely wide enough to enter is not wide enough to assert in. Measured
// at 300ms it was not: the pending-check's own wait carried the clock past
// L2's wake, L2 was awake and mid-probe by the time `stop()` landed, and the
// resolution below then held for a reason that had nothing to do with the wake
// — green over the very defect it exists to catch.
//
// Both ends are therefore machine-checked, and the upper end is re-checked
// immediately before `stop()`, which is the moment it has to be true.
//
// TWO defects live in that gap, and each assertion pins one:
//
//   (1) `settled()` said "no announcement is outstanding" while one was.
//       `_probing` was a single slot and L1's unconditional `.finally` nulled
//       it — the slot then held L2. Measured before the fix: `settled()`
//       resolved while the live loop went on probing.
//
//   (2) stop() woke nothing. `_probeWake` was a single slot too: L2's sleep
//       overwrote L1's resolver, then L1 woke on its own timer and nulled the
//       slot on the way out — taking L2's only wake with it. stop() clears L2's
//       timer and finds nothing to call, so L2's await never settles and its
//       frame is retained for the life of the process. That is the EXACT bug
//       the wake was added to close, re-opened by having two loops.
test('two overlapping probe loops each own their own wake, timer and promise', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder({ syncExit: false });
  const POLL_MS = 1000;
  const BACKOFF_MS = 800;         // = the width of the window; see above
  const PENDING_WAIT_MS = 200;    // spent inside it, and must fit inside it
  const probed = [];
  let firstProbeAt = 0;
  const tun = new SupervisedTunnel(peerish({
    spawnFn,
    backoffMinMs: BACKOFF_MS, backoffMaxMs: BACKOFF_MS,
    readiness: {
      // Never accepts, so every loop goes to sleep between attempts — the
      // ordinary case, and the only one in which a loop holds a wake at all.
      probe: async (port) => { probed.push(port); firstProbeAt = firstProbeAt || Date.now(); return false; },
      timeoutMs: 60_000, pollMs: POLL_MS,
    },
  }));

  tun.start();
  await waitFor(() => probed.length === 1, 'L1`s first probe');
  const firstPort = tun.localPort;

  // Killed mid-sleep: L1 is parked on its 1000ms poll and will not notice for
  // another second.
  children[0].emit('exit', 255);
  await waitFor(() => calls.length === 2, 'the replacement child');
  await waitFor(() => probed.length === 2, 'L2`s first probe');
  assert.notStrictEqual(tun.localPort, firstPort, 'sanity: the replacement is a different tunnel');

  // Into the gap. Both bounds are checked, not hoped for.
  await settle(POLL_MS - BACKOFF_MS + 100);
  assert.ok(Date.now() - firstProbeAt > POLL_MS,
    'the test never entered its window: L1 has not reached the end of its sleep, so it has not finished and nothing has been taken from L2 yet');
  assert.strictEqual(probed.length, 2,
    'the test overran its window: L2 woke and probed again, so it is no longer the sleeping loop these assertions are about');

  assert.strictEqual(await outcome(tun.settled(), PENDING_WAIT_MS), 'pending',
    'settled() resolved while a readiness loop is still outstanding — the older loop`s completion nulled a slot that by then held the LIVE loop, so the supervisor reports finished while it goes on probing');

  // (2) and now the wake, from the same overlap — but only if L2 is still
  // ASLEEP. A loop that has woken by itself resolves for its own reasons, and
  // the assertion below would then hold with no wake at all. Re-checked here
  // because the pending-wait above consumed part of the window.
  assert.strictEqual(probed.length, 2,
    'the sleeping loop woke on its own before stop() — the window closed while the previous assertion was being waited out, so what follows would pass without any wake being delivered');
  tun.stop();
  assert.strictEqual(await outcome(tun.settled(), 1000), 'resolved',
    'the live loop is still parked on a sleep whose timer stop() cleared: its wake resolver was overwritten by the second loop and then nulled by the first, so nothing will ever resolve it and it holds the child and the supervisor with it');
});

// ── D3, the arm that was never pinned: a stale `error` ───────────────────────
//
// WINDOW: identical to the D3 exit test — stop() then start() with a child that
// is still dying — but the dead child raises `error` instead of `exit`. A real
// one can: a vendor CLI whose binary resolution fails, or an EPIPE on a child
// being torn down, both land on this callback.
//
// D3's claim is "every child callback is a no-op unless `this._child === child`"
// and only `exit` was actually tested — removing `mine()` from `error` left all
// 71 green. Without it the handler nulls `_child` out from under the LIVE
// child, releases its port and schedules a restart, so a third ssh lands on top
// of a forward that was never down.
test('D3: a stale ERROR from a killed child never disturbs the live one', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder({ syncExit: false });
  const tun = new SupervisedTunnel(peerish({ spawnFn }));
  tun.start();
  await waitFor(() => calls.length === 1, 'the first spawn');
  const first = children[0];
  const firstPort = tun.localPort;

  tun.stop();                       // signals `first`; nothing has landed yet
  tun.start();
  await waitFor(() => calls.length === 2, 'the replacement spawn');
  assert.strictEqual(tun.state, 'up');
  const livePort = tun.localPort;
  assert.notStrictEqual(livePort, firstPort, 'sanity: the replacement really is a different tunnel');

  const err = new Error('spawn ssh ENOENT');
  err.code = 'ENOENT';
  first.emit('error', err);
  await settle(120);

  assert.strictEqual(calls.length, 2,
    `a third child was spawned on top of a live forward — the dead child's error handler ran against a tunnel it no longer owned (spawns: ${calls.length})`);
  assert.strictEqual(tun.localPort, livePort,
    'and the live tunnel`s port was released out from under it');
  assert.strictEqual(tun.state, 'up');
  tun.stop();
});

// ── The RETRY parameter's zero ───────────────────────────────────────────────
//
// WINDOW: `giveUpMs: 0` — give up on the FIRST failure. The pre-merge web side
// admitted it (`Number.isInteger(giveUpMs)`); the merged supervisor tested the
// value for truthiness, under which 0 falls through to "retry forever". That is
// not a weaker bound, it is the opposite policy, on the arm whose entire reason
// for existing is that someone's attention is finite.
//
// Latent — no call site passes 0 — and it is a behaviour lost in a MOVE, which
// is the category that gets a guard precisely because nothing else would catch
// it. Reverting to `if (this._giveUpMs)` fails this by message.
test('retry: giveUpMs 0 gives up on the first failure, it does not mean forever', async () => {
  const { children, spawnFn } = makeSpawnRecorder({ syncExit: false });
  const tun = new SupervisedTunnel(peerish({
    spawnFn, giveUpMs: 0, backoffMinMs: 20, backoffMaxMs: 20,
  }));
  tun.start();
  await waitFor(() => children.length === 1, 'the spawn');

  children[0].emit('exit', 255);
  await settle(120);

  assert.strictEqual(tun.state, 'gave-up',
    `giveUpMs: 0 asked for a bound of zero and got an unbounded retry instead — the tunnel is state '${tun.state}' after its first failure and will keep dialling a box nobody is waiting on`);
  assert.strictEqual(children.length, 1, 'and it must not have retried at all');
  tun.stop();
});

// ── D5's third death path ────────────────────────────────────────────────────
//
// WINDOW: a SYNCHRONOUS spawn failure — `spawnFn` itself throws, which is what
// `child_process.spawn` does on a bad argv or an unreadable cwd, and what
// `argv()` does if a builder rejects the block. That lands in `_spawnOn`'s
// catch, which is neither of the two death paths D5 unified: it was added later
// and left out, so `status().localPort` went on naming a port nothing ever
// bound.
//
// Cosmetic, exactly like D5 itself (`url()` gates on `state === 'up'`, so
// nothing downstream lies — the renderer's status row does), and free. Removing
// the `_releasePort()` from the catch fails this by message.
test('D5: an unpinned port is released when the spawn throws SYNCHRONOUSLY too', async () => {
  let thrown = 0;
  const spawnFn = () => { thrown++; throw new Error('spawn ssh EACCES'); };
  const tun = new SupervisedTunnel(peerish({
    spawnFn, backoffMinMs: 5_000, backoffMaxMs: 5_000,
  }));
  tun.start();
  await waitFor(() => thrown === 1, 'the throwing spawn');
  await settle(50);

  assert.strictEqual(tun.state, 'down');
  assert.strictEqual(tun.status().localPort, null,
    'the status row still names a local port, but the spawn threw before anything bound it — the third death path does not release, so D5 holds on two paths out of three');
  assert.strictEqual(tun.url(), null);
  tun.stop();
});

// ── D1, de-vacuumed ──────────────────────────────────────────────────────────
//
// The D1 test in tunnel-supervisor.test.js asserts that the port the supervisor
// REPORTS is the port its child was given. Two `pickFreePort` calls are in
// flight there, and each closes its listener before handing the port back — so
// if the two picks ever returned the SAME port the agreement would hold
// trivially, with or without the fix.
//
// (They can't in practice: both `listen(0)` binds land before either close, so
// the OS must hand out different ports. But "can't in practice" is the reasoning
// a guard exists to replace.)
//
// The seam is NOT the module's `pickFreePort` export — `_spawnTunnel` closes
// over the module-local const, so reassigning an export would change nothing,
// and the export is dropped in this pass for that reason among others. It is
// `net.createServer`, looked up on the module object at call time. Stubbed here
// to hand out two known-distinct ports, so the collision case is excluded by
// construction and the ports appear in the failure message.
test('D1: the reported port agrees with the child`s, with the port pick made distinct', async () => {
  const PORTS = [40001, 40002];
  const handed = [];
  const realCreateServer = net.createServer;
  net.createServer = () => {
    const port = PORTS[Math.min(handed.length, PORTS.length - 1)];
    handed.push(port);
    return {
      on() {},
      listen(_p, _host, cb) { setImmediate(cb); },
      address() { return { port }; },
      close(cb) { setImmediate(cb); },
    };
  };
  try {
    const { calls, spawnFn } = makeSpawnRecorder();
    const tun = new SupervisedTunnel(peerish({ spawnFn }));
    tun.start();
    tun.start();                    // both land before either pick resolves
    await waitFor(() => calls.length >= 1, 'the first spawn');
    await settle(120);

    assert.deepStrictEqual(handed, PORTS,
      'precondition: two picks really were in flight, and they returned DIFFERENT ports — otherwise the agreement below would hold for free');
    const forwarded = calls[0].args[calls[0].args.indexOf('-L') + 1];
    assert.strictEqual(forwarded.split(':')[0], String(tun.localPort),
      `the supervisor reports port ${tun.localPort} but its child forwards ${forwarded} — the second pick overwrote localPort, so url() names a port nothing is bound to and the peer client would dial it`);
    assert.strictEqual(tun.url(), `http://127.0.0.1:${PORTS[0]}`);
    tun.stop();
  } finally {
    net.createServer = realCreateServer;
  }
});
