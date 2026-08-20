'use strict';
// peer-wirescope-forward.test.js — t443: the COMPANION forward to a peer's own
// wirescope, raised with the web view so the dashboard links inside that page
// resolve. Sibling of peer-web-open.test.js, which owns the web forward's
// policy; what lives here is the property that makes this one safe to add:
//
//   • IT IS SUBORDINATE. The web view opens whatever this forward does — the
//     box has no wirescope, the peer is too old to say where it is, the
//     supervisor throws. Each of those costs the dashboard link and NOTHING
//     else. A regression here is a peer web view that stops opening because of
//     a feature that only decorates it.
//   • IT NEVER GUESSES. 7800 is the DEFAULT port of a wirescope, which makes
//     guessing it especially tempting and especially bad: unforwarded, a link
//     at 127.0.0.1:7800 resolves against the VIEWER'S own wirescope and shows
//     them a foreign session id. Confidently wrong beats broken only for the
//     person who wrote it.
//
// The real createPeerWiring runs; the WebTunnelManager constructor is stubbed
// through the module registry, so no child process and no socket is created.
// Both forwards are that same class, so the stub hands back a DISTINCT recorder
// per construction — conflating them is how a test would "pass" against one
// manager doing both jobs, which is the arrangement the renderer's
// peer-web-tunnel channel rules out.

const { test } = require('node:test');
const assert = require('node:assert');

const { createPeerWiring } = require('../peer-wiring');

// Construction order is load-bearing and asserted directly in its own test: the
// wirescope manager is built FIRST (openPeerWeb raises it before the web
// forward, so its pinned port exists when the pop composes the URL). Everywhere
// else the two are addressed by ROLE rather than by index — several cases below
// raise no wirescope forward at all, and an index would silently slide the web
// manager into the wirescope slot and assert against the wrong recorder.

function makeWiring({ peers = [], statuses = {}, localPort = 45501, openThrows = false, webOpenRefuses = false } = {}) {
  const store = { peers, peerAttached: {}, peerControlled: {}, peerVisible: {} };
  const uiSettings = { get: () => store, set: (p) => Object.assign(store, p) };
  const externals = [];      // every URL handed to the operator's browser
  const logs = [];
  const mgrs = [];           // one recorder per WebTunnelManager construction

  function makeMgr() {
    const rec = {
      opened: [], closed: [], synced: [], onState: () => {},
      open(o) {
        if (openThrows && rec.role === 'wirescope') throw new Error('supervisor exploded');
        if (webOpenRefuses && rec.role === 'web') return { ok: false, error: 'refused' };
        rec.opened.push(o);
        return { ok: true, status: { id: o.id, state: 'down', url: null } };
      },
      close(id) { rec.closed.push(id); return { ok: true }; },
      sync(list) { rec.synced.push((list || []).map((p) => p.id)); },
      statuses: () => [],
      // The pinned port exists from `open` — deliberately BEFORE the forward is
      // up, which is the whole reason the page URL can be composed at pop time.
      statusFor: (id) => (rec.opened.some((o) => o.id === String(id))
        ? { id: String(id), state: 'down', localPort, url: null } : null),
      stopAll() { rec.stopped = true; },
    };
    return rec;
  }

  // Which manager a construction is, decided by what its onState DOES rather
  // than by when it happened. peer-wiring gives the web manager the renderer
  // broadcast (`peer-web-tunnel`, which drives the ↗ button's phase) and gives
  // the companion one only a log — a separation this ticket requires. Probing
  // it means a test whose peer raises no companion forward still addresses the
  // right recorder, and that a future merge of the two fails loudly here rather
  // than mislabelling them.
  let broadcastSeen = false;
  const mod = require('../web-tunnel');
  const origCtor = mod.WebTunnelManager;
  mod.WebTunnelManager = function (opts) {
    const rec = makeMgr();
    rec.onState = opts.onState;
    broadcastSeen = false;
    try { opts.onState('__probe__', { id: '__probe__', state: 'down', url: null }); } catch { /* still classifiable */ }
    rec.role = broadcastSeen ? 'web' : 'wirescope';
    mgrs.push(rec);
    return rec;
  };

  let webTunnelManager = null;
  const wiring = createPeerWiring({
    manager: { _broadcast: () => { broadcastSeen = true; }, _deliverClaimedDms() {} },
    log: { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
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

  const byRole = (role) => mgrs.find((m) => m.role === role) || null;

  return {
    wiring, externals, logs, mgrs, byRole,
    web: () => byRole('web'),
    wirescope: () => byRole('wirescope'),
    // What the WEB supervisor fires on its first successful up — the emit the
    // browser pop rides.
    emitWebUp: (id, url, extra) => byRole('web').onState(id, { id, state: 'up', url, firstUp: true, ...extra }),
    restore: () => { mod.WebTunnelManager = origCtor; },
  };
}

const SSH = { id: 'p1', label: 'box', sshHost: 'box' };
// A hello from a box that serves both: a web frontend on 8080, wirescope on 7800.
const BOTH = { webHost: { port: 8080, tokenGated: false }, wirescope: { port: 7800 } };
// The same box with wirescope off (CLODEX_WIRESCOPE=off, a supported deploy).
const WEB_ONLY = { webHost: { port: 8080, tokenGated: false }, wirescope: null };
// A peer running a version that predates the hello field entirely.
const OLD = { webHost: { port: 8080, tokenGated: false } };

// ── The happy path: the page is told where the forward is ────────────────────

test('the page URL carries the LOCAL forwarded port, and the forward goes to the box`s own', () => {
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH }, localPort: 45501 });
  try {
    assert.equal(h.wiring.openPeerWeb('p1').ok, true);
    assert.deepEqual(h.wirescope().opened, [{ id: 'p1', sshHost: 'box', remotePort: 7800 }],
      'forwarded to the port the BOX reported for its own wirescope');
    h.emitWebUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001?wirescope=45501&via=tunnel'],
      'the browser is sent the web view, told where wirescope was forwarded LOCALLY');
  } finally { h.restore(); }
});

test('the param is appended, never assumed to be the first — a URL that already has a query keeps it', () => {
  // The web view's URL is the supervisor's today, but token-gated boxes and any
  // later selector would put a query on it. Clobbering `?` would take the page's
  // own params with it.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH }, localPort: 45502 });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitWebUp('p1', 'http://127.0.0.1:45001/?workspace=w2');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001/?workspace=w2&wirescope=45502&via=tunnel']);
  } finally { h.restore(); }
});

test('the two forwards are SEPARATE supervisors, wirescope raised first', () => {
  // Separate because the web manager's state is broadcast on `peer-web-tunnel`,
  // which the renderer reads as the ↗ button's phase: a second tunnel emitting
  // there under the same peer id would drive the button from the wrong forward.
  // First because the pop reads the pinned port at firstUp, and a port picked
  // after the pop is a port the tab never learns.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    assert.equal(h.mgrs.length, 2, 'two managers, not one doing both jobs');
    // Asserted on the CONSTRUCTION SEQUENCE, not via the role lookup the other
    // tests use: byRole answers the same either way, so a lookup here would
    // leave this test's whole point — the order — unexercised while still
    // passing.
    assert.deepEqual(h.mgrs.map((m) => m.role), ['wirescope', 'web'],
      'the companion forward is raised BEFORE the web one, so its pinned port exists at pop time');
    assert.deepEqual(h.wirescope().opened.map((o) => o.remotePort), [7800], 'and forwards to wirescope');
    assert.deepEqual(h.web().opened.map((o) => o.remotePort), [8080], 'while the web one forwards to the frontend');
  } finally { h.restore(); }
});

test('a cloud peer forwards its wirescope over the SAME transport block as its web view', () => {
  // The t36 bug, one layer over: any code that rebuilds a destination from named
  // fields drops what it does not name, and a kubectl peer would get a wirescope
  // forward with no target.
  const h = makeWiring({
    peers: [{ id: 'p1', label: 'box', kubectl: { target: 'svc/clodex', namespace: 'ops', context: 'prod' } }],
    statuses: { p1: BOTH },
  });
  try {
    h.wiring.openPeerWeb('p1');
    assert.deepEqual(h.wirescope().opened, [{
      id: 'p1', sshHost: null, remotePort: 7800,
      kubectl: { target: 'svc/clodex', namespace: 'ops', context: 'prod' },
    }], 'the whole block reaches the supervisor');
  } finally { h.restore(); }
});

// ── Subordination: the web view survives everything this forward can do ──────

test('no wirescope on the box: the web view opens fine, and the page gets NO link', () => {
  // CLODEX_WIRESCOPE=off is a supported deploy option, so this is the normal
  // quiet case — not an error, and not a reason to withhold the web frontend.
  const h = makeWiring({ peers: [SSH], statuses: { p1: WEB_ONLY } });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, true, 'the web view still opens');
    h.emitWebUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001?via=tunnel'],
      'popped, with no wirescope param — but still marked as tunnelled (t445)');
    assert.equal(h.mgrs.length, 1, 'and no wirescope supervisor was constructed');
  } finally { h.restore(); }
});

test('an OLDER peer that never sends the field degrades to no forward — never a guessed 7800', () => {
  // The assertion that must fail if anyone defaults the port. An unforwarded
  // 127.0.0.1:7800 in the page resolves against the VIEWER'S own wirescope,
  // which is the confidently-wrong failure this ticket exists to remove.
  const h = makeWiring({ peers: [SSH], statuses: { p1: OLD } });
  try {
    assert.equal(h.wiring.openPeerWeb('p1').ok, true);
    h.emitWebUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001?via=tunnel']);
    assert.equal(h.mgrs.length, 1, 'no forward was attempted');
    assert.ok(!h.externals[0].includes('7800'), 'and no port was invented for it');
  } finally { h.restore(); }
});

test('a malformed port in the hello is refused like an absent one', () => {
  // The hello is validated at the peer-client edge, but a consumer that trusts
  // its own side of a wire contract is one release from a forward to port NaN.
  for (const bad of [{ port: 0 }, { port: -1 }, { port: 65536 }, { port: 7800.5 }, { port: '7800' }, { port: NaN }, {}]) {
    const h = makeWiring({
      peers: [SSH],
      statuses: { p1: { webHost: { port: 8080, tokenGated: false }, wirescope: bad } },
    });
    try {
      assert.equal(h.wiring.openPeerWeb('p1').ok, true, `${JSON.stringify(bad)}: web view unaffected`);
      assert.equal(h.mgrs.length, 1, `${JSON.stringify(bad)}: no forward`);
    } finally { h.restore(); }
  }
});

test('a THROWING wirescope supervisor costs the link and nothing else', () => {
  // The strongest form of the subordination rule: the companion forward blowing
  // up must not take out the browser pop the operator actually asked for.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH }, openThrows: true });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, true, 'the web view still opens');
    h.emitWebUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, ['http://127.0.0.1:45001?via=tunnel'], 'the browser still opens, without a link');
  } finally { h.restore(); }
});

test('a wirescope forward that GIVES UP is logged as harmless, not raised as a failure', () => {
  // The give-up cap fires on a box that never serves. For the web view that is
  // the operator's whole request failing; here it is a missing link, so it must
  // not read like an error in the log either.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.wirescope().onState('p1', { id: 'p1', state: 'gave-up', url: null, error: 'no route to host' });
    const line = h.logs.find((l) => /wirescope forward for p1 gave up/.test(l));
    assert.ok(line, 'the give-up is visible in the ops log');
    assert.match(line, /keeps working/i, 'and says the web view is unaffected');
  } finally { h.restore(); }
});

// ── The web view DYING takes the companion with it (review round 1) ─────────
// The teardown paths wired at first submission — closePeerWeb, the sync prune,
// app quit — all assume someone or something still ASKS. A web tunnel that
// gives up asks nobody: the affordance renders `action: 'open'` at that state,
// so the operator has no close button, while the companion `ssh -N -L` keeps
// republishing the box's unauthenticated wirescope on their loopback for the
// rest of the process lifetime. That is the exact "forgotten forward open to a
// remote machine" web-tunnel.js inversion 3 exists to prevent, reintroduced
// one layer up.

test('the web view GIVING UP tears the companion forward down', () => {
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    assert.deepEqual(h.wirescope().closed, [], 'live while the web view is');
    h.web().onState('p1', { id: 'p1', state: 'gave-up', url: null, error: 'no route to host' });
    assert.deepEqual(h.wirescope().closed, ['p1'],
      'a give-up leaves no close button, so nothing else would ever close this');
  } finally { h.restore(); }
});

test('the web view being CLOSED by the supervisor tears the companion down too', () => {
  // `closed` is the manager's own final emit. It arrives on the closePeerWeb
  // path (where the companion is closed anyway, and a second close is a no-op)
  // AND on the sync prune — so keying on it costs nothing and covers a caller
  // that closes the web manager directly.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.web().onState('p1', { id: 'p1', state: 'closed', url: null });
    assert.deepEqual(h.wirescope().closed, ['p1']);
  } finally { h.restore(); }
});

test('an ordinary web-view blip does NOT tear the companion down', () => {
  // The other half: `down` is a respawn away from `up`, and the pinned ports on
  // both sides mean the operator's tab recovers by itself. Tearing the companion
  // down on every wifi blip would take the dashboard link away permanently,
  // since only a fresh ↗ click re-raises it.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.web().onState('p1', { id: 'p1', state: 'down', url: null });
    h.web().onState('p1', { id: 'p1', state: 'up', url: 'http://127.0.0.1:45001' });
    assert.deepEqual(h.wirescope().closed, [], 'survives a blip');
  } finally { h.restore(); }
});

test('a REFUSED web open unwinds the companion raised moments earlier', () => {
  // openPeerWirescope runs BEFORE the web open (its pinned port must exist when
  // the pop composes the URL), so a web open that refuses leaves a forward with
  // nothing to decorate. Currently unreachable — the supervisor's own refusals
  // are all caught earlier — but it is the failure the ordering creates, and it
  // costs one line to close.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH }, webOpenRefuses: true });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, false, 'the web open refused');
    assert.deepEqual(h.wirescope().closed, ['p1'], 'and the companion did not outlive it');
  } finally { h.restore(); }
});

// ── The token-gated decision is respected, not worked around ─────────────────

test('SECURITY-adjacent: a token-gated peer gets NO wirescope forward and NO composed URL', () => {
  // t30b decided a gated box is not popped, because its page answers a bare 401.
  // A companion forward there would be a tunnel to a remote machine raised for a
  // page nobody opens — and composing a URL to carry its port would be quietly
  // undoing the decision rather than respecting it.
  const h = makeWiring({
    peers: [SSH],
    statuses: { p1: { webHost: { port: 8080, tokenGated: true }, wirescope: { port: 7800 } } },
  });
  try {
    const res = h.wiring.openPeerWeb('p1');
    assert.equal(res.ok, true);
    assert.equal(res.tokenGated, true);
    assert.equal(h.mgrs.length, 1, 'no wirescope forward was raised for a page that will not be opened');
    h.emitWebUp('p1', 'http://127.0.0.1:45001');
    assert.deepEqual(h.externals, [], 'and still no browser at a 401');
  } finally { h.restore(); }
});

// ── Teardown: it goes when the web view goes ─────────────────────────────────

test('closing the web view tears the wirescope forward down with it', () => {
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.wiring.closePeerWeb('p1');
    assert.deepEqual(h.wirescope().closed, ['p1'], 'the companion forward is closed');
    assert.deepEqual(h.web().closed, ['p1'], 'along with the web one');
  } finally { h.restore(); }
});

test('reconciliation prunes a companion forward whose peer was disabled or removed', () => {
  // Close #2 for the web view, and it must reach the companion too: a forward to
  // a peer the operator disabled is a live connection to a remote machine with
  // nothing left in the UI that would close it.
  const peers = [SSH, { id: 'p2', label: 'paused', sshHost: 'box2', disabled: true }];
  const h = makeWiring({ peers, statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.wiring.syncPeerManager();
    assert.deepEqual(h.wirescope().synced.at(-1), ['p1'],
      'the companion manager reconciles against the same already-filtered list');
  } finally { h.restore(); }
});

test('app shutdown stops the companion forwards — an ssh child outlives nothing', () => {
  // They are child processes with no persistence record behind them, so a quit
  // that skipped this orphans one holding a local port.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH } });
  try {
    h.wiring.openPeerWeb('p1');
    h.wiring.stopPeerWirescopeTunnels();
    assert.equal(h.wirescope().stopped, true);
  } finally { h.restore(); }
});

test('closePeerWeb is still safe before anything was ever opened', () => {
  // The companion manager is lazy for the same reason the web one is; a close on
  // a peer nobody looked at must not construct one just to close it.
  const h = makeWiring({ peers: [SSH] });
  try {
    assert.deepEqual(h.wiring.closePeerWeb('p1'), { ok: true });
    assert.equal(h.mgrs.length, 0, 'no supervisor was built');
  } finally { h.restore(); }
});

test('a refused web view raises no companion forward — the refusals come first', () => {
  // openPeerWeb refuses an unknown peer and a url-only one before either forward
  // is touched. A companion raised ahead of those checks would be a tunnel for a
  // web view that never opens.
  for (const [peers, statuses, what] of [
    [[], {}, 'unknown peer'],
    [[{ id: 'p1', label: 'cloud', url: 'https://box.example' }], { p1: BOTH }, 'url-only peer'],
    [[SSH], { p1: { wirescope: { port: 7800 } } }, 'peer with no web frontend'],
  ]) {
    const h = makeWiring({ peers, statuses });
    try {
      assert.equal(h.wiring.openPeerWeb('p1').ok, false, `${what}: refused`);
      assert.equal(h.mgrs.length, 0, `${what}: and no forward of either kind`);
    } finally { h.restore(); }
  }
});

// ── t445: the tunnel MARK, which is not the wirescope param ──────────────────

test('t445: every tunnelled pop is marked `via=tunnel`, wirescope forward or not', () => {
  // The mark and the port are independent on purpose, and this is the assertion
  // that keeps them so. The served page cannot tell a tunnelled tab from a tab
  // opened on the box — both are served from a 127.0.0.1 origin — yet the box's
  // own loopback links are correct in one and wrong in the other. If the mark
  // rode along with `wirescope=`, every box deployed with CLODEX_WIRESCOPE=off
  // (a supported option, and the WEB_ONLY case below) would serve a page that
  // reads as "on the box" and re-opens the whole t445 defect for it.
  for (const [label, status] of [['with wirescope', BOTH], ['wirescope off', WEB_ONLY], ['old peer', OLD]]) {
    const h = makeWiring({ peers: [SSH], statuses: { p1: status }, localPort: 45501 });
    try {
      h.wiring.openPeerWeb('p1');
      h.emitWebUp('p1', 'http://127.0.0.1:45001');
      assert.equal(h.externals.length, 1, `${label}: popped`);
      const u = new URL(h.externals[0]);
      assert.equal(u.searchParams.get('via'), 'tunnel', `${label}: marked as tunnelled`);
    } finally { h.restore(); }
  }
});

test('t445: the mark survives a URL that already carries a query, alongside the port', () => {
  // Both params must land parseable — a hand-rolled second `?` would make the
  // page read `via` as part of the previous value and silently lose the mark.
  const h = makeWiring({ peers: [SSH], statuses: { p1: BOTH }, localPort: 45502 });
  try {
    h.wiring.openPeerWeb('p1');
    h.emitWebUp('p1', 'http://127.0.0.1:45001/?workspace=w2');
    const u = new URL(h.externals[0]);
    assert.equal(u.searchParams.get('workspace'), 'w2', 'the page`s own param survives');
    assert.equal(u.searchParams.get('wirescope'), '45502');
    assert.equal(u.searchParams.get('via'), 'tunnel');
  } finally { h.restore(); }
});
