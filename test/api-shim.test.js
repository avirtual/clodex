'use strict';
// api-shim.test.js — exercises the browser transport's core wire protocol against
// the same api-contract table the host speaks (web-frontend Phase 3b). The shim
// is browser code, so we stub the minimum DOM/WebSocket surface it touches and
// drive the frames by hand. This covers the parts a browser can't be spun up for
// in CI: the contract-driven window.api surface, invoke request/reply, send
// framing (incl. the sole argmap wrapper), on-subscription fan-out, and the
// Buffer decode that mirrors the host's encodeBuffers. The in-page menu/dialog
// rendering is deliberately out of scope here (pure DOM, no protocol logic).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { API_CONTRACT } = require('../api-contract');

const SHIM = path.join(__dirname, '..', 'renderer', 'web', 'api-shim.js');

// A controllable WebSocket stand-in the shim will construct in start().
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  frames() { return this.sent; }
}
FakeWS.OPEN = 1;

// Minimal DOM: enough for the module's top-level pointer listeners and start()'s
// injectStyle + visibilitychange wiring. Nothing here needs to do real work.
function fakeNode() {
  return {
    className: '', textContent: '', innerHTML: '', value: '', placeholder: '',
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    contains() { return false; }, focus() {}, select() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}
function fakeDocument() {
  const head = fakeNode();
  const body = fakeNode();
  return {
    head, body,
    visibilityState: 'visible',
    createElement: () => fakeNode(),
    addEventListener() {}, removeEventListener() {},
  };
}

// Load the shim fresh with the browser globals it reads at module-eval time set.
function loadShim({ search = '?workspace=w1', hostname = 'localhost' } = {}) {
  const prev = {
    window: global.window, document: global.document, location: global.location, WebSocket: global.WebSocket,
  };
  global.window = {};
  global.document = fakeDocument();
  // `hostname` is where the browser thinks IT is, and the t445 rule reads it —
  // the default keeps every pre-t445 test in its original topology (a browser on
  // the engine's own machine), where no loopback link is suppressed.
  global.location = { search, protocol: 'http:', host: `${hostname}:7900`, hostname, reload() { global.location._reloaded = true; } };
  global.WebSocket = FakeWS;
  delete require.cache[require.resolve(SHIM)];
  const shim = require(SHIM);
  const restore = () => {
    delete require.cache[require.resolve(SHIM)];
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; }
  };
  return { shim, restore };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Bring a shim to the post-welcome steady state and hand back the live socket.
async function connected(opts) {
  const ctx = loadShim(opts);
  ctx.shim.start();
  const ws = FakeWS.last;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', appVersion: '9.9.9', home: '/home/tester' }) });
  await tick();
  return { ...ctx, ws };
}

test('window.api is built from the table with exactly the 165-method surface', async () => {
  const { shim, restore } = loadShim();
  try {
    shim.start();
    const names = Object.keys(global.window.api);
    assert.equal(names.length, API_CONTRACT.length, 'one method per contract row');
    assert.deepEqual(new Set(names), new Set(API_CONTRACT.map((r) => r.name)), 'names match the table');
    for (const n of names) assert.equal(typeof global.window.api[n], 'function', `${n} is a function`);
    // The browser-frontend marker the renderer degrades on (e.g. hiding the
    // file-peek Open button) must be set alongside window.api, before renderer.js runs.
    assert.equal(global.window.__CLODEX_WEB__, true, 'browser-frontend marker is set');
  } finally { restore(); }
});

test('hello frame carries token + workspace and rides on socket open', async () => {
  const { ws, restore } = await connected({ search: '?workspace=w1&token=sekret' });
  try {
    const hello = ws.frames().find((f) => f.t === 'hello');
    assert.ok(hello, 'a hello frame was sent');
    assert.equal(hello.workspaceId, 'w1');
    assert.equal(hello.token, 'sekret');
  } finally { restore(); }
});

test('invoke sends an id\'d request and resolves on the matching reply', async () => {
  const { ws, restore } = await connected();
  try {
    const p = global.window.api.listSessions();
    await tick();
    const inv = ws.frames().find((f) => f.t === 'invoke' && f.channel === 'session:list');
    assert.ok(inv, 'invoke frame sent on the mapped channel');
    assert.equal(typeof inv.id, 'number');
    assert.deepEqual(inv.args, [], 'no args for listSessions');
    ws.onmessage({ data: JSON.stringify({ t: 'reply', id: inv.id, ok: true, value: [{ name: 'a' }] }) });
    assert.deepEqual(await p, [{ name: 'a' }], 'promise resolves with the reply value');
  } finally { restore(); }
});

test('invoke rejects on an error reply', async () => {
  const { ws, restore } = await connected();
  try {
    const p = global.window.api.killSession('x');
    await tick();
    const inv = ws.frames().find((f) => f.t === 'invoke' && f.channel === 'session:kill');
    assert.deepEqual(inv.args, ['x']);
    ws.onmessage({ data: JSON.stringify({ t: 'reply', id: inv.id, ok: false, error: 'nope' }) });
    await assert.rejects(p, /nope/);
  } finally { restore(); }
});

test('send is fire-and-forget on the mapped channel; argmap wrapper is applied', async () => {
  const { ws, restore } = await connected();
  try {
    assert.equal(global.window.api.writeToSession('a', 'hi'), undefined, 'send returns undefined');
    const w = ws.frames().find((f) => f.t === 'send' && f.channel === 'pty-input');
    assert.deepEqual(w.args, ['a', 'hi'], 'passthrough send args');

    global.window.api.showSessionContextMenu('sess', '/cwd');
    const m = ws.frames().find((f) => f.t === 'send' && f.channel === 'session:context-menu');
    assert.deepEqual(m.args, [{ name: 'sess', cwd: '/cwd' }], 'argmap bundled the two args into one object');
  } finally { restore(); }
});

test('on subscribes and receives event args; Buffer envelopes decode to bytes', async () => {
  const { ws, restore } = await connected();
  try {
    const got = [];
    global.window.api.onPtyData((name, data) => got.push([name, data]));
    ws.onmessage({ data: JSON.stringify({ t: 'event', channel: 'pty-data', args: ['a', 'hello'] }) });
    assert.deepEqual(got.at(-1), ['a', 'hello'], 'plain string pty-data delivered as-is');

    const peer = [];
    global.window.api.onPeerData((id, name, data) => peer.push([id, name, data]));
    const b64 = Buffer.from('hi').toString('base64');
    ws.onmessage({ data: JSON.stringify({ t: 'event', channel: 'peer-data', args: ['p1', 'a', { $type: 'Buffer', b64 }] }) });
    const last = peer.at(-1);
    assert.deepEqual([last[0], last[1]], ['p1', 'a']);
    assert.ok(last[2] instanceof Uint8Array, 'Buffer envelope decoded to a Uint8Array');
    assert.deepEqual([...last[2]], [104, 105], 'bytes for "hi"');
  } finally { restore(); }
});

test('emit() routes a channel into local on-subscribers (drives the in-page menu)', async () => {
  const { shim, ws, restore } = await connected();
  try {
    const got = [];
    global.window.api.onRequestOpenAgentsDrawer((name) => got.push(name));
    shim.emit('request-open-agents-drawer', null);
    assert.deepEqual(got, [null], 'subscriber fired with the emitted args, no wire frame');
    assert.ok(!ws.frames().some((f) => f.channel === 'request-open-agents-drawer'), 'emit stays local — nothing sent to the host');
  } finally { restore(); }
});

test('rewriteExternalUrl: origin-matches proxyBase → swap to publicBase (keep path/query); else pass through', () => {
  const { shim, restore } = loadShim();
  try {
    const { rewriteExternalUrl } = shim;
    const proxy = 'http://127.0.0.1:7800';
    const pub = 'http://localhost:7811';
    // A dashboard link on the loopback proxyBase → rewritten to the published base,
    // path + query preserved verbatim.
    assert.equal(
      rewriteExternalUrl('http://127.0.0.1:7800/_timeline?session=abc', proxy, pub),
      'http://localhost:7811/_timeline?session=abc',
    );
    // A trailing slash on publicBase is normalized (no double slash).
    assert.equal(
      rewriteExternalUrl('http://127.0.0.1:7800/_session', proxy, 'http://localhost:7811/'),
      'http://localhost:7811/_session',
    );
    // A different origin (e.g. a GitHub release link) is untouched.
    assert.equal(
      rewriteExternalUrl('https://github.com/avirtual/clodex/releases', proxy, pub),
      'https://github.com/avirtual/clodex/releases',
    );
    // Missing proxyBase or publicBase → no rewrite (desktop / unconfigured web).
    assert.equal(rewriteExternalUrl('http://127.0.0.1:7800/x', '', pub), 'http://127.0.0.1:7800/x');
    assert.equal(rewriteExternalUrl('http://127.0.0.1:7800/x', proxy, ''), 'http://127.0.0.1:7800/x');
    // Unparseable url → returned as-is (never throws).
    assert.equal(rewriteExternalUrl('not a url', proxy, pub), 'not a url');
  } finally { restore(); }
});

test('open-external event rewrites a proxyBase dashboard url to the published base before window.open', async () => {
  const { shim, restore } = loadShim();
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    shim.start();
    const ws = FakeWS.last;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/h',
      proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: 'http://localhost:7811' }) });
    await tick();
    ws.onmessage({ data: JSON.stringify({ t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_timeline?s=1'] }) });
    assert.deepEqual(opened, ['http://localhost:7811/_timeline?s=1'], 'the loopback dashboard link is rewritten before opening');
  } finally { restore(); }
});

// ── t443: ?wirescope= — a LOCAL forward beats the box's own public base ──────
// When the viewer's Clodex opens this page through a peer web tunnel it also
// forwards the box's wirescope, and puts that local port on the page URL. That
// is the only channel into a tab the BOX served.

test('wirescopeBase: a ?wirescope= port wins over the welcome frame`s public base', () => {
  // Precedence, not merely presence: `wirescopePublicBase` is the BOX'S idea of
  // where it is publicly reachable, which is by construction not reachable from
  // a viewer on the far side of a tunnel — it is set for a browser on the box's
  // own host. The local forward is a port on THIS machine raised for THIS page,
  // so it is the only candidate known to resolve here.
  const { shim, restore } = loadShim({ search: '?workspace=w1&wirescope=45501' });
  try {
    assert.equal(shim.wirescopeBase({ wirescopePublicBase: 'http://localhost:7811' }),
      'http://127.0.0.1:45501', 'the local forward wins');
    assert.equal(shim.wirescopeBase({}), 'http://127.0.0.1:45501', 'and stands alone when the box offers nothing');
  } finally { restore(); }
});

test('wirescopeBase: with no param the box`s public base is still used — the compose case is untouched', () => {
  // The container flavor publishes wirescope on a host port and advertises it.
  // This ticket must not regress a viewer on the box's own host.
  const { shim, restore } = loadShim({ search: '?workspace=w1' });
  try {
    assert.equal(shim.wirescopeBase({ wirescopePublicBase: 'http://localhost:7811' }), 'http://localhost:7811');
    assert.equal(shim.wirescopeBase({}), '', 'and with neither, no base at all → rewriteExternalUrl passes through');
    assert.equal(shim.wirescopeBase(null), '', 'a welcome frame that never arrived is not a crash');
  } finally { restore(); }
});

test('SECURITY-adjacent: the param is a PORT, so it can only ever compose a 127.0.0.1 origin', () => {
  // The value reaches the page through a URL, which anything can write. Reading
  // it as a base would let a crafted link re-point every dashboard jump-out at
  // an arbitrary origin; reading it as a port bounds the damage to a loopback
  // port on the viewer's own machine. Each case below must fall back to the
  // box's base rather than being believed.
  for (const bad of ['http://evil.example', '0', '-1', '65536', '80.5', 'abc', '', '7800abc']) {
    const { shim, restore } = loadShim({ search: `?wirescope=${encodeURIComponent(bad)}` });
    try {
      assert.equal(shim.wirescopeBase({ wirescopePublicBase: 'http://localhost:7811' }), 'http://localhost:7811',
        `${JSON.stringify(bad)} is not a usable port → the local candidate is ignored`);
    } finally { restore(); }
  }
  // '7800abc' deserves its own note: parseInt would happily return 7800 from it.
  // The Number.isInteger guard on the PARSED value is what rejects it, and a
  // future refactor to `parseInt(...) || null` would silently accept it again.
  const { shim, restore } = loadShim({ search: '?wirescope=65535' });
  try {
    assert.equal(shim.wirescopeBase({}), 'http://127.0.0.1:65535', 'and the last valid port is not swept up');
  } finally { restore(); }
});

test('open-external through a forwarded wirescope opens the LOCAL port, end to end', async () => {
  // The whole chain in one assertion: the box serves this page, its renderer
  // builds a dashboard link against the box's own loopback proxyBase, and the
  // browser must be sent to the forward rather than to 127.0.0.1:7800 — which on
  // the viewer's machine is usually their OWN wirescope, answering with a
  // foreign session id.
  const { shim, restore } = loadShim({ search: '?workspace=w1&wirescope=45501' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    shim.start();
    const ws = FakeWS.last;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/h',
      proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: 'http://localhost:7811' }) });
    await tick();
    ws.onmessage({ data: JSON.stringify({ t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session?session=abc'] }) });
    assert.deepEqual(opened, ['http://127.0.0.1:45501/_session?session=abc'],
      'the link resolves through the forward, not through the box`s unreachable public base');
  } finally { restore(); }
});

test('a non-wirescope external link is untouched by the param', async () => {
  // The rewrite is origin-gated on proxyBase; a release link must not acquire a
  // loopback origin because a forward happens to exist.
  const { shim, restore } = loadShim({ search: '?wirescope=45501' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    shim.start();
    const ws = FakeWS.last;
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/h',
      proxyBase: 'http://127.0.0.1:7800' }) });
    await tick();
    ws.onmessage({ data: JSON.stringify({ t: 'event', channel: 'open-external', args: ['https://github.com/avirtual/clodex/releases'] }) });
    assert.deepEqual(opened, ['https://github.com/avirtual/clodex/releases']);
  } finally { restore(); }
});

test('the in-page menu/dialog/toast styles are theme-token-driven, not hardcoded dark (Chunk 4)', () => {
  // Source-level guard: the shim's injected stylesheet is a template literal, so
  // assert on the source text. The always-dark panel/accent hexes that made the
  // menus and modals ignore the theme must be gone, replaced by the same CSS
  // custom properties the desktop dialogs use.
  const src = fs.readFileSync(SHIM, 'utf8');
  const style = src.slice(src.indexOf('const STYLE = `'), src.indexOf('`;', src.indexOf('const STYLE = `')));

  for (const dead of ['#2b2b2b', '#222', '#1c1c1c', '#3a3a3a', '#3a6ea5', '#7db7ff', '#eee', '#444', '#555']) {
    assert.ok(!style.includes(dead), `hardcoded ${dead} was replaced by a theme token`);
  }
  for (const tok of ['var(--sidebar-bg)', 'var(--border)', 'var(--text)', 'var(--accent)', 'var(--input-bg,var(--active-bg))']) {
    assert.ok(style.includes(tok), `themed panels reference ${tok}`);
  }
  // The reconnect banner is the intentional exception — a theme-independent alarm.
  assert.ok(style.includes('#8a1c1c'), 'the connection-lost banner stays a fixed alarm red');
});

test('a second welcome (reconnect) reloads to re-run the restore flow', async () => {
  const { ws, restore } = await connected();
  try {
    assert.ok(!global.location._reloaded, 'first welcome does not reload');
    ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/home/tester' }) });
    assert.ok(global.location._reloaded, 'reconnect welcome triggers a reload');
  } finally { restore(); }
});

// ── appVersion (t28) ────────────────────────────────────────────────────────
// The browser has no About panel, so on a headless box the sidebar footer's
// version line is the only way to tell what is deployed — which makes it a
// fleet-operations fact rather than chrome. `web-dist/index.html` is tracked, so
// a git-deployed box gets a rebuilt bundle from a plain `git pull`, and this is
// how an operator confirms the pull took effect. It must therefore come off the
// WIRE: a version re-derived inside the bundle would only ever confirm itself.

test('appVersion reports the ENGINE version from the welcome frame', async () => {
  const { shim, restore } = await connected();
  try {
    assert.equal(shim.appVersion(), '9.9.9', 'the value the host sent, not anything client-side');
  } finally { restore(); }
});

test('appVersion is null before a welcome, and exposes nothing else from the frame', async () => {
  const { shim, restore } = loadShim();
  try {
    shim.start();
    assert.equal(shim.appVersion(), null, 'no version yet → say nothing rather than guess');
    // One field, not the frame. The welcome also carries the token-bearing proxy
    // reach, and a whole-frame getter would make every future field ambiently
    // readable by anything that can require the shim.
    assert.ok(!Object.keys(shim).some((k) => /welcome/i.test(k)), 'welcomeInfo is not exported');
  } finally { restore(); }
});

// ── t442: a wirescope link the browser cannot resolve must not be OFFERED.
// Only the container flavors set CLODEX_WIRESCOPE_PUBLIC_URL; the ssh installer
// never does, so publicBase is routinely empty. A proxyBase-origin url opened
// then resolves against the VIEWER's machine — usually its own wirescope on the
// same port — and renders a foreign sessionId. The gate lives in the shim, the
// one place that knows publicBase.

// Collect toast text without leaving the toast's 5s removal timer dangling: the
// stub is installed only around the synchronous dispatch, so `tick`'s real
// setTimeout is untouched.
function dispatchCapturingToasts(ws, frame) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = () => 0;
  try { ws.onmessage({ data: JSON.stringify(frame) }); } finally { global.setTimeout = realSetTimeout; }
}
function toastTexts(node, out = []) {
  for (const c of node.children || []) {
    // innerHTML too: a toast rendered as markup has an empty textContent, and
    // skipping it would make an "exactly one toast" count silently vacuous.
    const text = c.textContent || c.innerHTML;
    if (String(c.className).includes('clx-toast') && text) out.push(text);
    toastTexts(c, out);
  }
  return out;
}
async function welcomed(shim, { proxyBase, wirescopePublicBase }) {
  shim.start();
  const ws = FakeWS.last;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/h', proxyBase, wirescopePublicBase }) });
  await tick();
  return ws;
}

test('unreachableProxyUrl keys on origin-match AND an empty publicBase, never on publicBase alone', () => {
  const { shim, restore } = loadShim();
  try {
    const { unreachableProxyUrl } = shim;
    const proxy = 'http://127.0.0.1:7800';
    // The defect case: the box advertises no public base, so this url would
    // resolve against the viewer's own loopback.
    assert.equal(unreachableProxyUrl('http://127.0.0.1:7800/_session?session=abc', proxy, ''), true);
    assert.equal(unreachableProxyUrl('http://127.0.0.1:7800/_session', proxy, undefined), true);
    // A public base exists → rewritable, so not suppressed.
    assert.equal(unreachableProxyUrl('http://127.0.0.1:7800/_session', proxy, 'http://localhost:7811'), false);
    // The regression to guard: a foreign origin is NEVER suppressed, empty
    // publicBase or not. Gating on publicBase alone would swallow these.
    assert.equal(unreachableProxyUrl('https://github.com/avirtual/clodex/releases', proxy, ''), false);
    assert.equal(unreachableProxyUrl('https://example.com/x', proxy, ''), false);
    // A different loopback PORT is a different origin — not the box's proxy.
    assert.equal(unreachableProxyUrl('http://127.0.0.1:9999/x', proxy, ''), false);
    // Desktop / no proxyBase at all, and unparseable urls: nothing to suppress.
    assert.equal(unreachableProxyUrl('http://127.0.0.1:7800/x', '', ''), false);
    assert.equal(unreachableProxyUrl('not a url', proxy, ''), false);
    assert.equal(unreachableProxyUrl('', proxy, ''), false);
  } finally { restore(); }
});

test('open-external SUPPRESSES a proxyBase url when there is no public base, and says why', async () => {
  const { shim, restore } = loadShim();
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session?session=abc'] });
    assert.deepEqual(opened, [], 'the unresolvable wirescope link is not opened at all');
    const toasts = toastTexts(global.document.body);
    // ENTER: the suppressed click must SAY something — a silent no-op reads as a
    // broken button, which is what this assertion is really pinning.
    assert.equal(toasts.length, 1, `exactly one toast explains the suppression (got ${JSON.stringify(toasts)})`);
    assert.match(toasts[0], /wirescope/i);
    assert.match(toasts[0], /loopback|no route/i);
  } finally { restore(); }
});

test('open-external still opens a NON-proxyBase url untouched when there is no public base', async () => {
  const { shim, restore } = loadShim();
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['https://github.com/avirtual/clodex/releases'] });
    assert.deepEqual(opened, ['https://github.com/avirtual/clodex/releases'], 'a github link opens exactly as before');
    assert.deepEqual(toastTexts(global.document.body), [], 'and nothing is toasted at it');
  } finally { restore(); }
});

// ── t442 × t443: the two halves composed ─────────────────────────────────────
// t442 suppresses a dashboard link the browser cannot resolve; t443 makes one
// resolvable by forwarding the box's wirescope. They meet on a single line of
// dispatchEvent, and the failure mode of getting that meeting wrong is silent:
// if the GATE keeps reading the raw `wirescopePublicBase` while the REWRITE
// reads the forward, then a live forward is still judged unreachable and
// suppressed — each ticket works in isolation and together they do nothing.
// These pin the composition, not either half.

test('t442×t443: with a live forward the link is REWRITTEN and opened, never suppressed', async () => {
  // THE combination assertion. The box publishes no public base (the ssh
  // installer case t442 was written for), so t442 alone would suppress this
  // click. The forward makes it resolvable, so it must open — at the local port.
  const { shim, restore } = loadShim({ search: '?workspace=w1&wirescope=45501' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session?session=abc'] });
    assert.deepEqual(opened, ['http://127.0.0.1:45501/_session?session=abc'],
      'the forward resolves the link — suppressing it here would cancel t443 out entirely');
    assert.deepEqual(toastTexts(global.document.body), [],
      'and nothing is toasted: there is a route, so the "no route" message would be a lie');
  } finally { restore(); }
});

test('t442×t443: with NO forward and no public base, t442`s fail-safe still holds', async () => {
  // The other side of the same line. t443 must not have weakened the gate: with
  // neither candidate base, the link is still suppressed with its explanation.
  const { shim, restore } = loadShim({ search: '?workspace=w1' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session'] });
    assert.deepEqual(opened, [], 'still suppressed');
    assert.equal(toastTexts(global.document.body).length, 1, 'still explained');
  } finally { restore(); }
});

test('t442×t443: a REFUSED wirescope param falls back to suppression, not to a bad port', async () => {
  // The two rules meeting at their edges: a malformed param yields no local base,
  // and with no public base either the gate must catch the link. The failure this
  // rules out is a param that is bad enough to reject but still non-empty enough
  // to look like a route.
  for (const bad of ['0', '99999', 'abc', '7800abc', 'http://evil.example']) {
    const { shim, restore } = loadShim({ search: `?wirescope=${encodeURIComponent(bad)}` });
    try {
      const opened = [];
      global.window.open = (url) => { opened.push(url); };
      const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
      dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session'] });
      assert.deepEqual(opened, [], `${JSON.stringify(bad)}: suppressed rather than opened at a junk port`);
    } finally { restore(); }
  }
});

test('t442×t443: the forward also wins over a box-published base, and is not suppressed', async () => {
  // The compose case reached through a tunnel: the box DOES publish a base, but
  // it names a host only reachable from the box's own machine. The forward wins,
  // and the gate must not fire on either value.
  const { shim, restore } = loadShim({ search: '?wirescope=45501' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: 'http://localhost:7811' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_timeline?s=1'] });
    assert.deepEqual(opened, ['http://127.0.0.1:45501/_timeline?s=1'], 'the local forward wins');
    assert.deepEqual(toastTexts(global.document.body), []);
  } finally { restore(); }
});

test('STRUCTURAL: only wirescopeBase reads wirescopePublicBase, so the gate and the rewrite cannot diverge', () => {
  // A source-level guard, because the bug it prevents is invisible at runtime
  // until someone opens a tunnelled dashboard link: two readers of the same
  // welcome field drifting apart re-creates the "suppressed despite a live
  // forward" state, and every other test here would still pass. Pinning the
  // single-reader rule is what makes the composition structural rather than
  // merely correct today.
  const src = fs.readFileSync(SHIM, 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const readers = code.match(/wirescopePublicBase/g) || [];
  assert.equal(readers.length, 1,
    `wirescopePublicBase must be read in exactly one place (wirescopeBase); found ${readers.length}`);
  assert.match(code, /function wirescopeBase\(info\)[\s\S]{0,160}wirescopePublicBase/,
    'and that one place is wirescopeBase');
  // And dispatchEvent must feed ONE computed base to both consumers, rather than
  // calling wirescopeBase twice or passing different values.
  const dispatch = code.slice(code.indexOf('function dispatchEvent'), code.indexOf('function onMessage'));
  assert.match(dispatch, /const publicBase = wirescopeBase\(welcomeInfo\)/, 'the base is computed once');
  assert.match(dispatch, /unreachableProxyUrl\(args\[0\], proxyBase, publicBase\)/, 'the gate is fed it');
  assert.match(dispatch, /rewriteExternalUrl\(args\[0\], proxyBase, publicBase\)/, 'and so is the rewrite');
});

// ── t445: the broad loopback rule ────────────────────────────────────────────
// t442 asked a narrow question (is THIS wirescope link rewritable) and the audit
// that followed found the same defect at links it does not key on: the sandbox
// "open in browser" links compose `http://localhost:<webPort>` from a managed
// box's ports, sail past the proxy-origin match, and open the viewer's own
// machine. Rather than widen that key — settled, and its blind spot deliberate —
// the question is asked once about the BROWSER: a loopback url the engine
// composed is correct only when the browser runs on the engine's machine.

test('isLoopbackHost: the whole 127/8 block and ::1, and never a public name that merely looks local', () => {
  const { shim, restore } = loadShim();
  try {
    const { isLoopbackHost } = shim;
    for (const h of ['localhost', '127.0.0.1', '127.1.1.1', '127.255.255.254', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      assert.equal(isLoopbackHost(h), true, `${h} is loopback`);
    }
    // The regression a substring/suffix test would introduce: all of these are
    // ordinary public DNS names that an attacker can point anywhere, and treating
    // one as loopback would EXEMPT it from the rule rather than merely mislabel it.
    for (const h of ['127.0.0.1.evil.com', 'localhost.evil.com', 'notlocalhost', 'evil-127.0.0.1.com',
      'github.com', 'box.internal', '10.0.0.1', '0.0.0.0', '', null, undefined]) {
      assert.equal(isLoopbackHost(h), false, `${JSON.stringify(h)} is NOT loopback`);
    }
  } finally { restore(); }
});

test('refuseExternalUrl: loopback is refused only OFF the engine host; public links always open', () => {
  const { shim, restore } = loadShim();
  try {
    const { refuseExternalUrl } = shim;
    const box = 'http://localhost:7810';         // sandbox "open in browser" (finding 1 + 2)
    // Off the engine's machine: the defect case. This is the url both findings compose.
    assert.equal(refuseExternalUrl(box, false), true);
    assert.equal(refuseExternalUrl('http://127.0.0.1:9222/x', false), true);
    // ON the engine's machine every one of them is correct and must still open —
    // the trap in this rule is breaking the case that genuinely works.
    assert.equal(refuseExternalUrl(box, true), false);
    assert.equal(refuseExternalUrl('http://127.0.0.1:9222/x', true), false);
    // Public links are never touched, on either side.
    for (const on of [true, false]) {
      assert.equal(refuseExternalUrl('https://github.com/avirtual/clodex/releases', on), false);
      assert.equal(refuseExternalUrl('https://example.com/x', on), false);
    }
    // The scheme-less proxyUrl blind spot named in the ticket: `new URL` throws on
    // it, so the ORIGIN-matching gate cannot see it and passes it through — and
    // window.open would then resolve it RELATIVE to the box's own page. Refusing
    // what cannot be parsed is what closes that, and it is why the predicate
    // refuses rather than ignores on a parse failure.
    assert.equal(refuseExternalUrl('127.0.0.1:7800/_session', true), true);
    assert.equal(refuseExternalUrl('not a url', true), true);
    assert.equal(refuseExternalUrl('', true), true);
    // Non-http schemes never ride this channel.
    assert.equal(refuseExternalUrl('file:///etc/passwd', true), true);
    assert.equal(refuseExternalUrl('javascript:alert(1)', true), true);
  } finally { restore(); }
});

test('browserSharesEngineHost: a tunnelled tab is loopback-served and still NOT on the engine host', () => {
  // The distinction the whole rule rests on, and the reason page origin alone
  // cannot carry it: both tabs below are served from a loopback origin, and they
  // need OPPOSITE answers. Without the mark the tunnelled case — the one this
  // ticket was filed about — reads as "on the box" and nothing is suppressed.
  {
    const { shim, restore } = loadShim({ hostname: 'localhost', search: '?workspace=w1' });
    try { assert.equal(shim.browserSharesEngineHost(), true, 'a tab opened ON the box'); } finally { restore(); }
  }
  {
    const { shim, restore } = loadShim({ hostname: '127.0.0.1', search: '?workspace=w1&wirescope=45501&via=tunnel' });
    try { assert.equal(shim.browserSharesEngineHost(), false, 'the same origin, but tunnelled'); } finally { restore(); }
  }
  {
    // A box reached by its real address: not loopback, so no mark is needed.
    const { shim, restore } = loadShim({ hostname: 'box.internal', search: '?workspace=w1' });
    try { assert.equal(shim.browserSharesEngineHost(), false, 'a remote viewer'); } finally { restore(); }
  }
});

test('t445 finding 1+2: the sandbox open-in-browser link is SUPPRESSED with a reason on a tunnelled tab', async () => {
  // End to end at the exact url `sandbox-view.js openUrl` composes. t442's gate
  // keys on the proxy origin, so this url is invisible to it — before this rule
  // it opened `localhost:7810` on the VIEWER's machine, which is a plausible port
  // for a box that viewer also runs: a real-looking Clodex UI that is the wrong
  // one. Note the proxyBase here is configured and rewritable, so this is not
  // the t442 case wearing a different hat.
  const { shim, restore } = loadShim({ hostname: '127.0.0.1', search: '?workspace=w1&via=tunnel' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://localhost:7810'] });
    assert.deepEqual(opened, [], 'the box-loopback link is not opened on the viewer`s machine');
    const toasts = toastTexts(global.document.body);
    // ENTER: a suppressed link that says nothing reads as a dead button, which is
    // the failure mode this assertion exists for rather than the suppression.
    assert.equal(toasts.length, 1, `exactly one toast explains it (got ${JSON.stringify(toasts)})`);
    assert.match(toasts[0], /can't reach|cannot reach/i);
    assert.match(toasts[0], /localhost:7810/, 'and names the url, so the operator can still paste it');
  } finally { restore(); }
});

test('t445: the SAME link on a tab served to the box`s own browser opens untouched', async () => {
  // The rule's whole cost is here. On the box this url is simply correct, and a
  // rule that suppressed it would break the ordinary local sandbox workflow to
  // fix a remote one.
  const { shim, restore } = loadShim({ hostname: 'localhost', search: '?workspace=w1' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: '', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://localhost:7810'] });
    assert.deepEqual(opened, ['http://localhost:7810'], 'opened exactly as before');
    assert.deepEqual(toastTexts(global.document.body), [], 'and nothing is said about it');
  } finally { restore(); }
});

test('t445 THE TRAP: a forwarded wirescope link is loopback on the VIEWER`s machine and must still open', async () => {
  // The one loopback url that genuinely works from a tunnelled tab: t443's
  // forward is a port on THIS machine raised for THIS page. A naive "block all
  // loopback" rule kills it — and would silently undo t443 while every t443 test
  // still passed, because those load the shim without a tunnel mark. This is the
  // assertion that makes the broad rule safe to hold.
  const { shim, restore } = loadShim({ hostname: '127.0.0.1', search: '?workspace=w1&wirescope=45501&via=tunnel' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session?session=abc'] });
    assert.deepEqual(opened, ['http://127.0.0.1:45501/_session?session=abc'],
      'the rewrite`s target is exempt — re-judging it here would re-suppress what t443 fixed');
    assert.deepEqual(toastTexts(global.document.body), []);
  } finally { restore(); }
});

test('t445: github and release links are untouched on a tunnelled tab', async () => {
  // The preserve-list from the ticket. A rule this broad is one careless
  // predicate away from swallowing every external link in the app.
  const { shim, restore } = loadShim({ hostname: '127.0.0.1', search: '?workspace=w1&via=tunnel' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    for (const u of ['https://github.com/avirtual/clodex', 'https://github.com/avirtual/clodex/releases/tag/v5.13.0']) {
      dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: [u] });
    }
    assert.deepEqual(opened, ['https://github.com/avirtual/clodex', 'https://github.com/avirtual/clodex/releases/tag/v5.13.0']);
    assert.deepEqual(toastTexts(global.document.body), [], 'and none of them is toasted at');
  } finally { restore(); }
});

test('t445: t442`s narrow gate still owns the unrewritable dashboard link, with ITS message', async () => {
  // Both rules can fire on one url, and they must not race: t442 speaks first and
  // says the specific true thing (the dashboard has no route), rather than the
  // broad rule's generic sentence. A single toast, and it is t442's.
  const { shim, restore } = loadShim({ hostname: '127.0.0.1', search: '?workspace=w1&via=tunnel' });
  try {
    const opened = [];
    global.window.open = (url) => { opened.push(url); };
    const ws = await welcomed(shim, { proxyBase: 'http://127.0.0.1:7800', wirescopePublicBase: '' });
    dispatchCapturingToasts(ws, { t: 'event', channel: 'open-external', args: ['http://127.0.0.1:7800/_session'] });
    assert.deepEqual(opened, []);
    const toasts = toastTexts(global.document.body);
    assert.equal(toasts.length, 1, 'one explanation, not two');
    assert.match(toasts[0], /wirescope/i, 'and it is the specific one');
  } finally { restore(); }
});

test('t445 STRUCTURAL: the sandbox open-in-browser anchor carries no href to click around the gate', () => {
  // The gate lives on the openExternal fan, so a live `href` on that anchor is a
  // path straight past it: cmd-click and middle-click never reach the click
  // handler. This is a source guard because the failure is invisible to every
  // test above — they all dispatch through the fan, which is exactly what a
  // modifier-click does not do.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(!/sbOpenLink\.href\s*=/.test(src),
    'sbOpenLink.href must not be assigned — route the url through openExternal instead');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const anchor = (html.match(/<a id="sandbox-open-link"[^>]*>/) || [''])[0];
  assert.ok(anchor, 'the anchor still exists');
  assert.ok(!/href="http/.test(anchor), `no live href in the markup either (got ${anchor})`);
});
