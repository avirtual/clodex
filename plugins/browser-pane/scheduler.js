'use strict';

const fs = require('node:fs');
const path = require('node:path');
const replies = require('./replies');
const paths = require('./paths');
const { formatRead, chromeStrip, elementStrip, hostOf } = require('./read-format');

const NO_SERVICE = 'no service — name one, e.g. [agent:browser read <service>]';

function storedLogin(login, now) {
  if (!login || typeof login !== 'object') return { state: 'unknown', at: now };
  if (login.idp === 'google' || login.googleRejected) return { state: 'idp-refused', at: now, via: 'google' };
  if (login.password || login.otp || login.captcha || login.idp) return { state: 'login-page', at: now, via: 'password-field' };
  if (login.logoutLink) return { state: 'logged-in', at: now, via: 'logout-link' };
  if (login.loggedInHint) return { state: 'logged-in', at: now, via: 'account-ui' };
  return { state: 'unknown', at: now };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function splitTitle(text, title) {
  const t = String(title || '');
  return t && text.startsWith(`${t}\n`) ? [t, text.slice(t.length + 1)] : ['', text];
}

function pageKey(url) {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url || ''); }
}

function linesApart(a, b) {
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return Math.max(x.length - i - j, y.length - i - j);
}

function originPath(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; }
}

const LEASE_MS = 5 * 60 * 1000;
const IN_PLACE_LINES = 2;
const WAIT_DEFAULT_MS = 15000;
const WAIT_MAX_MS = 120000;
const HELD_WAIT_MAX_MS = 1800000;
const DOWNLOAD_OP_MS = 450000;
const SCREENSHOT_OP_MS = 30000;
const N_ACTS = new Set(['click', 'type', 'select']);
const HELD_OK = new Set(['wait', 'release']);
const realTimers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimeout: (t) => clearTimeout(t),
};

function cmdLabel(cmd) {
  if ((cmd.sub === 'click' || cmd.sub === 'inspect') && cmd.text != null) return `${cmd.sub} --text=${JSON.stringify(cmd.text)}`;
  if (cmd.sub === 'inspect') return `inspect ${cmd.n}`;
  if (N_ACTS.has(cmd.sub)) return `${cmd.sub} ${cmd.n}`;
  if (cmd.sub === 'key') return `key ${cmd.key}`;
  if (cmd.sub === 'download' && cmd.n != null) return `download ${cmd.n}`;
  return cmd.sub;
}

function needsRead(cmd) {
  return N_ACTS.has(cmd.sub) || cmd.sub === 'inspect' || (cmd.sub === 'download' && cmd.n != null);
}

function createScheduler({
  client, storage, mirror, now = () => Date.now(), log, timers = realTimers, fsScope = () => ({ error: 'Session not found' }), downloadsDir = null,
}) {
  const services = new Map();
  const seats = new Map();

  const seatState = (name) => {
    if (!seats.has(name)) seats.set(name, { current: null, hasRead: {}, lastText: {} });
    return seats.get(name);
  };

  const svcState = (name) => {
    if (!services.has(name)) services.set(name, { lease: null, queue: [], inflight: null, state: 'closed', reason: null, waiters: [], url: '' });
    return services.get(name);
  };

  function resolveService(handle, cmd) {
    const st = seatState(handle.name);
    const service = cmd.service || st.current;
    if (!service) throw new Error(NO_SERVICE);
    return service;
  }

  function holderActive(s) {
    const seat = s.lease.seat;
    return s.waiters.some((w) => w.seat === seat)
      || (s.inflight && s.inflight.handle.name === seat)
      || s.queue.some((j) => j.handle.name === seat);
  }

  function holderBusy(s) {
    return s.state === 'held' || holderActive(s);
  }

  function activeSeat(service) {
    const s = services.get(service);
    return s && s.lease && holderActive(s) ? s.lease.seat : null;
  }

  function grant(service, seat) {
    const s = svcState(service);
    if (s.lease && s.lease.seat !== seat && holderActive(s)) {
      const holder = s.lease.seat;
      const waiting = s.waiters.some((w) => w.seat === holder) && !(s.inflight && s.inflight.handle.name === holder) && !s.queue.some((j) => j.handle.name === holder);
      throw new Error(replies.TEXT.driving(holder, service, waiting));
    }
    const prev = s.lease;
    const prevCurrent = seatState(seat).current;
    s.lease = { seat, lastCmdAt: now() };
    seatState(seat).current = service;
    return { service, seat, prev, prevCurrent };
  }

  function restoreLease(service, seat, prev, prevCurrent = null) {
    const s = svcState(service);
    if (s.lease && s.lease.seat === seat) s.lease = prev || null;
    if (seatState(seat).current === service) seatState(seat).current = prevCurrent;
  }

  function leaseFree(s, seat) {
    if (!s.lease || s.lease.seat === seat) return true;
    return now() - s.lease.lastCmdAt >= LEASE_MS && !holderBusy(s);
  }

  function updateStorage(service, fn) {
    try {
      const all = storage.get();
      const data = all && typeof all === 'object' && all.v === 1 ? all : { v: 1, services: {} };
      if (!data.services || typeof data.services !== 'object') data.services = {};
      const prev = data.services[service] || { createdAt: now() };
      data.services[service] = fn(prev);
      storage.set(data);
    } catch (e) {
      if (log) log.error(`storage update failed: ${e.message}`);
    }
  }

  function noteUrl(service, url) {
    if (url) svcState(service).url = String(url);
  }

  function recordOpen(service, seat, r, asked) {
    const t = now();
    noteUrl(service, r.url);
    updateStorage(service, (prev) => ({
      ...prev,
      openedHost: prev.openedHost || hostOf(prev.lastUrl) || hostOf(asked || r.url),
      createdAt: prev.createdAt || t,
      lastUsedAt: t,
      lastSeat: seat,
      lastUrl: originPath(r.url),
      lastTitle: String(r.title || '').slice(0, 200),
      login: r.login == null && prev.login ? prev.login : storedLogin(r.login, t),
    }));
  }

  function operatorOpened(service, r) {
    recordOpen(service, 'operator', r);
  }

  function recordLogin(service, login) {
    updateStorage(service, (prev) => ({ ...prev, login }));
  }

  function signin(service, r) {
    const h = r.held || {};
    const out = replies.signinReply(service, h.login || r.login, h.url || r.url);
    const e = new Error(out);
    e.reply = out;
    e.signin = true;
    throw e;
  }

  async function runOpen(handle, service, cmd) {
    const r = await client.request('open', { url: cmd.url }, { service, seat: handle.name });
    recordOpen(service, handle.name, r, cmd.url);
    if (svcState(service).state === 'closed') onState({ service, state: 'idle' });
    if (r.held && !r.takeover) signin(service, r);
    return replies.openReply(service, r) + (r.takeover ? replies.TEXT.takeover : '');
  }

  async function runRead(handle, service, cmd) {
    const raw = await client.request('read', { scope: cmd.main ? 'main' : 'all' }, { service, seat: handle.name });
    if (raw && raw.held) signin(service, raw);
    if (raw) noteUrl(service, raw.url);
    const st = seatState(handle.name);
    const last = st.lastText[service];
    const hasText = !!raw && typeof raw.text === 'string';
    const origin = hasText ? originOf(raw.url) : '';
    const where = hasText ? originPath(raw.url) : '';
    const base = last && last.origin === origin
      ? (last.text === raw.text ? last.base : { text: last.text, title: last.title, where: last.where }) : null;
    let page = raw;
    let strip = null;
    let hidden = 0;
    const stripping = hasText && !cmd.all && cmd.mode !== 'links';
    if (stripping && base && (base.where !== where || linesApart(base.text, raw.text) > IN_PLACE_LINES)) {
      const [title, body] = splitTitle(raw.text, raw.title);
      const r = chromeStrip(splitTitle(base.text, base.title)[1], body);
      if (r.top || r.bottom) page = { ...raw, text: title ? `${title}\n\n${r.text}` : r.text };
      strip = { top: r.top, bottom: r.bottom };
    }
    const samePage = !!last && last.page === pageKey(raw && raw.url);
    const elBase = !stripping || cmd.mode !== 'default' || !last || last.origin !== origin ? null
      : !samePage ? { elements: last.elements, keys: last.keys } : (cmd.page > 1 && last.text === raw.text ? last.elBase : null);
    if (elBase) {
      const e = elementStrip(elBase.elements, raw.elements, elBase.keys, raw.keys, { chrome: raw.chrome });
      if (e.hidden) { page = { ...page, elements: e.lines }; hidden = e.hidden; }
    }
    if (hasText) st.lastText[service] = { text: raw.text, title: raw.title, origin, where, page: pageKey(raw.url), elements: raw.elements, keys: raw.keys, elBase, base };
    const rec = ((storage.get() || {}).services || {})[service] || {};
    const openedHost = rec.openedHost || hostOf(rec.lastUrl);
    const out = formatRead(page, { service, mode: cmd.mode, main: cmd.main, all: cmd.all, filter: cmd.filter, page: cmd.page, max: cmd.max, strip, hidden, openedHost });
    if (raw) seatState(handle.name).hasRead[service] = true;
    if (out.pdf) return replies.reply(out.line);
    const file = replies.writeReplyFile(handle.name, out.content);
    return replies.readReply(service, out, file, handle.type);
  }

  function downloadDir(handle, service, to) {
    if (to != null) {
      const root = paths.scopeCwd(fsScope(handle.name));
      return { root, dir: paths.resolveTo(root, to) };
    }
    if (!downloadsDir) throw new Error('no downloads folder');
    return { root: null, dir: path.join(downloadsDir, service) };
  }

  function keepInside(root, file) {
    if (!root || paths.landedInside(root, file)) return;
    try { fs.unlinkSync(file); } catch {}
    throw new Error(paths.leftCwd(root));
  }

  async function runAct(handle, service, cmd) {
    const args = {};
    let root = null;
    if (cmd.sub === 'click' && cmd.to != null) ({ root, dir: args.dir } = downloadDir(handle, service, cmd.to));
    if (cmd.n != null) args.n = cmd.n;
    if (cmd.sub === 'click' && cmd.text != null) args.byText = cmd.text;
    if (cmd.sub === 'type') { args.text = cmd.text; args.enter = cmd.enter; }
    if (cmd.sub === 'select') args.option = cmd.option;
    if (cmd.confirm) args.confirm = true;
    if (cmd.sub === 'key') args.key = cmd.key;
    const r = await client.request(cmd.sub, args, { service, seat: handle.name });
    noteUrl(service, r.url);
    const d = r.download;
    if (root && d && d.file && !d.failed) keepInside(root, d.bytes == null ? path.dirname(d.file) : d.file);
    if (r.held && !r.takeover) signin(service, r);
    return replies.actReply(cmd.sub, service, cmd, r);
  }

  async function runInspect(handle, service, cmd) {
    const args = {};
    if (cmd.n != null) args.n = cmd.n;
    if (cmd.text != null) args.byText = cmd.text;
    const r = await client.request('inspect', args, { service, seat: handle.name });
    return replies.inspectReply(service, r);
  }

  async function runWait(handle, service, cmd) {
    const ms = Math.min(WAIT_MAX_MS, cmd.ms == null ? WAIT_DEFAULT_MS : cmd.ms);
    const r = await client.request('idle', { ms, forText: cmd.forText }, { service, seat: handle.name, timeoutMs: ms + 10000 });
    return replies.waitReply(service, r, cmd.forText);
  }

  async function runDownload(handle, service, cmd) {
    const { root, dir } = downloadDir(handle, service, cmd.to);
    const args = { dir, as: cmd.as, n: cmd.n, url: cmd.url };
    const r = await client.request('download', args, { service, seat: handle.name, timeoutMs: DOWNLOAD_OP_MS });
    keepInside(root, r.file);
    if (r.held && !r.takeover) signin(service, r);
    return replies.downloadReply(service, cmd, r);
  }

  async function runScreenshot(handle, service, cmd) {
    const r = await client.request('screenshot', cmd && cmd.numbers ? { numbers: true } : {}, { service, seat: handle.name, timeoutMs: SCREENSHOT_OP_MS });
    const file = replies.writeReplyFile(handle.name, Buffer.from(String(r.jpeg || ''), 'base64'), { kind: 's', ext: 'jpg' });
    return replies.screenshotReply(service, r, file, handle.type);
  }

  const RUN = {
    open: runOpen, read: runRead, click: runAct, type: runAct, select: runAct, key: runAct, wait: runWait, download: runDownload, screenshot: runScreenshot, inspect: runInspect,
  };

  function fail(handle, s, text, keepWaits) {
    const seat = handle.name;
    const drops = (j) => j.handle.name === seat && !(keepWaits && j.cmd.sub === 'wait');
    const dropped = s.queue.filter(drops);
    s.queue = s.queue.filter((j) => !drops(j));
    handle.inject(text + replies.dropSuffix(dropped.map((j) => cmdLabel(j.cmd))));
  }

  function errText(service, e) {
    if (e && e.reply) return e.reply;
    return replies.errorReply((e && e.message) || String(e));
  }

  function pump(service) {
    const s = svcState(service);
    if (s.inflight || !s.queue.length) return;
    const job = s.queue.shift();
    s.inflight = job;
    let p;
    if (s.state === 'held' && job.cmd.sub === 'wait') {
      s.inflight = null;
      addWaiter(job.handle, service, job.cmd);
      pump(service);
      return;
    }
    if (s.state === 'held') p = Promise.reject(new Error(replies.TEXT.held(service, s.reason)));
    else p = Promise.resolve().then(() => RUN[job.cmd.sub](job.handle, service, job.cmd));
    p
      .then((text) => job.handle.inject(text))
      .catch((e) => fail(job.handle, s, errText(service, e), !!(e && (e.signin || e.code === 'HELD' || e.code === 'PASSWORD_FIELD')) || s.state === 'held'))
      .finally(() => {
        if (s.inflight === job) s.inflight = null;
        pump(service);
      });
  }

  function addWaiter(handle, service, cmd) {
    const s = svcState(service);
    const ms = Math.min(HELD_WAIT_MAX_MS, cmd.ms == null ? HELD_WAIT_MAX_MS : cmd.ms);
    const w = { seat: handle.name, handle, timer: null };
    w.timer = timers.setTimeout(() => {
      s.waiters = s.waiters.filter((x) => x !== w);
      handle.inject(replies.heldTimeout(service, ms));
    }, ms);
    s.waiters.push(w);
  }

  function settleWaiters(s, text) {
    const ws = s.waiters;
    s.waiters = [];
    for (const w of ws) {
      timers.clearTimeout(w.timer);
      w.handle.inject(text);
    }
  }

  function servicesLine() {
    const data = storage.get() || {};
    return replies.servicesReply((data && data.services) || {}, mirror, (name) => (services.get(name) || {}).url || '');
  }

  function release(handle, service) {
    const s = svcState(service);
    if (s.lease && s.lease.seat === handle.name) {
      s.lease = null;
      s.queue = s.queue.filter((j) => j.handle.name !== handle.name);
      for (const w of s.waiters.filter((x) => x.seat === handle.name)) timers.clearTimeout(w.timer);
      s.waiters = s.waiters.filter((x) => x.seat !== handle.name);
    }
    handle.inject(replies.reply(`released ${service}`));
  }

  function submit(handle, cmd) {
    if (cmd.sub === 'services') {
      handle.inject(servicesLine());
      return;
    }
    const service = resolveService(handle, cmd);
    const s = svcState(service);
    if (!leaseFree(s, handle.name)) {
      handle.inject(replies.errorReply(replies.TEXT.lease(service, s.lease.seat, now() - s.lease.lastCmdAt)));
      return;
    }
    seatState(handle.name).current = service;
    if (cmd.sub === 'release') { release(handle, service); return; }
    s.lease = { seat: handle.name, lastCmdAt: now() };
    if (s.state === 'held' && !HELD_OK.has(cmd.sub)) {
      handle.inject(replies.errorReply(replies.TEXT.held(service, s.reason)));
      return;
    }
    if (needsRead(cmd) && !seatState(handle.name).hasRead[service]) {
      handle.inject(replies.errorReply(replies.TEXT.readFirst(service)));
      return;
    }
    if (cmd.sub === 'wait' && s.state === 'held') { addWaiter(handle, service, cmd); return; }
    s.queue.push({ handle, cmd });
    pump(service);
  }

  function onState(frame) {
    const service = frame.service;
    const s = svcState(service);
    const was = s.state;
    s.state = frame.state;
    s.reason = frame.state === 'held' ? (frame.reason || 'login') : null;
    noteUrl(service, frame.url);
    if (mirror) mirror.set(service, frame.state);
    if (frame.state === 'held' && was !== 'held' && frame.reason !== 'takeover') {
      const login = storedLogin(frame.login, now());
      if (login.state !== 'unknown') recordLogin(service, login);
    }
    if (frame.handback) {
      const pw = !!(frame.login && (frame.login.password || frame.login.otp));
      recordLogin(service, { state: pw ? 'login-page' : 'logged-in', at: now(), via: 'handback' });
    }
    if (was === 'held' && frame.state !== 'held') {
      if (frame.state === 'closed') settleWaiters(s, replies.errorReply(`the ${service} window was closed — open it again`));
      else settleWaiters(s, replies.handbackReply(service, frame));
    }
  }

  function onClosed(service) {
    for (const st of seats.values()) { delete st.hasRead[service]; delete st.lastText[service]; }
    onState({ service, state: 'closed' });
  }

  function onChildExit() {
    for (const name of services.keys()) onClosed(name);
  }

  function onSessionExit(handle) {
    const name = handle && handle.name;
    for (const s of services.values()) {
      if (s.lease && s.lease.seat === name) s.lease = null;
      s.queue = s.queue.filter((j) => j.handle.name !== name);
      for (const w of s.waiters.filter((x) => x.seat === name)) timers.clearTimeout(w.timer);
      s.waiters = s.waiters.filter((x) => x.seat !== name);
    }
    seats.delete(name);
  }

  function leaseHolder(service) {
    const s = services.get(service);
    return s && s.lease && !leaseFree(s, null) ? s.lease.seat : null;
  }

  return {
    submit,
    onState,
    onClosed,
    onChildExit,
    onSessionExit,
    seatState,
    grant,
    activeSeat,
    operatorOpened,
    restoreLease,
    leaseHolder,
    noteUrl,
    NO_SERVICE,
  };
}

module.exports = { createScheduler, storedLogin, NO_SERVICE };
