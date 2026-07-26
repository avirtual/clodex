'use strict';

// Tunnel supervisor: ssh arg construction, up/down state machine, restart
// with backoff, reconcile-on-change. spawn is faked — no real ssh runs.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { TunnelManager, Tunnel } = require('../peer-tunnel');

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

test('tunnel spawns ssh with batch/forward-failure/keepalive flags and correct -L', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new Tunnel({ id: 'p1', sshHost: 'user@laptop2', remotePort: 7900, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.equal(args[args.length - 1], 'user@laptop2');
  const lIdx = args.indexOf('-L');
  assert.match(args[lIdx + 1], /^\d+:127\.0\.0\.1:7900$/);
  assert.equal(tun.state, 'up');
  assert.match(tun.url(), /^http:\/\/127\.0\.0\.1:\d+$/);
  tun.stop();
});

test('ssh exit -> down with stderr tail as error, then restart on a fresh port', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const states = [];
  const tun = new Tunnel({ id: 'p1', sshHost: 'laptop2', remotePort: 7900, spawnFn, onState: (_id, st) => states.push(st.state) });
  tun.start();
  await waitFor(() => calls.length === 1, 'first spawn');
  const firstPort = tun.localPort;
  children[0].stderr.emit('data', 'ssh: connect to host laptop2 port 22: Connection refused\n');
  children[0].emit('exit', 255);
  assert.equal(tun.state, 'down');
  assert.equal(tun.url(), null);
  assert.match(tun.lastError, /Connection refused/);
  // backoff restart (min 1s)
  await waitFor(() => calls.length === 2, 'restart spawn', 3000);
  assert.equal(tun.state, 'up');
  assert.notEqual(tun.localPort, null);
  // fresh pick each round — usually different, but the guarantee is only
  // that a port was re-picked and the args carry it
  const lIdx = calls[1].args.indexOf('-L');
  assert.ok(calls[1].args[lIdx + 1].startsWith(`${tun.localPort}:`));
  assert.ok(states.includes('down') && states.includes('up'));
  assert.ok(firstPort); // sanity
  tun.stop();
});

test('stop kills the child and stays down (no restart)', async () => {
  const { calls, children, spawnFn } = makeSpawnRecorder();
  const tun = new Tunnel({ id: 'p1', sshHost: 'laptop2', spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  tun.stop();
  assert.ok(children[0].killed);
  assert.equal(tun.state, 'down');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls.length, 1);
});

test('manager reconciles: only sshHost peers, restart on host change, drop on removal', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new TunnelManager({ spawnFn, onState: () => {} });
  mgr.sync([
    { id: 'a', label: 'a', sshHost: 'laptop2', remotePort: 7900 },
    { id: 'b', label: 'b', url: 'http://127.0.0.1:7901' },   // url-only: no tunnel
  ]);
  await waitFor(() => calls.length === 1, 'tunnel for a');
  assert.equal(mgr.statuses().length, 1);
  assert.equal(mgr.urlFor('b'), null);
  await waitFor(() => mgr.urlFor('a'), 'a up');

  mgr.sync([{ id: 'a', label: 'a', sshHost: 'laptop3', remotePort: 7900 }]);
  await waitFor(() => calls.length === 2, 'respawn after host change');
  assert.equal(calls[1].args[calls[1].args.length - 1], 'laptop3');

  mgr.sync([]);
  assert.equal(mgr.statuses().length, 0);
  mgr.stopAll();
});

// --- typed cloud transports (t32 step 1: ssm.target) -------------------------
//
// The argv is NOT built here — it comes from cli/src/transport.js's ssmArgv, so
// the GUI and the CLI dial the same box the same way. These tests pin the
// wiring (the right builder, the port substituted, the right process handling),
// not the argv's contents, which cli/test owns.

test('tunnel dials an ssm peer with the CLI`s aws argv, {port} substituted', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new Tunnel({ id: 'p1', ssm: { target: 'i-0abc123', region: 'eu-west-1' }, remotePort: 7900, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'aws', 'the command word comes from the argv, not a hardcoded ssh');
  assert.ok(args.includes('start-session'), 'aws ssm start-session');
  assert.deepStrictEqual(args.slice(args.indexOf('--target'), args.indexOf('--target') + 2),
    ['--target', 'i-0abc123']);
  assert.ok(args.includes('--region') && args[args.indexOf('--region') + 1] === 'eu-west-1');
  assert.ok(!args.includes('--profile'), 'an unset profile emits no flag');
  // The whole point of substitutePort: a surviving literal would be handed to
  // aws as a port named "{port}" and fail at dial time, not here.
  assert.ok(!args.some((a) => String(a).includes('{port}')), 'no literal {port} survives');
  const params = JSON.parse(args[args.indexOf('--parameters') + 1]);
  assert.deepStrictEqual(params.localPortNumber, [String(tun.localPort)], 'the local end is the picked free port');
  assert.deepStrictEqual(params.portNumber, ['7900'], 'the remote end is the peer`s wire port');
  // aws forks a session-manager-plugin helper that a plain child-kill orphans.
  assert.equal(opts.detached, true, 'an ssm child leads its own process group');
  tun.stop();
});

test('tunnel leaves the ssh path exactly as it was (no detach, ssh argv)', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const tun = new Tunnel({ id: 'p1', sshHost: 'user@laptop2', remotePort: 7900, spawnFn, onState: () => {} });
  tun.start();
  await waitFor(() => calls.length === 1, 'spawn');
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'ssh');
  assert.equal(args[args.length - 1], 'user@laptop2');
  assert.ok(!('detached' in opts), 'ssh keeps its original non-detached spawn — group-kill is ssm-only');
  tun.stop();
});

test('stopping an ssm tunnel kills the process GROUP, not just the child', async () => {
  const { children, spawnFn } = makeSpawnRecorder();
  // A fake child with a pid, so the group-kill branch is reachable; the real
  // process.kill is swapped for a recorder (a negative pid here would signal a
  // real process group).
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { killed.push([pid, sig]); };
  try {
    const tun = new Tunnel({ id: 'p1', ssm: { target: 'i-0abc' }, spawnFn, onState: () => {} });
    tun.start();
    await waitFor(() => children.length === 1, 'spawn');
    children[0].pid = 4242;
    tun.stop();
    assert.deepStrictEqual(killed, [[-4242, 'SIGTERM']], 'negative pid = the whole group');
  } finally { process.kill = realKill; }
});

test('manager: an ssm peer gets a tunnel, and a region change restarts it', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new TunnelManager({ spawnFn, onState: () => {} });
  mgr.sync([{ id: 'a', label: 'a', ssm: { target: 'i-0abc', region: 'eu-west-1' }, remotePort: 7900 }]);
  await waitFor(() => calls.length === 1, 'tunnel for the ssm peer');
  await waitFor(() => mgr.urlFor('a'), 'a up');
  // Same target, DIFFERENT region — a different box entirely. An identity
  // comparison of two freshly-built objects would restart on every sync; a
  // target-only comparison would never restart here. Both are wrong.
  mgr.sync([{ id: 'a', label: 'a', ssm: { target: 'i-0abc', region: 'us-east-1' }, remotePort: 7900 }]);
  await waitFor(() => calls.length === 2, 'respawn after region change');
  assert.equal(calls[1].args[calls[1].args.indexOf('--region') + 1], 'us-east-1');
  // An unchanged destination must NOT restart — a sync runs on every settings
  // write, so a spurious restart would drop the wire on an unrelated edit.
  mgr.sync([{ id: 'a', label: 'a', ssm: { target: 'i-0abc', region: 'us-east-1' }, remotePort: 7900 }]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 2, 'an identical sync is a no-op');
  mgr.stopAll();
});

test('manager: a peer with neither sshHost nor a usable ssm target gets no tunnel', async () => {
  const { calls, spawnFn } = makeSpawnRecorder();
  const mgr = new TunnelManager({ spawnFn, onState: () => {} });
  mgr.sync([
    { id: 'url', url: 'http://127.0.0.1:7901' },
    { id: 'empty', ssm: {} },
    { id: 'ecs', ssm: { ecs: 'cluster/family' } },   // step 3: not dialable yet
  ]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 0);
  assert.equal(mgr.statuses().length, 0);
  mgr.stopAll();
});
