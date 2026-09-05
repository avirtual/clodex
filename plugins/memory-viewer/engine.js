'use strict';

/**
 * memory-viewer — engine half. `forget` goes through host.library.remove, never
 * fs.unlinkSync on the file this module can plainly see: deleting a unit obliges
 * a boot-digest rewrite core owns and whose timing a plugin cannot know, so a
 * direct unlink would leave live agents serving a memory that is gone.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Re-derived rather than imported: nothing exports it to plugins, and requiring
// core's memory-store is the reach-around the boundary lint refuses. If core
// moves the library root this plugin shows an empty list — the coupling's
// accepted failure mode, not a bug in the walk below.
const MEMORY_ROOT = path.join(os.homedir(), '.clodex', 'library', 'memory');

// Same rule as core's session names — a character filter, nothing more. NOT the
// containment check: `.` is in the class, so '.' and '..' both match it, and
// agentDir() is where confinement is enforced. Keep it there if this loosens.
const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

let host = null;
let realRootCache = null;

// Cached only on SUCCESS: core creates the root at its first save, which can
// follow this plugin's load, so caching a failure blanks the list for the process.
function realRoot() {
  if (realRootCache !== null) return realRootCache;
  try {
    realRootCache = fs.realpathSync(MEMORY_ROOT);
  } catch (_) {
    return null;
  }
  return realRootCache;
}

/**
 * `key` (from the filename) is the DELETE TARGET: core resolves a unit as
 * `<dir>/<id>.md`, so the basename is the identity and `id:` only a claim about
 * it. They can disagree — the store is hand-authorable — and deleting by
 * `meta.id` would unlink a different file than the confirmation showed.
 */
function parseUnit(text, key) {
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
    key,
    id: meta.id || key,
    // A disagreement is shown, not silently resolved: the delete targets `key`,
    // so the user must be able to see that the id on screen is not it.
    idMismatch: !!meta.id && meta.id !== key,
    scope: meta.scope || '',
    learned_at: meta.learned_at || '',
    source: meta.source || '',
    pinned: meta.pinned === 'true',
    // The operator's own flag, distinct from the agent's `pinned`. Only this
    // one guarantees a full body in the boot digest.
    operatorPinned: meta.operator_pinned === 'true',
    body: s.slice(end + 5).replace(/^\n+/, '').replace(/\s+$/, ''),
  };
}

function listAgentDirs() {
  const root = realRoot();
  if (root === null) return [];
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  // A Dirent's isDirectory() does not follow the link, so a symlinked folder is
  // false here and never becomes an agent row. Do not swap it for a statSync.
  return names
    .filter((d) => d.isDirectory() && AGENT_NAME_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

/**
 * The directory for `agent`, or null if it is not a single child of the resolved
 * MEMORY_ROOT. `agent` arrives over IPC, so this is the only sanctioned way to
 * turn it into a path: the dirname comparison rejects '.', '..' and anything
 * else lexically elsewhere, whatever the regex allows. LEXICAL only — it says
 * nothing about what that dir or its entries RESOLVE to, so every read below
 * owes confineToDir() a call as well.
 */
function agentDir(agent) {
  if (typeof agent !== 'string' || !AGENT_NAME_RE.test(agent)) return null;
  const root = realRoot();
  if (root === null) return null;
  const dir = path.resolve(root, agent);
  if (path.dirname(dir) !== root) return null;
  return dir;
}

/**
 * The real path of `entryPath` if it resolves strictly inside the ALREADY
 * RESOLVED `base`, else null. An agent writes its own memory folder, so an entry
 * there may be a symlink aimed anywhere on disk. `path.sep` is load-bearing: a
 * bare prefix test also admits `clodex-evil` beside `clodex`.
 */
function confineToDir(base, entryPath) {
  let real;
  try {
    real = fs.realpathSync(entryPath);
  } catch (_) {
    return null;
  }
  return real.startsWith(base + path.sep) ? real : null;
}

function readUnits(agent) {
  const dir = agentDir(agent);
  if (dir === null) return [];
  // The folder must resolve to ITSELF, not merely inside the root: an agent that
  // replaced its memory dir with a symlink gets nothing, whether it aims out of
  // the root or at a SIBLING agent's folder, whose memories would otherwise
  // render under this agent's name. listAgentDirs refusing to list such a dir is
  // not the guard — `agent` arrives over IPC, not necessarily from that listing.
  const base = confineToDir(realRoot(), dir);
  if (base !== dir) return [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const units = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const real = confineToDir(base, path.join(dir, f));
    if (real === null) continue;
    // Judged through the FD: `real` re-resolves at open, a hardlink is in-dir.
    let text;
    let fd = null;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) continue;
      text = fs.readFileSync(fd, 'utf8');
    } catch (_) {
      continue;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const u = parseUnit(text, f.replace(/\.md$/, ''));
    if (u) units.push(u);
  }
  // Newest first. learned_at is ISO-8601 so a plain string comparison orders
  // correctly and units missing it sink to the end. Not localeCompare — that is
  // collation-sensitive about punctuation, which an ISO timestamp is not.
  units.sort((a, b) => {
    const x = String(a.learned_at);
    const y = String(b.learned_at);
    if (x === y) return 0;
    return x < y ? 1 : -1;
  });
  return units;
}

// The unit reads are uncached by design: this runs only when the user opens the
// overlay, so a cache would buy nothing and reintroduce the staleness bound the
// badge removal deleted.
function computeAgents() {
  return listAgentDirs().map((agent) => {
    const units = readUnits(agent);
    return {
      agent,
      count: units.length,
      pinned: units.filter((u) => u.operatorPinned).length,
      // Memories outlive sessions: dead agents stay in the list, marked.
      live: host.sessions.get(agent) !== null,
    };
  });
}

module.exports.activate = (h) => {
  // Re-enable reuses this module object; start from zero. The resolved root is
  // part of that state — a root removed and recreated between enables resolves
  // somewhere new.
  host = h;
  realRootCache = null;

  host.ipc.handle('agents', () => {
    return { ok: true, agents: computeAgents() };
  });

  host.ipc.handle('units', (agent) => {
    if (agentDir(agent) === null) {
      return { ok: false, error: 'a valid agent name is required' };
    }
    return { ok: true, agent, units: readUnits(agent) };
  });

  // `agent` arrives over IPC, so it is vetted through agentDir() like every
  // other renderer-supplied name here — core validates it again, with its own
  // rules, and neither guard is the other's excuse. The id is NOT vetted here:
  // core's MEMORY_ID_RE owns that, and a second grammar would drift.
  host.ipc.handle('forget', (payload) => {
    const { agent, id } = payload || {};
    if (agentDir(agent) === null) {
      return { ok: false, error: 'a valid agent name is required' };
    }
    return host.library.remove('memory', { agent, id });
  });

  // The cap is core's to enforce, not this plugin's: a plugin-side count would
  // be advisory (another window, or the store edited by hand, moves it) and
  // would disagree with the refusal the operator actually gets.
  host.ipc.handle('setPin', (payload) => {
    const { agent, id, on } = payload || {};
    if (agentDir(agent) === null) {
      return { ok: false, error: 'a valid agent name is required' };
    }
    return host.library.setPin('memory', { agent, id }, !!on);
  });

  host.log.info('activated');
};

module.exports.deactivate = () => {
  host = null;
};
