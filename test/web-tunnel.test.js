'use strict';
// web-tunnel.test.js — t30b: the on-demand forward to a PEER'S web frontend,
// over ssh or a typed cloud transport (t36).
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
// HARNESS TIMING CONTRACT — read before changing giveUpMs at any call site.
//
// The supervisor retires its give-up clock when a spawn SURVIVES `_stableMs`
// (web-tunnel.js:184), and `_stableMs` is derived as floor(giveUpMs / 2). This
// helper kills each child from a polling loop, so the child's apparent lifetime
// is the poll latency. If that latency ever reaches `_stableMs`, the child
// reads as "genuinely worked", the clock retires, and the tunnel can NEVER
// reach its cap — the loop then spins to `timeoutMs` and fails.
//
// That is a harness race, not a product bug, and it bit exactly once: with
// giveUpMs 40-50 (→ _stableMs 20-25ms) against a 25ms poll, the margin was
// zero. It passed alone and failed under full-suite load, where a 25ms timer
// slips. So the invariant is now explicit and generous:
//
//     POLL_MS  <<  _stableMs  ==  floor(giveUpMs / 2)
//
// Call sites pass giveUpMs >= 400 (→ _stableMs >= 200ms, a 40x margin over the
// 5ms poll). Do not shrink giveUpMs to make a test faster; the cap it exercises
// is reached via BACKOFF_MIN_MS (1s), not via the deadline, so a smaller
// deadline buys no speed and only narrows this margin.
const POLL_MS = 5;

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
    await new Promise((r) => setTimeout(r, POLL_MS));
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

// ── t36: the typed cloud transports ──────────────────────────────────────────
//
// The bug this block exists against: `args()` built only `ssh -L`, so a kubectl
// peer whose WIRE tunnel dialled fine (t32) had its web view refused. What each
// test pins is a way that fix can regress — a re-copied kind table that misses a
// kind, a cloud path that re-picks its port, a cloud child killed without its
// group, or an ssh path quietly changed while making room for cloud.

test('cloud argv comes from the CLI builders, and carries the PINNED port', async () => {
  // Not a re-implementation check: the assertion is that the argv this module
  // spawns is byte-for-byte what cli/src/transport.js builds with our pinned
  // port substituted. Anyone who hand-rolls a `kubectl port-forward` string here
  // fails this, which is the point — the argv builders are shared so the GUI and
  // the CLI cannot drift into two ideas of how to dial one box.
  const { ssmArgv, kubectlArgv, gcloudArgv, azArgv, substitutePort } = require('../cli/src/transport');
  const cases = [
    ['kubectl', { target: 'svc/clodex', namespace: 'ops', context: 'prod' }, kubectlArgv],
    ['ssm', { target: 'i-0abc', region: 'eu-west-1', profile: 'ops' }, ssmArgv],
    ['gcloud', { instance: 'vm-1', zone: 'europe-west1-b', project: 'p' }, gcloudArgv],
    ['az', { bastion: 'bast', resourceGroup: 'rg', target: '/subscriptions/x/vm' }, azArgv],
  ];
  for (const [kind, block, build] of cases) {
    const { calls, spawnFn } = makeSpawnRecorder();
    const tun = new WebTunnel({ id: 'p1', [kind]: block, remotePort: 8080, spawnFn, onState: () => {} });
    tun.start();
    await waitFor(() => calls.length === 1, `${kind} spawn`);
    const pinned = tun.localPort;
    assert.ok(Number.isInteger(pinned) && pinned > 0, `${kind}: a port was picked`);
    const expected = substitutePort(build(block, 8080), pinned);
    assert.deepEqual([calls[0].cmd, ...calls[0].args], expected,
      `${kind}: the argv is the CLI builder's, with the pinned local port`);
    // The {port} token must be GONE — an unsubstituted one reaches the vendor CLI
    // as a literal and fails with its own confusing message.
    assert.ok(!JSON.stringify([calls[0].cmd, ...calls[0].args]).includes('{port}'),
      `${kind}: no unsubstituted {port} token survives`);
    tun.stop();
  }
});

test('the pinned port survives a CLOUD respawn — the whole reason this supervisor exists', async () => {
  // The regression the ticket names explicitly: copying peer-tunnel too
  // faithfully would re-pick a free port on every attempt, which is right for
  // the wire (its consumer is re-pointed through onState) and wrong here (the
  // consumer is a browser tab holding a URL string Clodex cannot re-point).
  // Asserted on the ARGV, not on tun.localPort — the argv decides where the
  // forward actually lands.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({
    id: 'p1', kubectl: { target: 'svc/clodex' }, remotePort: 8080, spawnFn, onState: () => {},
  });
  tun.start();
  await waitFor(() => calls.length === 1, 'first spawn');
  const pinned = tun.localPort;
  const spec = calls[0].args.find((a) => String(a).startsWith(`${pinned}:`));
  assert.ok(spec, 'the first spawn forwards from the pinned port');

  children[0].emit('exit', 255);                     // the wifi blip
  await waitFor(() => calls.length === 2, 'respawn');
  assert.equal(tun.localPort, pinned, 'the pin survives the respawn');
  assert.ok(calls[1].args.includes(spec), 'and the cloud CLI re-binds the SAME local port');

  children[1].emit('exit', 255);
  await waitFor(() => calls.length === 3, 'second respawn');
  assert.ok(calls[2].args.includes(spec), 'and again');
  tun.stop();
});

test('a cloud child leads its own process group and is killed BY GROUP', async () => {
  // aws/kubectl/gcloud/az each fork helpers a plain child.kill() orphans, and an
  // orphaned forward to a REMOTE box is the worst failure available here: it
  // outlives the operator's reason for it with nothing in the UI to close it.
  for (const [kind, block] of [
    ['kubectl', { target: 'svc/x' }],
    ['ssm', { target: 'i-0abc' }],
    ['gcloud', { instance: 'vm' }],
    ['az', { bastion: 'b', resourceGroup: 'rg', target: '/s/x' }],
  ]) {
    const { calls, children, spawnFn } = makeSpawnRecorder();
    const tun = new WebTunnel({ id: 'p1', [kind]: block, remotePort: 8080, spawnFn, onState: () => {} });
    tun.start();
    await waitFor(() => calls.length === 1, `${kind} spawn`);
    assert.equal(calls[0].opts.detached, true, `${kind}: the child must lead its own group`);

    // Intercept the group kill: a real process.kill(-pid) here would signal this
    // test runner's own group.
    const signalled = [];
    const origKill = process.kill;
    children[0].pid = 4242;
    children[0].kill = () => { signalled.push('child.kill'); };
    process.kill = (pid, sig) => { signalled.push([pid, sig]); };
    try { tun.stop(); } finally { process.kill = origKill; }
    assert.deepEqual(signalled, [[-4242, 'SIGTERM']],
      `${kind}: the whole group is signalled, and a plain child.kill is not what happened`);
  }
});

test('the ssh path is untouched: no `detached`, and a plain child kill', async () => {
  // The ssh spawn stays byte-identical through the cloud work — the same
  // property peer-tunnel pins at its own layer. `!('detached' in opts)` rather
  // than `=== undefined`: adding the key at all changes the spawn.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  assert.ok(!('detached' in calls[0].opts), 'ssh keeps its original non-detached spawn');
  const signalled = [];
  const origKill = process.kill;
  children[0].pid = 4242;
  children[0].kill = () => { signalled.push('child.kill'); };
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try { tun.stop(); } finally { process.kill = origKill; }
  assert.deepEqual(signalled, ['child.kill'], 'and is killed directly, never by group');
});

test('a missing vendor CLI is named, not reported as a bare ENOENT', async () => {
  // The common cloud misconfig. `spawn ENOENT` alone tells an operator nothing
  // about WHICH binary to install. (ssh is always present, which is why the
  // ssh-only version of this module had no such arm.)
  const children = [];
  const spawnFn = () => { const c = fakeChild(); children.push(c); return c; };
  const tun = new WebTunnel({
    id: 'p1', kubectl: { target: 'svc/x' }, remotePort: 8080, spawnFn, onState: () => {},
  });
  tun.start();
  await waitFor(() => children.length === 1, 'spawn');
  const err = new Error('spawn kubectl ENOENT');
  err.code = 'ENOENT';
  children[0].emit('error', err);
  assert.ok(tun.lastError, 'an error was recorded');
  assert.match(tun.lastError, /kubectl/, 'and it names the binary the operator must install');
  tun.stop();
});

test('a cloud tunnel`s status carries its destination block, so the UI can name the transport', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({
    id: 'p1', kubectl: { target: 'svc/x', namespace: 'ops' }, remotePort: 8080, spawnFn, onState: () => {},
  });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const st = tun.status();
  assert.deepEqual(st.kubectl, { target: 'svc/x', namespace: 'ops' }, 'the DATA, under its kind key');
  assert.strictEqual(st.sshHost, null, 'and no phantom ssh host');
  // The status is a UI row: an argv in it would be code crossing a boundary that
  // only carries data.
  assert.ok(!JSON.stringify(st).includes('port-forward'), 'never an argv');
  tun.stop();
});

test('sync KEEPS a cloud web tunnel — an sshHost-only prune would close it instantly', async () => {
  // The second bug the ssh-only gate hid: sync() compared `live.get(id)` (never
  // set for a cloud peer) against `tun.sshHost` (null), so every cloud web
  // tunnel would be pruned by the next settings write — an affordance that
  // closes itself a moment after it opens, with nothing to say why.
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  const peer = { id: 'p1', kubectl: { target: 'svc/x', namespace: 'ops' } };
  mgr.open({ ...peer, remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  mgr.sync([peer]);
  assert.ok(mgr.statusFor('p1'), 'a cloud peer that is still present KEEPS its web tunnel');

  // …and a re-pointed one still loses it: a changed namespace is a different box.
  mgr.sync([{ id: 'p1', kubectl: { target: 'svc/x', namespace: 'staging' } }]);
  assert.equal(mgr.statusFor('p1'), null, 'a re-pointed cloud peer loses the stale forward');
  mgr.stopAll();
});

test('re-opening a cloud tunnel is idempotent, but a changed field replaces it', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  mgr.open({ id: 'p1', ssm: { target: 'i-0abc', region: 'eu-west-1' }, remotePort: 8080 });
  await waitFor(() => calls.length === 1, 'spawn');
  mgr.open({ id: 'p1', ssm: { target: 'i-0abc', region: 'eu-west-1' }, remotePort: 8080 });
  assert.equal(calls.length, 1, 'the same destination does not spawn a second forward');
  // A changed region is a DIFFERENT instance, not the same one described twice.
  mgr.open({ id: 'p1', ssm: { target: 'i-0abc', region: 'us-east-1' }, remotePort: 8080 });
  await waitFor(() => calls.length === 2, 'replacement spawn');
  mgr.stopAll();
});

// ── No placeholder: a URL exists only while the forward is up ────────────────

test('url() is null in every state except up — there is no dead placeholder', async () => {
  // peer-tunnel's consumer gets http://127.0.0.1:1 while down, so its connection
  // object stays alive. A web view has no such need and a dead URL in a browser
  // is a broken page, so this side simply has no placeholder to leak.
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {}, giveUpMs: 400 });
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
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, onState: () => {}, giveUpMs: 400 });
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
    id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, giveUpMs: 400,
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
  const tun = new WebTunnel({ id: 'p1', sshHost: 'box', remotePort: 8080, spawnFn, giveUpMs: 400, onState: () => {} });
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

test('open refuses rather than guessing: no forwardable transport, and no reported web port', () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {} });
  const noSsh = mgr.open({ id: 'p1', sshHost: '', remotePort: 8080 });
  assert.equal(noSsh.ok, false);
  // Matched on the REASON. /ssh/i would pass on the new message too (it lists
  // ssh among the transports Clodex DOES dial), so it would no longer be
  // evidence of anything.
  assert.match(noSsh.error, /reached by URL/i, 'and says the limitation out loud');
  const urlOnly = mgr.open({ id: 'p1', url: 'https://box.example', remotePort: 8080 });
  assert.equal(urlOnly.ok, false, 'a url-only record is the one unforwardable case');
  const incomplete = mgr.open({ id: 'p1', kubectl: {}, remotePort: 8080 });
  assert.equal(incomplete.ok, false, 'and a cloud block with no target has nothing to dial');
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
  const mgr = new WebTunnelManager({ spawnFn, onState: () => {}, giveUpMs: 400 });
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
