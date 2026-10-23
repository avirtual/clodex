'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createPeerWiring } = require('../peer-wiring');

function makeWiring({ peers, statuses = {}, peerWebOpen = {} }) {
  const store = { peers, peerAttached: {}, peerControlled: {}, peerVisible: {}, peerWebOpen };
  const uiSettings = { get: () => store, set: (p) => Object.assign(store, p) };
  const windows = [];
  const boundsListeners = [];
  const closedListeners = [];
  let emit = null;
  let peerManager = null;
  const pc = require('../peer-client');
  const origPM = pc.PeerManager;
  pc.PeerManager = function (opts) {
    emit = opts.emit;
    return { sync() {}, statuses: () => [], get: (id) => (statuses[id] ? { status: () => statuses[id] } : null) };
  };
  const wt = require('../web-tunnel');
  const origWT = wt.WebTunnelManager;
  wt.WebTunnelManager = function () { return { open: () => ({ ok: true }), close: () => ({ ok: true }), sync() {}, statuses: () => [], stopAll() {} }; };
  let webTunnelManager = null;
  let tunnelManager = { sync() {}, urlFor: () => null, statuses: () => [] };
  const wiring = createPeerWiring({
    manager: { _broadcast() {}, _deliverClaimedDms() {}, _flushPeerHeld() {} },
    log: { info() {}, error() {} },
    SELF_LABEL: 'self',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => uiSettings,
    getPeerManager: () => peerManager,
    setPeerManager: (v) => { peerManager = v; },
    getTunnelManager: () => tunnelManager,
    setTunnelManager: (v) => { tunnelManager = v; },
    getWebTunnelManager: () => webTunnelManager,
    setWebTunnelManager: (v) => { webTunnelManager = v; },
    openRemoteWindow: (key, url, opts) => windows.push({ key, url, opts }),
    closeRemoteWindow: () => {},
    onRemoteWindowClosed: (cb) => closedListeners.push(cb),
    onRemoteWindowBounds: (cb) => boundsListeners.push(cb),
  });
  return {
    wiring, store, windows,
    sync: () => wiring.syncPeerManager(),
    peerState: (id, st) => emit('peer-state', id, st),
    fireBounds: (key, b) => boundsListeners.forEach((cb) => cb(key, b)),
    fireClosed: (key) => closedListeners.forEach((cb) => cb(key)),
    restore: () => { pc.PeerManager = origPM; wt.WebTunnelManager = origWT; },
  };
}

const OPEN = { online: true, webHost: { port: 8080, tokenGated: false } };
const GATED = { online: true, webHost: { port: 8080, tokenGated: true } };
const DIRECT = { id: 'p1', label: 'box', url: 'https://box.example' };

test('openPeerWeb on a non-gated peer persists peerWebOpen; closePeerWeb and an operator close forget it', () => {
  const h = makeWiring({ peers: [DIRECT, { id: 'p2', label: 'b2', sshHost: 'b2' }], statuses: { p1: OPEN, p2: OPEN } });
  try {
    h.sync();
    h.wiring.openPeerWeb('p1');
    h.wiring.openPeerWeb('p2');
    assert.deepStrictEqual(h.store.peerWebOpen, { p1: {}, p2: {} });
    h.wiring.closePeerWeb('p1');
    assert.deepStrictEqual(h.store.peerWebOpen, { p2: {} });
    h.fireClosed('peer:p2');
    assert.deepStrictEqual(h.store.peerWebOpen, {});
  } finally { h.restore(); }
});

test('a token-gated open forgets a persisted entry rather than writing one', () => {
  const h = makeWiring({ peers: [DIRECT, { id: 'p2', label: 'b2', sshHost: 'b2' }], statuses: { p1: GATED, p2: GATED }, peerWebOpen: { p1: {}, p2: {} } });
  try {
    h.sync();
    h.wiring.openPeerWeb('p1');
    h.wiring.openPeerWeb('p2');
    assert.deepStrictEqual(h.store.peerWebOpen, {});
  } finally { h.restore(); }
});

test('a persisted peer is reopened on its first online peer-state, once per boot', () => {
  const h = makeWiring({ peers: [DIRECT], statuses: { p1: OPEN }, peerWebOpen: { p1: {} } });
  try {
    h.sync();
    h.peerState('p1', OPEN);
    assert.deepStrictEqual(h.windows.map((w) => w.key), ['peer:p1']);
    h.peerState('p1', { online: false });
    h.peerState('p1', OPEN);
    assert.deepStrictEqual(h.windows.map((w) => w.key), ['peer:p1']);
  } finally { h.restore(); }
});

test('a peer-state without webHost, or for an id not persisted, opens nothing', () => {
  const h = makeWiring({ peers: [DIRECT, { id: 'p3', label: 'b3', url: 'https://b3.example' }], statuses: { p1: OPEN, p3: OPEN }, peerWebOpen: { p1: {} } });
  try {
    h.sync();
    h.peerState('p3', OPEN);
    h.peerState('p1', { online: true, webHost: null });
    assert.deepStrictEqual(h.windows, []);
    h.peerState('p1', OPEN);
    assert.deepStrictEqual(h.windows.map((w) => w.key), ['peer:p1']);
  } finally { h.restore(); }
});

test('the bounds listener stores bounds under the peer id and the next open carries them', () => {
  const h = makeWiring({ peers: [DIRECT], statuses: { p1: OPEN } });
  try {
    h.sync();
    h.wiring.openPeerWeb('p1');
    assert.equal(h.windows[0].opts.bounds, undefined);
    const bounds = { x: 10, y: 20, width: 900, height: 700 };
    h.fireBounds('peer:p1', bounds);
    h.fireBounds('sandbox:sandbox', { x: 1, y: 1, width: 1, height: 1 });
    assert.deepStrictEqual(h.store.peerWebOpen, { p1: { bounds } });
    h.wiring.openPeerWeb('p1');
    assert.deepStrictEqual(h.windows[1].opts, { title: 'box — Clodex', bounds });
    assert.deepStrictEqual(h.store.peerWebOpen, { p1: { bounds } });
  } finally { h.restore(); }
});
