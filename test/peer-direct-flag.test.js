'use strict';

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
    { id: 'half-az', label: 'az', url: 'http://box.example:7900', az: { bastion: 'b' } },
  ]);
  wiring.resolvePeerUrls();
  const byId = Object.fromEntries(peerSynced.at(-1).map((p) => [p.id, p.direct]));
  assert.deepEqual(byId, { url: true, ssh: false, kubectl: false, ssm: false, 'half-az': true },
    'the SAME verdict openPeerWeb routes a click with — a second kind list here would be one to forget a kind '
    + 'from; and an incomplete cloud block dials nothing, so it is direct and refused on the direct path`s terms');
});

test('t925: a forwardable peer is marked NOT direct even while its tunnel is down', () => {
  const { wiring, peerSynced } = makeWiring([{ id: 'p1', label: 'box', sshHost: 'box' }]);
  wiring.resolvePeerUrls();
  const [p] = peerSynced.at(-1);
  assert.equal(p.url, 'http://127.0.0.1:1', 'the offline placeholder, as before');
  assert.strictEqual(p.direct, false,
    'a down tunnel is still a tunnel — KIND, not reachability. This is the shape the renderer misread: if the '
    + 'flag tracked reachability it would compose http://127.0.0.1:<webPort> from that sentinel url');
});

test('t925: status() carries `direct` to the renderer, strictly', () => {
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
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
  const emits = [];
  const mgr = new PeerManager({ emit: (ch, ...a) => emits.push([ch, ...a]) });
  try {
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: true }]);
    emits.length = 0;
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: false }]);

    assert.deepEqual(emits.filter(([ch]) => ch === 'peer-removed'), [],
      'no teardown: adding an sshHost moves the ROUTE while url, label and token — the fields sync restarts on '
      + '— are untouched, and nothing on the wire depends on the flag, so a restart would shed every live '
      + 'attachment to carry one boolean');
    const states = emits.filter(([ch]) => ch === 'peer-state');
    assert.equal(states.length, 1,
      'exactly one re-announcement — a silent no-op would leave the sidebar offering a direct address for a '
      + 'peer main now tunnels to');
    assert.strictEqual(states[0][2].direct, false, 'carrying the new route');

    emits.length = 0;
    mgr.sync([{ id: 'p1', label: 'box', url: 'http://127.0.0.1:1', direct: false }]);
    assert.deepEqual(emits, [], 'and an unchanged re-sync stays the no-op it was');
  } finally { mgr.stopAll(); }
});
