'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const driver = require('./driver');
const scripts = require('./page-scripts');

const BAR_HEIGHT = 40;
const MAX_WINDOWS = 8;
const PIN_DEBOUNCE_MS = 2000;
const QUIT_CAP_MS = 2000;
const OPEN_IDLE_MS = 15000;
const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CODES = new Set(['NOT_OPEN', 'BAD_URL', 'NAV_FAILED', 'TOO_MANY_WINDOWS', 'CLOSED', 'TIMEOUT', 'INTERNAL']);

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function argValue(argv, key) {
  const pre = `--${key}=`;
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

function allowedNav(url) {
  if (url === 'about:blank') return true;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch { return false; }
}

function checkOpenUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw codedError('BAD_URL', `not a URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw codedError('BAD_URL', `only http: and https: URLs can be opened, not ${u.protocol}`);
  if (u.username || u.password) throw codedError('BAD_URL', 'a URL with user:pass@ is refused');
  return url;
}

function run(electron, ctx) {
  console.log = console.error;
  const argv = (ctx && ctx.argv) || process.argv;
  const data = argValue(argv, 'cxb-data');
  const proto = Number(argValue(argv, 'cxb-proto') || 1);
  if (!data || !path.isAbsolute(data)) {
    process.stderr.write('browser child: --cxb-data=<absolute dir> is required\n');
    process.exit(2);
    return;
  }
  const { app, BrowserWindow, WebContentsView, session, Menu, powerSaveBlocker } = electron;
  fs.mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setPath('sessionData', data);
  app.on('window-all-closed', () => {});

  const t0 = Date.now();
  const services = new Map();
  const chains = new Map();
  const partitions = new Set();
  let blockerId = null;
  let shuttingDown = false;

  const send = (frame) => {
    try { process.stdout.write(JSON.stringify({ cxb: 1, ...frame }) + '\n'); } catch {}
  };

  const dockSync = () => {
    if (!app.dock) return;
    if (services.size) Promise.resolve(app.dock.show()).catch(() => {});
    else app.dock.hide();
  };

  const busyTotal = () => [...services.values()].reduce((n, s) => n + s.busy, 0);
  const blockerSync = () => {
    const busy = busyTotal() > 0;
    if (busy && blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
    else if (!busy && blockerId != null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  };

  const render = (svc) => {
    if (svc.win.isDestroyed()) return;
    const vm = { service: svc.name, url: svc.wc.isDestroyed() ? '' : svc.wc.getURL(), state: 'idle' };
    svc.win.webContents.executeJavaScript(`window.cxbRender && window.cxbRender(${JSON.stringify(vm)})`).catch(() => {});
  };

  const ensureCdp = (svc) => {
    if (svc.wc.debugger.isAttached()) return;
    driver.attachCdp(svc.wc);
    svc.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  };

  const watchCookies = (name, ses) => {
    if (partitions.has(name)) return;
    partitions.add(name);
    let timer = null;
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (removed || !cookie || !cookie.session) return;
      clearTimeout(timer);
      timer = setTimeout(() => { driver.pinSessionCookies(ses).catch(() => {}); }, PIN_DEBOUNCE_MS);
    });
  };

  function openService(name) {
    const have = services.get(name);
    if (have && !have.win.isDestroyed()) return have;
    if (services.size >= MAX_WINDOWS) {
      throw codedError('TOO_MANY_WINDOWS', `at most ${MAX_WINDOWS} service windows can be open — the operator can close one`);
    }
    const ses = session.fromPartition('persist:' + name);
    ses.setUserAgent(ses.getUserAgent().replace(/ (Clodex|Electron)\/\S+/g, ''));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    watchCookies(name, ses);
    const slot = services.size;
    const win = new BrowserWindow({
      width: 1280, height: 940, x: 80 + slot * 28, y: 60 + slot * 28, show: false,
      title: `${name} — Clodex Browser`,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(path.join(__dirname, 'bar.html')).catch(() => {});
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.contentView.addChildView(view);
    const layout = () => {
      if (win.isDestroyed()) return;
      const b = win.getContentBounds();
      view.setBounds({ x: 0, y: BAR_HEIGHT, width: b.width, height: Math.max(0, b.height - BAR_HEIGHT) });
    };
    layout();
    win.on('resize', layout);
    const wc = view.webContents;
    const svc = { name, win, view, wc, ses, doc: 0, busy: 0, blank: wc.loadURL('about:blank').catch(() => {}) };
    wc.on('did-navigate', () => { svc.doc += 1; render(svc); });
    wc.on('did-navigate-in-page', () => render(svc));
    const block = (e, url) => {
      const target = (e && e.url) || url;
      if (!allowedNav(target)) e.preventDefault();
    };
    wc.on('will-navigate', block);
    wc.on('will-frame-navigate', block);
    wc.setWindowOpenHandler(({ url }) => {
      if (svc.busy > 0) {
        if (allowedNav(url)) wc.loadURL(url).catch(() => {});
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } },
      };
    });
    win.webContents.on('did-finish-load', () => render(svc));
    try { ensureCdp(svc); } catch {}
    win.on('closed', () => {
      if (services.get(name) === svc) services.delete(name);
      send({ event: 'window-closed', service: name });
      dockSync();
      blockerSync();
    });
    services.set(name, svc);
    dockSync();
    win.showInactive();
    return svc;
  }

  const inIsolated = (wc, code) => driver.withTimeout(
    wc.executeJavaScriptInIsolatedWorld(scripts.ISOLATED_WORLD, [{ code }]).catch(() => null),
    driver.SCRIPT_TIMEOUT_MS, null);
  const inMain = (wc, code) => driver.withTimeout(wc.executeJavaScript(code).catch(() => null), driver.SCRIPT_TIMEOUT_MS, null);

  const probe = async (svc) => (await inIsolated(svc.wc, scripts.LOGIN_PROBE)) || {};

  async function opOpen(name, args) {
    const url = checkOpenUrl(String(args.url || ''));
    const svc = openService(name);
    svc.busy += 1;
    blockerSync();
    let status = null;
    const onNav = (_e, _url, code) => { status = code; };
    svc.wc.on('did-navigate', onNav);
    try {
      await svc.blank;
      ensureCdp(svc);
      let navErr = null;
      const { idle } = await driver.act(svc.wc, () => svc.wc.loadURL(url).catch((e) => { navErr = e; }), { timeoutMs: OPEN_IDLE_MS });
      if (svc.wc.isDestroyed()) throw codedError('CLOSED', `the operator closed the ${name} window — open it again`);
      if (navErr && status == null) throw codedError('NAV_FAILED', `NAV_FAILED: ${navErr.code || navErr.message} for ${url}`);
      const login = await probe(svc);
      return {
        status, url: svc.wc.getURL(), title: svc.wc.getTitle(), doc: svc.doc,
        idle: { ok: !!idle.ok, ms: idle.ms, inflight: idle.inflight || [] }, login,
      };
    } finally {
      if (!svc.wc.isDestroyed()) svc.wc.removeListener('did-navigate', onNav);
      svc.busy -= 1;
      blockerSync();
    }
  }

  async function opRead(name, args) {
    const svc = services.get(name);
    if (!svc || svc.win.isDestroyed() || svc.wc.isDestroyed()) {
      throw codedError('NOT_OPEN', `${name} is not open — [agent:browser open ${name}] <url>`);
    }
    const wc = svc.wc;
    const main = args.scope === 'main';
    const contentType = await inMain(wc, scripts.CONTENT_TYPE);
    const base = { url: wc.getURL(), title: wc.getTitle(), doc: svc.doc, contentType };
    if (contentType === 'application/pdf') return base;
    let text = await inMain(wc, scripts.READ_TEXT(main));
    if (text == null) text = await inMain(wc, scripts.READ_TEXT(main));
    let el = await inIsolated(wc, scripts.READ_INTERACTIVE(main));
    if (el == null) el = await inIsolated(wc, scripts.READ_INTERACTIVE(main));
    if (text == null && el == null) throw codedError('TIMEOUT', `the ${name} page did not answer the read (document replaced?) — read again`);
    const login = await probe(svc);
    const frames = wc.mainFrame.framesInSubtree
      .filter((f) => f !== wc.mainFrame)
      .map((f) => f.url)
      .filter((u) => u && u !== 'about:blank');
    const elements = el && Array.isArray(el.lines) ? el.lines : [];
    return {
      ...base,
      text: text || '',
      elements,
      counts: { elements: elements.length, textChars: (text || '').length },
      truncated: !!(el && el.truncated) || (text || '').length >= scripts.TEXT_MAX,
      frames,
      login,
    };
  }

  function serial(name, fn) {
    const prev = chains.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(name, next.catch(() => {}));
    return next;
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => app.exit(0), QUIT_CAP_MS);
    if (!app.isReady()) { app.exit(0); return; }
    const pins = [...partitions].map((p) => driver.pinSessionCookies(session.fromPartition('persist:' + p)).catch(() => 0));
    Promise.all(pins).finally(() => app.exit(0));
  }

  async function handle(frame) {
    const { id, op } = frame;
    const args = (frame.args && typeof frame.args === 'object') ? frame.args : {};
    try {
      if (op === 'shutdown') {
        send({ id, ok: true, result: {} });
        shutdown();
        return;
      }
      await app.whenReady();
      let result;
      if (op === 'ping') result = { uptimeMs: Date.now() - t0 };
      else if (op === 'open' || op === 'read') {
        const name = String(frame.service || '');
        if (!SERVICE_RE.test(name)) throw codedError('INTERNAL', `bad service name: ${name}`);
        result = await serial(name, () => (op === 'open' ? opOpen(name, args) : opRead(name, args)));
      } else {
        throw codedError('INTERNAL', `unknown op ${op}`);
      }
      send({ id, ok: true, result });
    } catch (e) {
      const code = e && CODES.has(e.code) ? e.code : 'INTERNAL';
      send({ id, ok: false, code, error: String((e && e.message) || e) });
    }
  }

  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    e.preventDefault();
    shutdown();
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let frame = null;
    try { frame = JSON.parse(line); } catch { return; }
    if (!frame || frame.cxb !== 1 || frame.id == null) return;
    handle(frame);
  });
  rl.on('close', () => shutdown());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    dockSync();
    send({ event: 'ready', proto, electron: process.versions.electron, pid: process.pid });
  });
}

module.exports = { run };
