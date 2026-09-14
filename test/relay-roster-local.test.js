'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const PEER_CLIENT = require.resolve('../peer-client');

function withStubbedPeerClient(fn) {
  const had = Object.prototype.hasOwnProperty.call(require.cache, PEER_CLIENT);
  const prev = require.cache[PEER_CLIENT];
  const captured = {};
  const stub = new Module(PEER_CLIENT, null);
  stub.filename = PEER_CLIENT;
  stub.paths = Module._nodeModulePaths(path.dirname(PEER_CLIENT));
  stub.loaded = true;
  stub.exports = {
    PeerManager: class {
      constructor(opts) { captured.opts = opts; }
      sync() {}
      statuses() { return captured.statuses || []; }
    },
  };
  require.cache[PEER_CLIENT] = stub;
  try { return fn(captured); } finally {
    if (had) require.cache[PEER_CLIENT] = prev; else delete require.cache[PEER_CLIENT];
  }
}

function makeWiring(captured, { peers, sessions, selfLabel = 'hub', statuses = [] }) {
  captured.statuses = statuses;
  const store = { peers, peerAttached: {}, peerControlled: {}, peerVisible: {} };
  const uiSettings = { get: () => store, set: (patch) => Object.assign(store, patch) };
  let pm = null;
  const listCalls = [];
  const { createPeerWiring } = require('../peer-wiring');
  const wiring = createPeerWiring({
    manager: {
      _broadcast() {}, _deliverClaimedDms() {}, _deliverClaimedInbox() {},
      list: () => { listCalls.push(1); return sessions; },
    },
    log: { info() {}, error() {} },
    SELF_LABEL: selfLabel,
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => uiSettings,
    getPeerManager: () => pm, setPeerManager: (v) => { pm = v; },
    getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
    setTunnelManager: () => {},
  });
  wiring.syncPeerManager();
  return { computeRoster: captured.opts.computeRoster, listCalls };
}

const SESSIONS = [
  { name: 'clodex', type: 'claude', workspaceId: 'ws-a' },
  { name: 'Codex', type: 'codex', workspaceId: 'ws-b' },
  { name: 'shell', type: 'bash', workspaceId: 'ws-a' },
];

test('peer-wiring feeds computeRosterFor the local sessions and SELF_LABEL', () => {
  withStubbedPeerClient((captured) => {
    const { computeRoster } = makeWiring(captured, {
      peers: [{ id: 'ios', label: 'ios', url: 'http://ios', relayAllowed: true }],
      sessions: SESSIONS,
    });
    assert.deepStrictEqual(computeRoster('ios'), [
      { name: 'clodex', origin: 'hub', type: 'claude' },
      { name: 'Codex', origin: 'hub', type: 'codex' },
    ], 'an allowed spoke can NAME the hub\'s own agents, so it can initiate a dm');
  });
});

test('peer-wiring: a spoke that is not relayAllowed learns none of the hub\'s names', () => {
  withStubbedPeerClient((captured) => {
    const { computeRoster } = makeWiring(captured, {
      peers: [{ id: 'ios', label: 'ios', url: 'http://ios', relayAllowed: false }],
      sessions: SESSIONS,
    });
    assert.deepStrictEqual(computeRoster('ios'), []);
    assert.deepStrictEqual(computeRoster('stranger'), [], 'nor a peer absent from settings');
  });
});

test('peer-wiring: the bash session never leaves this machine', () => {
  withStubbedPeerClient((captured) => {
    const { computeRoster } = makeWiring(captured, {
      peers: [{ id: 'ios', label: 'ios', url: 'http://ios', relayAllowed: true }],
      sessions: SESSIONS,
    });
    const names = computeRoster('ios').map((r) => r.name);
    assert.strictEqual(names.includes('shell'), false, 'a bash session is private by design');
  });
});

test('peer-wiring reads the session list at CALL time, not at construction', () => {
  withStubbedPeerClient((captured) => {
    const live = [];
    const { computeRoster, listCalls } = makeWiring(captured, {
      peers: [{ id: 'ios', label: 'ios', url: 'http://ios', relayAllowed: true }],
      sessions: live,
    });
    assert.deepStrictEqual(computeRoster('ios'), [], 'no sessions yet → no local rows');
    live.push({ name: 'late', type: 'claude' });
    assert.deepStrictEqual(
      computeRoster('ios'), [{ name: 'late', origin: 'hub', type: 'claude' }],
      'a session started after construction rides the next hello tick\'s push',
    );
    assert.strictEqual(listCalls.length, 2, 'one list read per computeRoster call');
  });
});

test('peer-wiring: a throwing session list degrades to no local rows, not a dead push', () => {
  withStubbedPeerClient((captured) => {
    const store = { peers: [{ id: 'ios', label: 'ios', url: 'http://ios', relayAllowed: true }], peerAttached: {}, peerControlled: {}, peerVisible: {} };
    const uiSettings = { get: () => store, set: (p) => Object.assign(store, p) };
    let pm = null;
    const { createPeerWiring } = require('../peer-wiring');
    captured.statuses = [];
    const wiring = createPeerWiring({
      manager: {
        _broadcast() {}, _deliverClaimedDms() {}, _deliverClaimedInbox() {},
        list: () => { throw new Error('manager not ready'); },
      },
      log: { info() {}, error() {} },
      SELF_LABEL: 'hub',
      scheduleAppMenuRefresh: () => {},
      getUiSettings: () => uiSettings,
      getPeerManager: () => pm, setPeerManager: (v) => { pm = v; },
      getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
      setTunnelManager: () => {},
    });
    wiring.syncPeerManager();
    assert.deepStrictEqual(captured.opts.computeRoster('ios'), []);
  });
});
