'use strict';

/**
 * memory-viewer — engine half. Read-only: no write path exists here on purpose
 * (writes would couple this plugin to core's digest-refresh timing; see the
 * t110 journal's one-consumer-first rationale before adding one).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Core's memory root, re-derived rather than imported: nothing exports it to
// plugins, and requiring core's memory-store is exactly the reach-around the
// boundary lint refuses. If core ever moves the library root, this plugin
// silently shows an empty list — that is the accepted failure mode of this
// coupling, not a bug in the directory walk below.
const MEMORY_ROOT = path.join(os.homedir(), '.clodex', 'library', 'memory');

// Same rule as core's session names — a character filter, nothing more. It is
// NOT the containment check: `.` is in the class, so '.' and '..' both match
// it. Confinement is enforced positively in agentDir(); keep it that way if
// this regex is ever loosened.
const AGENT_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// Bounds the staleness of badge counts, not of the overlay (the overlay
// re-reads on every open). Nothing notifies a plugin that a memory file
// changed, so freshness is only ever "how long ago did we look".
const AGENTS_TTL_MS = 60 * 1000;

let host = null;
/** { at, rows } — one cache for agents(); units() is never cached. */
let agentsCache = null;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * `---\nkey: value\n---\n\nbody`. `pinned: true` is written only when pinned;
 * absent means unpinned — do not expect `pinned: false` on disk.
 */
function parseUnit(text) {
  const s = String(text);
  if (!s.startsWith('---\n')) return null;
  const end = s.indexOf('\n---\n', 4);
  if (end === -1) return null;

  const meta = {};
  for (const line of s.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  return {
    id: meta.id || '',
    scope: meta.scope || '',
    learned_at: meta.learned_at || '',
    source: meta.source || '',
    pinned: meta.pinned === 'true',
    body: s.slice(end + 5).replace(/^\n+/, '').replace(/\s+$/, ''),
  };
}

function listAgentDirs() {
  let names;
  try {
    names = fs.readdirSync(MEMORY_ROOT, { withFileTypes: true });
  } catch (_) {
    return []; // no root yet — no agent has ever saved a memory
  }
  return names
    .filter((d) => d.isDirectory() && AGENT_NAME_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

/**
 * The resolved directory for `agent`, or null if it is not a single child of
 * MEMORY_ROOT. `agent` arrives over IPC from the renderer, so this is the only
 * sanctioned way to turn it into a path: the dirname comparison rejects '.',
 * '..' and anything else that resolves elsewhere, whatever the regex allows.
 */
function agentDir(agent) {
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) return null;
  const dir = path.resolve(MEMORY_ROOT, agent);
  if (path.dirname(dir) !== path.resolve(MEMORY_ROOT)) return null;
  return dir;
}

function readUnits(agent) {
  const dir = agentDir(agent);
  if (dir === null) return [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const units = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch (_) {
      continue; // deleted between readdir and read — skip, don't fail the list
    }
    const u = parseUnit(text);
    if (u) units.push(u);
  }
  // Newest first. learned_at is ISO-8601 so a plain string comparison orders
  // correctly; units missing it sink to the end rather than throwing. Not
  // localeCompare — that is collation-sensitive about punctuation, which is
  // not what an ISO timestamp wants.
  units.sort((a, b) => {
    const x = String(a.learned_at);
    const y = String(b.learned_at);
    if (x === y) return 0;
    return x < y ? 1 : -1;
  });
  return units;
}

function computeAgents() {
  return listAgentDirs().map((agent) => {
    const units = readUnits(agent);
    return {
      agent,
      count: units.length,
      pinned: units.filter((u) => u.pinned).length,
      // Memories outlive sessions: dead agents stay in the list, marked.
      live: host.sessions.get(agent) !== null,
    };
  });
}

function getAgents(force) {
  if (!force && agentsCache && Date.now() - agentsCache.at < AGENTS_TTL_MS) {
    return agentsCache.rows;
  }
  const rows = computeAgents();
  agentsCache = { at: Date.now(), rows };
  return rows;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  // Re-enable reuses this module object; start from zero.
  host = h;
  agentsCache = null;

  // force:true is the overlay path — it must see the disk as it is now, so it
  // bypasses the TTL that exists only for badge polls.
  host.ipc.handle('agents', (opts) => {
    return { ok: true, agents: getAgents(!!(opts && opts.force)) };
  });

  host.ipc.handle('units', (agent) => {
    if (agentDir(agent) === null) {
      return { ok: false, error: 'a valid agent name is required' };
    }
    return { ok: true, agent, units: readUnits(agent) };
  });

  host.ipc.handle('settings.get', () => {
    const s = host.settings.get() || {};
    return { ok: true, values: { showRowBadge: s.showRowBadge !== false } };
  });

  // Liveness markers change with the session set; drop the cache so the next
  // ask recomputes them instead of serving up to 60s of stale `live` flags.
  host.sessions.onCreate(() => { agentsCache = null; });
  host.sessions.onExit(() => { agentsCache = null; });

  host.log.info('activated');
};

module.exports.deactivate = () => {
  agentsCache = null;
  host = null;
};
