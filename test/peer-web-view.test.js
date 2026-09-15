'use strict';
// peer-web-view.test.js — t30b: the pure decision behind the peer web-view (↗)
// affordance. peers-ui.js is DOM-bound and untested by the R1 rule, which is
// exactly why this leaf exists: everything that could be gotten wrong about
// WHEN the button shows, what it says, and whether a URL may be shown lives
// here, where it can be asserted.
//
// The rules it enforces:
//   • no TUNNEL url before there is a live one (t30) — the `url` field carries
//     only what the supervisor reports, and peer-tunnel's dead-peer sentinel
//     http://127.0.0.1:1 must never surface as a web link;
//   • a token-gated box is not a link (t30) — web-host answers a bare 401, so
//     the affordance says the box needs a token rather than promising a click;
//   • the route is TOLD, not inferred (t925) — `status.direct` decides which arm
//     a closed-phase peer takes, because the tunnel row it used to be read from
//     is seeded after the first repaint.
//
// Assert the TIP, not just `url`. The t925 bug composed a loopback address and
// put it in the tip while leaving `url` null, and every assertion here read
// `url` — so the operator saw a wrong address that no test could fail on.

const { test } = require('node:test');
const assert = require('node:assert');

const { webViewAffordance, tunnelPhase, isSshPeer } = require('../renderer/lib/peer-web-view');

const sshTunnel = { id: 'p1', sshHost: 'box', state: 'up', localPort: 40001 };
const online = (webHost) => ({ id: 'p1', label: 'box', host: 'box', online: true, webHost });
// A url-kind peer as main reports it: `direct` is the verdict resolvePeerUrls
// computed from destinationOf, not something the renderer works out. Its `url`
// is the peer's own wire address, which the direct arm recomposes.
const urlPeer = (webHost, url) => ({ ...online(webHost), url, direct: true });
const WEB = { port: 8080, tokenGated: false };
const WEB_GATED = { port: 8080, tokenGated: true };

// ── The URL rule ─────────────────────────────────────────────────────────────

test('SECURITY-adjacent: no tunnel URL is ever produced unless the tunnel is UP and reported one', () => {
  // The affordance is never allowed to assemble `http://127.0.0.1:${port}` from
  // a pinned-but-not-forwarded local port — a port that is reserved is not a
  // service. t923's direct address is not a local port and rides the tip.
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

// ── t923: the url-kind peer OPENS, and its tip carries the address ───────────

test('t923 PIN: a url-kind peer gets an ENABLED button whose tip names the composed address', () => {
  const a = webViewAffordance({
    status: urlPeer(WEB, 'https://box.example:7900'), tunnel: null,
  });
  assert.equal(a.show, true);
  assert.equal(a.enabled, true, 'the arrow refused BECAUSE there was no tunnel — the one case needing none');
  assert.equal(a.action, 'open');
  assert.match(a.tip, /https:\/\/box\.example:8080/, 'the peer\'s own host and its ADVERTISED port');
  assert.doesNotMatch(a.tip, /localhost|127\.0\.0\.1/,
    'never a loopback: a tip composed from localhost passes on the dev box and lies on the next one');
  assert.doesNotMatch(a.tip, /can only tunnel/i, 'and the refusal sentence is gone');
  assert.strictEqual(a.url, null,
    'and `url` still means only "a live forward reports this" — the direct address rides the tip');
});

test('t923: a url-kind peer whose OWN url is unreadable keeps the disabled button, never a hidden one', () => {
  for (const url of [undefined, null, '', 'not a url', 'ftp://box.example', '127.0.0.1:7900']) {
    const a = webViewAffordance({ status: urlPeer(WEB, url), tunnel: null });
    assert.equal(a.show, true,
      `${JSON.stringify(url)}: hiding it would read as "this box has no web UI", a different and false claim`);
    assert.equal(a.enabled, false, `${JSON.stringify(url)}: but there is no address to offer, so not clickable`);
    assert.equal(a.action, null);
    assert.doesNotMatch(a.tip, /undefined|null|http/, `${JSON.stringify(url)}: no half-composed address in the tip`);
  }
});

test('t923: a GATED url peer is still not a link — the tip says token and names the address to append it to', () => {
  const a = webViewAffordance({
    status: urlPeer(WEB_GATED, 'https://box.example'), tunnel: null,
  });
  assert.equal(a.tokenGated, true);
  assert.match(a.tip, /token/i, 'the gate is stated');
  assert.match(a.tip, /https:\/\/box\.example:8080/, 'with the address to append it to');
});

test('t36: a CLOUD peer gets a real, ENABLED button — the ssh-only refusal is gone', () => {
  // The operator-reported bug, at the renderer end. Between t30 and t36 an ssm
  // or kubectl peer landed in the url-only arm and got a disabled button whose
  // tip said "Clodex can only tunnel to a web UI over ssh" — true when written,
  // false one release later, and the reason a working peer looked broken. The
  // assertion that must fail if anyone restores the sshHost gate.
  for (const [tunnel, what] of [
    [{ id: 'p1', ssm: { target: 'i-0abc' } }, 'ssm'],
    [{ id: 'p1', kubectl: { target: 'svc/x' } }, 'kubectl'],
    [{ id: 'p1', gcloud: { instance: 'vm' } }, 'gcloud'],
    [{ id: 'p1', az: { bastion: 'b', resourceGroup: 'rg', target: '/s/x' } }, 'az'],
  ]) {
    const a = webViewAffordance({ status: online(WEB), tunnel });
    assert.equal(a.show, true, `${what}: shown`);
    assert.equal(a.enabled, true, `${what}: a peer whose wire tunnel Clodex dials can also be web-tunnelled`);
    assert.equal(a.action, 'open', `${what}: and clicking it opens`);
    assert.doesNotMatch(a.tip, /only tunnel to a web UI over ssh/i,
      `${what}: the sentence that outlived its premise must not come back`);
    assert.doesNotMatch(a.tip, /reached by URL/, `${what}: and it is not a URL peer`);
  }
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
  // ssh and url peers have no cloud transport — the caller says "over ssh" for
  // the first and "reached by URL" for the second.
  assert.strictEqual(cloudTransportName({ sshHost: 'box' }), null);
  assert.strictEqual(cloudTransportName(null), null);
});

test('every tip names the transport the operator is ACTUALLY getting', () => {
  // A kubectl peer told "Open box's web UI over ssh" is the same category of
  // false-but-plausible sentence t36 removed — it would send an operator to
  // debug ssh at a box they never reach over ssh.
  const kubectl = { id: 'p1', kubectl: { target: 'svc/x' } };
  const closed = webViewAffordance({ status: online(WEB), tunnel: kubectl });
  assert.match(closed.tip, /kubectl port-forward/, 'the open tip names kubectl');
  assert.doesNotMatch(closed.tip, /over ssh/, 'and never claims ssh');

  const connecting = webViewAffordance({
    status: online(WEB), tunnel: kubectl, webTunnel: { id: 'p1', state: 'down' },
  });
  assert.equal(connecting.phase, 'connecting');
  assert.match(connecting.tip, /kubectl port-forward/, 'the connecting tip too');
  assert.doesNotMatch(connecting.tip, /over ssh/);

  // And an ssh peer still says ssh — the phrase is per-transport, not removed.
  const ssh = webViewAffordance({ status: online(WEB), tunnel: { id: 'p1', sshHost: 'box' } });
  assert.match(ssh.tip, /over ssh/, 'an ssh peer is still described as ssh');
});

test('isSshPeer keys off the wire tunnel`s sshHost — the renderer never sees the peer record', () => {
  // Still the NARROW question (the deploy/setup flow is genuinely ssh-only:
  // it copies files and runs a shell, which a port-forward carries neither of).
  // The web-view route is `status.direct`, below — they must not be conflated.
  assert.equal(isSshPeer({ sshHost: 'box' }), true);
  assert.equal(isSshPeer({ id: 'p1' }), false, 'a tunnel row with no ssh host is not ssh');
  assert.equal(isSshPeer({ kubectl: { target: 'svc/x' } }), false, 'a cloud peer is not an ssh peer');
  assert.equal(isSshPeer(null), false);
  assert.equal(isSshPeer(undefined), false);
});

test('t925 PIN: before the tunnel rows are seeded, a forwardable peer keeps the TUNNEL tip — no loopback in it', () => {
  // The interleaving this exists for: peers-ui`s onPeerState calls renderPeers
  // immediately, while peerTunnels is seeded only by the later peerList reply.
  // So an ssh/cloud peer really does paint with `tunnel === undefined`, and
  // resolvePeerUrls has by then rewritten its status.url to the forward`s own
  // loopback address. Reading the missing row as "url peer" composed
  // http://127.0.0.1:<webHost.port> from it and offered an ENABLED button whose
  // tip said "no tunnel needed" — at a port on OUR machine that nothing binds.
  // `direct: false` is main`s verdict and the only thing this may turn on.
  for (const tunnel of [undefined, null]) {
    const a = webViewAffordance({
      status: { ...online(WEB), url: 'http://127.0.0.1:40001', direct: false }, tunnel,
    });
    const what = `tunnel=${JSON.stringify(tunnel)}`;
    assert.doesNotMatch(a.tip, /127\.0\.0\.1|localhost/,
      `${what}: the TIP is the surface the operator reads, and a.url being null hid this for a whole release`);
    assert.doesNotMatch(a.tip, /no tunnel needed/i, `${what}: a forward is exactly what this peer needs`);
    assert.match(a.tip, /over ssh/, `${what}: it falls to the ordinary open arm, which names the forward`);
    assert.strictEqual(a.url, null, `${what}: and still no url before a live forward reports one`);
  }
});

test('t925: `direct` is read as a strict fact — an absent or non-true value is never the direct route', () => {
  // A status from a main that predates the field, or a half-built fixture, must
  // fall to the tunnel arms rather than compose an address. The direct arm is
  // the one that PRODUCES a URL, so an ambiguous read has to land on the side
  // that produces none.
  for (const direct of [undefined, null, false, 0, '', 'true', 1, {}]) {
    const a = webViewAffordance({
      status: { ...online(WEB), url: 'https://box.example:7900', direct }, tunnel: null,
    });
    assert.doesNotMatch(a.tip, /box\.example:8080/,
      `direct=${JSON.stringify(direct)}: only a strict true routes direct`);
  }
  const yes = webViewAffordance({ status: urlPeer(WEB, 'https://box.example:7900'), tunnel: null });
  assert.match(yes.tip, /box\.example:8080/, 'and a strict true does');
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
