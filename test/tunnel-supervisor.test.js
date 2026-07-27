'use strict';

// tunnel-supervisor.test.js — the shared supervisor (t49/L2).
//
// peer-tunnel.js's `Tunnel` and web-tunnel.js's `WebTunnel` are now one class
// under three parameters. test/peer-tunnel.test.js and test/web-tunnel.test.js
// keep pinning each side's BEHAVIOUR unchanged (63 tests, none edited for this
// ticket, which is the real regression guard for the merge). What is pinned
// HERE is only what the merge newly decides:
//
//   • the three drifts it resolved (D1, D3, D5 in tasks/tunnel-supervisor/) —
//     each was correct on at most one side, and each is now correct on both,
//   • the status row the two sides had disagreed about (D8),
//   • the RETRY parameter's two arms, which used to be "one class has give-up
//     code, the other has none" and is now a constructor argument — a one-word
//     edit, so it needs a guard it never had.
//
// spawn is faked throughout; no real ssh runs.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { SupervisedTunnel } = require('../tunnel-supervisor');
const { Tunnel } = require('../peer-tunnel');
const { WebTunnel } = require('../web-tunnel');

// A child that dies the way a real one does: `kill()` signals, and the exit
// lands LATER. The other tunnel suites use a child whose kill() emits 'exit'
// synchronously, which is convenient and hides exactly the window D3 is about —
// a stale exit arriving after the supervisor has moved on.
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

// Settle for a bounded time without ever rejecting — for assertions about
// something NOT happening, where a rejection would read as a hung suite and say
// nothing about what was expected.
async function settle(ms) { await new Promise((r) => setTimeout(r, ms)); }

// Peer-side policy, spelled out rather than imported, so a test that says
// "unbounded retry" is reading the arm it names.
function peerish(over) {
  return {
    id: 'p1', sshHost: 'box', remotePort: 7900,
    backoffMinMs: 20, backoffMaxMs: 40, stableMs: 100_000,
    giveUpMs: null, pinPort: false, readiness: null,
    onState: () => {}, ...over,
  };
}

// ── D1: the re-entry window around the free-port pick ────────────────────────
//
// WINDOW. `_spawnTunnel` guards on `_stopped || _child`, then goes async through
// a real `net.createServer().listen()` to pick a port — and `_child` is null for
// the whole of that round trip. `start()` has no guard covering it either (its
// own check is `!_stopped && _child`), so two starts land two picks.
//
// WHAT ACTUALLY BREAKS, which is not the obvious thing. `_spawnOn` has a
// `_child` guard of its own, so the second pass never spawns a second child —
// a spawn-count assertion here passes with or without the fix, and that is the
// first shape this test was written in. What the second pass DOES do is run
// `this.localPort = port` before reaching that guard. The live child is
// forwarding the FIRST port; `localPort`, `status()` and `url()` now all name
// the second, which nothing is bound to.
//
// On the wire side that URL is not decorative: onState → resolvePeerUrls →
// PeerManager.sync points the peer client straight at the dead port, and the
// symptom is a peer that reads offline while its forward is up.
//
// So the assertion is AGREEMENT between what the supervisor reports and what the
// child was actually given. Reverting the `|| this._child` half of the re-check
// fails it by message (measured: child forwards 61442, status says 61443).
test('D1: a second start in the port-pick window cannot re-point the reported URL', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new SupervisedTunnel(peerish({ spawnFn }));
  // Both calls land before either pick resolves — that IS the window.
  tun.start();
  tun.start();
  await waitFor(() => calls.length >= 1, 'the first spawn');
  await settle(120);

  assert.strictEqual(calls.length, 1, 'sanity: one child, which _spawnOn`s own guard already ensures');
  const forwarded = calls[0].args[calls[0].args.indexOf('-L') + 1];
  assert.ok(forwarded.startsWith(`${tun.localPort}:`),
    `the supervisor reports port ${tun.localPort} but its child forwards ${forwarded} — the second pick overwrote localPort, so url() names a port nothing is bound to and the peer client would dial it`);
  assert.strictEqual(tun.url(), `http://127.0.0.1:${forwarded.split(':')[0]}`);
  tun.stop();
});

// ── D3: a stale child's exit must not act on a live one ──────────────────────
//
// WINDOW. stop() → start() with a child that is still dying, which is what a
// real `ssh` does (kill signals; exit lands milliseconds later). The old child's
// exit handler then runs while a NEW child is the current one.
//
// Neither side had a guard for this: both handlers did `this._child = null` and
// scheduled a restart unconditionally. The consequence is not cosmetic — the
// live child is orphaned by having its reference cleared, the tunnel reports
// down while its forward is actually up, and a third spawn arrives on top.
//
// Reverting `mine()` in the exit handler fails this by message on the state
// assertion, not by crash.
test('D3: a stale exit from a killed child never disturbs the live one', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder({ syncExit: false });
  const tun = new SupervisedTunnel(peerish({ spawnFn }));
  tun.start();
  await waitFor(() => calls.length === 1, 'the first spawn');
  const first = children[0];
  const firstPort = tun.localPort;

  tun.stop();                       // signals `first`; its exit has NOT landed
  tun.start();
  await waitFor(() => calls.length === 2, 'the replacement spawn');
  assert.strictEqual(tun.state, 'up');
  const livePort = tun.localPort;

  // The old child finally dies, long after it stopped being ours.
  first.stderr.emit('data', 'ssh: connect to host box port 22: Connection refused\n');
  first.emit('exit', 255);
  await settle(120);

  assert.notStrictEqual(livePort, firstPort, 'sanity: the replacement really is a different tunnel');
  // The spawn count leads, because it is the symptom that survives: the stale
  // exit reports down and schedules a restart, and the restart then puts a
  // THIRD ssh on top of a forward that was never down. (Asserting the 'down'
  // state alone would be flaky in the other direction — the restart lands
  // inside the settle window and the state reads 'up' again by the end.)
  assert.strictEqual(calls.length, 2,
    `a third child was spawned on top of a live forward — the dead child's exit handler ran against a tunnel it no longer owned (spawns: ${calls.length})`);
  assert.strictEqual(tun.localPort, livePort,
    'and the live tunnel`s port was released out from under it');
  assert.strictEqual(tun.state, 'up');
  tun.stop();
});

// ── D5: the port is released on BOTH death paths, or on neither ──────────────
//
// WINDOW. A spawn FAILURE (ENOENT — the vendor CLI is not installed), which is
// the `child.on('error')` path, not the `exit` path. The wire supervisor cleared
// `localPort` on exit only, so after a missing-binary failure its status row
// named a port that was never bound.
//
// Reverting the `_releasePort()` in the error handler fails this by message.
test('D5: an unpinned port is released when the SPAWN fails, not only on exit', async () => {
  const { children, spawnFn } = makeSpawnRecorder();
  const tun = new SupervisedTunnel(peerish({ spawnFn, backoffMinMs: 5_000, backoffMaxMs: 5_000 }));
  tun.start();
  await waitFor(() => children.length === 1, 'the spawn');
  assert.ok(tun.localPort, 'precondition: a port was picked');

  const err = new Error('spawn kubectl ENOENT');
  err.code = 'ENOENT';
  children[0].emit('error', err);
  await settle(50);

  assert.strictEqual(tun.state, 'down');
  assert.strictEqual(tun.status().localPort, null,
    'the status row still names a local port, but the child never bound it — nothing is listening there');
  assert.strictEqual(tun.url(), null);
  tun.stop();
});

// WINDOW: the same failure on a PINNED tunnel, where the answer is the opposite
// and for the consumer's sake. The pin is the whole reason the web view exists
// as a separate policy: a browser tab holds the port as a dead string. Releasing
// it on a failed spawn would hand the next attempt a different port and strand
// the tab — the exact bug the pin prevents, reached through the one death path
// that used to be handled differently from the other.
test('D5: a PINNED port survives a failed spawn — the tab keeps working', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new SupervisedTunnel(peerish({
    spawnFn, pinPort: true, backoffMinMs: 20, backoffMaxMs: 20,
  }));
  tun.start();
  await waitFor(() => children.length === 1, 'the spawn');
  const pinned = tun.localPort;
  assert.ok(pinned, 'precondition: a port was pinned');

  const err = new Error('spawn kubectl ENOENT');
  err.code = 'ENOENT';
  children[0].emit('error', err);
  await waitFor(() => calls.length === 2, 'the retry after a failed spawn');

  assert.strictEqual(tun.localPort, pinned,
    'the pinned port was released on a failed spawn, so the retry bound a different one and the browser tab is stranded');
  const lIdx = calls[1].args.indexOf('-L');
  assert.ok(calls[1].args[lIdx + 1].startsWith(`${pinned}:`),
    'and the retry`s argv must carry the SAME local end');
  tun.stop();
});

// ── D8: one status row shape ─────────────────────────────────────────────────
//
// WINDOW: `status().url` on the WIRE side, which did not carry it while the web
// side did — although `url()` itself was identical on both. Two shapes for one
// row is how a consumer comes to assemble a URL from `localPort` itself, which
// is precisely the mistake `url()` exists to prevent (a port that is pinned but
// not currently forwarded is not a URL).
//
// Removing `url: this.url()` from status() fails this by message.
test('D8: both supervisors report the same status row, url included', async () => {
  const { children, spawnFn } = makeSpawnRecorder();
  const wire = new Tunnel({ id: 'p1', sshHost: 'box', spawnFn, onState: () => {} });
  wire.start();
  await waitFor(() => children.length === 1, 'the spawn');

  const up = wire.status();
  assert.strictEqual(up.url, wire.url(), 'the wire status row must carry url, like the web one');
  assert.match(up.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  children[0].emit('exit', 255);
  assert.strictEqual(wire.status().url, null,
    'and it must be null the moment the forward is down — never a stale string');
  wire.stop();

  // Both classes really are the one supervisor, so the row cannot diverge again
  // without someone re-forking the class on purpose.
  assert.ok(wire instanceof SupervisedTunnel);
  assert.ok(new WebTunnel({ id: 'p2', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {} })
    instanceof SupervisedTunnel);
});

// ── The RETRY parameter, both arms ───────────────────────────────────────────
//
// Before t49 this was not a parameter: one class had give-up code and the other
// had none, so "the wire tunnel retries forever" was guarded by the absence of
// an entire mechanism. It is now `giveUpMs: null` — a one-word edit away from
// capping a forward nobody is watching, which would need a human to notice and
// re-arm it. Hence a guard it never had.
//
// WINDOW for both: repeated failures across a real backoff, long enough that the
// cap would have fired if there were one. The unbounded arm is the REAL `Tunnel`
// rather than a hand-configured supervisor — the policy under test is
// peer-tunnel.js's choice, so a test that passed its own `giveUpMs: null` in
// would be pinning its own argument and would sit green while the product's
// changed. (Measured: it does. That shape of this test survived the revert.)
//
// The bounded arm runs the same failure loop and must reach 'gave-up', which is
// what proves the loop genuinely exercises the cap and the unbounded arm's
// silence means something.
test('retry: the wire tunnel retries forever, where a bounded one gives up', async () => {
  const failFor = async (tun, children, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && tun.state !== 'gave-up') {
      const child = children[children.length - 1];
      if (child && !child.failed) { child.failed = true; child.emit('exit', 255); }
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  // Bounded: this one must reach the cap.
  const b = makeSpawnRecorder();
  const bounded = new SupervisedTunnel(peerish({
    spawnFn: b.spawnFn, giveUpMs: 300, stableMs: 150, backoffMinMs: 20, backoffMaxMs: 20,
  }));
  bounded.start();
  await failFor(bounded, b.children, 2000);
  assert.strictEqual(bounded.state, 'gave-up',
    'the bounded arm never capped — the test never entered the window it claims to check');

  // Unbounded: the shipped wire tunnel, failing across its real 1s backoff for
  // long enough that any deadline shorter than the run would have fired.
  const u = makeSpawnRecorder();
  const wire = new Tunnel({ id: 'p1', sshHost: 'box', spawnFn: u.spawnFn, onState: () => {} });
  wire.start();
  await failFor(wire, u.children, 2500);
  assert.notStrictEqual(wire.state, 'gave-up',
    'a forward nobody is watching gave up — nothing would notice and re-arm it, and the peer would stay offline until the app restarted');
  assert.ok(u.calls.length >= 2,
    `and it must still be trying across the backoff: only ${u.calls.length} attempt(s) were made`);
  wire.stop();
});

// ── The readiness probe's own teardown ───────────────────────────────────────
//
// WINDOW: stop() called while the probe loop is ASLEEP between attempts — the
// common case, since the poll gap is 100ms in production and a stopped tunnel is
// stopped at an arbitrary moment.
//
// `stop()` clears `_probeTimer`, which is the timer that would have resolved the
// sleep. Nothing else ever resolves it, so without an explicit wake the `await`
// is parked for the life of the process and the async frame — closing over the
// child and the supervisor — is retained with it. Bounded and invisible: no
// timer remains, so nothing fires and no behaviour changes. That is exactly why
// it survived a year in web-tunnel.js.
//
// `settled()` is what makes it observable at all. Removing the wake from stop()
// fails this by MESSAGE — the race gives the assertion its own deadline rather
// than letting a never-resolving promise hang the runner, which is the failure
// mode t48 found reports nothing.
test('stop() during a probe wakes the sleeping loop instead of parking it forever', async () => {
  const { children, spawnFn } = makeSpawnRecorder();
  let probes = 0;
  const tun = new WebTunnel({
    id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {},
    // Never accepts, so the loop always goes to sleep between attempts.
    probeFn: async () => { probes++; return false; },
    probeMs: 10_000,
  });
  tun.start();
  await waitFor(() => children.length === 1, 'the spawn');
  await waitFor(() => probes >= 1, 'the first probe attempt');

  tun.stop();
  const outcome = await Promise.race([
    tun.settled().then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('parked'), 1000)),
  ]);
  assert.strictEqual(outcome, 'settled',
    'the probe loop is still parked on a sleep whose timer stop() cleared — nothing will ever resolve it, and it holds the child and the supervisor with it');
});

// ── The READINESS parameter, null arm ────────────────────────────────────────
//
// WINDOW: a supervisor whose consumer verifies the forward itself must emit no
// `firstUp` at all. That announcement is a one-shot a consumer ACTS on (the web
// side pops a browser); a wire tunnel emitting one would be an event with a
// listener and no meaning, and the next person to give it meaning would be
// wiring up a signal that fires on every peer.
//
// Giving `Tunnel` a readiness config fails this by message.
test('readiness: null emits no firstUp, ever', async () => {
  const { children, spawnFn } = makeSpawnRecorder();
  const emits = [];
  const tun = new Tunnel({ id: 'p1', sshHost: 'box', spawnFn, onState: (_id, st) => emits.push(st) });
  tun.start();
  await waitFor(() => children.length === 1, 'the spawn');
  await settle(200);
  assert.strictEqual(tun.state, 'up', 'precondition: the tunnel came up, so an announcement had its chance');
  assert.deepStrictEqual(emits.filter((e) => e.firstUp), [],
    'a wire tunnel announced firstUp — the one-shot a consumer ACTS on, emitted for a consumer that has its own hello loop');
  tun.stop();
});
