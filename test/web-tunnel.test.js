'use strict';
// web-tunnel.test.js — t30b: the on-demand ssh forward to a PEER'S web frontend.
//
// The supervisor is a deliberate near-copy of peer-tunnel.js, so what these
// tests are really pinning is the set of places it must NOT behave like its
// sibling. Each of the three inversions has a specific way of regressing:
//
//   • the pinned port regresses by someone "simplifying" _spawnTunnel back to
//     peer-tunnel's shape, which re-picks a free port on respawn and silently
//     orphans the operator's browser tab;
//   • firstUp regresses by moving it into the stored status, where a consumer
//     polling status() reads it as still true and pops a second window;
//   • the give-up cap regresses by being deleted, which is invisible — the only
//     symptom is a forwarded port to a remote box that outlives its reason.
//
// spawn is faked throughout: no real ssh, no real remote host.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { WebTunnelManager, WebTunnel } = require('../web-tunnel');

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

function makeSpawnRecorder() {
  const calls = [];
  const children = [];
  const spawnFn = (cmd, args, opts) => {
    const child = fakeChild();
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

// Pull the `-L` spec out of a recorded spawn, so a port assertion reads the
// argv ssh would actually have been given rather than the object's own field.
function forwardSpec(call) {
  const i = call.args.indexOf('-L');
  return i >= 0 ? call.args[i + 1] : null;
}

// Drive a tunnel to its give-up cap by failing every ssh the supervisor spawns.
//
// A short giveUpMs alone does NOT get there: the deadline is only consulted when
// a spawn dies, and a faked child stays "alive" until the test kills it — a
// tunnel whose ssh is up is not failing, and must not be capped. So the box has
// to be failed repeatedly, across the real backoff (1s, then 2s), which is why
// this polls for a few seconds rather than a few hundred ms.
async function failUntilGaveUp(get, children, { stderr = '', timeoutMs = 6000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (get().state === 'gave-up') return true;
    const child = children[children.length - 1];
    if (child && !child.failed) {
      child.failed = true;
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', 255);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return get().state === 'gave-up';
}

// ── Inversion 1: the local port is PINNED ────────────────────────────────────

test('the local port is pinned: a respawn re-binds the SAME port', async () => {
  // The load-bearing difference from peer-tunnel.js, whose _spawnTunnel calls
  // pickFreePort on EVERY attempt. Our consumer is a browser tab Clodex cannot
  // re-point, so a fresh port after a wifi blip would leave that tab pointing at
  // nothing. Asserted on the ssh argv, not just tun.localPort — the argv is what
  // determines where the forward actually lands.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'first spawn');
  const pinned = tun.localPort;
  assert.ok(Number.isInteger(pinned) && pinned > 0, 'a port was picked');
  assert.equal(forwardSpec(calls[0]), `${pinned}:127.0.0.1:8080`);

  children[0].emit('exit', 255);            // the wifi blip
  await waitFor(() => calls.length === 2, 'respawn');
  assert.equal(tun.localPort, pinned, 'the pin survives the respawn');
  assert.equal(forwardSpec(calls[1]), `${pinned}:127.0.0.1:8080`, 'ssh re-binds the same local port');

  children[1].emit('exit', 255);
  await waitFor(() => calls.length === 3, 'second respawn');
  assert.equal(forwardSpec(calls[2]), `${pinned}:127.0.0.1:8080`, 'and again');
  tun.stop();
});

test('the pinned port survives a respawn even while the tunnel is DOWN', async () => {
  // localPort is not cleared on exit (peer-tunnel nulls it at :125). The pin has
  // to outlive the down state or it isn't a pin — but the URL must NOT, which
  // the next block covers.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const pinned = tun.localPort;
  children[0].emit('exit', 1);
  assert.equal(tun.state, 'down');
  assert.equal(tun.localPort, pinned, 'the port is remembered across the outage');
  tun.stop();
});

test('ssh argv carries the honest-failure flags, and ExitOnForwardFailure is the pin`s safety', async () => {
  // A pinned port can be taken by something else between attempts.
  // ExitOnForwardFailure=yes makes that an ssh exit (→ backoff → retry) instead
  // of a silent bind elsewhere, which would be a tunnel to the wrong place.
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'user@box', remotePort: 8080, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('-N'), 'no remote command');
  assert.ok(args.includes('BatchMode=yes'), 'never prompts for a password');
  assert.ok(args.includes('ExitOnForwardFailure=yes'), 'a taken pin fails honestly');
  assert.equal(args[args.length - 1], 'user@box');
  tun.stop();
});

// ── No placeholder: a URL exists only while the forward is up ────────────────

test('url() is null in every state except up — there is no dead placeholder', async () => {
  // peer-tunnel's consumer gets http://127.0.0.1:1 while down, so its connection
  // object stays alive. A web view has no such need and a dead URL in a browser
  // is a broken page, so this side simply has no placeholder to leak.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {}, giveUpMs: 50 });
  assert.strictEqual(tun.url(), null, 'before start');
  assert.strictEqual(tun.status().url, null, 'and the status agrees');
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  assert.match(tun.url(), /^http:\/\/127\.0\.0\.1:\d+$/, 'up → a real URL');
  assert.equal(tun.status().url, tun.url(), 'status carries the same one');
  children[0].emit('exit', 255);
  assert.strictEqual(tun.url(), null, 'down → no URL, despite the port still being pinned');
  assert.strictEqual(tun.status().url, null);
  assert.ok(await failUntilGaveUp(() => tun, children), 'reached the cap');
  assert.strictEqual(tun.url(), null, 'gave-up → no URL');
  assert.strictEqual(tun.status().url, null);
  tun.stop();
  assert.strictEqual(tun.url(), null, 'stopped → no URL');
});

test('SECURITY-adjacent: 127.0.0.1:1 never appears — the dead-peer sentinel is not a web URL', async () => {
  // http://127.0.0.1:1 is TunnelManager's placeholder for an offline peer
  // (peer-wiring.js resolvePeerUrls). If it ever reached the web affordance the
  // operator would get a browser tab at a closed port. Written so it fails if
  // anyone introduces a placeholder here.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {}, giveUpMs: 50 });
  const seen = [];
  const record = () => { seen.push(tun.url(), tun.status().url); };
  record();
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  record();
  children[0].emit('exit', 1);
  record();
  await failUntilGaveUp(() => tun, children);
  record();
  for (const u of seen) {
    assert.notStrictEqual(u, 'http://127.0.0.1:1', 'the dead-peer sentinel is never produced');
    if (u !== null) assert.match(u, /^http:\/\/127\.0\.0\.1:\d{2,5}$/, `a real ephemeral port, got ${u}`);
  }
});

// ── Inversion 2: the browser opens EXACTLY once ──────────────────────────────

test('firstUp rides exactly one emit, and never a later status() read', async () => {
  // The pop is main's job (peer-wiring), triggered by this flag. If firstUp were
  // stored on the status instead of riding one emit, anything that later reads
  // status() — peer:list seeding a reopened window, say — would read it as still
  // true and pop a second browser window.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const emits = [];
  const tun = new WebTunnel({
    id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn,
    onState: (_id, st) => emits.push(st),
  });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const ups = emits.filter((e) => e.state === 'up');
  assert.equal(ups.length, 1, 'one up emit');
  assert.strictEqual(ups[0].firstUp, true, 'carrying firstUp');
  assert.strictEqual(tun.status().firstUp, undefined, 'but the stored status does NOT carry it');

  // A respawn is up again — and must NOT re-pop.
  children[0].emit('exit', 255);
  await waitFor(() => calls.length === 2, 'respawn');
  const ups2 = emits.filter((e) => e.state === 'up');
  assert.equal(ups2.length, 2, 'two up emits total');
  assert.notStrictEqual(ups2[1].firstUp, true, 'the SECOND up does not carry firstUp');
  assert.strictEqual(tun.status().firstUp, undefined, 'still absent from the stored status');
  tun.stop();
});

test('firstUp is per-tunnel: a fresh tunnel to the same peer pops again', async () => {
  // Closing and re-opening is a NEW request to look at the box — the operator
  // closed the tab. The once-only rule is scoped to a tunnel's life, not the
  // peer's, or a re-open would silently do nothing visible.
  const { calls, spawnFn } = makeSpawnRecorder();
  const emits = [];
  const mgr = new WebTunnelManager({ spawnFn, onState: (_id, st) => emits.push(st) });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'first spawn');
  mgr.close('p1');
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 2, 'second spawn');
  assert.equal(emits.filter((e) => e.firstUp === true).length, 2, 'each tunnel pops once');
  mgr.stopAll();
});

// ── Inversion 3: the give-up cap (close #4) ──────────────────────────────────

test('give-up cap: a box that never comes up stops retrying and SAYS why', async () => {
  // The only close that needs nobody to do anything. Without it a forgotten
  // forward retries at a dead remote box forever.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const states = [];
  const tun = new WebTunnel({
    id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, giveUpMs: 40,
    onState: (_id, st) => states.push(st.state),
  });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  await failUntilGaveUp(() => tun, children, { stderr: 'ssh: connect to host box port 22: No route to host\n' });
  assert.equal(tun.state, 'gave-up', 'it gave up rather than retrying forever');
  assert.match(tun.lastError || '', /No route to host/, 'and kept WHY, so the UI can say it');
  assert.ok(states.includes('gave-up'), 'the terminal state was emitted, not just set');
  const after = calls.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, after, 'no further spawns after giving up');
});

test('a tunnel that DID come up is never capped — a blip is not a failure', async () => {
  // The cap exists for boxes that never worked. Once the operator has a working
  // tab, a wifi drop must keep retrying, or looking away for two minutes would
  // kill a working view.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, giveUpMs: 40, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'first spawn (this one comes UP)');
  await new Promise((r) => setTimeout(r, 80));   // longer than giveUpMs
  children[0].emit('exit', 255);
  await waitFor(() => calls.length === 2, 'respawn after the cap window would have expired');
  assert.notEqual(tun.state, 'gave-up', 'a tunnel that served the operator is not capped');
  tun.stop();
});

// ── The four closes ──────────────────────────────────────────────────────────

test('close #1 (explicit toggle): close() kills ssh, drops the tunnel, reports closed', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const emits = [];
  const mgr = new WebTunnelManager({ spawnFn, onState: (id, st) => emits.push([id, st.state]) });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  mgr.close('p1');
  assert.ok(children[0].killed, 'the ssh child was killed');
  assert.equal(mgr.statusFor('p1'), null, 'no longer tracked');
  assert.deepEqual(mgr.statuses(), [], 'and gone from the list');
  assert.ok(emits.some(([, s]) => s === 'closed'), 'a closed state was reported, so the UI can repaint');
});

test('close #2 (peer removed or disabled): sync prunes, and NEVER opens', async () => {
  // syncPeerManager feeds this the same already-disabled-filtered list it gives
  // TunnelManager. The asymmetry is the point: TunnelManager.sync OPENS what's
  // missing; this one only closes. A web tunnel to a peer nobody asked to look
  // at is a tunnel with no reason to exist.
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  mgr.sync([{ id: 'p1', sshHost: 'box' }, { id: 'p2', sshHost: 'box2' }]);
  assert.deepEqual(mgr.statuses(), [], 'sync opened nothing');
  assert.equal(calls.length, 0, 'and spawned no ssh');

  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  mgr.sync([{ id: 'p1', sshHost: 'box' }]);                 // still there
  assert.ok(mgr.statusFor('p1'), 'a peer that is still present keeps its tunnel');
  mgr.sync([]);                                              // removed / disabled
  assert.equal(mgr.statusFor('p1'), null, 'a removed or disabled peer loses its web tunnel');
  mgr.stopAll();
});

test('close #2 also fires when the peer is re-pointed at a DIFFERENT ssh host', async () => {
  // Same record id, different box. Keeping the old forward would leave the
  // operator looking at a machine the peer no longer refers to.
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  mgr.sync([{ id: 'p1', sshHost: 'a-different-box' }]);
  assert.equal(mgr.statusFor('p1'), null, 'the stale forward is closed');
  mgr.stopAll();
});

test('close #3 (app shutdown): stopAll kills every child and empties the map', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  mgr.open({ id: 'p2', sshHost: 'box2', remotePort: 9090 });
  await waitFor(() => calls.length === 2, 'both spawns');
  mgr.stopAll();
  assert.ok(children.every((c) => c.killed), 'no ssh child outlives the app');
  assert.deepEqual(mgr.statuses(), [], 'nothing left tracked');
});

// ── Manager: refusals and identity ───────────────────────────────────────────

test('open refuses rather than guessing: no ssh host, and no reported web port', () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  const noSsh = mgr.open({ id: 'p1', sshHost: '', remotePort: 8080 });
  assert.equal(noSsh.ok, false);
  assert.match(noSsh.error, /ssh/i, 'and says the limitation out loud');
  for (const bad of [undefined, null, 0, -1, 70000, '8080', 1.5]) {
    const r = mgr.open({ id: 'p1', sshHost: 'box', remotePort: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} is refused`);
    assert.match(r.error, /web frontend/i);
  }
  assert.equal(calls.length, 0, 'a refusal never spawns ssh');
});

test('re-opening an already-open tunnel to the same place is idempotent', async () => {
  // The affordance can be clicked twice, and two forwards to one box on two
  // ports would leave one of them orphaned.
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  const a = mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  const b = mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  assert.equal(b.ok, true);
  assert.equal(calls.length, 1, 'no second ssh');
  assert.equal(b.status.localPort, a.status.localPort ?? mgr.statusFor('p1').localPort, 'same forward');
  mgr.stopAll();
});

test('re-opening after the remote web port MOVED replaces the tunnel', async () => {
  // The box restarted its web host on another port. Forwarding to the old one
  // would tunnel to nothing — or worse, to whatever took the port.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'first spawn');
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 9999 });
  await waitFor(() => calls.length === 2, 'replacement spawn');
  assert.ok(children[0].killed, 'the stale forward was torn down');
  assert.match(forwardSpec(calls[1]), /:127\.0\.0\.1:9999$/, 'the new one goes to the new port');
  mgr.stopAll();
});

test('re-opening a GAVE-UP tunnel tries again (the retry affordance is real)', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {}, giveUpMs: 40 });
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  await failUntilGaveUp(() => mgr.statusFor('p1'), children);
  assert.equal(mgr.statusFor('p1').state, 'gave-up', 'reached the cap');
  const before = calls.length;
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length > before, 'a retry actually spawns');
  mgr.stopAll();
});

test('statuses/urlFor are per-peer and empty for a peer nobody opened', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  assert.deepEqual(mgr.statuses(), []);
  assert.strictEqual(mgr.urlFor('p1'), null, 'no tunnel → no URL, not a guess');
  assert.strictEqual(mgr.statusFor('p1'), null);
  mgr.open({ id: 'p1', sshHost: 'box', remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  assert.match(mgr.urlFor('p1'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.strictEqual(mgr.urlFor('p2'), null, 'and still nothing for an unopened peer');
  mgr.stopAll();
});
