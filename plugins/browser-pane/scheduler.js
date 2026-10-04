'use strict';

const fs = require('node:fs');
const path = require('node:path');
const replies = require('./replies');
const paths = require('./paths');
const { formatRead } = require('./read-format');

const NO_SERVICE = 'no service — name one, e.g. [agent:browser read <service>]';

function storedLogin(login, now) {
  if (!login || typeof login !== 'object') return { state: 'unknown', at: now };
  if (login.idp === 'google' || login.googleRejected) return { state: 'idp-refused', at: now, via: 'google' };
  if (login.password || login.otp || login.captcha || login.idp) return { state: 'login-page', at: now, via: 'password-field' };
  if (login.logoutLink) return { state: 'logged-in', at: now, via: 'logout-link' };
  return { state: 'unknown', at: now };
}

function originPath(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; }
}

const LEASE_MS = 5 * 60 * 1000;
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
  if (cmd.sub === 'click' && cmd.text != null) return `click --text=${JSON.stringify(cmd.text)}`;
  if (N_ACTS.has(cmd.sub)) return `${cmd.sub} ${cmd.n}`;
  if (cmd.sub === 'key') return `key ${cmd.key}`;
  if (cmd.sub === 'download' && cmd.n != null) return `download ${cmd.n}`;
  return cmd.sub;
}

function needsRead(cmd) {
  return N_ACTS.has(cmd.sub) || (cmd.sub === 'download' && cmd.n != null);
}

function createScheduler({
  client, storage, mirror, now = () => Date.now(), log, timers = realTimers, fsScope = () => ({ error: 'Session not found' }), downloadsDir = null,
}) {
  const services = new Map();
  const seats = new Map();

  const seatState = (name) => {
    if (!seats.has(name)) seats.set(name, { current: null, lastDoc: {} });
    return seats.get(name);
  };

  const svcState = (name) => {
    if (!services.has(name)) services.set(name, { lease: null, queue: [], inflight: null, state: 'closed', reason: null, waiters: [] });
    return services.get(name);
  };

  function resolveService(handle, cmd) {
    const st = seatState(handle.name);
    const service = cmd.service || st.current;
    if (!service) throw new Error(NO_SERVICE);
    return service;
  }

  function holderBusy(s) {
    const seat = s.lease.seat;
    return s.state === 'held'
      || s.waiters.some((w) => w.seat === seat)
      || (s.inflight && s.inflight.handle.name === seat)
      || s.queue.some((j) => j.handle.name === seat);
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

  function recordOpen(service, seat, r) {
    const t = now();
    updateStorage(service, (prev) => ({
      ...prev,
      createdAt: prev.createdAt || t,
      lastUsedAt: t,
      lastSeat: seat,
      lastUrl: originPath(r.url),
      lastTitle: String(r.title || '').slice(0, 200),
      login: storedLogin(r.login, t),
    }));
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
    recordOpen(service, handle.name, r);
    if (svcState(service).state === 'closed') onState({ service, state: 'idle' });
    if (r.held && !r.takeover) signin(service, r);
    return replies.openReply(service, r) + (r.takeover ? replies.TEXT.takeover : '');
  }

  async function runRead(handle, service, cmd) {
    const raw = await client.request('read', { scope: cmd.main ? 'main' : 'all' }, { service, seat: handle.name });
    if (raw && raw.held) signin(service, raw);
    const out = formatRead(raw, { service, mode: cmd.mode, main: cmd.main, filter: cmd.filter, page: cmd.page, max: cmd.max });
    if (raw && raw.doc != null) seatState(handle.name).lastDoc[service] = raw.doc;
    if (out.pdf) return replies.reply(out.line);
    const file = replies.writeReplyFile(handle.name, out.content);
    return replies.readReply(service, out, file, handle.type);
  }

  async function runAct(handle, service, cmd) {
    const args = { expectDoc: seatState(handle.name).lastDoc[service] };
    if (cmd.n != null) args.n = cmd.n;
    if (cmd.sub === 'click' && cmd.text != null) args.byText = cmd.text;
    if (cmd.sub === 'type') { args.text = cmd.text; args.enter = cmd.enter; }
    if (cmd.sub === 'select') args.option = cmd.option;
    if (cmd.sub === 'key') { args.key = cmd.key; delete args.expectDoc; }
    const r = await client.request(cmd.sub, args, { service, seat: handle.name });
    if (r.held && !r.takeover) signin(service, r);
    return replies.actReply(cmd.sub, service, cmd, r);
  }

  async function runWait(handle, service, cmd) {
    const ms = Math.min(WAIT_MAX_MS, cmd.ms == null ? WAIT_DEFAULT_MS : cmd.ms);
    const r = await client.request('idle', { ms, forText: cmd.forText }, { service, seat: handle.name, timeoutMs: ms + 10000 });
    return replies.waitReply(service, r, cmd.forText);
  }

  async function runDownload(handle, service, cmd) {
    let root = null;
    let dir;
    if (cmd.to != null) {
      root = paths.scopeCwd(fsScope(handle.name));
      dir = paths.resolveTo(root, cmd.to);
    } else {
      if (!downloadsDir) throw new Error('no downloads folder');
      dir = path.join(downloadsDir, service);
    }
    const args = { dir, as: cmd.as, n: cmd.n, url: cmd.url };
    if (cmd.n != null) args.expectDoc = seatState(handle.name).lastDoc[service];
    const r = await client.request('download', args, { service, seat: handle.name, timeoutMs: DOWNLOAD_OP_MS });
    if (root && !paths.landedInside(root, r.file)) {
      try { fs.unlinkSync(r.file); } catch {}
      throw new Error(`the download left your working directory (${root}) and was deleted — download it again`);
    }
    if (r.held && !r.takeover) signin(service, r);
    return replies.downloadReply(service, cmd, r);
  }

  async function runScreenshot(handle, service) {
    const r = await client.request('screenshot', {}, { service, seat: handle.name, timeoutMs: SCREENSHOT_OP_MS });
    const file = replies.writeReplyFile(handle.name, Buffer.from(String(r.jpeg || ''), 'base64'), { kind: 's', ext: 'jpg' });
    return replies.screenshotReply(service, r, file, handle.type);
  }

  const RUN = {
    open: runOpen, read: runRead, click: runAct, type: runAct, select: runAct, key: runAct, wait: runWait, download: runDownload, screenshot: runScreenshot,
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
    return replies.servicesReply((data && data.services) || {}, mirror);
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
    if (needsRead(cmd) && seatState(handle.name).lastDoc[service] == null) {
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
    for (const st of seats.values()) delete st.lastDoc[service];
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

  return {
    submit, onState, onClosed, onChildExit, onSessionExit, seatState, NO_SERVICE,
  };
}

module.exports = { createScheduler, storedLogin, NO_SERVICE };
