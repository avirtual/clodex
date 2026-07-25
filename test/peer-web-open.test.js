'use strict';
// peer-web-open.test.js — t30b: peer-wiring's half of the peer web view. The
// supervisor's own behaviour is pinned in web-tunnel.test.js; what lives here is
// the policy the supervisor deliberately does NOT know:
//
//   • WHETHER TO POP A BROWSER. web-host.js:383 answers an unauthenticated
//     request with a bare `401 unauthorized` — no login form, no redirect — and
//     auth-token.js only ever reads a token from ?token= / Bearer / a cookie,
//     none of which a freshly opened tab carries. So opening a tab at a
//     token-gated box hands the operator a dead end they cannot fix from the
//     browser. The tunnel still opens (that is what makes the box reachable);
//     the pop is what would lie.
//   • WHAT TO REFUSE. Every missing input is refused rather than guessed: an
//     unknown peer, a url-only peer (ssh-only, by ruling), and a peer whose
//     hello reports no web frontend. A guessed port is exactly the lie t30a
//     exists to prevent.
//
// The real createPeerWiring runs; only its seams are faked. ssh never spawns —
// the WebTunnelManager is stubbed through the module registry so no child
// process and no socket is created.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPeerWiring } = require('../peer-wiring');

// Stand up peer-wiring with a fake settings store, a fake peer manager whose
// status() returns the hello we want, and a WebTunnelManager stub that records
// what it was asked to open and lets the test drive its onState emits.
function makeWiring({ peers = [], statuses = {} } = {}) {
  const store = { peers, peerAttached: {}, peerControlled: {}, peerVisible: {} };
  const uiSettings = { get: () => store, set: (p) => Object.assign(store, p) };
  const opened = [];
  const closed = [];
  const externals = [];      // every URL handed to the operator's browser
  const broadcasts = [];
  let onState = () => {};

  const synced = [];
  const webMgr = {
    open(o) { opened.push(o); return { ok: true, status: { id: o.id, state: 'down', url: null } }; },
    close(id) { closed.push(id); return { ok: true }; },
    sync(list) { synced.push((list || []).map((p) => p.id)); },
    statuses: () => [],
  };

  // Swap the constructor in the module cache so ensureWebTunnelManager builds
  // the stub. Restored by the caller via the returned `restore`.
  const mod = require('../web-tunnel');
  const origCtor = mod.WebTunnelManager;
  mod.WebTunnelManager = function (opts) { onState = opts.onState; return webMgr; };

  let webTunnelManager = null;
  const wiring = createPeerWiring({
    manager: { _broadcast: (...a) => broadcasts.push(a), _deliverClaimedDms() {} },
    log: { info() {}, error() {} },
    SELF_LABEL: 'self',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => uiSettings,
    getPeerManager: () => ({
      sync() {},
      get: (id) => (statuses[id] ? { status: () => statuses[id] } : null),
    }),
    setPeerManager: () => {},
    getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
    setTunnelManager: () => {},
    getWebTunnelManager: () => webTunnelManager,
    setWebTunnelManager: (v) => { webTunnelManager = v; },
    openExternal: (url) => externals.push(url),
  });

  return {
    wiring, opened, closed, externals, broadcasts, synced,
    // Fire what the supervisor would fire on its first successful up.
    emitUp: (id, url) => onState(id, { id, state: 'up', url, firstUp: true }),
    emitState: (id, st) => onState(id, st),
    restore: () => { mod.WebTunnelManager = origCtor; },
  };
}

const GATED = { webHost: { port: 8080, tokenGated: true } };
const OPEN = { webHost: { port: 8080, tokenGated: false } };

// ── The token decision ───────────────────────────────────────────────────────

test('SECURITY-adjacent: a TOKEN-GATED peer opens its tunnel but NO browser is popped', () => {
  // The assertion that must fail if anyone ever "simplifies" this into always
  // popping: a gated box's URL answers 401, so handing it to a browser is worse
  // than doing nothing — the operator gets an error page with no way to fix it.
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: { p1: GATED } });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, true, 'the tunnel still opens — that is what makes the box reachable');
    assert.equal(res.tokenGated, true, 'and the caller is TOLD a token is required');
    assert.deepEqual(h.opened.map((o) => o.remotePort), [8080], 'forwarding to the reported port');
    h.emitUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, [], 'NO browser was opened at a URL that will 401');
  } finally { h.restore(); }
});

test('an UNGATED peer pops the browser exactly once, at the supervisor`s live URL', () => {
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: { p1: OPEN } });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, true);
    assert.equal(res.tokenGated, false);
    h.emitUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001'], 'opened once, at the URL the tunnel reported');
  } finally { h.restore(); }
});

test('the pop rides firstUp ONLY — a respawn after a blip does not open a second window', () => {
  // The pinned local port means the operator's existing tab works again the
  // moment the forward is back. Popping on every up would stack browser windows
  // on a flaky wifi link.
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: { p1: OPEN } });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitUp('p1', 'http://127.0.0.1:45001');
    h.emitState('p1', { id: 'p1', state: 'down', url: null });
    h.emitState('p1', { id: 'p1', state: 'up', url: 'http://127.0.0.1:45001' });   // no firstUp
    h.emitState('p1', { id: 'p1', state: 'up', url: 'http://127.0.0.1:45001' });
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001'], 'still exactly one');
  } finally { h.restore(); }
});

test('a state emit with no URL never reaches the browser', () => {
  // Belt and braces on "never render a URL until one is live": even a firstUp
  // that somehow arrives without a URL must not produce an open.
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: { p1: OPEN } });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitState('p1', { id: 'p1', state: 'up', url: null, firstUp: true });
    h.emitState('p1', { id: 'p1', state: 'gave-up', url: null, error: 'no route to host' });
    assert.deepEqual(h.externals, [], 'nothing opened');
  } finally { h.restore(); }
});

test('the token decision is re-taken per open: the same peer gated, then not', () => {
  // tokenGated is a live fact from the hello. A box that gains or drops its
  // token between opens must be treated as it is NOW, not as it was the first
  // time — the decision is keyed by peer, so a stale entry would be a leak of
  // the previous answer.
  const statuses = { p1: { webHost: { port: 8080, tokenGated: true } } };
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, [], 'gated: no pop');

    statuses.p1 = { webHost: { port: 8080, tokenGated: false } };   // token removed on the box
    h.wiring.closePeerWeb('p1');
    h.wiring.openPeerWeb('p1');
    h.emitUp('p1', 'http://127.0.0.1:45002');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45002'], 'ungated now: pops');

    statuses.p1 = { webHost: { port: 8080, tokenGated: true } };    // token added again
    h.wiring.closePeerWeb('p1');
    h.wiring.openPeerWeb('p1');
    h.emitUp('p1', 'http://127.0.0.1:45003');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45002'], 'gated again: no new pop');
  } finally { h.restore(); }
});

test('tokenGated is reported strictly: only an explicit true gates the pop', () => {
  // The mirror of t30a's rule. A hello value that isn't exactly `true` means the
  // box did not say "a token is required" — and reading a non-gated box as gated
  // would merely withhold a pop (visible, recoverable), where the reverse pops a
  // 401 at the operator. The strict comparison lives at the producer
  // (peer-client normalizes to a boolean); this pins the consumer agrees.
  for (const [val, gated] of [[true, true], [false, false], [undefined, false], ['yes', false], [1, false]]) {
    const h = makeWiring({
      peers: [{ id: 'p1', label: 'box', sshHost: 'box' }],
      statuses: { p1: { webHost: { port: 8080, tokenGated: val } } },
    });
    try {
      const res = h.wiring.openPeerWeb('p1');
      assert.strictEqual(res.tokenGated, gated, `${JSON.stringify(val)} → tokenGated ${gated}`);
      h.emitUp('p1', 'http://127.0.0.1:45001');
      assert.equal(h.externals.length, gated ? 0 : 1, `${JSON.stringify(val)} → pop ${gated ? 'withheld' : 'made'}`);
    } finally { h.restore(); }
  }
});

// ── Refusals: every missing input is refused, never guessed ──────────────────

test('openPeerWeb refuses an unknown peer', () => {
  const h = makeWiring({ peers: [] });
  try {
    const res = h.wiring.openPeerWeb('nope');
    assert.equal(res.ok, false);
    assert.match(res.error, /no such peer/i);
    assert.deepEqual(h.opened, [], 'nothing was opened');
  } finally { h.restore(); }
});

test('openPeerWeb refuses a URL-only peer, and SAYS ssh-only rather than failing mutely', () => {
  // The ruled limitation. A silent failure would read as "this box has no web
  // UI", which is a different and false claim.
  const h = makeWiring({
    peers: [{ id: 'p1', label: 'cloud', url: 'https://box.example' }],
    statuses: { p1: OPEN },
  });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, false);
    assert.match(res.error, /ssh/i, 'the limitation is stated');
    assert.deepEqual(h.opened, [], 'no tunnel attempted');
  } finally { h.restore(); }
});

test('openPeerWeb refuses a peer whose hello reports NO web frontend — never a guessed port', () => {
  // The whole point of t30a's hello field: a consumer must not guess
  // wire-port+1. An absent webHost means "no web host", not "try 7901".
  for (const st of [null, {}, { webHost: null }, { webHost: undefined }]) {
    const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: st ? { p1: st } : {} });
    try {
      const res = h.wiring.openPeerWeb('p1');
      assert.equal(res.ok, false, `${JSON.stringify(st)} → refused`);
      assert.match(res.error, /web frontend/i);
      assert.deepEqual(h.opened, [], 'no tunnel, no guessed port');
    } finally { h.restore(); }
  }
});

test('openPeerWeb forwards to the port the PEER reported, not a local guess', () => {
  const h = makeWiring({
    peers: [{ id: 'p1', label: 'box', sshHost: 'user@box' }],
    statuses: { p1: { webHost: { port: 31337, tokenGated: false } } },
  });
  try {
    h.wiring.openPeerWeb('p1');
    assert.deepEqual(h.opened, [{ id: 'p1', sshHost: 'user@box', remotePort: 31337 }]);
  } finally { h.restore(); }
});

// ── State reaches the renderer, and close #2 rides the existing sync ─────────

test('every supervisor state emit is broadcast to the renderer as peer-web-tunnel', () => {
  // The affordance renders from live state, so a state the renderer never hears
  // about is an affordance stuck on the wrong phase.
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], statuses: { p1: OPEN } });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitState('p1', { id: 'p1', state: 'down', url: null });
    h.emitUp('p1', 'http://127.0.0.1:45001');
    h.emitState('p1', { id: 'p1', state: 'gave-up', url: null, error: 'boom' });
    const webEvents = h.broadcasts.filter(([ch]) => ch === 'peer-web-tunnel');
    assert.deepEqual(webEvents.map(([, , st]) => st.state), ['down', 'up', 'gave-up']);
  } finally { h.restore(); }
});

test('closePeerWeb is safe before anything was ever opened', () => {
  // The manager is lazy — a close on a peer nobody looked at must not construct
  // one just to close it.
  const h = makeWiring({ peers: [{ id: 'p1', label: 'box', sshHost: 'box' }] });
  try {
    assert.deepEqual(h.wiring.closePeerWeb('p1'), { ok: true });
    assert.deepEqual(h.closed, [], 'no manager was built');
  } finally { h.restore(); }
});

test('syncPeerManager prunes web tunnels for disabled peers (close #2) and never opens one', () => {
  // The web manager rides the SAME already-filtered list peer-wiring hands the
  // wire TunnelManager, so disable/remove closes the web view for free. And a
  // sync must never open: a tunnel to a peer nobody asked to look at is a
  // tunnel with no reason to exist.
  const peers = [
    { id: 'p1', label: 'box', sshHost: 'box' },
    { id: 'p2', label: 'paused', sshHost: 'box2', disabled: true },
  ];
  const h = makeWiring({ peers, statuses: { p1: OPEN } });
  try {
    h.wiring.openPeerWeb('p1');            // builds the (stubbed) manager
    h.opened.length = 0;
    h.wiring.syncPeerManager();
    assert.deepEqual(h.synced.at(-1), ['p1'], 'the disabled peer is not in the list the web manager reconciles against');
    assert.deepEqual(h.opened, [], 'reconciliation opened nothing — on-demand only');
  } finally { h.restore(); }
});

test('syncPeerManager does NOT build a web manager for a peer nobody looked at', () => {
  // Lazy by construction: reconciliation runs on every settings change, and
  // standing up a supervisor just to iterate an empty map would be work with no
  // reason. Proven by the constructor never being called.
  let built = 0;
  const mod = require('../web-tunnel');
  const orig = mod.WebTunnelManager;
  mod.WebTunnelManager = function () { built += 1; return { open: () => ({ ok: true }), close: () => ({ ok: true }), sync() {}, statuses: () => [] }; };
  let webTunnelManager = null;
  try {
    const store = { peers: [{ id: 'p1', label: 'box', sshHost: 'box' }], peerAttached: {}, peerControlled: {}, peerVisible: {} };
    const wiring = createPeerWiring({
      manager: { _broadcast() {}, _deliverClaimedDms() {} },
      log: { info() {}, error() {} },
      SELF_LABEL: 'self',
      scheduleAppMenuRefresh: () => {},
      getUiSettings: () => ({ get: () => store, set: (p) => Object.assign(store, p) }),
      getPeerManager: () => ({ sync() {}, get: () => null }), setPeerManager: () => {},
      getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }), setTunnelManager: () => {},
      getWebTunnelManager: () => webTunnelManager,
      setWebTunnelManager: (v) => { webTunnelManager = v; },
      openExternal: () => {},
    });
    wiring.syncPeerManager();
    wiring.syncPeerManager();
    assert.equal(built, 0, 'no supervisor was constructed by reconciliation alone');
  } finally { mod.WebTunnelManager = orig; }
});
