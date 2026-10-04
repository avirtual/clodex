'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const driver = require('./driver');
const scripts = require('./page-scripts');
const lock = require('./lock');
const { TEXT } = require('./replies');
const paths = require('./paths');
const { changedRegion, CHANGE_MAX } = require('./read-format');

const BAR_HEIGHT = 40;
const MAX_WINDOWS = 8;
const PIN_DEBOUNCE_MS = 2000;
const QUIT_CAP_MS = 2000;
const OPEN_IDLE_MS = 15000;
const LOAD_TIMEOUT_MS = 25000;
const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ACT_IDLE_MS = 15000;
const DOWNLOAD_START_MS = 30000;
const DOWNLOAD_DONE_MS = 300000;
const CLICK_DOWNLOAD_MS = 5000;
const SNAP_MS = 2000;
const LOADING_INFLIGHT_MS = 300;
const CLICKISH = ['click', 'mousedown', 'pointerdown', 'mouseup'];
const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;
const FLASH_MS = 4000;
const SHOT_WIDTH = 1280;
const SHOT_QUALITY = 80;
const CODES = new Set(['NOT_OPEN', 'NO_ELEMENT', 'STALE_DOC', 'HELD', 'OPERATOR_BUSY', 'PASSWORD_FIELD', 'NOT_SELECT', 'NO_OPTION',
  'NOT_EDITABLE', 'BAD_URL', 'NAV_FAILED', 'TOO_MANY_WINDOWS', 'CLOSED', 'TIMEOUT', 'INTERNAL', 'DOWNLOAD_TIMEOUT', 'DOWNLOAD_FAILED', 'AMBIGUOUS']);
const SERVICE_OPS = new Set(['open', 'read', 'click', 'type', 'key', 'select', 'idle', 'hold', 'handback', 'show', 'download', 'screenshot', 'forget', 'inspect']);

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function signinOf(login) {
  if (!login) return null;
  if (login.idp === 'google' || login.googleRejected) return 'idp';
  if (login.password) return 'login';
  if (login.otp) return 'otp';
  if (login.captcha) return 'captcha';
  if (login.idp) return 'idp';
  return null;
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

function magicOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(5);
    const n = fs.readSync(fd, buf, 0, 5, 0);
    const head = buf.slice(0, n).toString('latin1');
    if (head === '%PDF-') return 'pdf';
    if (/^(<!doc|<html)/i.test(head)) return 'html';
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

function sameUrl(a, b) {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}

function keepOrFold(out, w, isReserved) {
  if (w.nameHint || w.abandoned) return out;
  const dup = paths.sameFileIn(out.file, isReserved);
  if (!dup) return out;
  try { fs.unlinkSync(out.file); } catch {}
  return { ...out, file: dup, magic: magicOf(dup), same: true };
}

async function settleDownload(w, deadline) {
  const within = (p) => {
    let t;
    return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(undefined), Math.max(0, deadline - Date.now())); })])
      .finally(() => clearTimeout(t));
  };
  const item = await within(w.started);
  if (!item) return null;
  const head = { file: item.getSavePath(), mime: item.getMimeType(), url: (item.getURLChain() || [])[0] || '' };
  try {
    const out = await within(w.done);
    if (!out) {
      w.abandoned = true;
      return { ...head, bytes: null };
    }
    return { file: out.file, bytes: out.bytes, mime: out.mime, url: out.url || head.url, ...(out.same ? { same: true } : {}) };
  } catch (e) {
    return { ...head, bytes: null, failed: String((e && e.message) || e).replace(/^DOWNLOAD_FAILED: /, '') };
  }
}

function run(electron, ctx) {
  console.log = console.error;
  const argv = (ctx && ctx.argv) || process.argv;
  const data = argValue(argv, 'cxb-data');
  const proto = Number(argValue(argv, 'cxb-proto') || 1);
  const downloadsRoot = argValue(argv, 'cxb-downloads') || path.join(path.dirname(data || '.'), 'downloads');
  if (!data || !path.isAbsolute(data)) {
    process.stderr.write('browser child: --cxb-data=<absolute dir> is required\n');
    process.exit(2);
    return;
  }
  const { app, BrowserWindow, WebContentsView, session, Menu, powerSaveBlocker, nativeImage } = electron;
  fs.mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setPath('sessionData', data);
  app.on('window-all-closed', () => {});

  const t0 = Date.now();
  const quietMs = Number((ctx && ctx.quietMs) || 3000);
  const gateMaxMs = Number((ctx && ctx.gateMaxMs) || 60000);
  const services = new Map();
  const chains = new Map();
  const partitions = new Set();
  const routers = new Map();
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

  const busyTotal = () => [...services.values()].reduce((n, s) => n + s.busy + s.reading, 0);
  const blockerSync = () => {
    const busy = busyTotal() > 0;
    if (busy && blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
    else if (!busy && blockerId != null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  };

  const render = (svc) => {
    if (svc.win.isDestroyed()) return;
    const vm = lock.barView(svc.lock, { service: svc.name, url: svc.wc.isDestroyed() ? '' : svc.wc.getURL() });
    if (svc.flash && Date.now() < svc.flash.until) vm.text = svc.flash.text;
    svc.win.webContents.executeJavaScript(`window.cxbRender && window.cxbRender(${JSON.stringify(vm)})`).catch(() => {});
  };

  const pageInfo = (svc) => (svc.wc.isDestroyed() ? { url: '', title: '' } : { url: svc.wc.getURL(), title: svc.wc.getTitle() });

  const dispatch = (svc, ev, extra = {}) => {
    const prev = svc.lock;
    svc.lock = lock.reduce(prev, ev);
    render(svc);
    if (prev.state === svc.lock.state && prev.reason === svc.lock.reason) return false;
    send({ event: 'state', service: svc.name, state: svc.lock.state, reason: svc.lock.reason, ...pageInfo(svc), ...extra });
    return true;
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

  function routerFor(name, ses) {
    if (routers.has(name)) return routers.get(name);
    const waiters = [];
    const reserved = new Set();
    const r = { waiters };
    const drop = (w) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
    r.expect = ({ url = null, dir, nameHint = null }) => {
      const w = { url, dir, nameHint, item: null };
      w.started = new Promise((res) => { w.onStart = res; });
      w.done = new Promise((res, rej) => { w.resolve = res; w.reject = rej; });
      w.done.catch(() => {});
      w.cancel = () => drop(w);
      waiters.push(w);
      return w;
    };
    ses.on('will-download', (_e, item) => {
      const chain = item.getURLChain();
      const url = (chain && chain[0]) || '';
      let w = waiters.find((x) => x.url && chain.some((u) => sameUrl(u, x.url)));
      if (!w) w = waiters.find((x) => !x.url);
      if (w) drop(w);
      const mime = item.getMimeType();
      const dir = w ? w.dir : path.join(downloadsRoot, name);
      const t0 = Date.now();
      let file;
      try {
        fs.mkdirSync(dir, { recursive: true });
        file = paths.uniquePath(dir, paths.sanitizeName((w && w.nameHint) || item.getFilename(), mime), (p) => reserved.has(p));
      } catch (e) {
        item.cancel();
        if (w) w.reject(codedError('DOWNLOAD_FAILED', `DOWNLOAD_FAILED: cannot write to ${dir} (${e.code || e.message})`));
        return;
      }
      item.setSavePath(file);
      reserved.add(file);
      let why = null;
      const stopWith = (reason) => { if (!why) { why = reason; item.cancel(); } };
      if (item.getTotalBytes() > DOWNLOAD_MAX_BYTES) stopWith('larger than 500 MB');
      const timer = setTimeout(() => stopWith('not finished after 300s'), DOWNLOAD_DONE_MS);
      item.on('updated', () => { if (item.getReceivedBytes() > DOWNLOAD_MAX_BYTES) stopWith('larger than 500 MB'); });
      if (w) w.onStart(item);
      item.once('done', (_ev, state) => {
        clearTimeout(timer);
        reserved.delete(file);
        if (state !== 'completed') {
          try { fs.unlinkSync(file); } catch {}
          if (w) w.reject(codedError('DOWNLOAD_FAILED', `DOWNLOAD_FAILED: ${why || state}`));
          return;
        }
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch {}
        const out = { file, bytes, mime, magic: magicOf(file), ms: Date.now() - t0, url };
        if (w) {
          w.resolve(keepOrFold(out, w, (p) => reserved.has(p)));
          return;
        }
        send({ event: 'operator-download', service: name, file, bytes, mime });
        const svc = services.get(name);
        if (svc) {
          svc.flash = { text: `Downloaded ${path.basename(file)} → ${dir}`, until: Date.now() + FLASH_MS };
          render(svc);
          setTimeout(() => render(svc), FLASH_MS + 50);
        }
      });
    });
    routers.set(name, r);
    return r;
  }

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
    routerFor(name, ses);
    const slot = services.size;
    const win = new BrowserWindow({
      width: 1280, height: 940, x: 80 + slot * 28, y: 60 + slot * 28, show: false,
      title: `${name} — Clodex Browser`,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('console-message', (...a) => {
      const first = a[0];
      const msg = first && typeof first.message === 'string' ? first.message : a[2];
      const svc = services.get(name);
      if (!svc || svc.win !== win) return;
      if (msg === 'cxb:takeover') takeover(svc);
      else if (msg === 'cxb:handback') handback(svc).catch(() => {});
    });
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
    const svc = {
      name, win, view, wc, ses, doc: 0, busy: 0, reading: 0, lock: lock.reduce(lock.initial(), { type: 'open' }),
      lastInput: 0, popup: false, popupUrl: null, downloading: false, pendingNav: false, flash: null, watch: null, navAt: Date.now(),
      blank: wc.loadURL('about:blank').catch(() => {}),
    };
    driver.installFilters(wc, { driving: () => svc.lock.state === 'driving', onOperator: () => { svc.lastInput = Date.now(); } });
    wc.on('did-start-navigation', (e, ...a) => {
      const main = e && e.isMainFrame != null ? e.isMainFrame : a[2];
      const same = e && e.isSameDocument != null ? e.isSameDocument : a[1];
      if (main && !same) svc.pendingNav = true;
    });
    wc.on('did-navigate', () => { svc.pendingNav = false; if (svc.watch) svc.watch.reset(); svc.doc += 1; svc.navAt = Date.now(); dispatch(svc, { type: 'navigate' }); });
    const failed = (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) svc.pendingNav = false; };
    wc.on('did-fail-load', failed);
    wc.on('did-fail-provisional-load', failed);
    wc.on('did-stop-loading', () => { svc.pendingNav = false; });
    wc.on('did-navigate-in-page', () => render(svc));
    const block = (e, url) => {
      const target = (e && e.url) || url;
      if (!allowedNav(target)) e.preventDefault();
    };
    wc.on('will-navigate', block);
    wc.on('will-frame-navigate', block);
    wc.setWindowOpenHandler(({ url }) => {
      if (svc.lock.state === 'driving') {
        if (svc.downloading) { if (allowedNav(url)) svc.popupUrl = url; return { action: 'deny' }; }
        if (allowedNav(url)) { svc.popup = true; svc.popupUrl = url; wc.loadURL(url).catch(() => {}); }
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
      if (svc.watch) { try { svc.watch.detach(); } catch {} }
      svc.lock = lock.initial();
      send({ event: 'window-closed', service: name });
      dockSync();
      blockerSync();
    });
    services.set(name, svc);
    dockSync();
    win.showInactive();
    send({ event: 'state', service: name, state: 'idle', reason: null, url: '', title: '' });
    return svc;
  }

  const inIsolated = (wc, code) => driver.withTimeout(
    wc.executeJavaScriptInIsolatedWorld(scripts.ISOLATED_WORLD, [{ code }]).catch(() => null),
    driver.SCRIPT_TIMEOUT_MS, null);
  const inMain = (wc, code) => driver.withTimeout(wc.executeJavaScript(code).catch(() => null), driver.SCRIPT_TIMEOUT_MS, null);

  const snapText = (wc) => driver.withTimeout(wc.executeJavaScript(scripts.PAGE_TEXT).catch(() => null), SNAP_MS, null);

  const probe = async (svc) => (await inIsolated(svc.wc, scripts.LOGIN_PROBE)) || {};

  const need = (name) => {
    const svc = services.get(name);
    if (!svc || svc.win.isDestroyed() || svc.wc.isDestroyed()) {
      throw codedError('NOT_OPEN', `${name} is not open — [agent:browser open ${name}] <url>`);
    }
    return svc;
  };

  const heldError = (svc) => codedError('HELD', TEXT.held(svc.name, svc.lock.reason));
  const closedError = (name) => codedError('CLOSED', `the operator closed the ${name} window — open it again`);

  const checkDoc = (svc, args) => {
    if (args.expectDoc != null && Number(args.expectDoc) !== svc.doc) {
      throw codedError('STALE_DOC', TEXT.staleDoc(svc.name, svc.wc.getURL()));
    }
  };

  async function resolve(svc, n) {
    const el = await inIsolated(svc.wc, scripts.FIND(n));
    if (!el) throw codedError('NO_ELEMENT', TEXT.noElement(svc.name, n));
    return el;
  }

  async function mutating(svc, frame, what, body) {
    const seat = frame.seat || null;
    if (svc.lock.state === 'held') throw heldError(svc);
    svc.busy += 1;
    blockerSync();
    svc.popup = false;
    svc.popupUrl = null;
    try {
      dispatch(svc, { type: 'gate', seat, what }, { seat });
      const gate = await driver.quietGate({
        lastInputAt: () => svc.lastInput, quietMs, maxMs: gateMaxMs, shouldStop: () => svc.lock.state !== 'gating',
      });
      if (svc.win.isDestroyed() || svc.wc.isDestroyed()) throw closedError(svc.name);
      if (svc.lock.state === 'held') throw heldError(svc);
      if (gate !== 'quiet') {
        dispatch(svc, { type: 'busy' }, { seat });
        throw codedError('OPERATOR_BUSY', TEXT.operatorBusy(svc.name));
      }
      dispatch(svc, { type: 'quiet' }, { seat });
      let out;
      const docAt = svc.doc;
      try {
        out = await body();
      } catch (e) {
        if (!svc.wc.isDestroyed()) {
          if (e && e.handoff) dispatch(svc, { type: 'done', signin: 'login', force: true }, { seat, login: e.handoff });
          else dispatch(svc, { type: 'done' }, { seat });
        }
        throw e;
      }
      if (svc.win.isDestroyed() || svc.wc.isDestroyed()) throw closedError(svc.name);
      if (out && out.idle && !out.idle.ok && svc.wc.isLoading() && !svc.pendingNav && (frame.op === 'open' || svc.doc !== docAt)) {
        svc.wc.stop();
        out.idle.stopped = true;
      }
      const login = await probe(svc);
      const takeover = svc.lock.takeover;
      dispatch(svc, { type: 'done', signin: signinOf(login) }, { seat, login });
      const result = { ...out, ...pageInfo(svc), doc: svc.doc, login, takeover };
      if (svc.popup) result.popup = true;
      if (svc.popup && svc.popupUrl) result.popupUrl = svc.popupUrl;
      if (!takeover && svc.lock.state === 'held') result.held = { reason: svc.lock.reason, login, url: result.url };
      return result;
    } finally {
      svc.busy -= 1;
      blockerSync();
    }
  }

  const idleOf = (idle) => ({ ok: !!idle.ok, ms: idle.ms, inflight: idle.inflight || [] });
  const actOpts = (svc) => ({ timeoutMs: ACT_IDLE_MS, shouldStop: () => svc.lock.takeover });

  async function opOpen(name, frame, args) {
    const url = checkOpenUrl(String(args.url || ''));
    const svc = openService(name);
    await svc.blank;
    return mutating(svc, frame, `open ${url.slice(0, 80)}`, async () => {
      let status = null;
      const onNav = (_e, _url, code) => { status = code; };
      svc.wc.on('did-navigate', onNav);
      try {
        ensureCdp(svc);
        if (!svc.watch) svc.watch = await driver.armIdle(svc.wc).catch(() => null);
        let navErr = null;
        const load = () => driver.withTimeout(svc.wc.loadURL(url).catch((e) => { navErr = e; }), LOAD_TIMEOUT_MS);
        const { idle } = await driver.act(svc.wc, load, { timeoutMs: OPEN_IDLE_MS, shouldStop: () => svc.lock.takeover });
        if (svc.wc.isDestroyed()) throw closedError(name);
        if (navErr && status == null) throw codedError('NAV_FAILED', `NAV_FAILED: ${navErr.code || navErr.message} for ${url}`);
        return { status, idle: idleOf(idle) };
      } finally {
        if (!svc.wc.isDestroyed()) svc.wc.removeListener('did-navigate', onNav);
      }
    });
  }

  async function opAct(name, frame, args) {
    const svc = need(name);
    const op = frame.op;
    const byText = op === 'click' && args.byText != null ? String(args.byText) : null;
    let n = Number(args.n);
    const dir = args.dir == null ? path.join(downloadsRoot, svc.name) : String(args.dir);
    if (!path.isAbsolute(dir)) throw codedError('INTERNAL', 'click needs an absolute dir');
    if (byText == null) checkDoc(svc, args);
    const what = op === 'key' ? `press ${args.key}` : byText != null ? `click --text=${JSON.stringify(byText)}` : `${op} [${n}]`;
    return mutating(svc, frame, what, async () => {
      ensureCdp(svc);
      const wc = svc.wc;
      await driver.emulateFocus(wc);
      const docBefore = svc.doc;
      if (op === 'key') {
        if (!driver.KEYS[args.key]) throw codedError('INTERNAL', `unknown key ${args.key}`);
        const before = await snapText(wc);
        const { idle } = await driver.act(wc, () => driver.pressKey(wc, args.key), actOpts(svc));
        return withChange(svc, before, { navigated: svc.doc !== docBefore, idle: idleOf(idle) });
      }
      if (byText == null) checkDoc(svc, args);
      let fresh = false;
      if (byText != null) ({ n, fresh } = await textTarget(svc, byText));
      const el = await resolve(svc, n);
      dispatch(svc, { type: 'describe', what: `${op} [${n}]${el.label ? ' ' + JSON.stringify(el.label) : ''}` });
      const before = await snapText(wc);
      if (op === 'click') {
        const out = await clickWatched(svc, n, el, docBefore, dir);
        if (fresh) out.fresh = true;
        return withChange(svc, before, out);
      }
      if (op === 'type') {
        if (el.password || el.otp) {
          const e = codedError('PASSWORD_FIELD', TEXT.passwordField(svc.name, n));
          e.handoff = { password: !!el.password, otp: !!el.otp };
          throw e;
        }
        if (!el.editable) throw codedError('NOT_EDITABLE', TEXT.notEditable(n, el.kind));
        const text = String(args.text || '');
        const { idle } = await driver.act(wc, async () => {
          driver.click(wc, el);
          await inIsolated(wc, scripts.CLEAR(n));
          await driver.typeText(wc, text);
          if (args.enter) driver.pressKey(wc, 'Enter');
        }, actOpts(svc));
        const out = await withChange(svc, before, { kind: el.kind, label: el.label, navigated: svc.doc !== docBefore, idle: idleOf(idle) });
        if (out.changed === '' && !wc.isDestroyed()) {
          const value = await inIsolated(wc, scripts.VALUE(n));
          if (typeof value === 'string') out.value = value;
        }
        return out;
      }
      let picked = null;
      const { idle } = await driver.act(wc, async () => {
        picked = await inIsolated(wc, scripts.SELECT(n, String(args.option || '')));
      }, actOpts(svc));
      if (!picked) throw codedError('NO_ELEMENT', TEXT.noElement(svc.name, n));
      if (picked.err === 'NOT_SELECT') throw codedError('NOT_SELECT', TEXT.notSelect(n));
      if (picked.err === 'NO_OPTION') {
        const list = picked.options.slice(0, 20).map((o) => JSON.stringify(o)).join(', ')
          + (picked.options.length > 20 ? `, …(+${picked.options.length - 20} more)` : '');
        throw codedError('NO_OPTION', picked.ambiguous
          ? `${JSON.stringify(String(args.option))} matches ${picked.options.length} options of [${n}]: ${list} — use the exact text`
          : `no option ${JSON.stringify(String(args.option))} in [${n}] — options: ${list}`);
      }
      return withChange(svc, before, {
        kind: el.kind, label: el.label, value: picked.value, text: picked.text, navigated: svc.doc !== docBefore, idle: idleOf(idle),
      });
    });
  }

  async function withChange(svc, before, out) {
    if (before == null || out.navigated || out.download || svc.popup || svc.popupUrl || svc.wc.isDestroyed()) return out;
    const after = await snapText(svc.wc);
    if (after != null) out.changed = changedRegion(before, after, CHANGE_MAX);
    return out;
  }

  async function textTarget(svc, text, verb = 'click') {
    const found = await inIsolated(svc.wc, scripts.FIND_TEXT(text));
    if (!found || !found.count) throw codedError('NO_ELEMENT', TEXT.noText(svc.name, text));
    if (found.count > 1) throw codedError('AMBIGUOUS', TEXT.manyText(svc.name, text, found.count, found.hits, verb));
    return { n: found.hits[0].n, fresh: !!found.hits[0].fresh };
  }

  async function clickWatched(svc, n, el, docBefore, dir) {
    const wc = svc.wc;
    const w = routerFor(svc.name, svc.ses).expect({ dir });
    let began = false;
    let pdf = false;
    let acting = true;
    w.started.then(() => { began = true; });
    const watchPdf = (async () => {
      while (acting && !pdf) {
        await driver.sleep(250);
        if (acting && svc.popupUrl && !wc.isDestroyed()) pdf = await inMain(wc, scripts.CONTENT_TYPE) === 'application/pdf';
      }
    })();
    try {
      const { idle } = await driver.act(wc, () => driver.click(wc, el), { ...actOpts(svc), shouldStop: () => svc.lock.takeover || began || pdf })
        .finally(() => { acting = false; });
      await watchPdf;
      const out = { n, kind: el.kind, label: el.label, idle: idleOf(idle) };
      const deadline = Date.now() + CLICK_DOWNLOAD_MS;
      if (began) out.download = await settleDownload(w, deadline);
      else if (svc.popupUrl && await inMain(wc, scripts.CONTENT_TYPE) === 'application/pdf') {
        w.cancel();
        const pw = routerFor(svc.name, svc.ses).expect({ url: wc.getURL(), dir });
        wc.downloadURL(wc.getURL());
        out.download = await settleDownload(pw, deadline);
        if (out.download) out.download.url = svc.popupUrl;
        pw.cancel();
        if (wc.navigationHistory && wc.navigationHistory.canGoBack()) {
          await driver.act(wc, () => wc.navigationHistory.goBack(), { timeoutMs: CLICK_DOWNLOAD_MS });
        }
      }
      if (!out.download) delete out.download;
      out.navigated = svc.doc !== docBefore;
      return out;
    } finally {
      w.abandoned = true;
      w.cancel();
    }
  }

  function downloadUrlOf(svc, raw) {
    let u;
    try { u = new URL(String(raw), svc.wc.getURL() || undefined); } catch { throw codedError('BAD_URL', `not a URL: ${raw}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw codedError('BAD_URL', `only http: and https: URLs can be downloaded, not ${u.protocol}`);
    if (u.username || u.password) throw codedError('BAD_URL', 'a URL with user:pass@ is refused');
    return u.href;
  }

  async function landed(w, startMs) {
    let t;
    const started = await Promise.race([w.started.then(() => true), w.done.then(() => true, () => true),
      new Promise((r) => { t = setTimeout(() => r(false), startMs); })]);
    clearTimeout(t);
    if (!started) {
      w.cancel();
      throw codedError('DOWNLOAD_FAILED', 'DOWNLOAD_FAILED: the download did not start within 30s');
    }
    return w.done;
  }

  async function viaUrl(svc, url, dir, nameHint) {
    const w = routerFor(svc.name, svc.ses).expect({ url, dir, nameHint });
    svc.wc.downloadURL(url);
    return landed(w, DOWNLOAD_START_MS);
  }

  async function viaClick(svc, n, el, dir, nameHint) {
    const wc = svc.wc;
    const w = routerFor(svc.name, svc.ses).expect({ dir, nameHint });
    const t0 = Date.now();
    svc.popupUrl = null;
    try {
      await driver.act(wc, () => driver.click(wc, el), actOpts(svc));
      for (;;) {
        const got = await Promise.race([w.started.then(() => true), driver.sleep(250).then(() => false)]);
        if (got) return await w.done;
        if (svc.popupUrl || Date.now() - t0 >= DOWNLOAD_START_MS) break;
        if (await inMain(wc, scripts.CONTENT_TYPE) === 'application/pdf') break;
      }
      w.cancel();
      if (await inMain(wc, scripts.CONTENT_TYPE) === 'application/pdf') {
        const out = await viaUrl(svc, wc.getURL(), dir, nameHint);
        if (wc.navigationHistory && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return out;
      }
      if (svc.popupUrl) return await viaUrl(svc, svc.popupUrl, dir, nameHint);
      throw codedError('DOWNLOAD_TIMEOUT',
        `nothing downloaded within 30s after clicking [${n}] — read ${svc.name} to see what happened, or download its URL`);
    } finally {
      w.cancel();
    }
  }

  async function opDownload(name, frame, args) {
    const svc = need(name);
    const dir = String(args.dir || '');
    if (!path.isAbsolute(dir)) throw codedError('INTERNAL', 'download needs an absolute dir');
    const n = args.n == null ? null : Number(args.n);
    if (n != null) checkDoc(svc, args);
    const what = n != null ? `download [${n}]` : 'download';
    const t0 = Date.now();
    return mutating(svc, frame, what, async () => {
      ensureCdp(svc);
      await driver.emulateFocus(svc.wc);
      svc.downloading = true;
      try {
        let out;
        if (n != null) {
          checkDoc(svc, args);
          const el = await resolve(svc, n);
          dispatch(svc, { type: 'describe', what: `download [${n}]${el.label ? ' ' + JSON.stringify(el.label) : ''}` });
          const hint = args.as || el.download || null;
          if (paths.directHref(el.href, svc.wc.getURL())) out = await viaUrl(svc, downloadUrlOf(svc, el.href), dir, hint);
          else out = await viaClick(svc, n, el, dir, hint);
        } else {
          const url = downloadUrlOf(svc, args.url || svc.wc.getURL());
          out = await viaUrl(svc, url, dir, args.as || null);
        }
        return { ...out, ms: Date.now() - t0 };
      } finally {
        svc.downloading = false;
      }
    });
  }

  async function opScreenshot(name) {
    const svc = need(name);
    const wc = svc.wc;
    let img = await wc.capturePage();
    const empty = !img || img.isEmpty();
    if (empty) {
      process.stderr.write(`screenshot ${name}: capturePage was empty, using CDP\n`);
      ensureCdp(svc);
      const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: SHOT_QUALITY });
      img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    }
    if (img.isEmpty()) throw codedError('INTERNAL', `the ${name} window gave an empty screenshot`);
    if (img.getSize().width > SHOT_WIDTH) img = img.resize({ width: SHOT_WIDTH, quality: 'good' });
    const { width, height } = img.getSize();
    return { jpeg: img.toJPEG(SHOT_QUALITY).toString('base64'), width, height, fallback: empty };
  }

  async function opForget(name) {
    const svc = services.get(name);
    if (svc && !svc.win.isDestroyed()) svc.win.destroy();
    const ses = session.fromPartition('persist:' + name);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache().catch(() => {});
    return { forgotten: name };
  }

  async function listenersOf(svc, n) {
    ensureCdp(svc);
    const dbg = svc.wc.debugger;
    const group = 'cx-inspect';
    const typesAt = async (k) => {
      const expression = `(() => { let e = document.querySelector('[data-cx="${Number(n) | 0}"]');
        for (let i = 0; i < ${k} && e; i++) e = e.parentElement || (e.parentNode && e.parentNode.host) || null; return e; })()`;
      const { result } = await dbg.sendCommand('Runtime.evaluate', { expression, objectGroup: group });
      if (!result || !result.objectId) return null;
      const { listeners } = await dbg.sendCommand('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
      return [...new Set((listeners || []).map((l) => l.type))];
    };
    try {
      const types = await typesAt(0);
      if (!types) return null;
      const out = { types };
      if (!types.some((t) => CLICKISH.includes(t))) {
        for (let k = 1; k <= 4; k++) {
          const up = await typesAt(k);
          if (!up) break;
          const hit = CLICKISH.find((t) => up.includes(t));
          if (hit) { out.ancestorAt = k; out.ancestorType = hit; break; }
        }
      }
      return out;
    } finally {
      await dbg.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    }
  }

  async function opInspect(name, frame, args) {
    const svc = need(name);
    if (svc.lock.state === 'held') throw heldError(svc);
    if (args.byText == null) checkDoc(svc, args);
    svc.reading += 1;
    blockerSync();
    try {
      const { n, fresh } = args.byText != null ? await textTarget(svc, String(args.byText), 'inspect') : { n: Number(args.n), fresh: false };
      const r = await inIsolated(svc.wc, scripts.INSPECT(n));
      if (!r) throw codedError('NO_ELEMENT', TEXT.noElement(svc.name, n));
      const listeners = await driver.withTimeout(listenersOf(svc, n).catch(() => null), driver.SCRIPT_TIMEOUT_MS, null);
      if (listeners && listeners.ancestorAt) listeners.ancestor = r.ancestors[listeners.ancestorAt - 1] || '?';
      return { n, ...r, listeners, ...(fresh ? { fresh: true } : {}) };
    } finally {
      svc.reading -= 1;
      blockerSync();
    }
  }

  async function opRead(name, frame, args) {
    const svc = need(name);
    if (svc.lock.state === 'held') throw heldError(svc);
    svc.reading += 1;
    blockerSync();
    try {
      const r = await readPage(name, svc, args);
      const reason = signinOf(r.login);
      if (reason && svc.lock.state === 'idle' && dispatch(svc, { type: 'signin', reason }, { seat: frame.seat || null, login: r.login })) {
        r.held = { reason, login: r.login, url: r.url };
      }
      return r;
    } finally {
      svc.reading -= 1;
      blockerSync();
    }
  }

  async function opIdle(name, args) {
    const svc = need(name);
    const ms = Math.max(1, Number(args.ms) || 15000);
    if (args.forText) {
      const t = Date.now();
      const want = JSON.stringify(String(args.forText));
      for (;;) {
        const has = await inMain(svc.wc, `!!(document.body && document.body.innerText.includes(${want}))`);
        if (has) return { ok: true, found: true, ms: Date.now() - t };
        if (Date.now() - t >= ms) return { ok: false, found: false, ms: Date.now() - t };
        await driver.sleep(250);
      }
    }
    const r = await driver.waitIdle(svc.wc, { timeoutMs: ms });
    return idleOf(r);
  }

  function takeover(svc) {
    dispatch(svc, { type: 'takeover' });
    return { state: svc.lock.state };
  }

  async function handback(svc) {
    if (svc.lock.state !== 'held') return { state: svc.lock.state };
    await driver.pinSessionCookies(svc.ses).catch(() => 0);
    const login = svc.wc.isDestroyed() ? {} : await probe(svc);
    if (svc.lock.state === 'held') dispatch(svc, { type: 'handback' }, { handback: true, login });
    return { state: svc.lock.state };
  }

  function operatorOp(op, name) {
    const svc = need(name);
    if (op === 'hold') return takeover(svc);
    if (op === 'handback') return handback(svc);
    svc.win.show();
    svc.win.focus();
    app.focus({ steal: true });
    return {};
  }

  async function readPage(name, svc, args) {
    const wc = svc.wc;
    const main = args.scope === 'main';
    const contentType = await inMain(wc, scripts.CONTENT_TYPE);
    const base = { url: wc.getURL(), title: wc.getTitle(), doc: svc.doc, contentType };
    if (contentType === 'application/pdf') return base;
    let got = await inMain(wc, scripts.READ_TEXT(main));
    if (got == null) got = await inMain(wc, scripts.READ_TEXT(main));
    const text = got == null ? null : typeof got === 'string' ? got : String(got.text || '');
    const busy = got && got.busy && got.busy.count > 0 ? { count: got.busy.count, text: String(got.busy.text || '') } : null;
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
      loading: loadingOf(svc),
      ...(busy ? { busy } : {}),
    };
  }

  function loadingOf(svc) {
    const w = svc.watch;
    const inflight = w ? w.size(LOADING_INFLIGHT_MS) : 0;
    const since = Math.max(svc.navAt || 0, w ? w.lastNet() : 0);
    return { active: svc.wc.isLoading() || inflight > 0, inflight, ms: Date.now() - since };
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
      else if (SERVICE_OPS.has(op)) {
        const name = String(frame.service || '');
        if (!SERVICE_RE.test(name)) throw codedError('INTERNAL', `bad service name: ${name}`);
        if (op === 'hold' || op === 'handback' || op === 'show') result = await operatorOp(op, name);
        else if (op === 'forget') result = await serial(name, () => opForget(name));
        else {
          result = await serial(name, () => {
            if (op === 'open') return opOpen(name, frame, args);
            if (op === 'read') return opRead(name, frame, args);
            if (op === 'inspect') return opInspect(name, frame, args);
            if (op === 'idle') return opIdle(name, args);
            if (op === 'download') return opDownload(name, frame, args);
            if (op === 'screenshot') return opScreenshot(name);
            return opAct(name, frame, args);
          });
        }
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

module.exports = { run, keepOrFold, settleDownload };
