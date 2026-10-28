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
  // waitExit for a url ctx never resolves (no child) — race it against a timer.
  const raced = await Promise.race([t.waitExit().then(() => 'exited'), new Promise((r) => setTimeout(() => r('pending'), 60))]);
  assert.strictEqual(raced, 'pending');
  t.close(); // no-op
});

// port-forward pins the LOCAL end. A real detached child that binds the pinned
// {port} proves openTransport honors localPort and reports it back.
test('openTransport(localPort): pins the local end, reports it, waitExit resolves on close', async () => {
  const script = 'const net=require("net");const p=+process.argv[1].split(":")[0];net.createServer(s=>s.end()).listen(p,"127.0.0.1");setInterval(()=>{},1000);';
  const local = await T.pickFreePort();
  const ctx = { tunnel: [process.execPath, '-e', script, '{port}:7900'] };
  const t = await T.openTransport(ctx, { deadlineMs: 5000, localPort: local });
  assert.strictEqual(t.localPort, local);
  assert.strictEqual(t.baseUrl, `http://127.0.0.1:${local}`);
  assert.strictEqual(await T.portAccepts(local), true);
  const exited = t.waitExit();
  t.close();
  await exited; // resolves once the group-killed child's exit event fires
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(await T.portAccepts(local), false);
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

test('openTransport(localPort): a busy pinned port → CONNECT before spawn', async () => {
  const srv = net.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const busy = srv.address().port;
  let spawned = false;
  try {
    await assert.rejects(
      T.openTransport({ tunnel: ['faketunnel', '{port}:7900'] }, { spawnFn: () => { spawned = true; throw new Error('spawned'); }, localPort: busy }),
      (e) => { assert.strictEqual(e.exitCode, 3); assert.match(e.message, new RegExp(`local port ${busy} is already in use`)); return true; },
    );
    assert.strictEqual(spawned, false);
  } finally { await new Promise((res) => srv.close(res)); }
});

test('waitForPort: a dead child is its exit even while a foreign listener holds the port', async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    await assert.rejects(
      T.waitForPort(srv.address().port, { deadlineMs: 2000, isDead: () => true, stderr: () => 'bind failed' }),
      (e) => { assert.strictEqual(e.exitCode, 3); assert.match(e.message, /exited before the port opened:\nbind failed/); return true; },
    );
  } finally { await new Promise((res) => srv.close(res)); }
});


test('reapAll: an open dial is group-killed (negative pid, SIGTERM), once', async (t) => {
  const srv = net.createServer((s) => s.end());
  t.after(() => new Promise((r) => srv.close(() => r())));
  const kills = [];
  t.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stderr = new EventEmitter();
    child.kill = () => {};
    srv.listen(+args[0].split(':')[0], '127.0.0.1');
    return child;
  };
  const tr = await T.openTransport({ tunnel: ['faketunnel', '{port}:7900'] }, { spawnFn, deadlineMs: 2000 });
  t.after(() => tr.close());
  T.reapAll();
  assert.deepStrictEqual(kills, [[-424242, 'SIGTERM']]);
  T.reapAll();
  assert.deepStrictEqual(kills, [[-424242, 'SIGTERM']]);
  tr.close();
});

test('reapAll: a dial whose leader child exited is still group-killed until close()', async (t) => {
  const srv = net.createServer((s) => s.end());
  t.after(() => new Promise((r) => srv.close(() => r())));
  const kills = [];
  t.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
  let child;
  const spawnFn = (cmd, args) => {
    child = new EventEmitter();
    child.pid = 444444;
    child.stderr = new EventEmitter();
    srv.listen(+args[0].split(':')[0], '127.0.0.1');
    return child;
  };
  const tr = await T.openTransport({ tunnel: ['faketunnel', '{port}:7900'] }, { spawnFn, deadlineMs: 2000 });
  t.after(() => tr.close());
  child.emit('exit', 0, null);
  T.reapAll();
  assert.deepStrictEqual(kills, [[-444444, 'SIGTERM']]);
});

test('reapAll: a closed dial is no longer reaped', async (t) => {
  const srv = net.createServer((s) => s.end());
  t.after(() => new Promise((r) => srv.close(() => r())));
  const kills = [];
  t.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.pid = 434343;
    child.stderr = new EventEmitter();
    srv.listen(+args[0].split(':')[0], '127.0.0.1');
    return child;
  };
  const tr = await T.openTransport({ tunnel: ['faketunnel', '{port}:7900'] }, { spawnFn, deadlineMs: 2000 });
  tr.close();
  T.reapAll();
  assert.deepStrictEqual(kills, [[-434343, 'SIGTERM']]);
});

test('reapAll: a registered tmpdir is removed, and each cleanup runs once', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-reap-t-'));
  fs.writeFileSync(path.join(dir, 'wire-token'), 'secret');
  let runs = 0;
  T.register('tmpdir', () => { runs++; fs.rmSync(dir, { recursive: true, force: true }); });
  T.register('dial', () => { throw new Error('best effort'); });
  T.reapAll();
  T.reapAll();
  assert.strictEqual(fs.existsSync(dir), false);
  assert.strictEqual(runs, 1);
  const off = T.register('tmpdir', () => { runs++; });
  off();
  T.reapAll();
  assert.strictEqual(runs, 1);
});

test('installSignalReaper: reaps and exits 130/143/129 only when no verb handler claimed the signal', () => {
  const { EventEmitter: EE } = require('node:events');
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const proc = new EE();
    const exits = [];
    let reaped = 0;
    const off = T.installSignalReaper({ proc, exit: (c) => exits.push(c) });
    const verb = () => {};
    proc.on(sig, verb);
    T.register('dial', () => { reaped++; });
    proc.emit(sig);
    assert.deepStrictEqual(exits, []);
    assert.strictEqual(reaped, 0);
    proc.off(sig, verb);
    proc.emit(sig);
    assert.deepStrictEqual(exits, [code]);
    assert.strictEqual(reaped, 1);
    off();
    assert.strictEqual(proc.listenerCount(sig), 0);
  }
});

test('clodexctl bin installs the signal reaper', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'bin', 'clodexctl.js'), 'utf8');
  assert.match(src, /^installSignalReaper\(\);$/m);
});
