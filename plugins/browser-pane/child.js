'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const driver = require('./driver');
const scripts = require('./page-scripts');
const lock = require('./lock');
const { TEXT } = require('./replies');
const paths = require('./paths');
const urlpolicy = require('./urlpolicy');
const keys = require('./keys');
const { changedRegion, CHANGE_MAX, hostOf } = require('./read-format');

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
const LATE_CHANGE_MS = 3000;
const LATE_STEP_MS = 500;
const BASELINE_GAP_MS = 300;
const ORIGINS_MAX = 8;
const NUMBERS_SCHEMA = 1;
const NUMBERS_SAVE_MS = 1000;
const SLUG_MAX = 120;
const GEN_OPS = new Set(['click', 'type', 'select', 'download', 'inspect']);
const HMS = /\b\d{1,2}:\d{2}:\d{2}\b/g;
const CLASS_NOISE = /focus|hover|ripple/i;
const LOADING_INFLIGHT_MS = 300;
const CLICKISH = ['click', 'mousedown', 'pointerdown', 'mouseup'];
const DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;
const FLASH_MS = 4000;
const BAR_MSG_MS = 5000;
const DENY_DEDUPE_MS = 1000;
const SHOT_WIDTH = 1280;
const SHOT_QUALITY = 80;
const CODES = new Set(['NOT_OPEN', 'NO_ELEMENT', 'HELD', 'OPERATOR_BUSY', 'PASSWORD_FIELD', 'NOT_SELECT', 'NO_OPTION',
  'NOT_EDITABLE', 'BAD_URL', 'NAV_FAILED', 'TOO_MANY_WINDOWS', 'CLOSED', 'TIMEOUT', 'INTERNAL', 'DOWNLOAD_TIMEOUT', 'DOWNLOAD_FAILED', 'AMBIGUOUS', 'DENIED', 'CONSEQUENTIAL', 'RESTARTED']);
const SERVICE_OPS = new Set(['open', 'read', 'click', 'type', 'key', 'select', 'idle', 'hold', 'handback', 'show', 'download', 'screenshot', 'forget', 'inspect', 'policy']);

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

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function blankNumbers(origin) {
  return { origin, numbers: new Map(), byN: new Map(), nextN: 1, volatile: new Set(), lastRead: null, listed: new Set(), restoredAt: null };
}

function originSlug(origin) {
  return String(origin).toLowerCase().replace(/[^a-z0-9.-]/g, '_').slice(0, SLUG_MAX);
}

function numbersFile(dir, origin) {
  return path.join(dir, originSlug(origin) + '.json');
}

const persistable = (dir, origin) => !!dir && !!origin && origin !== 'null';

function loadNumbers(dir, origin, now = Date.now()) {
  if (!persistable(dir, origin)) return null;
  const file = numbersFile(dir, origin);
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!j || j.v !== NUMBERS_SCHEMA || j.origin !== origin || !j.numbers || typeof j.numbers !== 'object' || !Number.isInteger(j.nextN)) return null;
  const e = blankNumbers(origin);
  for (const [k, n] of Object.entries(j.numbers)) {
    if (!Number.isInteger(n) || n < 1) continue;
    e.numbers.set(k, n);
    e.byN.set(n, k);
  }
  e.nextN = Math.max(1, j.nextN, ...[...e.byN.keys()].map((n) => n + 1));
  for (const v of Array.isArray(j.volatile) ? j.volatile : []) e.volatile.add(String(v));
  for (const n of Array.isArray(j.listed) ? j.listed : []) if (Number.isInteger(n)) e.listed.add(n);
  let mtime = '';
  try { mtime = fs.statSync(file).mtime.toISOString(); } catch {}
  e.restoredAt = typeof j.savedAt === 'string' ? j.savedAt : mtime;
  try { fs.utimesSync(file, now / 1000, now / 1000); } catch {}
  return e;
}

function notOpenError(name, opened, numbersDir) {
  let saved = [];
  try { saved = fs.readdirSync(numbersDir).filter((f) => !f.startsWith('.')); } catch {}
  if (opened.has(name) || saved.includes(name)) return codedError('NOT_OPEN', `${name} is not open — [agent:browser open ${name}] <url>`);
  return codedError('NOT_OPEN', TEXT.notService(name, [...new Set([...opened, ...saved])].sort()));
}

function pruneNumbers(dir, max = ORIGINS_MAX) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
  const files = names.map((f) => {
    const file = path.join(dir, f);
    try { return { file, at: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  for (const { file } of files.slice(max)) { try { fs.unlinkSync(file); } catch {} }
}

function saveNumbers(dir, e, now = Date.now()) {
  if (!e || !persistable(dir, e.origin)) return false;
  const file = numbersFile(dir, e.origin);
  const body = {
    v: NUMBERS_SCHEMA, origin: e.origin, numbers: Object.fromEntries(e.numbers), nextN: e.nextN, volatile: [...e.volatile], listed: [...e.listed], savedAt: new Date(now).toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file);
    fs.utimesSync(file, now / 1000, now / 1000);
  } catch { return false; }
  pruneNumbers(dir);
  return true;
}

function flushNumbers(svc, now = Date.now()) {
  if (!svc.dirty) return;
  for (const e of svc.dirty) saveNumbers(svc.numDir, e, now);
  svc.dirty.clear();
}

function forgetNumbers(svc, dir) {
  if (svc) {
    if (svc.saveTimer) clearTimeout(svc.saveTimer);
    svc.saveTimer = null;
    if (svc.dirty) svc.dirty.clear();
    if (svc.origins) svc.origins.clear();
    svc.num = null;
    svc.numDir = null;
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function genRefusal(service, op, args, gen) {
  if (!GEN_OPS.has(op) || !args || args.n == null || args.byText != null || args.gen === undefined) return null;
  return Number(args.gen) === gen ? null : codedError('RESTARTED', TEXT.restarted(service));
}

function numState(svc, url) {
  const origin = originOf(url);
  let e = svc.origins.get(origin);
  if (e) svc.origins.delete(origin);
  else e = loadNumbers(svc.numDir, origin) || blankNumbers(origin);
  svc.origins.set(origin, e);
  while (svc.origins.size > ORIGINS_MAX) svc.origins.delete(svc.origins.keys().next().value);
  svc.num = e;
  return { known: Object.fromEntries(e.numbers), next: e.nextN, volatile: [...e.volatile] };
}

function mergeNumbers(svc, out) {
  const e = svc.num;
  if (!e || !out || !out.assigned) return;
  for (const [k, n] of Object.entries(out.assigned)) { e.numbers.set(k, Number(n)); e.byN.set(Number(n), k); }
  if (Number(out.next) > e.nextN) e.nextN = Number(out.next);
  if (!svc.numDir) return;
  if (!svc.dirty) svc.dirty = new Set();
  svc.dirty.add(e);
  if (svc.scheduleSave) svc.scheduleSave();
}

function numberRefusal(service, n, stored, verdict) {
  if (stored == null) return codedError('NO_ELEMENT', TEXT.unknownN(service, n));
  if (verdict === 'ok') return null;
  const p = keys.parseStored(stored);
  const label = p.label.length > 60 ? p.label.slice(0, 59) + '…' : p.label;
  if (verdict === 'ambiguous') return codedError('AMBIGUOUS', TEXT.ambiguousN(service, n, label, p.context));
  if (verdict && verdict.verdict === 'retired') return codedError('NO_ELEMENT', TEXT.retiredN(service, n, verdict.now));
  return codedError('NO_ELEMENT', TEXT.noElement(service, n));
}

function navOf({ docBefore, docAfter, hrefBefore, hrefAfter, download = false }) {
  const moved = !sameUrl(hrefBefore, hrefAfter);
  if (docAfter === docBefore) return moved ? { navigated: true, inPage: true } : { navigated: false };
  if (download && !moved) return { navigated: false };
  return { navigated: true };
}

const digitMask = (l) => l.replace(/\d/g, '#');

function tickersOf(a, b) {
  const out = new Set();
  if (a == null || b == null) return out;
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  for (const l of [...x.slice(i, x.length - j), ...y.slice(i, y.length - j)]) out.add(digitMask(l));
  return out;
}

const normOf = (tickers) => (l) => (tickers.has(digitMask(l)) ? `\u0001${digitMask(l)}` : l.replace(HMS, '#:##:##'));

function targetDiff(before, after) {
  if (!before || !after) return null;
  const parts = [];
  let strong = false;
  for (const [where, b, a] of [['', before.el, after.el], ['tile ', before.tile, after.tile]]) {
    if (!b || !a) continue;
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
      if (b[k] === a[k]) continue;
      if (k === 'class') {
        const bs = new Set(String(b[k] || '').split(/\s+/).filter(Boolean));
        const as = new Set(String(a[k] || '').split(/\s+/).filter(Boolean));
        const d = [...[...as].filter((c) => !bs.has(c)).map((c) => `+${c}`), ...[...bs].filter((c) => !as.has(c)).map((c) => `-${c}`)]
          .filter((c) => !CLASS_NOISE.test(c));
        if (d.length) parts.push(`${where}class ${d.join(' ')}`);
        continue;
      }
      strong = true;
      const q = (v) => (v == null ? 'none' : JSON.stringify(String(v).length > 60 ? `${String(v).slice(0, 59)}…` : String(v)));
      parts.push(`${where}${k} ${q(b[k])} → ${q(a[k])}`);
    }
  }
  return parts.length ? { text: parts.join(', '), strong } : null;
}

async function settleChange({
  before, tickers = new Set(), snap, target = null, targetBefore = null, sleepFn = driver.sleep, now = Date.now, lateMs = LATE_CHANGE_MS, stepMs = LATE_STEP_MS,
}) {
  const norm = normOf(tickers);
  const t0 = now();
  let changed = null;
  let tgt = null;
  for (;;) {
    const after = await snap();
    if (after != null) changed = changedRegion(before, after, CHANGE_MAX, norm);
    if (target && targetBefore) tgt = targetDiff(targetBefore, await target());
    if (changed || (tgt && tgt.strong) || now() - t0 >= lateMs) break;
    await sleepFn(stepMs);
  }
  return { changed, target: tgt ? tgt.text : null };
}

const RETIRED_PREFIX = 60;

function numberVerdict(verdict, stored, pageKeys) {
  if (verdict === 'ok' || verdict === 'ambiguous') return verdict;
  if (!pageKeys) return 'gone';
  const p = keys.parseStored(stored);
  const entries = Object.entries(pageKeys);
  if (entries.some(([, k]) => keys.parseStored(k).base === p.base)) return 'ambiguous';
  const head = p.label.slice(0, RETIRED_PREFIX);
  const now = head ? entries.find(([, k]) => { const q = keys.parseStored(k); return q.kind === p.kind && q.label.slice(0, RETIRED_PREFIX) === head; }) : null;
  return now ? { verdict: 'retired', now: Number(now[0]) } : 'gone';
}

function inspectKind(r, listeners) {
  if (!r || r.kind !== 'clickable' || r.marked || r.cursor === 'pointer' || !listeners) return r && r.kind;
  if ((listeners.types || []).some((t) => CLICKISH.includes(t)) || listeners.ancestorAt) return r.kind;
  return 'element';
}

function retiredOf(prevKeys, curKeys, sameDoc) {
  if (!prevKeys || !curKeys) return [];
  const cur = new Set(Object.values(curKeys));
  const bases = new Set([...cur].map((k) => keys.parseStored(k).base));
  return Object.entries(prevKeys)
    .filter(([, k]) => !cur.has(k) && (sameDoc || bases.has(keys.parseStored(k).base)))
    .map(([n]) => Number(n)).sort((a, b) => a - b);
}

const SIGNIN_REASONS = new Set(['login', 'otp', 'captcha', 'idp']);

function signinHold(svc) {
  return !!svc && !!svc.lock && svc.lock.state === 'held' && SIGNIN_REASONS.has(svc.lock.reason);
}

function lateMsFor(op) {
  return op === 'click' || op === 'select' ? LATE_CHANGE_MS : 0;
}

function consequentialRefusal(n, el, confirm) {
  if (!el || !el.consequential || confirm) return null;
  return codedError('CONSEQUENTIAL', TEXT.consequential(n, el.label, el.consequential));
}

function rowChanged(lastRead, n, row) {
  const before = lastRead && lastRead.rows ? lastRead.rows[n] : null;
  return before != null && row != null && before !== row;
}

function changedOf(prevSigs, curSigs) {
  if (!prevSigs || !curSigs) return [];
  return Object.keys(curSigs).filter((n) => prevSigs[n] != null && prevSigs[n] !== curSigs[n])
    .map(Number).sort((a, b) => a - b);
}

function wireHost({ stdin, stdout, shutdown }) {
  let broken = false;
  stdout.on('error', () => {
    if (broken) return;
    broken = true;
    shutdown();
  });
  stdin.on('end', () => shutdown());
  stdin.on('close', () => shutdown());
  return (frame) => {
    if (broken) return;
    try { stdout.write(JSON.stringify({ cxb: 1, ...frame }) + '\n'); } catch { broken = true; }
  };
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
  const gen = Number((ctx && ctx.gen) || t0);
  const quietMs = Number((ctx && ctx.quietMs) || 3000);
  const gateMaxMs = Number((ctx && ctx.gateMaxMs) || 60000);
  const services = new Map();
  const opened = new Set();
  const chains = new Map();
  const partitions = new Set();
  const routers = new Map();
  let blockerId = null;
  let shuttingDown = false;

  const send = wireHost({ stdin: process.stdin, stdout: process.stdout, shutdown: () => shutdown() });

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
    vm.editable = svc.lock.state === 'idle' || svc.lock.state === 'held';
    vm.canBack = !svc.wc.isDestroyed() && !!(svc.wc.navigationHistory && svc.wc.navigationHistory.canGoBack());
    if (svc.barMsg && Date.now() < svc.barMsg.until) vm.msg = svc.barMsg.text;
    svc.win.webContents.executeJavaScript(`window.cxbRender && window.cxbRender(${JSON.stringify(vm)})`).catch(() => {});
  };

  const policyDenies = (svc, url, by) => {
    const hit = svc.policy ? svc.policy(url) : null;
    if (!hit) return null;
    const now = Date.now();
    const seen = svc.lastDenied && svc.lastDenied.url === url && now - svc.lastDenied.at < DENY_DEDUPE_MS;
    svc.lastDenied = { url, at: now };
    if (!seen) send({ event: 'denied', service: svc.name, url, pattern: hit.pattern, list: hit.list, by });
    return hit;
  };

  const operatorNav = (svc, inPage) => {
    const info = pageInfo(svc);
    if (!info.url || info.url === 'about:blank' || signinHold(svc)) return;
    send({ event: 'operator-nav', service: svc.name, ...info, ...(inPage ? { inPage: true } : {}) });
  };

  const deniedError = (svc, url, hit, verb) => codedError('DENIED', TEXT.denied(url, hit.pattern, hit.list === 'service' ? svc.name : null, verb));

  const barSay = (svc, text) => {
    svc.barMsg = { text, until: Date.now() + BAR_MSG_MS };
    render(svc);
    setTimeout(() => render(svc), BAR_MSG_MS + 50);
  };

  const pageInfo = (svc) => (svc.wc.isDestroyed() ? { url: '', title: '', gen } : { url: svc.wc.getURL(), title: svc.wc.getTitle(), gen });

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
      const owner = services.get(name);
      const hit = owner ? (chain || []).reduce((h, u) => h || policyDenies(owner, u, w ? 'agent' : 'page'), null) : null;
      if (hit) {
        item.cancel();
        if (w) w.reject(deniedError(owner, url, hit, 'download'));
        return;
      }
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
    opened.add(name);
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
      else if (msg === 'cxb:back' || msg === 'cxb:reload') barNav(svc, msg.slice(4)).catch(() => {});
      else if (typeof msg === 'string' && msg.startsWith('cxb:go ')) barNav(svc, 'go', msg.slice(7)).catch(() => {});
    });
    win.webContents.on('before-input-event', () => {
      const svc = services.get(name);
      if (svc && svc.win === win) svc.lastInput = Date.now();
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
      policy: null, barMsg: null, lastDenied: null, blockedNav: null,
      origins: new Map(), num: null, agentNav: false, opNav: false, lastHref: '', numDir: path.join(data, 'numbers', name), dirty: new Set(), saveTimer: null,
      blank: wc.loadURL('about:blank').catch(() => {}),
    };
    svc.scheduleSave = () => {
      if (svc.saveTimer) return;
      svc.saveTimer = setTimeout(() => { svc.saveTimer = null; flushNumbers(svc); }, NUMBERS_SAVE_MS);
    };
    driver.installFilters(wc, { driving: () => svc.lock.state === 'driving', onOperator: () => { svc.lastInput = Date.now(); } });
    wc.on('did-start-navigation', (e, ...a) => {
      const main = e && e.isMainFrame != null ? e.isMainFrame : a[2];
      const same = e && e.isSameDocument != null ? e.isSameDocument : a[1];
      if (main && !same) { svc.pendingNav = true; if (svc.busy > 0) svc.agentNav = true; }
    });
    wc.on('did-navigate', () => {
      const agent = svc.busy > 0 || svc.agentNav;
      svc.pendingNav = false;
      svc.agentNav = false;
      if (svc.watch) svc.watch.reset();
      svc.doc += 1;
      svc.navAt = Date.now();
      svc.lastHref = wc.getURL();
      dispatch(svc, { type: 'navigate' });
      if (!agent) svc.opNav = true;
    });
    const failed = (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame) { svc.pendingNav = false; svc.agentNav = false; } };
    wc.on('did-fail-load', failed);
    wc.on('did-fail-provisional-load', failed);
    wc.on('did-stop-loading', () => {
      svc.pendingNav = false;
      svc.agentNav = false;
      if (!svc.opNav) return;
      svc.opNav = false;
      operatorNav(svc, false);
    });
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      render(svc);
      if (isMainFrame === false || wc.isDestroyed()) return;
      const href = wc.getURL();
      if (href === svc.lastHref) return;
      svc.lastHref = href;
      if (svc.busy === 0) operatorNav(svc, true);
    });
    const block = (e, url) => {
      const target = (e && e.url) || url;
      if (!allowedNav(target)) { e.preventDefault(); return; }
      const hit = policyDenies(svc, target, 'page');
      if (hit) { svc.blockedNav = { url: target, hit }; e.preventDefault(); }
    };
    const popupOpts = { webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } };
    const guardPopup = (pwc) => {
      for (const ev of ['will-navigate', 'will-frame-navigate', 'will-redirect']) pwc.on(ev, block);
      pwc.setWindowOpenHandler(({ url }) => (policyDenies(svc, url, 'page') ? { action: 'deny' } : { action: 'allow', overrideBrowserWindowOptions: popupOpts }));
      pwc.on('did-create-window', (w) => guardPopup(w.webContents));
    };
    wc.on('will-navigate', block);
    wc.on('will-frame-navigate', block);
    wc.on('will-redirect', block);
    wc.on('did-create-window', (w) => guardPopup(w.webContents));
    wc.setWindowOpenHandler(({ url }) => {
      if (policyDenies(svc, url, 'page')) return { action: 'deny' };
      if (svc.lock.state === 'driving') {
        if (svc.downloading) { if (allowedNav(url)) svc.popupUrl = url; return { action: 'deny' }; }
        if (allowedNav(url)) { svc.popup = true; svc.popupUrl = url; wc.loadURL(url).catch(() => {}); }
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: popupOpts };
    });
    win.webContents.on('did-finish-load', () => render(svc));
    try { ensureCdp(svc); } catch {}
    win.on('closed', () => {
      if (services.get(name) === svc) services.delete(name);
      if (svc.saveTimer) clearTimeout(svc.saveTimer);
      svc.saveTimer = null;
      flushNumbers(svc);
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
    if (!svc || svc.win.isDestroyed() || svc.wc.isDestroyed()) throw notOpenError(name, opened, path.join(data, 'numbers'));
    return svc;
  };

  const heldError = (svc) => codedError('HELD', TEXT.held(svc.name, svc.lock.reason));
  const closedError = (name) => codedError('CLOSED', `the operator closed the ${name} window — open it again`);

  const numOf = (svc) => numState(svc, svc.wc.getURL());

  async function stampPage(svc) {
    const out = await inIsolated(svc.wc, scripts.READ_INTERACTIVE(false, numOf(svc)));
    mergeNumbers(svc, out);
    return out;
  }

  async function checkNumber(svc, n) {
    const state = numOf(svc);
    const stored = svc.num.byN.get(Number(n));
    const missing = numberRefusal(svc.name, n, stored, 'ok');
    if (missing) throw missing;
    let verdict = await inIsolated(svc.wc, scripts.CHECK(n, stored, state));
    let page = null;
    if (verdict == null) {
      page = await stampPage(svc);
      verdict = await inIsolated(svc.wc, scripts.CHECK(n, stored, numOf(svc)));
    }
    const refused = numberRefusal(svc.name, n, stored, numberVerdict(verdict, stored, page && page.keys));
    if (refused) throw refused;
  }

  async function resolve(svc, n) {
    await checkNumber(svc, n);
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
    const policy = urlpolicy.compilePolicy(args.policy);
    const have = services.get(name);
    if (have) have.policy = policy;
    const hit = policyDenies(have || { name, policy }, url, 'agent');
    if (hit) throw deniedError({ name }, url, hit, 'open');
    const svc = openService(name);
    svc.policy = policy;
    await svc.blank;
    return mutating(svc, frame, `open ${url.slice(0, 80)}`, async () => {
      let status = null;
      const onNav = (_e, _url, code) => { status = code; };
      svc.wc.on('did-navigate', onNav);
      try {
        ensureCdp(svc);
        if (!svc.watch) svc.watch = await driver.armIdle(svc.wc).catch(() => null);
        let navErr = null;
        svc.blockedNav = null;
        const load = () => driver.withTimeout(svc.wc.loadURL(url).catch((e) => { navErr = e; }), LOAD_TIMEOUT_MS);
        const { idle } = await driver.act(svc.wc, load, { timeoutMs: OPEN_IDLE_MS, shouldStop: () => svc.lock.takeover });
        if (svc.wc.isDestroyed()) throw closedError(name);
        const blocked = svc.blockedNav;
        if (navErr && blocked) throw deniedError(svc, blocked.url, blocked.hit, 'open');
        if (navErr && status == null) throw codedError('NAV_FAILED', `NAV_FAILED: ${navErr.code || navErr.message} for ${url}`);
        return { status, idle: idleOf(idle) };
      } finally {
        if (!svc.wc.isDestroyed()) svc.wc.removeListener('did-navigate', onNav);
      }
    });
  }

  async function opOperatorOpen(name, args) {
    const url = checkOpenUrl(String(args.url || ''));
    const policy = urlpolicy.compilePolicy(args.policy);
    const have = services.get(name);
    if (have) have.policy = policy;
    const hit = policyDenies(have || { name, policy }, url, 'operator');
    if (hit) throw deniedError({ name }, url, hit, 'open');
    const svc = openService(name);
    svc.policy = policy;
    await svc.blank;
    if (svc.lock.state !== 'held' || svc.lock.reason !== 'takeover') takeover(svc);
    if (svc.lock.state !== 'held') throw codedError('OPERATOR_BUSY', TEXT.operatorBusy(name));
    ensureCdp(svc);
    if (!svc.watch) svc.watch = await driver.armIdle(svc.wc).catch(() => null);
    let navErr = null;
    await driver.withTimeout(svc.wc.loadURL(url).catch((e) => { navErr = e; }), LOAD_TIMEOUT_MS);
    if (svc.wc.isDestroyed()) throw closedError(name);
    if (navErr && svc.wc.getURL() === 'about:blank') throw codedError('NAV_FAILED', `NAV_FAILED: ${navErr.code || navErr.message} for ${url}`);
    svc.win.show();
    svc.win.focus();
    app.focus({ steal: true });
    return { ...pageInfo(svc), doc: svc.doc, state: svc.lock.state, reason: svc.lock.reason };
  }

  async function opAct(name, frame, args) {
    const svc = need(name);
    const op = frame.op;
    const byText = op === 'click' && args.byText != null ? String(args.byText) : null;
    let n = Number(args.n);
    const dir = args.dir == null ? path.join(downloadsRoot, svc.name) : String(args.dir);
    if (!path.isAbsolute(dir)) throw codedError('INTERNAL', 'click needs an absolute dir');
    const what = op === 'key' ? `press ${args.key}` : byText != null ? `click --text=${JSON.stringify(byText)}` : `${op} [${n}]`;
    return mutating(svc, frame, what, async () => {
      ensureCdp(svc);
      const wc = svc.wc;
      await driver.emulateFocus(wc);
      const docBefore = svc.doc;
      const hrefBefore = wc.getURL();
      const nav = (download = false) => navOf({ docBefore, docAfter: svc.doc, hrefBefore, hrefAfter: wc.isDestroyed() ? hrefBefore : wc.getURL(), download });
      if (op === 'key') {
        if (!driver.KEYS[args.key]) throw codedError('INTERNAL', `unknown key ${args.key}`);
        const pre = await preAct(svc, null);
        const { idle } = await driver.act(wc, () => driver.pressKey(wc, args.key), actOpts(svc));
        return withChange(svc, pre, { ...nav(), idle: idleOf(idle) }, lateMsFor(op));
      }
      let fresh = false;
      if (byText != null) ({ n, fresh } = await textTarget(svc, byText));
      const el = await resolve(svc, n);
      const refused = consequentialRefusal(n, el, !!args.confirm);
      if (refused) throw refused;
      dispatch(svc, { type: 'describe', what: `${op} [${n}]${el.label ? ' ' + JSON.stringify(el.label) : ''}` });
      const pre = await preAct(svc, op === 'click' ? n : null);
      if (op === 'click') {
        const out = await clickWatched(svc, n, el, nav, dir);
        if (fresh) out.fresh = true;
        if (rowChanged(svc.num && svc.num.lastRead, n, el.row)) out.textChanged = true;
        return withChange(svc, pre, out, lateMsFor(op));
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
        const out = await withChange(svc, pre, { kind: el.kind, label: el.label, ...nav(), idle: idleOf(idle) }, lateMsFor(op));
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
      return withChange(svc, pre, {
        kind: el.kind, label: el.label, value: picked.value, text: picked.text, ...nav(), idle: idleOf(idle),
      }, lateMsFor(op));
    });
  }

  const targetOf = (svc, n) => driver.withTimeout(
    svc.wc.executeJavaScriptInIsolatedWorld(scripts.ISOLATED_WORLD, [{ code: scripts.TARGET_STATE(n) }]).catch(() => null), SNAP_MS, null);

  async function preAct(svc, n) {
    const first = await snapText(svc.wc);
    await driver.sleep(BASELINE_GAP_MS);
    const before = await snapText(svc.wc);
    const target = n != null && !svc.wc.isDestroyed() ? await targetOf(svc, n) : null;
    return { before, tickers: tickersOf(first, before), n, target };
  }

  async function withChange(svc, pre, out, lateMs) {
    if (pre.before == null || (out.navigated && !out.inPage) || out.download || svc.popup || svc.popupUrl || svc.wc.isDestroyed()) return out;
    const r = await settleChange({
      before: pre.before,
      tickers: pre.tickers,
      snap: () => (svc.wc.isDestroyed() ? null : snapText(svc.wc)),
      target: pre.target ? () => (svc.wc.isDestroyed() ? null : targetOf(svc, pre.n)) : null,
      targetBefore: pre.target,
      lateMs,
    });
    if (r.changed != null) out.changed = r.changed;
    if (r.target) out.target = r.target;
    if (pre.target && !r.changed && !r.target) out.watched = lateMs;
    return out;
  }

  async function textTarget(svc, text, verb = 'click') {
    let found = await inIsolated(svc.wc, scripts.FIND_TEXT(text, numOf(svc)));
    if (found && found.unstamped) {
      await stampPage(svc);
      found = await inIsolated(svc.wc, scripts.FIND_TEXT(text, numOf(svc)));
    }
    mergeNumbers(svc, found);
    if (!found || !found.count) throw codedError('NO_ELEMENT', TEXT.noText(svc.name, text));
    if (found.count > 1) throw codedError('AMBIGUOUS', TEXT.manyText(svc.name, text, found.count, found.hits, verb));
    if (found.hits[0].loose) throw codedError('NO_ELEMENT', TEXT.looseText(svc.name, text, found.hits[0]));
    if (found.hits[0].n == null) throw codedError('AMBIGUOUS', TEXT.twinText(svc.name, text));
    return { n: found.hits[0].n, fresh: !!found.hits[0].fresh };
  }

  async function clickWatched(svc, n, el, nav, dir) {
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
      return Object.assign(out, nav(!!out.download));
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
    const hit = policyDenies(svc, url, 'agent');
    if (hit) throw deniedError(svc, url, hit, 'download');
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
        const got = await Promise.race([w.started.then(() => true), w.done.then(() => true), driver.sleep(250).then(() => false)]);
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
    const what = n != null ? `download [${n}]` : 'download';
    const t0 = Date.now();
    return mutating(svc, frame, what, async () => {
      ensureCdp(svc);
      await driver.emulateFocus(svc.wc);
      svc.downloading = true;
      try {
        let out;
        if (n != null) {
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

  async function opScreenshot(name, args) {
    const svc = need(name);
    const wc = svc.wc;
    let drawn = null;
    if (args && args.numbers) {
      await stampPage(svc);
      drawn = Number(await inIsolated(wc, scripts.OVERLAY)) || 0;
    }
    try {
      return { ...(await capture(svc)), ...(drawn == null ? {} : { numbers: drawn }) };
    } finally {
      if (drawn != null && !wc.isDestroyed()) await inIsolated(wc, scripts.OVERLAY_OFF);
    }
  }

  async function capture(svc) {
    const name = svc.name;
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
    forgetNumbers(svc, path.join(data, 'numbers', name));
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
    svc.reading += 1;
    blockerSync();
    try {
      const { n, fresh } = args.byText != null ? await textTarget(svc, String(args.byText), 'inspect') : { n: Number(args.n), fresh: false };
      await checkNumber(svc, n);
      const r = await inIsolated(svc.wc, scripts.INSPECT(n));
      if (!r) throw codedError('NO_ELEMENT', TEXT.noElement(svc.name, n));
      const listeners = await driver.withTimeout(listenersOf(svc, n).catch(() => null), driver.SCRIPT_TIMEOUT_MS, null);
      if (listeners && listeners.ancestorAt) listeners.ancestor = r.ancestors[listeners.ancestorAt - 1] || '?';
      const { marked, ...shown } = r;
      return { n, ...shown, kind: inspectKind(r, listeners), listeners, ...(fresh ? { fresh: true } : {}) };
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

  async function barNav(svc, kind, text) {
    svc.lastInput = Date.now();
    const free = () => svc.lock.state === 'idle' || svc.lock.state === 'held';
    if (!free()) return barSay(svc, 'agent driving');
    const wc = svc.wc;
    let url;
    if (kind === 'go') {
      try { url = checkOpenUrl(urlpolicy.typedUrl(text)); } catch (e) { return barSay(svc, e.message); }
    } else if (kind === 'back') {
      const h = wc.navigationHistory;
      if (!h || !h.canGoBack()) return undefined;
      const entry = h.getEntryAtIndex ? h.getEntryAtIndex(h.getActiveIndex() - 1) : null;
      url = entry && entry.url;
    } else url = wc.getURL();
    const hit = url ? policyDenies(svc, url, 'operator') : null;
    if (hit) return barSay(svc, TEXT.deniedBar(hit.pattern, hit.list === 'service' ? svc.name : null));
    return serial(svc.name, async () => {
      if (wc.isDestroyed() || !free()) return;
      ensureCdp(svc);
      const docAt = svc.doc;
      const go = kind === 'go' ? () => driver.withTimeout(wc.loadURL(url).catch(() => {}), LOAD_TIMEOUT_MS)
        : kind === 'back' ? () => wc.navigationHistory.goBack() : () => wc.reload();
      const { idle } = await driver.act(wc, go, { timeoutMs: OPEN_IDLE_MS });
      if (wc.isDestroyed()) return;
      if (!idle.ok && wc.isLoading() && !svc.pendingNav && (kind === 'go' || svc.doc !== docAt)) wc.stop();
    });
  }

  function takeover(svc) {
    dispatch(svc, { type: 'takeover' });
    return { state: svc.lock.state };
  }

  async function handback(svc) {
    if (svc.lock.state !== 'held') return { state: svc.lock.state, ...pageInfo(svc) };
    await driver.pinSessionCookies(svc.ses).catch(() => 0);
    const login = svc.wc.isDestroyed() ? {} : await probe(svc);
    if (svc.lock.state === 'held') dispatch(svc, { type: 'handback' }, { handback: true, login });
    return { state: svc.lock.state, ...pageInfo(svc) };
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
    const base = { url: wc.getURL(), title: wc.getTitle(), doc: svc.doc, contentType, gen };
    if (contentType === 'application/pdf') return base;
    let got = await inMain(wc, scripts.READ_TEXT(main));
    if (got == null) got = await inMain(wc, scripts.READ_TEXT(main));
    const text = got == null ? null : typeof got === 'string' ? got : String(got.text || '');
    const busy = got && got.busy && got.busy.count > 0 ? { count: got.busy.count, text: String(got.busy.text || '') } : null;
    const outline = got && got.outline && typeof got.outline === 'object' ? got.outline : null;
    const state = numOf(svc);
    const ent = svc.num;
    const first = !ent.lastRead;
    const firstHost = first && [...svc.origins.values()].some((e) => e.lastRead) ? hostOf(wc.getURL()) : null;
    state.listed = [...ent.listed];
    let el = await inIsolated(wc, scripts.READ_INTERACTIVE(main, state));
    if (el == null) el = await inIsolated(wc, scripts.READ_INTERACTIVE(main, state));
    const prev = ent.lastRead;
    if (el && prev) {
      const learned = keys.learnVolatile(prev.descs, el.descs, prev.url, el.url, state.volatile);
      if (learned.length) {
        for (const name of learned) ent.volatile.add(name);
        const again = await inIsolated(wc, scripts.READ_INTERACTIVE(main, { ...state, volatile: [...ent.volatile] }));
        if (again) el = again;
      }
    }
    mergeNumbers(svc, el);
    const numbers = el ? {
      fresh: (el.fresh || []).slice().sort((a, b) => a - b),
      retired: retiredOf(prev && prev.keys, el.keys, !!prev && keys.sameDoc(prev.url, el.url, [...ent.volatile])),
      changed: changedOf(prev && prev.sigs, el.sigs),
      chrome: el.chrome || [],
      keys: el.keys || {},
      ...(first && ent.restoredAt != null ? { restored: ent.restoredAt } : first ? { first: firstHost || true } : {}),
    } : {};
    if (el) {
      for (const n of el.fresh || []) ent.listed.add(Number(n));
      ent.lastRead = { url: el.url, descs: el.descs || [], keys: el.keys || {}, sigs: el.sigs || {}, rows: el.rows || {} };
    }
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
      ...numbers,
      frames,
      login,
      loading: loadingOf(svc),
      ...(busy ? { busy } : {}),
      ...(outline ? { outline } : {}),
    };
  }

  function loadingOf(svc) {
    const w = svc.watch;
    const inflight = w ? w.size(LOADING_INFLIGHT_MS) : 0;
    const since = Math.max(svc.navAt || 0, w ? w.lastNet() : 0);
    return { active: svc.wc.isLoading() || inflight > 0, inflight, background: w && w.background ? w.background() : 0, ms: Date.now() - since };
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
    for (const svc of services.values()) {
      if (svc.saveTimer) clearTimeout(svc.saveTimer);
      svc.saveTimer = null;
      flushNumbers(svc);
    }
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
        const stale = genRefusal(name, op, args, gen);
        if (stale) throw stale;
        if (op === 'policy') {
          const svc = services.get(name);
          if (svc) svc.policy = urlpolicy.compilePolicy(args.policy);
          result = { open: !!svc };
        } else if (op === 'hold' || op === 'handback' || op === 'show') result = await operatorOp(op, name);
        else if (op === 'forget') result = await serial(name, () => opForget(name));
        else {
          result = await serial(name, () => {
            if (op === 'open') return args.operator ? opOperatorOpen(name, args) : opOpen(name, frame, args);
            if (op === 'read') return opRead(name, frame, args);
            if (op === 'inspect') return opInspect(name, frame, args);
            if (op === 'idle') return opIdle(name, args);
            if (op === 'download') return opDownload(name, frame, args);
            if (op === 'screenshot') return opScreenshot(name, args);
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

module.exports = {
  run, keepOrFold, settleDownload, checkOpenUrl, wireHost, numberVerdict, inspectKind, retiredOf,
  numState, mergeNumbers, numberRefusal, notOpenError, loadNumbers, saveNumbers, pruneNumbers, flushNumbers, forgetNumbers, numbersFile, originSlug, genRefusal, NUMBERS_SCHEMA, changedOf, rowChanged, consequentialRefusal, signinHold, lateMsFor, navOf, tickersOf, targetDiff, settleChange, LATE_CHANGE_MS, ORIGINS_MAX,
};
