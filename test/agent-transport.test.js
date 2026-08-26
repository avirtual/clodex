// Run: node --test
// Covers agent-transport's registry round-trip against a real temp dir: atomic
// register, listPeers/getPeer resolution, socket-existence + live-PID pruning in
// listPeers/cleanup, and unregister. The Transport socket server itself is
// integration-only (needs a live net stack), so it is not exercised here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentTransport } = require('../agent-transport');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-reg-'); }
function mk(REGISTRY_DIR) { return createAgentTransport({ REGISTRY_DIR, MAX_MSG: 65536 }); }
// Registry entries now live per-agent at run/<name>/agent.json (clodex-paths).
function regFile(root, name) { return pathFor(root, name, 'registry'); }

test('register: writes an atomic json under run/<name>/ and round-trips via listPeers/getPeer', async () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const { Transport } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'foo.sock');
  // A REAL listening server, not an empty file. Before t75 a touched file was
  // enough to read as live — that was the defect: an empty socket file with a
  // live-looking pid IS the pid-recycle ghost, so a test that round-trips one
  // is asserting the bug. listPeers now dials.
  const srv = new Transport(sock, () => {});
  await srv.start();
  registry.register('foo', sock);

  try {
    const j = JSON.parse(fs.readFileSync(regFile(REGISTRY_DIR, 'foo'), 'utf-8'));
    assert.strictEqual(j.name, 'foo');
    assert.strictEqual(j.socket, sock);
    assert.strictEqual(j.pid, process.pid);

    const peers = await registry.listPeers();
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].name, 'foo');
    assert.strictEqual((await registry.getPeer('foo')).socket, sock);
    assert.strictEqual(await registry.getPeer('missing'), null);
  } finally {
    await srv.stop();
  }
});

// t75: THE GHOST. This is the case the whole ticket exists for, and before the
// probe it was indistinguishable from the test above — same record, same socket
// file on disk, same live pid. Nothing readable from the filesystem tells them
// apart, which is why listPeers dials.
test('listPeers: a ghost — socket FILE with nothing listening, live pid — is NOT advertised (t75)', async () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'ghost.sock');
  fs.writeFileSync(sock, '');            // the shape an unclean shutdown leaves
  registry.register('ghost', sock);      // our own pid → isAlive() says LIVE

  // Everything the OLD liveness test looked at says this agent is running.
  assert.ok(fs.existsSync(sock), 'the socket file exists');
  const rec = JSON.parse(fs.readFileSync(regFile(REGISTRY_DIR, 'ghost'), 'utf-8'));
  assert.ok(rec.pid === process.pid, 'and its pid is genuinely alive — existsSync+isAlive both pass, which is exactly why they cannot see a ghost');

  assert.deepStrictEqual(await registry.listPeers(), [],
    'a socket file with no server behind it must not be advertised as a peer — this is the pid-recycle ghost, and advertising it makes [agent:who] name an agent that does not exist while every dm to it fails silently');
  assert.strictEqual(await registry.getPeer('ghost'), null,
    'and getPeer must agree — it resolves through listPeers, so a ghost leaking through here would be handed straight to Transport.send');
});

// t75: the async conversion's own hazard, and the reason this pin exists at all.
// listPeers/getPeer returning Promises makes a forgotten `await` SILENT: a
// Promise is always truthy, so `if (peer)` succeeds for a peer that does not
// exist, and `.find(...)` on a Promise throws TypeError at a call site far from
// the mistake. Pinned structurally at the two production consumers.
test('t75: both production consumers await the async registry lookups', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  for (const call of ['registry.getPeer(', 'registry.listPeers(']) {
    let i = -1;
    while ((i = src.indexOf(call, i + 1)) !== -1) {
      const before = src.slice(Math.max(0, i - 60), i);
      assert.match(before, /await\s*\(?\s*$/,
        `${call.slice(0, -1)} must be awaited — it is async since t75, and an unawaited call yields a Promise, which is ALWAYS truthy: \`if (peer)\` then passes for an agent that does not exist and the dm is sent to undefined.socket. Found an unawaited call near: ${JSON.stringify(src.slice(i - 40, i + 40))}`);
    }
  }
});

test('listPeers: drops an entry whose socket has vanished', async () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'bar.sock');
  fs.writeFileSync(sock, '');
  registry.register('bar', sock);
  fs.unlinkSync(sock);                   // socket gone → peer no longer live
  assert.deepStrictEqual(await registry.listPeers(), []);
});

test('cleanup: prunes dead-pid records, keeps live ones, and LEAVES the socket file (t57)', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);

  const liveSock = path.join(REGISTRY_DIR, 'live.sock');
  fs.writeFileSync(liveSock, '');
  registry.register('live', liveSock);   // our own pid → alive

  const deadSock = path.join(REGISTRY_DIR, 'dead.sock');
  fs.writeFileSync(deadSock, '');
  fs.mkdirSync(runDirFor(REGISTRY_DIR, 'dead'), { recursive: true });
  fs.writeFileSync(regFile(REGISTRY_DIR, 'dead'),
    JSON.stringify({ name: 'dead', socket: deadSock, pid: 2147483647 })); // no such pid

  const removed = registry.cleanup();
  assert.strictEqual(removed, 1);
  assert.ok(fs.existsSync(regFile(REGISTRY_DIR, 'live')));
  assert.ok(!fs.existsSync(regFile(REGISTRY_DIR, 'dead')));
  // Cleanup removes registry ENTRIES and does not touch sockets. This is the
  // fix for the TOCTOU in the old behaviour: the entry is read and then deleted
  // with no re-validation, so unlinking the socket named by that stale read
  // could destroy a LIVE agent's socket if the name had been re-registered in
  // the gap — and a net.Server on an unlinked inode keeps listening silently,
  // unreachable forever with no error to notice by. Leaving the file is inert:
  // Transport.start unlinks the path before it binds.
  assert.ok(fs.existsSync(deadSock),
    'cleanup must LEAVE the socket file — unlinking a socket it never re-checked is how a live agent goes silently unreachable');
});

// --- Transport.isSocketLive (t57) ---
//
// The probe is the whole point of the ticket: the registry records a bare pid,
// and after an unclean shutdown + a pid recycle `isAlive(pid)` reports a corpse
// as running. Only a connect can tell a listening agent from a leftover file.
// These three pin the three answers it has to get right — and (b) is the one the
// defect turns on, because that is exactly the ghost's shape on disk.

test('isSocketLive: a bound socket with a server listening reads LIVE (t57)', async () => {
  const REGISTRY_DIR = tmp();
  const { Transport } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'up.sock');

  const seen = [];
  const t = new Transport(sock, (msg) => seen.push(msg));
  await t.start();
  try {
    assert.strictEqual(await Transport.isSocketLive(sock), true,
      'a socket with a real server accepting connections must read live — this is the case that legitimately keeps a name taken');
    // The probe writes nothing and the server drops zero-length frames, so the
    // agent being probed must not see a message. If this ever fails, probing
    // would be injecting phantom traffic into a running agent's intent stream.
    assert.deepStrictEqual(seen, [],
      'probing must be INERT — a connect-and-close must never surface as a message to the probed agent');
  } finally {
    await t.stop();
  }
});

test('isSocketLive: a socket FILE with nothing listening reads NOT live (t57)', async () => {
  const REGISTRY_DIR = tmp();
  const { Transport } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'ghost.sock');
  fs.writeFileSync(sock, '');            // the shape an unclean shutdown leaves

  assert.strictEqual(await Transport.isSocketLive(sock), false,
    'a leftover socket file with no server behind it must read NOT live — this is the pid-recycle ghost, the exact case existsSync+isAlive gets wrong');
});

test('isSocketLive: a missing path reads NOT live (t57)', async () => {
  const REGISTRY_DIR = tmp();
  const { Transport } = mk(REGISTRY_DIR);

  assert.strictEqual(await Transport.isSocketLive(path.join(REGISTRY_DIR, 'nope.sock')), false,
    'ENOENT must resolve false, not reject — the probe answers a question and never makes its caller handle errors');
});

// --- cleanup re-validation (t76) ---
//
// cleanup() is read-then-delete: the "dead" verdict describes the BYTES it read.
// If the entry is replaced in the gap, that verdict is about a record that no
// longer exists, and applying it unlinks a LIVE agent's registration.
//
// These two are only meaningful ACROSS the gap — a single-snapshot check cannot
// see this property at all, because at every individual instant the file is
// perfectly consistent. So the replacement is injected AT the read, by patching
// the fs.readFileSync that cleanup itself calls. That is the whole test: without
// an interleaving there is nothing to observe.
function withReplaceAfterFirstRead(regPath, replacement, fn) {
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    const out = realRead.call(this, p, ...rest);
    // Replace the record immediately after cleanup's FIRST read of it — i.e.
    // exactly inside the read-to-unlink gap, standing in for a concurrent
    // re-registration by create() or by a second engine.
    if (p === regPath && ++reads === 1) fs.writeFileSync(p, replacement);
    return out;
  };
  try { return { out: fn(), reads }; } finally { fs.readFileSync = realRead; }
}

test('cleanup: an entry REPLACED between the read and the unlink survives (t76)', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);

  const sock = path.join(REGISTRY_DIR, 'raced.sock');
  fs.writeFileSync(sock, '');
  fs.mkdirSync(runDirFor(REGISTRY_DIR, 'raced'), { recursive: true });
  const regPath = regFile(REGISTRY_DIR, 'raced');
  // The record cleanup reads: dead pid, so its verdict is "remove".
  fs.writeFileSync(regPath, JSON.stringify({ name: 'raced', socket: sock, pid: 2147483647 }));
  // The record that lands in the gap: a LIVE re-registration of the same name.
  const live = JSON.stringify({ name: 'raced', socket: sock, pid: process.pid });

  const { out: removed, reads } = withReplaceAfterFirstRead(regPath, live, () => registry.cleanup());

  // Prove the test ENTERED the window it names. Test 1 would catch a dead
  // harness on its own (no injection means the dead record is simply pruned and
  // the assertion below fires), but stating it costs one line and makes the
  // failure say "harness" instead of "guard".
  assert.ok(reads >= 1,
    'the replacement was never injected — cleanup did not read this record, so this test proved nothing about the read-to-unlink gap');
  assert.ok(fs.existsSync(regPath),
    'cleanup deleted a registration that was re-registered LIVE after it read the dead one — the agent is now undiscoverable (listPeers cannot see it) until it registers again, and nothing reports the loss');
  assert.strictEqual(fs.readFileSync(regPath, 'utf-8'), live,
    'the surviving record must be the LIVE replacement, byte for byte — anything else means cleanup wrote or restored something instead of leaving the newer entry alone');
  assert.strictEqual(removed, 0,
    'cleanup must not COUNT a record it did not remove — a count that includes skipped entries makes the return value useless for deciding whether a sweep did anything');
});

test('cleanup: an UNCHANGED dead entry is still pruned — the guard must not block real work (t76)', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);

  const sock = path.join(REGISTRY_DIR, 'stale.sock');
  fs.writeFileSync(sock, '');
  fs.mkdirSync(runDirFor(REGISTRY_DIR, 'stale'), { recursive: true });
  const regPath = regFile(REGISTRY_DIR, 'stale');
  const dead = JSON.stringify({ name: 'stale', socket: sock, pid: 2147483647 });
  fs.writeFileSync(regPath, dead);

  // Same interleaving machinery, but the "replacement" is byte-identical — the
  // no-race case. This is the discriminator for the test above: if the guard
  // were comparing something other than the bytes (an mtime, an inode, "did any
  // write happen"), the test above would still pass while cleanup quietly
  // stopped pruning anything at all.
  const { out: removed, reads } = withReplaceAfterFirstRead(regPath, dead, () => registry.cleanup());

  // This one CANNOT prove entry from its outcome — a harness that never fired
  // would produce an identical pass, since the no-race case is exactly what a
  // dead harness simulates. So entry is asserted directly; without this the
  // test is a green that means nothing.
  assert.ok(reads >= 1,
    'the byte-identical rewrite was never injected — this test degenerates into the plain prune case and stops discriminating a bytes-guard from any other guard');
  assert.strictEqual(removed, 1,
    'a dead entry whose bytes did NOT change must still be pruned — a guard that skips it turns cleanup into a no-op and dead registrations accumulate forever');
  assert.ok(!fs.existsSync(regPath),
    'the dead record must be gone — it is the whole job of cleanup()');
});

test('unregister: removes the record', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'z.sock');
  fs.writeFileSync(sock, '');
  registry.register('z', sock);
  registry.unregister('z');
  assert.ok(!fs.existsSync(regFile(REGISTRY_DIR, 'z')));
});
