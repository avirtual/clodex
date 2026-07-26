'use strict';
// peer-web-view.test.js — t30b: the pure decision behind the peer web-view (↗)
// affordance. peers-ui.js is DOM-bound and untested by the R1 rule, which is
// exactly why this leaf exists: everything that could be gotten wrong about
// WHEN the button shows, what it says, and whether a URL may be shown lives
// here, where it can be asserted.
//
// The two rules it enforces, both from t30:
//   • no URL before there is a live one — the affordance never composes one, and
//     peer-tunnel's dead-peer sentinel http://127.0.0.1:1 must never surface as
//     a web link;
//   • a token-gated box is not a link — web-host answers a bare 401, so the
//     affordance says the box needs a token rather than promising a click.

const { test } = require('node:test');
const assert = require('node:assert');

const { webViewAffordance, tunnelPhase, isSshPeer } = require('../renderer/lib/peer-web-view');

const sshTunnel = { id: 'p1', sshHost: 'box', state: 'up', localPort: 40001 };
const online = (webHost) => ({ id: 'p1', label: 'box', host: 'box', online: true, webHost });
const WEB = { port: 8080, tokenGated: false };
const WEB_GATED = { port: 8080, tokenGated: true };

// ── The URL rule ─────────────────────────────────────────────────────────────

test('SECURITY-adjacent: no URL is ever produced unless the tunnel is UP and reported one', () => {
  // The affordance is never allowed to assemble `http://127.0.0.1:${port}` from
  // a pinned-but-not-forwarded port — a port that is reserved is not a service.
  const cases = [
    undefined,
    { id: 'p1', state: 'down', url: null, localPort: 40001 },
    { id: 'p1', state: 'down', localPort: 40001 },                       // no url key at all
    { id: 'p1', state: 'gave-up', url: null, localPort: 40001, error: 'no route to host' },
    { id: 'p1', state: 'closed', url: null },
  ];
  for (const webTunnel of cases) {
    const a = webViewAffordance({ status: online(WEB), tunnel: sshTunnel, webTunnel });
    assert.strictEqual(a.url, null, `${JSON.stringify(webTunnel)} → no URL`);
  }
  // And up WITH a url is the only case that yields one.
  const up = webViewAffordance({
    status: online(WEB), tunnel: sshTunnel,
    webTunnel: { id: 'p1', state: 'up', url: 'http://127.0.0.1:40001' },
  });
  assert.equal(up.url, 'http://127.0.0.1:40001', 'only the supervisor`s own live URL');
});

test('SECURITY-adjacent: the dead-peer sentinel is never surfaced as a web link', () => {
  // http://127.0.0.1:1 is TunnelManager's offline placeholder for the WIRE
  // tunnel (resolvePeerUrls). It reaching a browser would be a tab at a closed
  // port. It rides the `tunnel` argument, so the shape is genuinely reachable.
  const deadWire = { id: 'p1', sshHost: 'box', state: 'down', localPort: null, url: 'http://127.0.0.1:1' };
  for (const webTunnel of [undefined, { id: 'p1', state: 'down', url: null }, { id: 'p1', state: 'gave-up', url: null }]) {
    const a = webViewAffordance({ status: online(WEB), tunnel: deadWire, webTunnel });
    assert.notStrictEqual(a.url, 'http://127.0.0.1:1', 'the wire placeholder is not a web URL');
    assert.strictEqual(a.url, null);
  }
});

// ── Phases ───────────────────────────────────────────────────────────────────

test('tunnelPhase maps supervisor states, and an unknown state reads as connecting', () => {
  assert.equal(tunnelPhase(undefined), 'closed');
  assert.equal(tunnelPhase(null), 'closed');
  assert.equal(tunnelPhase({ state: 'closed' }), 'closed');
  assert.equal(tunnelPhase({ state: 'up' }), 'open');
  assert.equal(tunnelPhase({ state: 'down' }), 'connecting');
  assert.equal(tunnelPhase({ state: 'gave-up' }), 'gave-up');
  // A tunnel that exists in some state we don't recognise is still a tunnel the
  // operator should be able to close — reading it as 'closed' would hide its
  // only close button, which is the bug the give-up cap exists to prevent.
  assert.equal(tunnelPhase({ state: 'weird-new-state' }), 'connecting');
});

test('closed phase: an ssh peer with a web host offers to OPEN', () => {
  const a = webViewAffordance({ status: online(WEB), tunnel: sshTunnel });
  assert.equal(a.show, true);
  assert.equal(a.enabled, true);
  assert.equal(a.action, 'open');
  assert.equal(a.phase, 'closed');
  assert.equal(a.url, null, 'nothing to link to yet');
  assert.match(a.tip, /open/i);
});

test('connecting phase: the click CANCELS, and no URL is promised', () => {
  const a = webViewAffordance({
    status: online(WEB), tunnel: sshTunnel, webTunnel: { id: 'p1', state: 'down', url: null },
  });
  assert.equal(a.phase, 'connecting');
  assert.equal(a.action, 'close', 'a connecting tunnel can be abandoned');
  assert.equal(a.enabled, true);
  assert.strictEqual(a.url, null);
  assert.match(a.tip, /connecting/i);
});

test('open phase: the click CLOSES, and the tip carries the live URL', () => {
  const a = webViewAffordance({
    status: online(WEB), tunnel: sshTunnel,
    webTunnel: { id: 'p1', state: 'up', url: 'http://127.0.0.1:40001' },
  });
  assert.equal(a.phase, 'open');
  assert.equal(a.action, 'close');
  assert.equal(a.url, 'http://127.0.0.1:40001');
  assert.ok(a.tip.includes('http://127.0.0.1:40001'), 'the operator can see where it went');
});

test('gave-up phase: offers a RETRY and says why it stopped', () => {
  // The cap's whole value is that it surfaces rather than retrying silently
  // forever, so the reason has to reach the UI.
  const a = webViewAffordance({
    status: online(WEB), tunnel: sshTunnel,
    webTunnel: { id: 'p1', state: 'gave-up', url: null, error: 'ssh: connect to host box port 22: No route to host' },
  });
  assert.equal(a.phase, 'gave-up');
  assert.equal(a.action, 'open', 'clicking tries again');
  assert.equal(a.enabled, true);
  assert.strictEqual(a.url, null);
  assert.match(a.tip, /No route to host/, 'the reason is shown, not swallowed');
});

test('gave-up with no error text still reads as a retry, not as a broken tip', () => {
  const a = webViewAffordance({
    status: online(WEB), tunnel: sshTunnel, webTunnel: { id: 'p1', state: 'gave-up', url: null },
  });
  assert.equal(a.action, 'open');
  assert.doesNotMatch(a.tip, /undefined|null|\(\)/, 'no placeholder text leaks into the UI');
});

// ── The ssh-only limitation, stated rather than hidden ───────────────────────

test('a URL-only peer gets a DISABLED button saying ssh-only — never a silent absence', () => {
  // Hiding it would read as "this box has no web UI", which is a different and
  // false claim: the box may well serve one, we just cannot tunnel to it.
  const a = webViewAffordance({ status: online(WEB), tunnel: null });
  assert.equal(a.show, true, 'the limitation is visible');
  assert.equal(a.enabled, false, 'but not clickable');
  assert.equal(a.action, null);
  assert.match(a.tip, /ssh/i, 'and it says why');
  assert.strictEqual(a.url, null);
});

test('an ssm peer gets the same ssh-only refusal, but the TRUE reason (t32)', () => {
  // Same answer as a URL peer (no button — the web view needs its own second
  // forward and only the ssh template can open one), but a different reason.
  // Telling this operator their box "is reached by URL" would be a false
  // explanation of a true limit, and would send them looking for a URL that
  // does not exist.
  const a = webViewAffordance({ status: online(WEB), tunnel: { id: 'p1', ssm: { target: 'i-0abc' } } });
  assert.equal(a.show, true);
  assert.equal(a.enabled, false);
  assert.match(a.tip, /SSM/i, 'names the transport it actually uses');
  assert.doesNotMatch(a.tip, /reached by URL/, 'and does not misdescribe it as a URL peer');
});

test('cloudTransportName names each transport, so no tip misdescribes a peer', () => {
  const { cloudTransportName } = require('../renderer/lib/peer-web-view');
  // Each kind checked non-null BEFORE matching: a kind missing from the table
  // returns null, and assert.match(null, …) throws a TypeError — which reads as
  // a broken test rather than as "this transport has no name".
  for (const [tunnel, re, what] of [
    [{ ssm: { target: 'i-0a' } }, /SSM/, 'ssm'],
    [{ kubectl: { target: 'svc/x' } }, /kubectl/, 'kubectl'],
    [{ gcloud: { instance: 'vm' } }, /IAP|GCP/, 'gcloud'],
    [{ az: { bastion: 'b' } }, /Azure/, 'az'],
  ]) {
    const name = cloudTransportName(tunnel);
    assert.ok(name, `${what} must have a name — an unnamed kind falls back to "URL" and misdescribes the peer`);
    assert.match(name, re);
  }
  // ssh and url peers have no cloud transport — the caller falls back to 'URL',
  // which is the true description for them and only for them.
  assert.strictEqual(cloudTransportName({ sshHost: 'box' }), null);
  assert.strictEqual(cloudTransportName(null), null);
});

test('a kubectl peer`s ssh-only tip names kubectl, not URL and not SSM', () => {
  const a = webViewAffordance({ status: online(WEB), tunnel: { id: 'p1', kubectl: { target: 'svc/x' } } });
  assert.equal(a.show, true);
  assert.equal(a.enabled, false);
  assert.match(a.tip, /kubectl/, 'the tip names kubectl, so the operator is not sent looking for a URL');
  assert.doesNotMatch(a.tip, /reached by URL/);
});

test('isSshPeer keys off the wire tunnel`s sshHost — the renderer never sees the peer record', () => {
  assert.equal(isSshPeer({ sshHost: 'box' }), true);
  assert.equal(isSshPeer({ id: 'p1' }), false, 'a tunnel row with no ssh host is not ssh');
  assert.equal(isSshPeer(null), false);
  assert.equal(isSshPeer(undefined), false);
});

// ── No web host reported ─────────────────────────────────────────────────────

test('a peer reporting no web frontend gets NO button at all', () => {
  // Distinct from the ssh-only case: there is genuinely nothing to offer, so an
  // affordance would be an invitation to a refusal.
  for (const status of [undefined, null, { id: 'p1', online: true }, { id: 'p1', online: true, webHost: null }]) {
    const a = webViewAffordance({ status, tunnel: sshTunnel });
    assert.equal(a.show, false, `${JSON.stringify(status)} → hidden`);
    assert.strictEqual(a.url, null);
  }
});

test('a peer that STOPS reporting a web host keeps its button while a tunnel is open', () => {
  // The one case where an absent webHost must still render: an open forward the
  // operator can no longer see is exactly the hole close #4 exists for, and
  // hiding its only close button would be the same bug in the UI.
  const a = webViewAffordance({
    status: { id: 'p1', label: 'box', online: true },      // hello no longer carries webHost
    tunnel: sshTunnel,
    webTunnel: { id: 'p1', state: 'up', url: 'http://127.0.0.1:40001' },
  });
  assert.equal(a.show, true, 'still visible');
  assert.equal(a.action, 'close', 'and closable');
});

// ── The token arm ────────────────────────────────────────────────────────────

test('a token-gated peer says the box REQUIRES a token, in every phase it can reach', () => {
  const gated = online(WEB_GATED);
  const closed = webViewAffordance({ status: gated, tunnel: sshTunnel });
  assert.equal(closed.tokenGated, true);
  assert.match(closed.tip, /token/i, 'said before you click');

  const up = webViewAffordance({
    status: gated, tunnel: sshTunnel,
    webTunnel: { id: 'p1', state: 'up', url: 'http://127.0.0.1:40001' },
  });
  assert.equal(up.tokenGated, true);
  assert.match(up.tip, /token/i, 'and said again once it is up');
  assert.ok(up.tip.includes('http://127.0.0.1:40001'), 'with the URL, since that is what the operator must use');
});

test('an UNGATED peer never mentions a token', () => {
  const a = webViewAffordance({ status: online(WEB), tunnel: sshTunnel });
  assert.equal(a.tokenGated, false);
  assert.doesNotMatch(a.tip, /token/i, 'no spurious warning on a box that needs none');
});

test('tokenGated is read as a strict fact — the SAME rule the pop decision uses', () => {
  // Three places read this field: peer-client normalizes the hello to a strict
  // boolean, peer-wiring decides the browser pop on `=== true`, and this leaf
  // writes the message. They must agree. If the leaf read truthy while the pop
  // read strict, a value like 'yes' would produce the worst combination — the UI
  // saying "needs a token" while main opened a browser at a 401.
  for (const val of [true]) {
    assert.strictEqual(webViewAffordance({ status: online({ port: 8080, tokenGated: val }), tunnel: sshTunnel }).tokenGated, true);
  }
  for (const val of [false, undefined, null, 'yes', 1, 0, {}]) {
    const a = webViewAffordance({ status: online({ port: 8080, tokenGated: val }), tunnel: sshTunnel });
    assert.strictEqual(a.tokenGated, false, `${JSON.stringify(val)} is not an explicit true`);
    assert.doesNotMatch(a.tip, /token/i, 'and no token message either');
  }
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('every result has the full shape, so the renderer never reads undefined', () => {
  const inputs = [
    {},
    { status: online(WEB), tunnel: sshTunnel },
    { status: online(WEB_GATED), tunnel: null },
    { status: online(WEB), tunnel: sshTunnel, webTunnel: { state: 'up', url: 'http://127.0.0.1:1234' } },
    { status: online(WEB), tunnel: sshTunnel, webTunnel: { state: 'gave-up', error: 'x' } },
  ];
  for (const input of inputs) {
    const a = webViewAffordance(input);
    for (const k of ['show', 'enabled', 'action', 'phase', 'tip', 'url', 'tokenGated']) {
      assert.ok(k in a, `${k} present for ${JSON.stringify(input)}`);
    }
    assert.equal(typeof a.show, 'boolean');
    assert.equal(typeof a.enabled, 'boolean');
    assert.equal(typeof a.tip, 'string');
    assert.ok(a.action === null || a.action === 'open' || a.action === 'close');
    assert.ok(a.url === null || /^http:\/\//.test(a.url));
  }
});

test('called with nothing at all it hides, rather than throwing into a repaint', () => {
  // renderPeers runs on every peer event; a throw here would take out the whole
  // sidebar repaint, not just this one button.
  const a = webViewAffordance();
  assert.equal(a.show, false);
  assert.strictEqual(a.url, null);
});
