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
