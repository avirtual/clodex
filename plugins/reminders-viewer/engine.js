'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const ID_RE = /^[a-z0-9]+$/;

let host = null;

function remindersFile() {
  return path.join(host.paths.dataDir, '..', '..', 'reminders.json');
}

function readAll() {
  let raw;
  try {
    raw = fs.readFileSync(remindersFile(), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? [] : null;
  }
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function seatsOf(wsId) {
  const seats = new Map();
  for (const s of host.sessions.listSavedWorkspace(wsId) || []) {
    if (s && typeof s.name === 'string') seats.set(s.name, false);
  }
  for (const s of host.sessions.listWorkspace(wsId) || []) {
    if (s && typeof s.name === 'string') seats.set(s.name, true);
  }
  return seats;
}

function toRow(r, live) {
  return {
    id: String(r.id),
    agent: String(r.agent),
    kind: String(r.kind || ''),
    spec: String(r.spec || ''),
    body: String(r.body ?? ''),
    nextFireAt: typeof r.nextFireAt === 'number' ? r.nextFireAt : null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : null,
    lastFiredAt: typeof r.lastFiredAt === 'number' ? r.lastFiredAt : null,
    ticket: r.ticket ? String(r.ticket) : null,
    live,
    ...(r.by === 'operator' ? { by: 'operator' } : {}),
  };
}

function byFire(a, b) {
  const fa = a.nextFireAt === null ? Infinity : a.nextFireAt;
  const fb = b.nextFireAt === null ? Infinity : b.nextFireAt;
  if (fa !== fb) return fa - fb;
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function list(wsId) {
  if (typeof wsId !== 'string' || !wsId) {
    return { ok: false, error: 'a workspace id is required' };
  }
  const all = readAll();
  if (all === null) return { ok: false, error: 'reminders.json could not be read' };
  const seats = seatsOf(wsId);
  const rows = all
    .filter((r) => r && typeof r.id === 'string' && typeof r.agent === 'string' && seats.has(r.agent))
    .map((r) => toRow(r, seats.get(r.agent)))
    .sort(byFire);
  return { ok: true, rows };
}

function cancel(payload) {
  const { agent, id } = payload || {};
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: 'a valid agent name is required' };
  }
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, error: 'a valid reminder id is required' };
  }
  const res = host.library.remove('reminder', { agent, id });
  if (res && res.ok === true) return res;
  const all = readAll();
  const gone = Array.isArray(all) && !all.some((r) => r && r.id === id);
  return { ...(res || { ok: false }), ok: false, gone };
}

function fire(payload) {
  const { agent, id } = payload || {};
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: 'a valid agent name is required' };
  }
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, error: 'a valid reminder id is required' };
  }
  return host.library.fire('reminder', { agent, id });
}

function seats(wsId) {
  if (typeof wsId !== 'string' || !wsId) {
    return { ok: false, error: 'a workspace id is required' };
  }
  const out = [...seatsOf(wsId)].map(([name, live]) => ({ name, live }));
  out.sort((a, b) => (a.live !== b.live ? (a.live ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, seats: out };
}

function add(payload) {
  const { wsId, agent, spec, body } = payload || {};
  if (typeof wsId !== 'string' || !wsId) {
    return { ok: false, error: 'a workspace id is required' };
  }
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) {
    return { ok: false, error: 'a valid agent name is required' };
  }
  if (!seatsOf(wsId).has(agent)) return { ok: false, error: 'no such seat' };
  if (typeof spec !== 'string' || !spec.trim()) {
    return { ok: false, error: 'a schedule is required' };
  }
  return host.library.add('reminder', { agent }, { spec: spec.trim(), body: typeof body === 'string' ? body : '' });
}

module.exports.activate = (h) => {
  host = h;
  host.ipc.handle('list', (wsId) => list(wsId));
  host.ipc.handle('cancel', (payload) => cancel(payload));
  host.ipc.handle('seats', (wsId) => seats(wsId));
  host.ipc.handle('add', (payload) => add(payload));
  host.ipc.handle('fire', (payload) => fire(payload));
  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};
