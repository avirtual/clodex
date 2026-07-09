'use strict';

// Per-peer disable/enable (pause without deleting config). Two node-testable
// invariants of the feature:
//   1. peer-wiring: a disabled peer is excluded from BOTH the tunnel sync and the
//      peer (url) sync, yet its persisted attachment/control claim is NOT pruned
//      (the prune keys on s.peers, which still holds the disabled record).
//   2. ipc: the peer:setDisabled handler flips the flag + re-syncs but NEVER calls
//      forgetPeerAttached/forgetPeerControlled — the durable record must survive a
//      pause. (The renderer's soft-shed half is DOM-bound; documented, not tested.)

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { createPeerWiring } = require('../peer-wiring');

// --- peer-wiring harness: stub the two managers so getPeerManager()/getTunnel
// Manager() are truthy (skipping construction) and just record their .sync() args.
function makeWiring(peers, persisted = {}) {
  const store = {
    peers,
    peerAttached: persisted.peerAttached || {},
    peerControlled: persisted.peerControlled || {},
    peerVisible: persisted.peerVisible || {},
  };
  const sets = [];
  const uiSettings = {
    get: () => store,
    set: (patch) => { sets.push(patch); Object.assign(store, patch); return store; },
  };
  const tunnelSynced = [];
  const peerSynced = [];
  const tunnelManager = { sync: (p) => tunnelSynced.push(p), urlFor: () => null, statuses: () => [] };
  const peerManager = { sync: (p) => peerSynced.push(p) };
  const wiring = createPeerWiring({
    manager: { _broadcast() {}, _deliverClaimedDms() {} },
    log: { info() {}, error() {} },
    SELF_LABEL: 'self',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => uiSettings,
    getPeerManager: () => peerManager, setPeerManager: () => {},
    getTunnelManager: () => tunnelManager, setTunnelManager: () => {},
  });
  return { wiring, store, sets, tunnelSynced, peerSynced };
}

test('disabled peer is excluded from both the tunnel and peer syncs', () => {
  const peers = [
    { id: 'a', label: 'A', url: 'http://a' },
    { id: 'b', label: 'B', url: 'http://b', disabled: true },
  ];
  const { wiring, tunnelSynced, peerSynced } = makeWiring(peers);
  wiring.syncPeerManager();
  assert.deepEqual(tunnelSynced.at(-1).map((p) => p.id), ['a'], 'tunnel sync skips disabled');
  assert.deepEqual(peerSynced.at(-1).map((p) => p.id), ['a'], 'peer sync skips disabled');
});

test('disabled peer keeps its persisted attachment + control claim (not pruned); a truly-removed one is pruned', () => {
  const peers = [
    { id: 'a', label: 'A', url: 'http://a' },
    { id: 'b', label: 'B', url: 'http://b', disabled: true },
  ];
  const persisted = {
    peerAttached: { b: ['sess'], gone: ['x'] },   // 'gone' has no record → prune
    peerControlled: { b: ['sess'] },
  };
  const { wiring, store } = makeWiring(peers, persisted);
  wiring.syncPeerManager();
  assert.deepEqual(store.peerAttached.b, ['sess'], 'disabled peer attachment survives');
  assert.deepEqual(store.peerControlled.b, ['sess'], 'disabled peer control claim survives');
  assert.equal(store.peerAttached.gone, undefined, 'orphaned attachment (no record) is still pruned');
});

// --- ipc harness: load ipc-handlers with a faked electron so registerIpcHandlers
// can register into a capturing ipcMain. Only the deps peer:setDisabled touches
// are real; the rest are undefined (registration never runs the other bodies).
function loadHandlers() {
  const handlers = new Map();
  const fakeElectron = {
    app: {}, BrowserWindow: {}, Menu: {}, dialog: {}, shell: {},
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set(ch, fn),
    },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  let registerIpcHandlers;
  try {
    delete require.cache[require.resolve('../ipc-handlers')];
    ({ registerIpcHandlers } = require('../ipc-handlers'));
  } finally {
    Module._load = origLoad;
  }
  return { handlers, registerIpcHandlers };
}

function setDisabledFixture() {
  const { handlers, registerIpcHandlers } = loadHandlers();
  const store = { peers: [{ id: 'a', label: 'A', url: 'http://a' }] };
  const calls = { forgetAttached: 0, forgetControlled: 0, sync: 0, broadcast: [], set: [] };
  registerIpcHandlers({
    uiSettings: {
      get: () => store,
      set: (patch) => { calls.set.push(patch); Object.assign(store, patch); return store; },
    },
    manager: { _broadcast: (...a) => calls.broadcast.push(a) },
    syncPeerManager: () => { calls.sync += 1; },
    log: { info() {}, error() {} },
    forgetPeerAttached: () => { calls.forgetAttached += 1; },
    forgetPeerControlled: () => { calls.forgetControlled += 1; },
  });
  return { handler: handlers.get('peer:setDisabled'), store, calls };
}

test('peer:setDisabled(on) flips the flag + re-syncs + broadcasts, and NEVER forgets attachment/control', () => {
  const { handler, store, calls } = setDisabledFixture();
  assert.equal(typeof handler, 'function', 'peer:setDisabled handler registered');
  const res = handler({}, 'a', true);
  assert.deepEqual(res, { ok: true });
  assert.equal(store.peers[0].disabled, true, 'record flagged disabled');
  assert.equal(calls.set.length, 1, 'persisted once');
  assert.equal(calls.sync, 1, 're-synced');
  assert.equal(calls.broadcast.length, 1);
  assert.deepEqual(calls.broadcast[0], ['peer-disabled', 'a', true, 'A'], 'broadcast id/on/label');
  assert.equal(calls.forgetAttached, 0, 'attachment never durably forgotten');
  assert.equal(calls.forgetControlled, 0, 'control claim never durably forgotten');
});

test('peer:setDisabled(off) clears the flag and still never forgets attachment/control', () => {
  const { handler, store, calls } = setDisabledFixture();
  handler({}, 'a', true);
  const res = handler({}, 'a', false);
  assert.deepEqual(res, { ok: true });
  assert.equal('disabled' in store.peers[0], false, 'flag deleted on enable');
  assert.equal(calls.forgetAttached, 0);
  assert.equal(calls.forgetControlled, 0);
  assert.deepEqual(calls.broadcast.at(-1), ['peer-disabled', 'a', false, 'A']);
});

test('peer:setDisabled on an unknown id is a no-op error', () => {
  const { handler, calls } = setDisabledFixture();
  const res = handler({}, 'nope', true);
  assert.equal(res.ok, false);
  assert.equal(calls.set.length, 0);
  assert.equal(calls.sync, 0);
});
