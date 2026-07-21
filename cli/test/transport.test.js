'use strict';
// transport.test.js — the tunnel mechanism WITHOUT real ssh: {port}
// substitution, free-port pick, wait-for-accept, and the spawn/teardown path
// driven by a fake child that actually listens on the substituted port.
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const T = require('../src/transport');

test('substitutePort replaces every {port}', () => {
  assert.deepStrictEqual(
    T.substitutePort(['kubectl', 'port-forward', '{port}:7900', '--x', '{port}'], 55123),
    ['kubectl', 'port-forward', '55123:7900', '--x', '55123'],
  );
});

test('pickFreePort returns a bindable loopback port', async () => {
  const p = await T.pickFreePort();
  assert.ok(p > 0 && p < 65536);
  // bindable again (it was released)
  await new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(p, '127.0.0.1', () => s.close(res));
  });
});

test('sshArgv is a {port} tunnel template around the system ssh', () => {
  const argv = T.sshArgv('user@box', 7900);
  assert.strictEqual(argv[0], 'ssh');
  assert.ok(argv.includes('-N'));
  assert.ok(argv.some((a) => a === 'BatchMode=yes'));
  assert.ok(argv.includes('{port}:127.0.0.1:7900'));
  assert.strictEqual(argv[argv.length - 1], 'user@box');
});

// An ARGV-INSPECTING fake spawn: never opens a real listener and gives the
// child no pid, so openTransport's teardown (process.kill(-pid)) is skipped —
// we only assert the spawn shape here. The port never accepts, so we drive it
// with a tiny deadline and expect the CONNECT timeout, THEN inspect the record.
function inspectSpawn(record) {
  return (cmd, args, opts) => {
    record.cmd = cmd; record.args = args; record.detached = opts && opts.detached;
    const child = new EventEmitter();
    child.pid = null;                 // no group → close() no-ops (safe in-process)
    child.stderr = new EventEmitter();
    child.kill = () => { record.killed = true; };
    return child;
  };
}

test('openTransport(tunnel): substitutes {port}, spawns detached (argv shape)', async () => {
  const rec = {};
  const ctx = { tunnel: ['faketunnel', '{port}:7900'], token: 'x' };
  await assert.rejects(
    T.openTransport(ctx, { spawnFn: inspectSpawn(rec), deadlineMs: 250 }),
    (e) => { assert.strictEqual(e.exitCode, 3); return true; },
  );
  assert.strictEqual(rec.cmd, 'faketunnel');
  assert.strictEqual(rec.detached, true);
  assert.ok(/^\d+:7900$/.test(rec.args[0]), `substituted arg was ${rec.args[0]}`);
});

test('openTransport(ssh): builds the ssh template argv', async () => {
  const rec = {};
  const ctx = { ssh: 'user@box', remotePort: 7900 };
  await assert.rejects(
    T.openTransport(ctx, { spawnFn: inspectSpawn(rec), deadlineMs: 250 }),
    (e) => { assert.strictEqual(e.exitCode, 3); return true; },
  );
  assert.strictEqual(rec.cmd, 'ssh');
  assert.ok(rec.args.includes('-N'));
});

// The genuine open→wait→teardown path with a REAL detached child that listens
// on the substituted {port}. Exercises the actual process-group kill safely
// (its own group, not the runner's) and asserts the port is reclaimed on close.
test('openTransport: real detached child — opens, waits, group-killed on close', async () => {
  const script = 'const net=require("net");const p=+process.argv[1].split(":")[0];net.createServer(s=>s.end()).listen(p,"127.0.0.1");setInterval(()=>{},1000);';
  const ctx = { tunnel: [process.execPath, '-e', script, '{port}:7900'] };
  const t = await T.openTransport(ctx, { deadlineMs: 5000 });
  const port = parseInt(t.baseUrl.match(/:(\d+)$/)[1], 10);
  assert.strictEqual(await T.portAccepts(port), true);
  t.close();
  // Give the SIGTERM a beat to land, then the port should be free again.
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(await T.portAccepts(port), false);
});

test('openTransport(direct): no child, base is the url (trailing slash trimmed)', async () => {
  const t = await T.openTransport({ url: 'http://h:7900/' });
  assert.strictEqual(t.baseUrl, 'http://h:7900');
  t.close(); // no-op
});

test('waitForPort rejects with child stderr when the child dies first', async () => {
  let dead = false;
  const p = T.waitForPort(59999, {
    deadlineMs: 2000,
    isDead: () => dead,
    stderr: () => 'ssh: could not resolve hostname box',
  });
  setTimeout(() => { dead = true; }, 50);
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.exitCode, 3); // EXIT.CONNECT
    assert.match(e.message, /could not resolve hostname box/);
    return true;
  });
});

test('openTransport: unknown transport kind is a usage error', async () => {
  await assert.rejects(T.openTransport({ token: 'x' }), /no url, ssh, tunnel, or cloud transport/);
});
