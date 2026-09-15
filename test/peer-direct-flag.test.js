'use strict';
// t925: main tells the renderer WHICH ROUTE a peer's web view takes, instead of
// leaving the renderer to infer it from a tunnel row that has not arrived yet.
//
// The bug this pins shut: peers-ui's onPeerState repaints the moment a
// peer-state lands, while peerTunnels is seeded only by the later peerList
// reply. In that window an ssh/cloud peer rendered with no tunnel row, the
// renderer read the miss as "url peer", and composed a direct address from the
// status url — which resolvePeerUrls had by then rewritten to the forward's own
// loopback port. An ENABLED button saying "no tunnel needed" at a port on the
// operator's own machine that nothing binds.
//
// Two halves, both here: resolvePeerUrls computes `direct` from the same
// destinationOf openPeerWeb routes a click with, and PeerConnection.status()
// carries it to the renderer. A pin on either alone would leave the other free
// to drop the field silently.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPeerWiring } = require('../peer-wiring');
const { PeerManager } = require('../peer-client');

function makeWiring(peers) {
  const store = { peers, peerAttached: {}, peerControlled: {}, peerVisible: {} };
  const peerSynced = [];
  const wiring = createPeerWiring({
    manager: { _broadcast() {}, _deliverClaimedDms() {} },
    log: { info() {}, error() {} },
    SELF_LABEL: 'self',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => ({ get: () => store, set: (p) => Object.assign(store, p) }),
    getPeerManager: () => ({ sync: (p) => peerSynced.push(p) }),
    setPeerManager: () => {},
    getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
    setTunnelManager: () => {},
  });
  return { wiring, peerSynced };
}

test('t925: resolvePeerUrls marks a peer direct only when it has NO dialable destination', () => {
  const { wiring, peerSynced } = makeWiring([
    { id: 'url', label: 'url', url: 'http://box.example:7900' },
    { id: 'ssh', label: 'ssh', url: 'http://box.example:7900', sshHost: 'box' },
    { id: 'kubectl', label: 'k8s', url: 'http://box.example:7900', kubectl: { target: 'svc/clodex' } },
    { id: 'ssm', label: 'ssm', url: 'http://box.example:7900', ssm: { target: 'i-0abc' } },
    // An incomplete cloud block dials nothing, so it is direct — and the direct
    // path refuses it on its own terms rather than half-spawning a vendor CLI.
    { id: 'half-az', label: 'az', url: 'http://box.example:7900', az: { bastion: 'b' } },
  ]);
  wiring.resolvePeerUrls();
  const byId = Object.fromEntries(peerSynced.at(-1).map((p) => [p.id, p.direct]));
  assert.deepEqual(byId, { url: true, ssh: false, kubectl: false, ssm: false, 'half-az': true },
    'the SAME verdict openPeerWeb routes a click with — a second kind list here would be one to forget a kind from');
});

test('t925: a forwardable peer is marked NOT direct even while its tunnel is down', () => {
  // The exact shape the renderer used to misread: resolvePeerUrls has replaced
  // this peer's url with the dead-peer sentinel, and its tunnel row does not
  // exist yet. If `direct` tracked reachability rather than KIND, the renderer
  // would compose http://127.0.0.1:<webPort> from that sentinel.
  const { wiring, peerSynced } = makeWiring([{ id: 'p1', label: 'box', sshHost: 'box' }]);
  wiring.resolvePeerUrls();
  const [p] = peerSynced.at(-1);
  assert.equal(p.url, 'http://127.0.0.1:1', 'the offline placeholder, as before');
  assert.strictEqual(p.direct, false, 'a down tunnel is still a tunnel — kind, not reachability');
});

test('t925: status() carries `direct` to the renderer, strictly', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    // Port 1 — hello can never succeed, so only sync's newborn emit fires.
    mgr.sync([
      { id: 'url', label: 'u', url: 'http://127.0.0.1:1', direct: true },
      { id: 'ssh', label: 's', url: 'http://127.0.0.1:1', direct: false },
      { id: 'legacy', label: 'l', url: 'http://127.0.0.1:1' },
    ]);
    const seen = Object.fromEntries(
      emits.filter(([ch]) => ch === 'peer-state').map(([, id, st]) => [id, st.direct]));
    assert.deepEqual(seen, { url: true, ssh: false, legacy: false },
      'an absent flag reads false: the direct arm is the one that PRODUCES an address, '
      + 'so an ambiguous read must land on the side that produces none');
  } finally { mgr.stopAll(); }
});

test('t925: a transport edit re-announces the new route WITHOUT restarting the connection', () => {
  // Adding an sshHost to a url peer moves it between routes while url, label and
  // token are untouched — the fields sync restarts on. Nothing on the WIRE
  // depends on `direct`, so a restart would cost the operator every open
  // attachment to carry one boolean; but a silent no-op would leave the sidebar
  // offering a direct address for a peer main now tunnels to.
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: true }]);
    emits.length = 0;
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: false }]);

    assert.deepEqual(emits.filter(([ch]) => ch === 'peer-removed'), [],
      'no teardown: the wire is unchanged');
    const states = emits.filter(([ch]) => ch === 'peer-state');
    assert.equal(states.length, 1, 'exactly one re-announcement');
    assert.strictEqual(states[0][2].direct, false, 'carrying the new route');

    emits.length = 0;
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: false }]);
    assert.deepEqual(emits, [], 'and an unchanged re-sync stays the no-op it was');
  } finally { mgr.stopAll(); }
});
