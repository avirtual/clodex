'use strict';

const replies = require('./replies');
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

function createScheduler({ client, storage, mirror, now = () => Date.now(), log }) {
  const queues = new Map();
  const seats = new Map();

  const seatState = (name) => {
    if (!seats.has(name)) seats.set(name, { current: null, lastDoc: {} });
    return seats.get(name);
  };

  function resolveService(handle, cmd) {
    const st = seatState(handle.name);
    const service = cmd.service || st.current;
    if (!service) throw new Error(NO_SERVICE);
    return service;
  }

  function enqueue(service, job) {
    const prev = queues.get(service) || Promise.resolve();
    const next = prev.then(job, job);
    queues.set(service, next.catch(() => {}));
    return next;
  }

  function recordOpen(service, seat, r) {
    const t = now();
    const all = storage.get();
    const data = all && typeof all === 'object' && all.v === 1 ? all : { v: 1, services: {} };
    if (!data.services || typeof data.services !== 'object') data.services = {};
    const prev = data.services[service] || { createdAt: t };
    data.services[service] = {
      ...prev,
      createdAt: prev.createdAt || t,
      lastUsedAt: t,
      lastSeat: seat,
      lastUrl: originPath(r.url),
      lastTitle: String(r.title || '').slice(0, 200),
      login: storedLogin(r.login, t),
    };
    storage.set(data);
  }

  async function runOpen(handle, service, cmd) {
    const r = await client.request('open', { url: cmd.url }, { service, seat: handle.name });
    mirror.set(service, 'idle');
    try { recordOpen(service, handle.name, r); } catch (e) { if (log) log.error(`storage update failed: ${e.message}`); }
    return replies.openReply(service, r);
  }

  async function runRead(handle, service, cmd) {
    const raw = await client.request('read', { scope: cmd.main ? 'main' : 'all' }, { service, seat: handle.name });
    mirror.set(service, 'idle');
    const out = formatRead(raw, { service, mode: cmd.mode, main: cmd.main, filter: cmd.filter, page: cmd.page, max: cmd.max });
    if (raw && raw.doc != null) seatState(handle.name).lastDoc[service] = raw.doc;
    if (out.pdf) return replies.reply(out.line);
    const file = replies.writeReplyFile(handle.name, out.content);
    return replies.readReply(service, out, file, handle.type);
  }

  function servicesLine() {
    const data = storage.get() || {};
    return replies.servicesReply((data && data.services) || {}, mirror);
  }

  function submit(handle, cmd) {
    if (cmd.sub === 'services') {
      handle.inject(servicesLine());
      return Promise.resolve();
    }
    const service = resolveService(handle, cmd);
    if (cmd.sub === 'release') {
      handle.inject(replies.reply(`released ${service}`));
      return Promise.resolve();
    }
    seatState(handle.name).current = service;
    const run = cmd.sub === 'open' ? runOpen : runRead;
    return enqueue(service, () => run(handle, service, cmd)
      .then((text) => handle.inject(text))
      .catch((e) => handle.inject(replies.errorReply((e && e.message) || String(e)))));
  }

  function forgetSeat(name) {
    seats.delete(name);
  }

  return { submit, forgetSeat, seatState, NO_SERVICE };
}

module.exports = { createScheduler, storedLogin, NO_SERVICE };
