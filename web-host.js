'use strict';
// Plain Node (HTTP + `ws`), never electron: this file must stay out of the
// electron-boundary ALLOWED set. Loaded only by headless-main.js when
// CLODEX_WEB_PORT is set.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');
const { WebSocketServer } = require('ws');
const { makeTokenGate } = require('./auth-token');

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

function createWebHost({ engine, log, port, host, token, userDataPath, registerHandlers } = {}) {
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

// Absent token = localhost-trust. The compare is constant-time; do not revert to `===`.
  const gate = makeTokenGate(token);
  const checkToken = (provided) => gate.check(provided);
  const tokenFromReq = (req) => gate.fromReq(req);

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

  const toConn = (channel, ...args) => { const c = als.getStore(); if (c) c.pushEvent(channel, args); };
  const openExternal = (url) => toConn('open-external', url);

// The browser cannot reach the engine's loopback proxyBase; the shim rewrites
// that origin to wirescopePublicBase. Both empty when unset → no rewrite.
  const wirescopeReach = () => {
    const s = (engine.stores && engine.stores.uiSettings) ? engine.stores.uiSettings.get() : {};
    const proxyBase = s.proxyEnabled ? (s.proxyUrl || '').trim().replace(/\/+$/, '') : '';
    return { proxyBase, wirescopePublicBase: (process.env.CLODEX_WIRESCOPE_PUBLIC_URL || '').trim().replace(/\/+$/, '') };
  };
  const openPath = (p) => { toConn('open-path', p); return Promise.resolve(''); };
  const showItemInFolder = (p) => toConn('show-item-in-folder', p);
  const getAppVersion = () => APP_VERSION;
  const getDesktopPath = () => exportsDir;

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
    createWindow: () => {},                   // browser tabs self-navigate; workspace:new persists the record before calling this
    openWirescopeWindow: (url) => openExternal(url),
    refreshAppMenu: () => {}, refreshTrayMenu: () => {}, setUiTheme: () => {},
    workspaceOfSender: (e) => (e && e.sender && e.sender.conn && e.sender.conn.workspaceId) || DEFAULT_WORKSPACE_ID,
    // The drawer's service-backed tenants (`ctl:*` verb runner, `wterm:*`
    // workbench PTY) must never have handlers in THIS map: onFrame dispatches
    // any registered channel by name, so registration IS the capability. Set
    // here rather than inherited from the engine seam so the guarantee holds
    // for whatever engine this host is handed.
    enableDrawerServices: false,
  };
  (registerHandlers || require('./ipc-handlers').registerIpcHandlers)(deps);

// Deliberately absent from api-contract: reached by a raw invoke, so the
// desktop surface stays untouched.
  handlers.set('app:restart', () => { if (typeof engine.restartClodex === 'function') engine.restartClodex(); return { ok: true }; });

  function onFrame(conn, frame) {
    if (!conn.authed) {
      if (!frame || frame.t !== 'hello' || !checkToken(frame.token)) { conn.ws.close(); return; }
      conn.authed = true;
      conn.workspaceId = frame.workspaceId || DEFAULT_WORKSPACE_ID;
      attachConn(conn);
      conn.send({ t: 'welcome', workspaceId: conn.workspaceId, appVersion: APP_VERSION, home: os.homedir(), ...wirescopeReach() });
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
    }
  }

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

// Unset host → Node's all-interfaces bind, which the docker port map
// (127.0.0.1:HOST_PORT→container:8080) depends on; a loopback container bind
// breaks it. Deploys pass CLODEX_WEB_HOST=127.0.0.1 explicitly instead.
  const listenArgs = host ? [port, host] : [port];
  server.listen(...listenArgs, () => log.info('web', `web host listening on ${host || '*'}:${port}${token ? ' (token required)' : ' (localhost-trust)'}`));

  return {
    close() {
      try { for (const c of conns) c.ws.close(); } catch {}
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
    },
// Port is read from the socket, not echoed from the request: a caller may pass 0.
// null until the listen callback fires. tokenGated says a token is required,
// never what it is.
    get info() {
      const addr = server.address();
      if (!addr || typeof addr.port !== 'number' || addr.port <= 0) return null;
      return { port: addr.port, tokenGated: gate.configured };
    },
    _server: server, _handlers: handlers, _scrollback: scrollback, _workspaceConns: workspaceConns,
  };
}

module.exports = { createWebHost };
