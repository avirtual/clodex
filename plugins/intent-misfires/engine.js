'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const KINDS = Object.freeze(['unclosed-body', 'empty-body', 'disabled', 'schema', 'exec-refused', 'bounce', 'truncated-head']);
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

let host = null;

function misfiresFile() {
  return path.join(host.paths.dataDir, '..', '..', 'intent-misfires.jsonl');
}

function readAll() {
  let raw;
  try {
    raw = fs.readFileSync(misfiresFile(), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? [] : null;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch (_) {}
  }
  return out;
}

function seatsOf(wsId) {
  const seats = new Set();
  for (const s of host.sessions.listSavedWorkspace(wsId) || []) {
    if (s && typeof s.name === 'string') seats.add(s.name);
  }
  for (const s of host.sessions.listWorkspace(wsId) || []) {
    if (s && typeof s.name === 'string') seats.add(s.name);
  }
  return seats;
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toRow(r) {
  return {
    ts: numOrNull(r.ts),
    agent: String(r.agent),
    kind: String(r.kind),
    intent: String(r.intent || ''),
    sub: r.sub ? String(r.sub) : null,
    detail: String(r.detail ?? ''),
    turnBytes: numOrNull(r.turnBytes),
    ctxTokens: numOrNull(r.ctxTokens),
    sinceCompact: numOrNull(r.sinceCompact),
  };
}

function countsOf(rows) {
  const counts = {};
  for (const r of rows) {
    const mine = counts[r.agent] || (counts[r.agent] = {});
    mine[r.kind] = (mine[r.kind] || 0) + 1;
  }
  return counts;
}

function list(payload) {
  const { workspaceId, agent, kind, limit } = payload || {};
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return { ok: false, error: 'a workspace id is required' };
  }
  if (agent != null && (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent))) {
    return { ok: false, error: 'the agent filter is not a valid seat name' };
  }
  if (kind != null && !KINDS.includes(kind)) {
    return { ok: false, error: `the kind filter must be one of ${KINDS.join(', ')}` };
  }
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
  const all = readAll();
  if (all === null) return { ok: false, error: 'intent-misfires.jsonl could not be read' };
  const seats = seatsOf(workspaceId);
  const scoped = all
    .filter((r) => typeof r.agent === 'string' && KINDS.includes(r.kind) && seats.has(r.agent))
    .map(toRow);
  const rows = scoped
    .filter((r) => (agent == null || r.agent === agent) && (kind == null || r.kind === kind))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, cap);
  return { ok: true, rows, counts: countsOf(scoped), kinds: KINDS.slice() };
}

module.exports.KINDS = KINDS;

module.exports.activate = (h) => {
  host = h;
  host.ipc.handle('list', (payload) => list(payload));
  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};
