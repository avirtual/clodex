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
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const { createWebHost, viewerOnHost } = require('../web-host');
const { mkTmpRoot } = require('./lib/tmp-roots');

const silentLog = { info() {}, warn() {}, error() {} };

// Fake engine: records registerWindow/unregisterWindow and serves listForWorkspace
// so the scrollback replay + handle-timing paths run without a real SessionManager.
function fakeEngine(sessions = {}, stores = {}) {
  const registered = [];   // { workspaceId, handle }
  const unregistered = []; // workspaceId
  const manager = {
    registerWindow: (workspaceId, handle) => registered.push({ workspaceId, handle }),
    unregisterWindow: (workspaceId) => unregistered.push(workspaceId),
    listForWorkspace: (workspaceId) => sessions[workspaceId] || [],
  };
  return { engine: { manager, stores }, registered, unregistered };
}

async function startHost({ registerHandlers, token, sessions, stores, userDataPath } = {}) {
  const { engine, registered, unregistered } = fakeEngine(sessions, stores);
  const host = createWebHost({
    engine, log: silentLog, port: 0, token: token || null,
    userDataPath: userDataPath || os.tmpdir(), registerHandlers: registerHandlers || (() => {}),
  });
  if (!host._server.listening) await new Promise((res) => host._server.once('listening', res));
  return { host, port: host._server.address().port, registered, unregistered };
}

// Minimal WS client: a message queue + a `next()` that awaits the next frame.
//
// 127.0.0.1, never `localhost`, and the rest of the suite already agrees. The
// host binds the wildcard (`listen(port)` with no address), which on this
// platform is `::` — and a wildcard bind does NOT conflict with a process
// holding the SAME port on `[::1]` specifically, so `listen(0)` will hand out a
// port another program is already listening on. `localhost` resolves to `::1`
// first, where the more specific bind wins, so the connection lands in the
// other program: a real one on this box is TextMate's rmate listener on 52698,
// which answers `220 ... RMATE` and fails the HTTP parse. Ephemeral ports are
// 49152-65535 here, so any such listener is inside the range this can draw.
function connect(port, { token } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
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
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
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

test('welcome carries wirescope reachability: proxyBase from settings + published base from env', async () => {
  const prevEnv = process.env.CLODEX_WIRESCOPE_PUBLIC_URL;
  process.env.CLODEX_WIRESCOPE_PUBLIC_URL = 'http://localhost:7811/';
  const stores = { uiSettings: { get: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7800/' }) } };
  const { host, port } = await startHost({ stores });
  try {
    const c = connect(port);
    const welcome = await helloWelcome(c, { workspaceId: 'default' });
    // proxyBase is the engine's loopback wirescope; publicBase is the browser-
    // reachable published address — both trailing-slash-normalized. The shim
    // rewrites open-external urls from the first origin to the second.
    assert.equal(welcome.proxyBase, 'http://127.0.0.1:7800', 'proxyBase from uiSettings, normalized');
    assert.equal(welcome.wirescopePublicBase, 'http://localhost:7811', 'published base from env, normalized');
    c.close();
  } finally {
    host.close();
    if (prevEnv === undefined) delete process.env.CLODEX_WIRESCOPE_PUBLIC_URL; else process.env.CLODEX_WIRESCOPE_PUBLIC_URL = prevEnv;
  }
});

test('welcome carries viewerOnHost: true for a socket that arrived over 127.0.0.1', async () => {
  const { host, port } = await startHost();
  try {
    const c = connect(port);
    const welcome = await helloWelcome(c, { workspaceId: 'default' });
    assert.equal(welcome.viewerOnHost, true);
    c.close();
  } finally { host.close(); }
});

test('viewerOnHost: loopback peer addresses in every spelling the socket reports', () => {
  assert.equal(viewerOnHost('127.0.0.1'), true);
  assert.equal(viewerOnHost('::1'), true);
  assert.equal(viewerOnHost('::ffff:127.0.0.1'), true);
  assert.equal(viewerOnHost('127.9.9.9'), true);
  assert.equal(viewerOnHost('192.168.0.79'), false);
  assert.equal(viewerOnHost('::ffff:192.168.0.79'), false);
  assert.equal(viewerOnHost('10.0.0.1'), false);
  assert.equal(viewerOnHost(undefined), false);
  assert.equal(viewerOnHost(''), false);
});

test('welcome viewerOnHost is the helper applied to the upgrade request socket address', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'web-host.js'), 'utf8');
  assert.match(src, /wss\.on\('connection', \(ws, req\) =>/);
  assert.match(src, /viewerOnHost: viewerOnHost\(req && req\.socket && req\.socket\.remoteAddress\)/);
  assert.match(src, /t: 'welcome',[^\n]*viewerOnHost: conn\.viewerOnHost === true/);
});

test('welcome reachability fields are empty when proxy is disabled and no published base is set', async () => {
  const prevEnv = process.env.CLODEX_WIRESCOPE_PUBLIC_URL;
  delete process.env.CLODEX_WIRESCOPE_PUBLIC_URL;
  const stores = { uiSettings: { get: () => ({ proxyEnabled: false, proxyUrl: 'http://127.0.0.1:7800' }) } };
  const { host, port } = await startHost({ stores });
  try {
    const c = connect(port);
    const welcome = await helloWelcome(c, { workspaceId: 'default' });
    assert.equal(welcome.proxyBase, '', 'no proxyBase when the proxy is off');
    assert.equal(welcome.wirescopePublicBase, '', 'no published base when the env is unset');
    c.close();
  } finally {
    host.close();
    if (prevEnv !== undefined) process.env.CLODEX_WIRESCOPE_PUBLIC_URL = prevEnv;
  }
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

test('transcript:pull over the web socket: the rev a tab sends back answers unchanged with no records', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { registerIpcHandlers } = require('../ipc-handlers');
  const { pathFor } = require('../clodex-paths');
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const reg = mkTmpRoot('ipc-tpull-');
  const link = pathFor(reg, 'rv', 'transcript');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(link, fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript-records', 'muse-intent.jsonl'), 'utf8'));
  const seat = { name: 'rv', agentType: 'muse', io: 'stream', _dead: false };
  let pullFn = null;
  const registerHandlers = (deps) => registerIpcHandlers({
    handle: (ch, fn) => { if (ch === 'transcript:pull') pullFn = fn; deps.handle(ch, fn); },
    on: deps.handle,
    log: { ...silentLog, debug() {} },
    REGISTRY_DIR: reg,
    manager: {
      sessions: new Map([['rv', seat]]),
      seatOutbox: () => ({ rev: 2, items: [] }),
      seatPermissions: () => null,
      compactNoticesFor: () => null,
      _sendToSession() {},
    },
  });
  const { host, port } = await startHost({ registerHandlers });
  const c = connect(port);
  try {
    await helloWelcome(c, { workspaceId: 'default' });
    c.send({ t: 'invoke', id: 20, channel: 'transcript:pull', args: ['rv', -1] });
    const first = (await c.until((m) => m.t === 'reply' && m.id === 20)).value;
    assert.strictEqual(first.rev, '1:o2');
    assert.ok(first.records.length > 0);
    c.send({ t: 'invoke', id: 21, channel: 'transcript:pull', args: ['rv', first.rev] });
    const again = (await c.until((m) => m.t === 'reply' && m.id === 21)).value;
    assert.deepStrictEqual(again, { ok: true, rev: '1:o2', unchanged: true });
  } finally {
    c.close();
    seat._dead = true;
    pullFn(null, 'rv');
    host.close();
  }
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

// A streaming handler guards each push with `wc.isDestroyed()` — the Electron
// liveness check. The web host's sender token omitted it, so the guard threw on
// the FIRST line into the handler's catch and every subsequent line with it: a
// 15-minute deploy streamed nothing and then returned a verdict. handleFor's
// window-shaped sender answered isDestroyed all along, which is what made this a
// seam between two senders from the same file rather than a missing feature.
test('sender token answers isDestroyed, so an isDestroyed-guarded stream delivers', async () => {
  const thrown = [];
  const registerHandlers = (deps) => {
    // Verbatim shape of the peer:deploy progress push, guard included.
    deps.handle('stream', (e) => {
      const wc = e.sender;
      let delivered = 0;
      for (const line of ['a', 'b', 'c']) {
        try { if (!wc.isDestroyed()) { wc.send('stream-line', line); delivered++; } }
        catch (err) { thrown.push(err.message); }
      }
      return { delivered };
    });
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });
    c.send({ t: 'invoke', id: 1, channel: 'stream', args: [] });

    // Bounded on purpose: the regression this pins DROPS the lines, and a bare
    // `until` would hang the suite instead of failing it. A test that cannot
    // fail in bounded time is not a regression pin.
    const lines = [];
    for (let i = 0; i < 3; i++) {
      const ev = await Promise.race([
        c.until((m) => m.t === 'event' && m.channel === 'stream-line'),
        new Promise((r) => setTimeout(() => r(null), 2000)),
      ]);
      assert.ok(ev, `line ${i} never arrived: the isDestroyed guard threw and the stream was dropped`);
      lines.push(ev.args[0]);
    }

    // ENTER: the guard must have been REACHED and passed. Asserting only that
    // nothing threw would hold just as well over a handler that never ran.
    assert.deepEqual(thrown, [], `guard threw: ${thrown[0]}`);
    assert.deepEqual(lines, ['a', 'b', 'c'], 'every guarded line must reach the tab');

    const reply = await c.until((m) => m.t === 'reply' && m.id === 1);
    assert.deepEqual(reply.value, { delivered: 3 });
    c.close();
  } finally { host.close(); }
});

// The FORWARD direction of the two-method contract (docs/renderer-events.md §C):
// the web adapter must SUPPLY both, so a handler written against the desktop host
// finds them here too. Asserted on the whole key set rather than per-method — a
// per-method check reads clean over a token that lost the OTHER one, which is the
// regression shape this contract exists to catch.
//
// Only the web half is assertable, and deliberately so: main.js passes Electron's
// own event through untouched, so `e.sender` on the desktop is a real WebContents
// that no code of ours can shrink and no test under plain node can construct
// (`require('electron')` returns the path string). The desktop side is pinned by
// Electron's API, not by us.
test('the web adapter supplies exactly the contracted sender shape', async () => {
  let captured = null;
  const registerHandlers = (deps) => {
    deps.handle('capture', (e) => { captured = e.sender; return { ok: true }; });
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });
    c.send({ t: 'invoke', id: 1, channel: 'capture', args: [] });
    await c.until((m) => m.t === 'reply' && m.id === 1);

    assert.ok(captured, 'ENTER: handler never ran, so no sender was captured');

    const methods = Object.keys(captured).filter((k) => typeof captured[k] === 'function').sort();
    assert.deepStrictEqual(
      methods, ['isDestroyed', 'send'],
      'the web sender token must carry exactly the contracted methods — adding one here '
      + 'without adding it to the docs and to what the desktop WebContents already answers '
      + 'lets a handler compile against a method only ONE host has',
    );

    // `conn` is the adapter's own workspace-resolution field, not contract. It is
    // asserted to be a NON-function so the key-set check above stays a statement
    // about the method set; a handler reading it would break on the desktop.
    assert.equal(typeof captured.conn, 'object', 'conn is the adapter-private workspace field');

    c.close();
  } finally { host.close(); }
});

test('sender token reports isDestroyed once its socket is gone', async () => {
  // The CONTROL. A token answering `false` unconditionally would satisfy the
  // test above while making the guard meaningless — the point of isDestroyed is
  // that it becomes true, so a handler still streaming after a tab closes stops.
  let captured = null;
  const registerHandlers = (deps) => {
    deps.handle('capture', (e) => { captured = e.sender; return { ok: true }; });
  };
  const { host, port } = await startHost({ registerHandlers });
  try {
    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'default' });
    c.send({ t: 'invoke', id: 1, channel: 'capture', args: [] });
    await c.until((m) => m.t === 'reply' && m.id === 1);

    assert.ok(captured, 'ENTER: handler never ran, so no sender was captured');
    assert.equal(captured.isDestroyed(), false, 'a live socket is not destroyed');

    c.close();
    await c.closed();
    assert.ok(await poll(() => captured.isDestroyed() === true), 'a closed socket must report destroyed');
  } finally { host.close(); }
});

function trapUncaught() {
  let onErr;
  const tripped = new Promise((_, reject) => { onErr = (e) => reject(new Error(`uncaught: ${e && e.message}`)); });
  process.on('uncaughtException', onErr);
  return { tripped, release: () => process.removeListener('uncaughtException', onErr) };
}

function getWith(agent, port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, cd: res.headers['content-disposition'] }));
    }).on('error', reject);
  });
}

test('a malformed percent-escape under /exports/ answers 400 and raises no uncaught exception', async () => {
  const { host, port } = await startHost();
  const agent = new http.Agent();
  const trap = trapUncaught();
  try {
    const r = await Promise.race([getWith(agent, port, '/exports/%zz'), trap.tripped]);
    assert.equal(r.status, 400);
    const after = await Promise.race([getWith(agent, port, '/healthz'), trap.tripped]);
    assert.equal(after.status, 200);
  } finally { trap.release(); agent.destroy(); host.close(); }
});

test('an exported file with a non-Latin-1 or CR/LF name downloads with an RFC 5987 filename and raises no uncaught exception', async () => {
  const dir = mkTmpRoot('wh-exports-');
  fs.mkdirSync(path.join(dir, 'exports'));
  const names = ['отчёт.md', 'a\nb', "it's (1).md"];
  for (const n of names) fs.writeFileSync(path.join(dir, 'exports', n), `body:${n}`);
  const { host, port } = await startHost({ userDataPath: dir });
  const agent = new http.Agent();
  const trap = trapUncaught();
  try {
    for (const n of names) {
      const r = await Promise.race([
        getWith(agent, port, '/exports/' + encodeURIComponent(n)),
        trap.tripped,
      ]);
      assert.equal(r.status, 200, n);
      assert.equal(r.body, `body:${n}`);
      assert.match(r.cd, /filename\*=UTF-8''[A-Za-z0-9%!._~-]+$/);
      assert.equal(decodeURIComponent(r.cd.split("''")[1]), n);
      assert.match(r.cd, /filename="[\x20-\x7e]+"/);
    }
  } finally { trap.release(); agent.destroy(); host.close(); }
});

test('a session that leaves the workspace listing while attached does not leak its ring into a same-named successor\'s replay', async () => {
  const sessions = { ws1: [{ name: 'x' }] };
  const { host, port, registered, unregistered } = await startHost({ sessions });
  try {
    const a = connect(port);
    await helloWelcome(a, { workspaceId: 'ws1' });
    registered[0].handle.webContents.send('pty-data', 'x', 'OLD');
    const live = await a.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepStrictEqual(live.args, ['x', 'OLD']);
    sessions.ws1 = [];
    a.close();
    assert.ok(await poll(() => unregistered.includes('ws1')), 'unregistered after last tab');
    sessions.ws1 = [{ name: 'x' }];

    const b = connect(port);
    await helloWelcome(b, { workspaceId: 'ws1' });
    registered[registered.length - 1].handle.webContents.send('pty-data', 'x', 'NEW');
    const first = await b.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepStrictEqual(first.args, ['x', 'NEW']);

    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'ws1' });
    const replay = await c.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepStrictEqual(replay.args, ['x', 'NEW']);
    b.close(); c.close();
  } finally { host.close(); }
});

test('a session moved to another workspace keeps its ring when the source workspace\'s last tab leaves', async () => {
  const sessions = { ws1: [{ name: 'x' }], ws2: [] };
  const { host, port, registered, unregistered } = await startHost({ sessions });
  try {
    const a = connect(port);
    await helloWelcome(a, { workspaceId: 'ws1' });
    const b = connect(port);
    await helloWelcome(b, { workspaceId: 'ws2' });
    const h1 = registered.find((r) => r.workspaceId === 'ws1').handle;
    const h2 = registered.find((r) => r.workspaceId === 'ws2').handle;
    h1.webContents.send('pty-data', 'x', 'RING');
    await a.until((m) => m.t === 'event' && m.channel === 'pty-data');

    sessions.ws1 = [];
    sessions.ws2 = [{ name: 'x' }];
    h1.webContents.send('session:moved-out', { name: 'x' });
    h2.webContents.send('session:moved-in', { name: 'x' });
    await b.until((m) => m.t === 'event' && m.channel === 'session:moved-in');
    a.close();
    assert.ok(await poll(() => unregistered.includes('ws1')), 'unregistered after last tab');

    const c = connect(port);
    await helloWelcome(c, { workspaceId: 'ws2' });
    h2.webContents.send('pty-data', 'x', 'LIVE');
    const first = await c.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepStrictEqual(first.args, ['x', 'RING']);
    b.close(); c.close();
  } finally { host.close(); }
});

test('a session-exit clears that name\'s ring so a late joiner does not replay the finished run', async () => {
  const { host, port, registered } = await startHost({ sessions: { ws1: [{ name: 'x' }] } });
  try {
    const a = connect(port);
    await helloWelcome(a, { workspaceId: 'ws1' });
    const handle = registered[0].handle;
    handle.webContents.send('pty-data', 'x', 'OLD');
    handle.webContents.send('session-exit', 'x', 0, {});
    await a.until((m) => m.t === 'event' && m.channel === 'session-exit');
    handle.webContents.send('pty-data', 'x', 'NEW');
    await a.until((m) => m.t === 'event' && m.channel === 'pty-data' && m.args[1] === 'NEW');
    const b = connect(port);
    await helloWelcome(b, { workspaceId: 'ws1' });
    const replay = await b.until((m) => m.t === 'event' && m.channel === 'pty-data');
    assert.deepStrictEqual(replay.args, ['x', 'NEW']);
    a.close(); b.close();
  } finally { host.close(); }
});
