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
function loadShim({ search = '?workspace=w1' } = {}) {
  const prev = {
    window: global.window, document: global.document, location: global.location, WebSocket: global.WebSocket,
  };
  global.window = {};
  global.document = fakeDocument();
  global.location = { search, protocol: 'http:', host: 'localhost:7900', reload() { global.location._reloaded = true; } };
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
