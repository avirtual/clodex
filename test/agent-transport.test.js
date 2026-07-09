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

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-reg-')); }
function mk(REGISTRY_DIR) { return createAgentTransport({ REGISTRY_DIR, MAX_MSG: 65536 }); }

test('register: writes an atomic json and round-trips via listPeers/getPeer', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'foo.sock');
  fs.writeFileSync(sock, '');            // socket must exist for listPeers
  registry.register('foo', sock);

  const j = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'foo.json'), 'utf-8'));
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

test('cleanup: prunes dead-pid records (and their sockets), keeps live ones', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);

  const liveSock = path.join(REGISTRY_DIR, 'live.sock');
  fs.writeFileSync(liveSock, '');
  registry.register('live', liveSock);   // our own pid → alive

  const deadSock = path.join(REGISTRY_DIR, 'dead.sock');
  fs.writeFileSync(deadSock, '');
  fs.writeFileSync(path.join(REGISTRY_DIR, 'dead.json'),
    JSON.stringify({ name: 'dead', socket: deadSock, pid: 2147483647 })); // no such pid

  const removed = registry.cleanup();
  assert.strictEqual(removed, 1);
  assert.ok(fs.existsSync(path.join(REGISTRY_DIR, 'live.json')));
  assert.ok(!fs.existsSync(path.join(REGISTRY_DIR, 'dead.json')));
  assert.ok(!fs.existsSync(deadSock), 'cleanup also unlinks the dead socket');
});

test('unregister: removes the record', () => {
  const REGISTRY_DIR = tmp();
  const { registry } = mk(REGISTRY_DIR);
  const sock = path.join(REGISTRY_DIR, 'z.sock');
  fs.writeFileSync(sock, '');
  registry.register('z', sock);
  registry.unregister('z');
  assert.ok(!fs.existsSync(path.join(REGISTRY_DIR, 'z.json')));
});
