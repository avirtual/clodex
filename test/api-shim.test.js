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

test('a second welcome (reconnect) reloads to re-run the restore flow', async () => {
  const { ws, restore } = await connected();
  try {
    assert.ok(!global.location._reloaded, 'first welcome does not reload');
    ws.onmessage({ data: JSON.stringify({ t: 'welcome', workspaceId: 'w1', home: '/home/tester' }) });
    assert.ok(global.location._reloaded, 'reconnect welcome triggers a reload');
  } finally { restore(); }
});
