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
  const gone = Array.isArray(all) && !all.some((r) => r && r.id === id && r.agent === agent);
  return { ...(res || { ok: false }), ok: false, gone };
}

module.exports.activate = (h) => {
  host = h;
  host.ipc.handle('list', (wsId) => list(wsId));
  host.ipc.handle('cancel', (payload) => cancel(payload));
  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};
