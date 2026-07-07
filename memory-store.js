// Agent memory store (spec §10 — the intent-driven MANAGEMENT layer) + the
// boot digest composer. Extracted from main.js so the store and digest policy
// are testable without Electron (same move as attention.js / proxy-util.js).
//
// Each agent has its own memories: discrete units as flat per-id files under
// <dir>/<agent>/<id>.md (DB overkill at this scale; same human-inspectable
// on-disk idiom as the prompt/agent/skill libraries). A unit is YAML-ish
// frontmatter (id, scope, learned_at, source, pinned) + the unit text body.
//
// This is the MANAGEMENT path (list/remember/recall/pin/forget via intent),
// distinct from the priced in-turn RETRIEVAL path (memory-as-tool-call,
// Part 2 — gated on wirescope). Mechanism-only per settled-position #1: empty
// until an agent or the user authors units. `last_referenced_at` is
// deliberately NOT written here — that's wirescope's decay clock (W1), and an
// intent-recall is UX, not a priced reference, so writing it would corrupt
// the decay signal.

const fs = require('fs');
const path = require('path');

const MEMORY_AGENT_RE = /^[a-zA-Z0-9._-]{1,64}$/; // mirrors session name rule
// Strict unit-id shape (as minted by remember()). pin/forget resolve ids into
// file paths, so anything looser would be a traversal vector.
const MEMORY_ID_RE = /^mem-\d+-[a-z0-9]+$/;

function serializeMemoryUnit(meta, body) {
  const lines = ['---'];
  for (const k of ['id', 'scope', 'learned_at', 'source']) {
    lines.push(`${k}: ${meta[k] != null ? String(meta[k]) : ''}`);
  }
  // Written only when set — pre-pin files stay byte-identical on disk.
  if (meta.pinned) lines.push('pinned: true');
  lines.push('---', '', String(body ?? '').trim(), '');
  return lines.join('\n');
}

function parseMemoryUnit(raw) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(raw).trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s?(.*)$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: (m[2] || '').trim() };
}

function createMemoryStore(rootDir) {
  return {
    _dir(agent) { return path.join(rootDir, agent); },
    _file(agent, id) { return path.join(this._dir(agent), `${id}.md`); },
    list(agent) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return [];
      let files;
      try { files = fs.readdirSync(this._dir(agent)); }
      catch { return []; }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const { meta, body } = parseMemoryUnit(fs.readFileSync(path.join(this._dir(agent), f), 'utf-8'));
          out.push({
            id: meta.id || f.replace(/\.md$/, ''),
            scope: meta.scope || '',
            learned_at: meta.learned_at || '',
            source: meta.source || '',
            pinned: meta.pinned === 'true',
            body,
          });
        } catch { /* skip garbled */ }
      }
      return out.sort((a, b) => String(a.learned_at).localeCompare(String(b.learned_at)));
    },
    remember(agent, { scope = '', text, source = '', pinned = false }) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      const body = String(text ?? '').trim();
      if (!body) throw new Error('empty memory text');
      fs.mkdirSync(this._dir(agent), { recursive: true, mode: 0o700 });
      const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const meta = { id, scope: String(scope || '').trim(), learned_at: new Date().toISOString(), source: source || agent };
      if (pinned) meta.pinned = 'true';
      fs.writeFileSync(this._file(agent, id), serializeMemoryUnit(meta, body), { mode: 0o600 });
      return { id, ...meta, pinned: !!pinned, body };
    },
    // Resolve a recall arg: exact id first, else a case-insensitive substring
    // match against scope+body (first by learned_at). Returns the unit or null.
    recall(agent, arg) {
      const units = this.list(agent);
      const q = String(arg || '').trim();
      if (!q) return null;
      const exact = units.find(u => u.id === q);
      if (exact) return exact;
      const ql = q.toLowerCase();
      return units.find(u => (u.scope + '\n' + u.body).toLowerCase().includes(ql)) || null;
    },
    // Pin/unpin: pinned units ride the boot digest in FULL (unpinned ones only
    // as index lines). Rewrites the unit file preserving all other meta.
    setPinned(agent, id, on) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      if (!MEMORY_ID_RE.test(String(id || ''))) throw new Error(`invalid unit id: ${id}`);
      const file = this._file(agent, id);
      let raw;
      try { raw = fs.readFileSync(file, 'utf-8'); }
      catch { throw new Error(`no unit ${id}`); }
      const { meta, body } = parseMemoryUnit(raw);
      if (on) meta.pinned = 'true'; else delete meta.pinned;
      if (!meta.id) meta.id = id;
      fs.writeFileSync(file, serializeMemoryUnit(meta, body), { mode: 0o600 });
      return { id, pinned: !!on };
    },
    forget(agent, id) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      if (!MEMORY_ID_RE.test(String(id || ''))) throw new Error(`invalid unit id: ${id}`);
      try { fs.unlinkSync(this._file(agent, id)); }
      catch { throw new Error(`no unit ${id}`); }
    },
  };
}

// --- Boot digest ---------------------------------------------------------------
// What a NEW conversation learns about its memory store, delivered via the
// SessionStart hook's additionalContext (source startup/clear only — resumes
// already carry it in history; see setupClaudeHook in main.js). Pinned units
// arrive in FULL (they're the "settled positions" class — useless if the agent
// has to know to ask); everything else is an index line, because a fresh
// session can't recall what it doesn't know exists, but re-injecting every
// body forever is how boot context bloats (live incident: a 79K memory file).
// Bodies stay on disk, one recall away.
//
// Budget: pinned first (oldest first — settled positions read in the order
// they were settled), then index newest-first; whole units only, overflow is
// counted, never truncated mid-unit. Empty store → null (no digest at all —
// and main.js leaves the conversation UNMARKED in the digest ledger, so units
// saved later still reach it via the append-once path).

const DIGEST_BUDGET = 8 * 1024;

function fmtAge(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.floor((now - t) / 86_400_000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((now - t) / 3_600_000);
  return h >= 1 ? `${h}h` : '<1h';
}

function composeDigest(units, { budget = DIGEST_BUDGET, now = Date.now() } = {}) {
  if (!Array.isArray(units) || units.length === 0) return null;
  const pinned = units.filter(u => u.pinned); // list() is learned_at ascending
  const rest = units.filter(u => !u.pinned).reverse(); // newest first
  const head = `Your persistent memory (${units.length} unit(s), saved across sessions). `
    + 'Recall any unit by id or keyword: [agent:memory recall] <id|query>.';
  const parts = [head];
  let used = head.length;
  let omitted = 0;

  if (pinned.length) {
    const ph = '\nPinned (full text):';
    parts.push(ph); used += ph.length;
    for (const u of pinned) {
      const block = `\n## ${u.id}${u.scope ? ` [${u.scope}]` : ''}\n${u.body}`;
      if (used + block.length > budget) { omitted += 1; continue; }
      parts.push(block); used += block.length;
    }
  }
  if (rest.length) {
    const ih = '\nIndex (bodies on disk — recall to read):';
    parts.push(ih); used += ih.length;
    for (const u of rest) {
      const first = (u.body.split('\n')[0] || '').slice(0, 80);
      const age = fmtAge(u.learned_at, now);
      const line = `\n- ${u.id}${u.scope ? ` [${u.scope}]` : ''} ${first}${age ? ` (${age})` : ''}`;
      if (used + line.length > budget) { omitted += 1; continue; }
      parts.push(line); used += line.length;
    }
  }
  if (omitted) parts.push(`\n(+${omitted} more — [agent:memory list])`);
  return parts.join('');
}

module.exports = {
  createMemoryStore, composeDigest, serializeMemoryUnit, parseMemoryUnit,
  MEMORY_ID_RE, DIGEST_BUDGET,
};
