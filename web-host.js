'use strict';
// web-host.js — the browser frontend's engine-side host (web-frontend Phase 3a).
// Plain Node (HTTP + `ws`), NOT electron: it must never appear in the
// electron-boundary ALLOWED set. Started ONLY by headless-main.js when
// CLODEX_WEB_PORT is set; the Electron desktop app never loads it and is
// byte-for-byte unchanged. This is a NEW frontend for engine.js, not a rewrite —
// it drives the SAME registerIpcHandlers handler map (the Phase-1 transport +
// capability seams) and the SAME event-push surface (docs/renderer-events.md, the
// Phase-2 audit) over a WebSocket, so zero engine change is required.
//
// Leak-scanner lists (test/free-identifier-leaks.test.js): NOT applicable — this
// is new code, not a move-only extraction of a coordinator, so there is no
// forward/reverse identifier split to guard.
//
// How the seams map onto WS:
//   • registration — `handle`/`on` populate a plain Map<channel, fn>; an `invoke`
//     frame dispatches `map.get(channel)(e, ...args)`, a `send` frame fires the
//     5 ipcMain.on channels with no reply.
//   • sender token — `e = {sender:{send, conn}}`: the same opaque token Phase 1
//     established (§C channels push straight back to the calling connection), plus
//     `conn` so `workspaceOfSender(e)` reads the connection's workspace.
//   • token-less capabilities (showMessageBox/showSaveDialog take only opts) — the
//     invoke dispatcher runs each handler inside `als.run(conn, …)` so the
//     capability impls recover the requesting connection from AsyncLocalStorage.
//   • window bridge — ONE multiplexing handle per workspace implements the
//     five-method opaque-handle contract (webContents.send / isDestroyed /
//     isFocused / show / focus); first tab registers it, last disconnect
//     unregisters it, so the engine's detached-session pendingOutput buffering
//     resumes exactly as for a closed Electron window.
//
// Two audit resolutions folded in (see the clodex P3a handoff):
//   1. peer-data / peer-replay carry Buffers (peer PTY bytes), which JSON can't
//      round-trip losslessly — the event serializer re-encodes any Buffer to
//      {$type:'Buffer', b64}. Local pty-data is a string and rides as-is (no
//      base64 layer, per the spec ruling). Invoke REPLIES are passed through raw
//      (the audit found no Buffer/Date among the 118 handler returns).
//   2. session:context-menu uses radio/checkbox/checked and a nested submenu, so
//      the flat template[i].click() model can't dispatch it. popupMenu instead
//      assigns a string id to every clickable item (recursing into submenus),
//      keeps the click closures server-side in an id→closure map, and resolves the
//      pick by id — a strict superset that leaves the two flat peer menus unchanged.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');
const { WebSocketServer } = require('ws');

const APP_VERSION = require('./package.json').version;
const UPDATE_REPO = 'avirtual/clodex'; // mirrors main.js — the deploy-briefing URL fallback
const MAX_SCROLLBACK = 2 * 1024 * 1024; // per-session ring; matches the engine's 2MB pendingOutput cap
const DEFAULT_WORKSPACE_ID = 'default';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

// Deep-replace any Buffer with a {$type:'Buffer', b64} envelope so peer PTY bytes
// survive JSON.stringify (audit 1). Strings/numbers short-circuit, so the
// high-frequency pty-data path (a plain string) pays only one typeof check.
function encodeBuffers(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Buffer.isBuffer(v)) return { $type: 'Buffer', b64: v.toString('base64') };
  if (Array.isArray(v)) return v.map(encodeBuffers);
  const out = {};
  for (const k of Object.keys(v)) out[k] = encodeBuffers(v[k]);
  return out;
}

function sanitizeBasename(name) {
  return path.basename(String(name || '')).replace(/[/\\]/g, '').trim() || 'export';
}

// createWebHost({ engine, log, port, token, userDataPath }) → { close }.
// `userDataPath` is threaded from headless-main (the sole caller) because the
// specified signature omits it and the engine return doesn't expose it — exports
// (the showSaveDialog degradation) land under <userDataPath>/exports/.
// `registerHandlers` is an optional test seam defaulting to the real
// registerIpcHandlers; tests inject fake handlers without standing up an engine.
function createWebHost({ engine, log, port, token, userDataPath, registerHandlers } = {}) {
  const manager = engine.manager;
  const exportsDir = path.join(userDataPath || os.homedir(), 'exports');
  const webDist = path.join(__dirname, 'web-dist'); // P3b esbuild output (may not exist yet)

  const als = new AsyncLocalStorage();
  const handlers = new Map();                 // channel → fn (handle + on share it)
  const conns = new Set();                    // all live connections
  const workspaceConns = new Map();           // workspaceId → Set<conn>
  const workspaceHandles = new Map();         // workspaceId → the 5-method handle
  const scrollback = new Map();               // sessionName → attached-period pty-data ring
  let menuSeq = 0, dialogSeq = 0;

  // ── token predicate — the single replaceable auth check (HTTP + upgrade +
  // hello). Absent token = localhost-trust (Phase 4 documents the stance). A real
  // auth layer later swaps this one function.
  const checkToken = (provided) => !token || provided === token;
  function tokenFromReq(req) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams.get('token');
      if (q) return q;
    } catch { /* malformed url — fall through to header */ }
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1] : null;
  }

  // ── event fan-out — the interception point the Phase-2 audit identified.
  // handle.webContents.send(channel, ...args) lands here; we grow the scrollback
  // ring for pty-data and push an event frame (Buffer-encoded) to every tab on
  // the workspace.
  function fanEvent(workspaceId, channel, args) {
    if (channel === 'pty-data') {
      const [name, data] = args;
      const cur = (scrollback.get(name) || '') + (data || '');
      scrollback.set(name, cur.length > MAX_SCROLLBACK ? cur.slice(-MAX_SCROLLBACK) : cur);
    }
    const set = workspaceConns.get(workspaceId);
    if (!set) return;
    const frame = { t: 'event', channel, args: args.map(encodeBuffers) };
    for (const c of set) c.send(frame);
  }

  // ── the multiplexing window handle (the P2 five-method opaque-handle contract).
  function handleFor(workspaceId) {
    return {
      webContents: { send: (channel, ...args) => fanEvent(workspaceId, channel, args) },
      isDestroyed: () => !(workspaceConns.get(workspaceId) || new Set()).size,
      isFocused: () => [...(workspaceConns.get(workspaceId) || [])].some((c) => c.visible),
      show: () => fanEvent(workspaceId, 'focus-hint', []),
      focus: () => {},
    };
  }

  function attachConn(conn) {
    let set = workspaceConns.get(conn.workspaceId);
    if (!set) { set = new Set(); workspaceConns.set(conn.workspaceId, set); }
    const first = set.size === 0;
    set.add(conn);
    if (first) {
      // First tab on this workspace — register the handle so the engine stops
      // buffering into pendingOutput and routes events to us instead.
      const h = handleFor(conn.workspaceId);
      workspaceHandles.set(conn.workspaceId, h);
      manager.registerWindow(conn.workspaceId, h);
    }
  }

  function detachConn(conn) {
    const set = workspaceConns.get(conn.workspaceId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      // Last tab gone — unregister so the engine resumes detached-session
      // pendingOutput buffering, and drop our scrollback rings for this
      // workspace's sessions so they can't double up with the engine's replay
      // when a tab returns.
      workspaceConns.delete(conn.workspaceId);
      workspaceHandles.delete(conn.workspaceId);
      manager.unregisterWindow(conn.workspaceId);
      try {
        for (const s of manager.listForWorkspace(conn.workspaceId)) scrollback.delete(s.name);
      } catch { /* fake managers in tests may omit listForWorkspace */ }
    }
  }

  // Replay the attached-period ring to a newly-joined tab. Empty for the FIRST
  // tab (nothing was attached before it), so the engine's pendingOutput replay
  // via app:restore-sessions covers that case; non-empty only for a LATE joiner
  // whose workspace was already attached — the one gap the engine buffer can't
  // cover (it fills only while detached). The two are therefore complementary.
  function replayScrollback(conn) {
    let sessions = [];
    try { sessions = manager.listForWorkspace(conn.workspaceId) || []; } catch { sessions = []; }
    for (const s of sessions) {
      const ring = scrollback.get(s.name);
      if (ring) conn.send({ t: 'event', channel: 'pty-data', args: [s.name, ring] });
    }
  }

  // ── degraded native-GUI capabilities (v1). Dialogs/menus belong to the
  // requesting connection (the P1 handoff ruling); connection recovered from the
  // sender token where present (popupMenu) or AsyncLocalStorage (dialogs).
  function popupMenu(template, e) {
    const conn = e && e.sender && e.sender.conn;
    if (!conn) return;
    const clickMap = new Map();
    let n = 0;
    const serialize = (items) => items.map((it) => {
      if (it.type === 'separator') return { type: 'separator' };
      const id = `i${n++}`;
      const out = { id, label: it.label, enabled: it.enabled !== false };
      if (it.type) out.type = it.type;              // radio / checkbox / normal
      if ('checked' in it) out.checked = !!it.checked;
      if (it.click) clickMap.set(id, it.click);
      if (it.submenu) out.submenu = serialize(it.submenu);
      return out;
    });
    const items = serialize(template);
    const menuId = `menu${menuSeq++}`;
    conn.pendingMenus.set(menuId, (itemId) => {
      const click = itemId != null && clickMap.get(itemId);
      if (click) als.run(conn, () => { try { click(); } catch (err) { log.error('web', `menu click: ${err.message}`); } });
    });
    conn.send({ t: 'menu-show', menuId, items });
  }

  function askDialog(kind, opts) {
    const conn = als.getStore();
    const cancel = kind === 'message'
      ? { response: (opts && Number.isInteger(opts.cancelId)) ? opts.cancelId : ((opts && opts.buttons ? opts.buttons.length - 1 : 0)) }
      : (kind === 'save' ? { canceled: true, filePath: undefined } : { canceled: true, filePaths: [] });
    if (!conn) return Promise.resolve(cancel);
    const dialogId = `dlg${dialogSeq++}`;
    return new Promise((resolve) => {
      conn.pendingDialogs.set(dialogId, (value) => resolve(value == null ? cancel : { value }));
      conn.send({ t: 'dialog-show', dialogId, kind, opts });
    });
  }

  async function showMessageBox(opts) {
    const r = await askDialog('message', opts);
    return ('response' in r) ? r : { response: Number.isInteger(r.value && r.value.response) ? r.value.response : 0 };
  }
  async function showSaveDialog(opts) {
    const r = await askDialog('save', opts);
    if (r.canceled) return r;
    // The handler writes to filePath directly (electron's dialog guarantees the
    // parent exists; here we must).
    try { fs.mkdirSync(exportsDir, { recursive: true }); } catch { /* surfaced by the write */ }
    const filePath = path.join(exportsDir, sanitizeBasename(r.value && r.value.filename));
    return { canceled: false, filePath };
  }
  async function showOpenDialog(opts) {
    const r = await askDialog('open', opts);
    if (r.canceled) return r;
    const p = r.value && r.value.path;
    try { if (p && fs.statSync(p).isDirectory()) return { canceled: false, filePaths: [p] }; } catch { /* not a dir */ }
    return { canceled: true, filePaths: [] };
  }

  // Fire-and-forget shell degradations — a synthetic event to the connection
  // driving the current invoke (or a menu click); the P3b shim maps them to
  // window.open / an in-page file view / a path toast.
  const toConn = (channel, ...args) => { const c = als.getStore(); if (c) c.pushEvent(channel, args); };
  const openExternal = (url) => toConn('open-external', url);
  const openPath = (p) => { toConn('open-path', p); return Promise.resolve(''); };
  const showItemInFolder = (p) => toConn('show-item-in-folder', p);
  const getAppVersion = () => APP_VERSION;
  const getDesktopPath = () => exportsDir;

  // ── the handler map: registerIpcHandlers ONCE with the main.js:473-mirrored
  // deps assembly — the engine + stores, our Map-backed transport, the degraded
  // capabilities, and inert/no-op stubs for the desktop-only tail.
  const deps = {
    ...engine,
    ...engine.stores,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    popupMenu, showMessageBox, showSaveDialog, showOpenDialog,
    openExternal, openPath, showItemInFolder, getAppVersion, getDesktopPath,
    fs, https, os, path, log,
    UPDATE_REPO,
    checkForUpdate: () => {},                 // update-available is designated desktop-only
    getUpdateInfo: () => null, getReleasesCache: () => null,
    createWindow: () => {},                   // browser tabs self-navigate; ws record work is in the handler
    openWirescopeWindow: (url) => log.info('web', `openWirescopeWindow (no browser window): ${url}`),
    refreshAppMenu: () => {}, refreshTrayMenu: () => {}, setUiTheme: () => {},
    workspaceOfSender: (e) => (e && e.sender && e.sender.conn && e.sender.conn.workspaceId) || DEFAULT_WORKSPACE_ID,
  };
  (registerHandlers || require('./ipc-handlers').registerIpcHandlers)(deps);

  // ── frame dispatch (client → server). Nothing but a valid hello is accepted
  // before the connection is authed; a bad token or a pre-hello frame closes it.
  function onFrame(conn, frame) {
    if (!conn.authed) {
      if (!frame || frame.t !== 'hello' || !checkToken(frame.token)) { conn.ws.close(); return; }
      conn.authed = true;
      conn.workspaceId = frame.workspaceId || DEFAULT_WORKSPACE_ID;
      attachConn(conn);
      conn.send({ t: 'welcome', workspaceId: conn.workspaceId, appVersion: APP_VERSION, home: os.homedir() });
      replayScrollback(conn);
      return;
    }
    switch (frame && frame.t) {
      case 'invoke': {
        const fn = handlers.get(frame.channel);
        if (!fn) { conn.send({ t: 'reply', id: frame.id, ok: false, error: `no handler: ${frame.channel}` }); return; }
        const e = conn.senderToken;
        // The executor runs als.run synchronously (so the ALS store is active for
        // the handler's sync portion + its awaited continuations); a SYNC throw is
        // caught by the Promise constructor and becomes a rejection, so both sync
        // and async handler failures land in the same error reply.
        new Promise((resolve) => resolve(als.run(conn, () => fn(e, ...(frame.args || [])))))
          .then((value) => conn.send({ t: 'reply', id: frame.id, ok: true, value }))
          .catch((err) => conn.send({ t: 'reply', id: frame.id, ok: false, error: (err && err.message) || String(err) }));
        break;
      }
      case 'send': {
        const fn = handlers.get(frame.channel);
        if (fn) als.run(conn, () => { try { fn(conn.senderToken, ...(frame.args || [])); } catch (err) { log.error('web', `send ${frame.channel}: ${err.message}`); } });
        break;
      }
      case 'menu-pick': {
        const r = conn.pendingMenus.get(frame.menuId);
        if (r) { conn.pendingMenus.delete(frame.menuId); r(frame.itemId != null ? frame.itemId : null); }
        break;
      }
      case 'dialog-reply': {
        const r = conn.pendingDialogs.get(frame.dialogId);
        if (r) { conn.pendingDialogs.delete(frame.dialogId); r(frame.value != null ? frame.value : null); }
        break;
      }
      case 'visible':
        conn.visible = frame.visible !== false; // isFocused hint (default true)
        break;
      default:
        /* unknown frame — ignore */
    }
  }

  // ── HTTP: token-gated static bundle + /exports/<file> download.
  function serveExports(req, res, rel) {
    const file = path.join(exportsDir, sanitizeBasename(decodeURIComponent(rel)));
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
      res.end(buf);
    });
  }
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(webDist, rel);
    if (!file.startsWith(webDist + path.sep)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // No bundle yet (P3b builds it) or unknown path — SPA fallback to index.
        fs.readFile(path.join(webDist, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404).end('web bundle not built (npm run build:web)'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(idx);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep default */ }
    // Unauthenticated liveness probe — exempt from the token gate so a compose
    // healthcheck can hit it without carrying the secret. Leaks only liveness.
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ok'); return; }
    if (!checkToken(tokenFromReq(req))) { res.writeHead(401).end('unauthorized'); return; }
    if (pathname.startsWith('/exports/')) return serveExports(req, res, pathname.slice('/exports/'.length));
    return serveStatic(req, res, pathname);
  });

  // Manual upgrade so the token gate runs before the WS handshake completes.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!checkToken(tokenFromReq(req))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const conn = {
      ws, authed: false, visible: true, workspaceId: DEFAULT_WORKSPACE_ID,
      pendingMenus: new Map(), pendingDialogs: new Map(),
      send: (frame) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); } catch (err) { log.error('web', `send: ${err.message}`); } },
      pushEvent: (channel, args) => conn.send({ t: 'event', channel, args: args.map(encodeBuffers) }),
    };
    conn.senderToken = { sender: { send: (channel, ...args) => conn.pushEvent(channel, args), conn } };
    conns.add(conn);
    ws.on('message', (raw) => {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      try { onFrame(conn, frame); } catch (err) { log.error('web', `frame ${frame && frame.t}: ${err.message}`); }
    });
    ws.on('close', () => {
      conns.delete(conn);
      if (conn.authed) detachConn(conn);
      // Resolve any pending menu/dialog as a dismiss so awaiting handlers unwind.
      for (const r of conn.pendingMenus.values()) { try { r(null); } catch {} }
      for (const r of conn.pendingDialogs.values()) { try { r(null); } catch {} }
    });
    ws.on('error', (err) => log.error('web', `socket: ${err.message}`));
  });

  server.listen(port, () => log.info('web', `web host listening on :${port}${token ? ' (token required)' : ' (localhost-trust)'}`));

  return {
    close() {
      try { for (const c of conns) c.ws.close(); } catch {}
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
    },
    // Test/introspection handles (not part of the wire contract).
    _server: server, _handlers: handlers, _scrollback: scrollback, _workspaceConns: workspaceConns,
  };
}

module.exports = { createWebHost };
