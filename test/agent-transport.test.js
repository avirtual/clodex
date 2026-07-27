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

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-reg-')); }
function mk(REGISTRY_DIR) { return createAgentTransport({ REGISTRY_DIR, MAX_MSG: 65536 }); }
// Registry entries now live per-agent at run/<name>/agent.json (clodex-paths).
function regFile(root, name) { return pathFor(root, name, 'registry'); }

test('register: writes an atomic json under run/<name>/ and round-trips via listPeers/getPeer', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'foo.sock');
  fs.writeFileSync(sock, '');            // socket must exist for listPeers
  registry.register('foo', sock);

  const j = JSON.parse(fs.readFileSync(regFile(REGISTRY_DIR, 'foo'), 'utf-8'));
  assert.strictEqual(j.name, 'foo');
  assert.strictEqual(j.socket, sock);
  assert.strictEqual(j.pid, process.pid);

  const peers = registry.listPeers();
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].name, 'foo');
  assert.strictEqual(registry.getPeer('foo').socket, sock);
  assert.strictEqual(registry.getPeer('missing'), null);
});

test('listPeers: drops an entry whose socket has vanished', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'bar.sock');
  fs.writeFileSync(sock, '');
  registry.register('bar', sock);
  fs.unlinkSync(sock);                   // socket gone → peer no longer live
  assert.deepStrictEqual(registry.listPeers(), []);
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

test('unregister: removes the record', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'z.sock');
  fs.writeFileSync(sock, '');
  registry.register('z', sock);
  registry.unregister('z');
  assert.ok(!fs.existsSync(regFile(REGISTRY_DIR, 'z')));
});
