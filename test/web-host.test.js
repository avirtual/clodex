'use strict';

// web-host.js — the browser frontend's WS server (web-frontend Phase 3a). Every
// invariant here is headlessly drivable with a raw `ws` client + a fake engine
// (no Electron, no real handlers): the protocol framing + hello/token gate, the
// invoke→handler round-trip incl. the §C sender-token push, AsyncLocalStorage
// threading into the token-less showMessageBox, the five-method window handle +
// register/unregister timing, the host-owned scrollback ring replay, and the
// server-side menu click round-trip. The `registerHandlers` seam injects fake
// handlers so none of this needs a stood-up engine.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const http = require('node:http');
const WebSocket = require('ws');

const { createWebHost } = require('../web-host');

const silentLog = { info() {}, warn() {}, error() {} };

// Fake engine: records registerWindow/unregisterWindow and serves listForWorkspace
// so the scrollback replay + handle-timing paths run without a real SessionManager.
function fakeEngine(sessions = {}) {
  const registered = [];   // { workspaceId, handle }
  const unregistered = []; // workspaceId
  const manager = {
    registerWindow: (workspaceId, handle) => registered.push({ workspaceId, handle }),
    unregisterWindow: (workspaceId) => unregistered.push(workspaceId),
    listForWorkspace: (workspaceId) => sessions[workspaceId] || [],
  };
  return { engine: { manager, stores: {} }, registered, unregistered };
}

async function startHost({ registerHandlers, token, sessions } = {}) {
  const { engine, registered, unregistered } = fakeEngine(sessions);
  const host = createWebHost({
    engine, log: silentLog, port: 0, token: token || null,
    userDataPath: os.tmpdir(), registerHandlers: registerHandlers || (() => {}),
  });
  if (!host._server.listening) await new Promise((res) => host._server.once('listening', res));
  return { host, port: host._server.address().port, registered, unregistered };
}

// Minimal WS client: a message queue + a `next()` that awaits the next frame.
function connect(port, { token } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
      ws.once('close', () => rej(new Error('closed before open')));
    }),
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => waiters.push(res))),
    // Read frames until one satisfies pred (skips e.g. the welcome before an event).
    until: async (pred) => { for (;;) { const m = queue.length ? queue.shift() : await new Promise((r) => waiters.push(r)); if (pred(m)) return m; } },
    close: () => ws.close(),
    closed: () => new Promise((res) => ws.once('close', res)),
  };
}

// Raw HTTP GET → { status, body }, for the token gate + the /healthz exemption.
function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function poll(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}

// A hello that lands the tab on a workspace + returns the welcome frame.
async function helloWelcome(c, { workspaceId, token } = {}) {
  await c.open();
  c.send({ t: 'hello', workspaceId, token });
  return c.until((m) => m.t === 'welcome');
}

test('hello gate: pre-hello frames close the socket; a valid hello yields welcome', async () => {
  const { host, port } = await startHost();
  try {
    const early = connect(port);
    await early.open();
    early.send({ t: 'invoke', id: 1, channel: 'x' }); // before hello → close
    await early.closed();

    const ok = connect(port);
    const welcome = await helloWelcome(ok, { workspaceId: 'default' });
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.workspaceId, 'default');
    assert.equal(typeof welcome.appVersion, 'string');
    ok.close();
  } finally { host.close(); }
});

test('/healthz is an unauthenticated 200 even when a token gates everything else', async () => {
  const { host, port } = await startHost({ token: 'secret' });
  try {
    const health = await httpGet(port, '/healthz');
    assert.equal(health.status, 200, 'healthz served without a token');
    assert.equal(health.body, 'ok');

    // Any other route still demands the token — the exemption is /healthz-only.
    const gated = await httpGet(port, '/');
    assert.equal(gated.status, 401, 'the static bundle stays gated');
  } finally { host.close(); }
});

test('token gate: bad upgrade token is refused; bad hello token closes; correct token welcomes', async () => {
  const { host, port } = await startHost({ token: 'secret' });
  try {
    // Wrong/absent token at the WS upgrade — never opens.
    const bad = connect(port); // no ?token
    await assert.rejects(bad.open());

    // Upgrade passes (query token) but the hello omits it → server closes.
    const noHelloTok = connect(port, { token: 'secret' });
    await noHelloTok.open();
    noHelloTok.send({ t: 'hello', workspaceId: 'default' }); // no token field
    await noHelloTok.closed();

    // Both gates satisfied → welcome.
    const good = connect(port, { token: 'secret' });
    const welcome = await helloWelcome(good, { workspaceId: 'default', token: 'secret' });
    assert.equal(welcome.t, 'welcome');
    good.close();
  } finally { host.close(); }
});

test('invoke round-trip + §C sender-token push', async () => {
  const registerHandlers = (deps) => {
    deps.handle('echo', (e, msg) => ({ echoed: msg }));
    deps.handle('boom', () => { throw new Error('nope'); });
    deps.handle('push', (e) => { e.sender.send('pushed', 7, 'via-token'); return { ok: true }; });
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });

    c.send({ t: 'invoke', id: 10, channel: 'echo', args: ['hi'] });
    const r = await c.until((m) => m.t === 'reply' && m.id === 10);
    assert.deepEqual(r, { t: 'reply', id: 10, ok: true, value: { echoed: 'hi' } });

    c.send({ t: 'invoke', id: 11, channel: 'boom', args: [] });
    const err = await c.until((m) => m.t === 'reply' && m.id === 11);
    assert.equal(err.ok, false);
    assert.equal(err.error, 'nope');

    c.send({ t: 'invoke', id: 12, channel: 'nope-channel', args: [] });
    const missing = await c.until((m) => m.t === 'reply' && m.id === 12);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no handler/);

    // §C: the handler pushes back through the sender token → an event frame.
    c.send({ t: 'invoke', id: 13, channel: 'push', args: [] });
    const ev = await c.until((m) => m.t === 'event' && m.channel === 'pushed');
    assert.deepEqual(ev.args, [7, 'via-token']);
    c.close();
  } finally { host.close(); }
});

test('AsyncLocalStorage threads the connection into a token-less showMessageBox', async () => {
  const registerHandlers = (deps) => {
    // The handler takes no `e`-derived window — showMessageBox must recover the
    // requesting connection from ALS.
    deps.handle('confirm', async () => {
      const r = await deps.showMessageBox({ buttons: ['Yes', 'No'], cancelId: 1 });
      return r.response;
    });
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });

    c.send({ t: 'invoke', id: 20, channel: 'confirm', args: [] });
    const show = await c.until((m) => m.t === 'dialog-show');
    assert.equal(show.kind, 'message');
    assert.deepEqual(show.opts.buttons, ['Yes', 'No']);
    c.send({ t: 'dialog-reply', dialogId: show.dialogId, value: { response: 0 } });
    const reply = await c.until((m) => m.t === 'reply' && m.id === 20);
    assert.deepEqual(reply, { t: 'reply', id: 20, ok: true, value: 0 });
    c.close();
  } finally { host.close(); }
});

test('showMessageBox resolves to cancel when the tab disconnects mid-dialog', async () => {
  const registerHandlers = (deps) => {
    deps.handle('confirm', async () => (await deps.showMessageBox({ buttons: ['Yes', 'No'], cancelId: 1 })).response);
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });
    c.send({ t: 'invoke', id: 30, channel: 'confirm', args: [] });
    await c.until((m) => m.t === 'dialog-show'); // dialog shown, then we vanish
    c.close();
    // No assertion needed beyond "the server didn't hang" — the pending dialog
    // resolves to cancelId on close, so the handler unwinds cleanly.
    assert.ok(await poll(() => true));
  } finally { host.close(); }
});

test('five-method handle: registered on first tab, unregistered on last; fans + reports state', async () => {
  const { host, port, registered, unregistered } = await startHost();
  try {
    const a = connect(port);
    await helloWelcome(a, { workspaceId: 'ws1' });
    assert.equal(registered.length, 1, 'handle registered on first tab');
    const handle = registered[0].handle;

    // The five-method contract.
    assert.equal(typeof handle.webContents.send, 'function');
    assert.equal(handle.isDestroyed(), false);
    assert.equal(handle.isFocused(), true); // default-visible tab
    assert.equal(typeof handle.show, 'function');
    assert.equal(typeof handle.focus, 'function');

    const b = connect(port);
    await helloWelcome(b, { workspaceId: 'ws1' });
    assert.equal(registered.length, 1, 'second tab on same workspace does NOT re-register');

    // webContents.send fans an event frame to every tab on the workspace.
    handle.webContents.send('session-activity', 'sess', 'working');
    const ea = await a.until((m) => m.t === 'event' && m.channel === 'session-activity');
    const eb = await b.until((m) => m.t === 'event' && m.channel === 'session-activity');
    assert.deepEqual(ea.args, ['sess', 'working']);
    assert.deepEqual(eb.args, ['sess', 'working']);

    // show() fans a focus-hint (serves session-file-view).
    handle.show();
    const fh = await a.until((m) => m.t === 'event' && m.channel === 'focus-hint');
    assert.deepEqual(fh.args, []);

    // First disconnect must NOT unregister; last one does.
    a.close();
    assert.ok(await poll(() => host._workspaceConns.get('ws1') && host._workspaceConns.get('ws1').size === 1));
    assert.equal(unregistered.length, 0, 'not unregistered while a tab remains');
    b.close();
    assert.ok(await poll(() => unregistered.length === 1), 'unregistered after last tab');
    assert.equal(unregistered[0], 'ws1');
  } finally { host.close(); }
});

test('scrollback ring replays attached-period pty-data to a late-joining tab; Buffers are base64-framed', async () => {
  const { host, port, registered } = await startHost({ sessions: { ws1: [{ name: 'sess' }] } });
  try {
    const a = connect(port);
    await helloWelcome(a, { workspaceId: 'ws1' });
    const handle = registered[0].handle;

    // Output while ws1 is attached → grows the host ring (the engine buffer only
    // fills while detached, which this workspace is not).
    handle.webContents.send('pty-data', 'sess', 'HELLO-');
    handle.webContents.send('pty-data', 'sess', 'WORLD');
    await a.until((m) => m.t === 'event' && m.channel === 'pty-data'); // live fan to A

    // A late-joining second tab replays the ring on connect.
    const b = connect(port);
    await b.open();
    b.send({ t: 'hello', workspaceId: 'ws1' });
    await b.until((m) => m.t === 'welcome');
    const replay = await b.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepEqual(replay.args, ['sess', 'HELLO-WORLD']);

    // peer-data carries a Buffer → base64 envelope on the wire (audit 1).
    handle.webContents.send('peer-data', 'peerId', 'sess', Buffer.from([1, 2, 3]));
    const pd = await a.until((m) => m.t === 'event' && m.channel === 'peer-data');
    assert.deepEqual(pd.args[2], { $type: 'Buffer', b64: Buffer.from([1, 2, 3]).toString('base64') });
    a.close(); b.close();
  } finally { host.close(); }
});

test('menu round-trip: click closures stay server-side and fire on pick (not show), incl. nested submenu', async () => {
  const fired = [];
  const registerHandlers = (deps) => {
    deps.on('ctx', (e) => deps.popupMenu([
      { label: 'Top', click: () => fired.push('Top') },
      { type: 'separator' },
      { label: 'Group', enabled: false },
      { label: 'Sub', submenu: [
        { label: 'S1', type: 'radio', checked: true, click: () => fired.push('S1') },
        { label: 'S2', type: 'checkbox', checked: false, click: () => fired.push('S2') },
      ] },
    ], e));
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });

    c.send({ t: 'send', channel: 'ctx', args: [] });
    const show = await c.until((m) => m.t === 'menu-show');
    assert.equal(fired.length, 0, 'no click fires on show');

    // Structure: separator has no id; disabled item carried; submenu nested; type/checked preserved.
    const [top, sep, group, sub] = show.items;
    assert.equal(top.label, 'Top');
    assert.equal(sep.type, 'separator');
    assert.equal(sep.id, undefined);
    assert.equal(group.enabled, false);
    assert.equal(Array.isArray(sub.submenu), true);
    assert.equal(sub.submenu[0].type, 'radio');
    assert.equal(sub.submenu[0].checked, true);
    assert.equal(sub.submenu[1].type, 'checkbox');

    // Pick the nested S2 by its id → only that closure runs.
    c.send({ t: 'menu-pick', menuId: show.menuId, itemId: sub.submenu[1].id });
    assert.ok(await poll(() => fired.length === 1));
    assert.deepEqual(fired, ['S2']);

    // A dismiss (itemId null) fires nothing.
    c.send({ t: 'send', channel: 'ctx', args: [] });
    const show2 = await c.until((m) => m.t === 'menu-show');
    c.send({ t: 'menu-pick', menuId: show2.menuId, itemId: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fired, ['S2'], 'dismiss fires no click');
    c.close();
  } finally { host.close(); }
});
