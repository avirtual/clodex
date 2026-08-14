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
const { confine } = require('./path-confine');
const { previewLine } = require('./body-preview');

// A charset filter, NOT the containment check — it admits `.` and `..`, which
// are spelled entirely in this charset. Containment is enforced positively in
// _dir() via confine(); every verb routes through it. Do not reintroduce this
// regex as a traversal guard if _dir is ever refactored.
const MEMORY_AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/; // mirrors session name rule
// Strict unit-id shape (as minted by remember()). pin/forget resolve ids into
// file paths, so anything looser would be a traversal vector.
const MEMORY_ID_RE = /^mem-\d+-[a-z0-9]+$/;

const CORE_META_KEYS = ['id', 'scope', 'learned_at', 'source'];

function serializeMemoryUnit(meta, body) {
  const lines = ['---'];
  for (const k of CORE_META_KEYS) {
    lines.push(`${k}: ${meta[k] != null ? String(meta[k]) : ''}`);
  }
  // Anything parse read that this function doesn't name. setPinned round-trips
  // parse -> serialize, so a key omitted here is a key that PIN DELETES —
  // silently, on a file the user never asked to edit. Emitted after the core
  // keys and before `pinned` so the core order stays byte-stable.
  for (const k of Object.keys(meta)) {
    if (CORE_META_KEYS.includes(k) || k === 'pinned' || k === 'operator_pinned') continue;
    lines.push(`${k}: ${meta[k] != null ? String(meta[k]) : ''}`);
  }
  // Written only when set — pre-pin files stay byte-identical on disk.
  if (meta.pinned) lines.push('pinned: true');
  // Last, so an operator pin is visible at the end of the frontmatter where a
  // human scanning the file expects the thing they set. Separate key from
  // `pinned` on purpose: the agent's flag and the operator's are different
  // claims, and collapsing them would erase which one a store's history came
  // from the moment either is written.
  if (meta.operator_pinned) lines.push('operator_pinned: true');
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
    // The single choke point: list/remember/recall/setPinned/forget all build
    // their paths from here, so one containment check covers the store rather
    // than each verb having to remember one.
    _dir(agent) {
      const dir = confine(rootDir, agent);
      if (dir === null) throw new Error(`invalid agent name: ${agent}`);
      return dir;
    },
    _file(agent, id) { return path.join(this._dir(agent), `${id}.md`); },
    // Every agent with a store, for callers that must reason about the WHOLE
    // store rather than one agent's slice — a shared cache keyed across agents
    // cannot garbage-collect correctly from a single agent's key set.
    agents() {
      let entries;
      try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
      catch { return []; }
      return entries
        .filter((e) => e.isDirectory() && MEMORY_AGENT_RE.test(e.name))
        .map((e) => e.name);
    },
    list(agent) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return [];
      let dir;
      // A refused name is not a read error: kept out of the catch below so it
      // can't be mistaken for "directory absent" by a future edit.
      try { dir = this._dir(agent); } catch { return []; }
      let files;
      try { files = fs.readdirSync(dir); }
      catch { return []; }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const { meta, body } = parseMemoryUnit(fs.readFileSync(path.join(dir, f), 'utf-8'));
          out.push({
            id: meta.id || f.replace(/\.md$/, ''),
            scope: meta.scope || '',
            learned_at: meta.learned_at || '',
            source: meta.source || '',
            pinned: meta.pinned === 'true',
            operatorPinned: meta.operator_pinned === 'true',
            // Carried for recall's haystack. Every other frontmatter key stays
            // on disk only; this one is surfaced because it is meant to be
            // searched, which is the whole point of writing it.
            tags: meta.tags || '',
            body,
          });
        } catch { /* skip garbled */ }
      }
      return out.sort((a, b) => String(a.learned_at).localeCompare(String(b.learned_at)));
    },
    remember(agent, { scope = '', tags = '', text, source = '', pinned = false }) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      const body = String(text ?? '').trim();
      if (!body) throw new Error('empty memory text');
      fs.mkdirSync(this._dir(agent), { recursive: true, mode: 0o700 });
      const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const meta = { id, scope: String(scope || '').trim(), learned_at: new Date().toISOString(), source: source || agent };
      // Omitted when empty so untagged units keep the pre-tags byte shape on
      // disk, matching how `pinned` is written only when set.
      if (String(tags || '').trim()) meta.tags = String(tags).trim();
      if (pinned) meta.pinned = 'true';
      fs.writeFileSync(this._file(agent, id), serializeMemoryUnit(meta, body), { mode: 0o600 });
      return { id, ...meta, pinned: !!pinned, body };
    },
    // Resolve a recall arg: exact id first, else a case-insensitive substring
    // match against scope+tags+body (first by learned_at). Returns the unit or
    // null. Tags are in the haystack because a tag nobody can search for is not
    // worth writing; the REST of the frontmatter stays out on purpose — ids and
    // ISO timestamps make short queries match on digits.
    recall(agent, arg) {
      const units = this.list(agent);
      const q = String(arg || '').trim();
      if (!q) return null;
      const exact = units.find(u => u.id === q);
      if (exact) return exact;
      const ql = q.toLowerCase();
      return units.find(u => (u.scope + '\n' + u.tags + '\n' + u.body).toLowerCase().includes(ql)) || null;
    },
    // The AGENT's flag. It orders the recent tier and nothing more — it does
    // NOT guarantee a body in the digest. See the OPERATOR_PIN_CAP note.
    setPinned(agent, id, on) {
      return this._setFlag(agent, id, 'pinned', on);
    },
    // The OPERATOR's flag: a hard-capped slot that guarantees a full body at
    // boot. Refuses past the cap rather than silently evicting — the operator
    // set both pins deliberately, so which one to drop is theirs to choose, and
    // an eviction here would look like the pin simply not working.
    setOperatorPinned(agent, id, on) {
      if (on) {
        const already = this.list(agent).filter(u => u.operatorPinned && u.id !== id);
        if (already.length >= OPERATOR_PIN_CAP) {
          throw new Error(`operator pin limit reached (${OPERATOR_PIN_CAP}) — unpin one first`);
        }
      }
      return this._setFlag(agent, id, 'operator_pinned', on);
    },
    _setFlag(agent, id, key, on) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      if (!MEMORY_ID_RE.test(String(id || ''))) throw new Error(`invalid unit id: ${id}`);
      const file = this._file(agent, id);
      let raw;
      try { raw = fs.readFileSync(file, 'utf-8'); }
      catch { throw new Error(`no unit ${id}`); }
      const { meta, body } = parseMemoryUnit(raw);
      if (on) meta[key] = 'true'; else delete meta[key];
      if (!meta.id) meta.id = id;
      fs.writeFileSync(file, serializeMemoryUnit(meta, body), { mode: 0o600 });
      return { id, [key === 'pinned' ? 'pinned' : 'operatorPinned']: !!on };
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
// already carry it in history; see setupClaudeHook in main.js).
//
// Three tiers, in fill order: OPERATOR pins in full, then the most RECENT units
// in full, then index lines. A fresh session can't recall what it doesn't know
// exists, but re-injecting every body forever is how boot context bloats (live
// incident: a 79K memory file). Bodies stay on disk, one recall away.
//
// Why the operator owns the pin, measured on the live store 2026-08-02: agent
// self-pinning inflated 33% -> 90% of units over four weeks, and a store with
// 130 pins served TWO of them in full. Everything past the budget was a claim
// the digest silently ignored. An agent pinning its own memories has no reason
// to ever say "worth saving, not worth pinning", so the flag stopped
// discriminating and the tier stopped meaning anything. OPERATOR_PIN_CAP is
// what keeps it meaningful: a scarce slot spends itself against the alternative.
// `pinned` (agent-set) survives as a RECENCY BOOST only — it orders the recent
// tier, it does not guarantee delivery.
//
// Budget: whole units only, overflow is counted, never truncated mid-unit.
// Bodies get half the budget; a unit whose body doesn't fit falls to an index
// line, and if the index overflows too, the tail is what keeps it countable.
// Empty store → null (no digest — and main.js leaves the conversation UNMARKED
// in the digest ledger, so units saved later still reach it via the
// append-once path).

const DIGEST_BUDGET = 8 * 1024;

// Operator pins bypass the per-unit cap below: the operator is asserting THIS
// text is worth its bytes, and silently demoting it would make the one
// deliberate human signal in the system unreliable.
const OPERATOR_PIN_CAP = 3;

// A single unit cannot eat the recent tier. Measured on the live store: p50
// body is 1162 B, so an uncapped fill serves 2-4 long units and starves
// everything after them; at 600 B the same budget serves 7 and the store's
// short units — the ones written as assertions rather than essays — are the
// ones that ride. The cap is an incentive as much as a bound.
const RECENT_BODY_CAP = 600;

function fmtAge(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = Math.floor((now - t) / 86_400_000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((now - t) / 3_600_000);
  return h >= 1 ? `${h}h` : '<1h';
}

// The tiering this function computes is also a consumer-facing fact: a unit
// whose BODY rode is in context, a unit that only got an index line is NOT —
// the model knows it exists and cannot read it. digestTiers reports both the
// string and the three id sets from ONE pass, so the tiers cannot drift from
// the bytes actually served. composeDigest keeps its string-or-null shape
// because callers branch on it (session-manager.js digestNonEmpty, cli-hooks).
function digestTiers(units, { budget = DIGEST_BUDGET, now = Date.now() } = {}) {
  const empty = { text: null, full: [], title: [], absent: [] };
  if (!Array.isArray(units) || units.length === 0) return empty;
  // Newest-first everywhere. The operator tier used to be ascending, which
  // froze the served set at the earliest pins once a store crossed the budget —
  // no later pin could ever displace one. Do not restore ascending order: a pin
  // is a claim about what a future session needs, and that claim decays.
  const operator = units.filter(u => u.operatorPinned).reverse().slice(0, OPERATOR_PIN_CAP);
  const inOperator = new Set(operator.map(u => u.id));
  // The recent tier is ordered by recency, with agent-set `pinned` as a tiebreak
  // BOOST rather than a gate. That demotion is the point: the agent's own flag
  // stopped discriminating (90% of recent units carried it), so it can order the
  // queue but must not decide membership.
  const candidates = units
    .filter(u => !inOperator.has(u.id))
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.learned_at) || 0;
      const bt = Date.parse(b.learned_at) || 0;
      if (bt !== at) return bt - at;
      return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    });
  const head = `Your persistent memory (${units.length} unit(s), saved across sessions). `
    + 'Recall any unit by id or keyword: [agent:memory recall] <id|query>.';
  const indexHead = '\nIndex (bodies on disk — recall to read):';
  const indexLine = (u, mark) => {
    const first = previewLine(u.body, 80);
    const age = fmtAge(u.learned_at, now);
    return `\n- ${mark}${u.id}${u.scope ? ` [${u.scope}]` : ''} ${first}${age ? ` (${age})` : ''}`;
  };
  // Every withheld unit is counted here, which is what makes withholding safe:
  // this tail, not a per-unit reserve, is the guarantee that nothing becomes
  // invisible. Built by a function because its own length has to be reserved
  // before the numbers going into it are known.
  const tailText = (shown, listed, omitted, more) => {
    const clauses = [];
    // Only worth stating once some unit did NOT get its body: "5 of 5" is noise.
    if (listed || omitted) clauses.push(`${shown} shown in full`);
    if (listed) clauses.push(`${listed} listed by title only`);
    if (omitted) clauses.push(`${omitted} omitted`);
    if (more) clauses.push(`+${more} more`);
    return clauses.length ? `\n(${clauses.join('; ')} — [agent:memory list])` : '';
  };
  const parts = [head];
  let used = head.length;
  let shown = 0;
  let demotedOmitted = 0;
  let indexOmitted = 0;
  // { id, line } rather than bare lines: the tier sets are built from whatever
  // actually gets pushed below, so a line that overflows cannot be counted as
  // served.
  const demoted = [];
  const full = [];
  const title = [];

  // Bodies get half the budget and stop. The rule this replaces reserved a
  // fallback index line for EVERY remaining pin before spending anything on
  // bodies — a reserve unbounded in the number of pins against a fixed budget,
  // so past roughly sixty pins it exceeded the budget by itself and the digest
  // served zero bodies (measured: 108 pins, 0 bodies, and no test caught it
  // because an empty digest satisfies every size assertion). Do not reintroduce
  // a per-unit reserve to protect reachability; that is the tail's job, and the
  // tail costs one line instead of one line per unit.
  const bodyBudget = Math.floor(budget / 2);
  let bodyBytes = 0;
  const emitBody = (u, heading) => {
    const block = `\n## ${u.id}${u.scope ? ` [${u.scope}]` : ''}\n${u.body}`;
    // A body that doesn't fit falls through to the index. Dropping it made a
    // served unit LESS reachable than an unserved one, which at least keeps a
    // line to recall from.
    if (bodyBytes + block.length > bodyBudget) {
      demoted.push({ id: u.id, line: indexLine(u, u.operatorPinned ? '[pinned] ' : '') });
      return;
    }
    // Heading emitted with the first body under it, not before: one oversized
    // unit is enough to demote a whole tier, and a heading over an empty
    // section reads as a store that lost its contents.
    if (heading.pending) { parts.push(heading.text); used += heading.text.length; heading.pending = false; }
    parts.push(block); used += block.length; bodyBytes += block.length; shown += 1;
    full.push(u.id);
  };

  const opHeading = { text: '\nPinned by the operator (full text):', pending: true };
  for (const u of operator) emitBody(u, opHeading);

  // Only SHORT recent units get bodies. Without this an essay-length unit eats
  // the tier and the next several are demoted behind it; the cap converts the
  // same budget from 2 units into ~7 (measured on the live store).
  const recentHeading = { text: '\nMost recent (full text):', pending: true };
  const overflow = [];
  for (const u of candidates) {
    if (u.body.length > RECENT_BODY_CAP) { overflow.push(u); continue; }
    if (bodyBytes >= bodyBudget) { overflow.push(u); continue; }
    emitBody(u, recentHeading);
  }

  if (demoted.length || overflow.length) {
    // Worst-case tail, every clause at its largest number. The exact tail can't
    // be reserved (its numbers come out of the loops below) and an unreserved
    // one is how a full index pushed the digest past the budget it was sized
    // against. Over-reserving costs an index line; under-reserving costs the
    // byte bound the whole function exists to hold.
    const n = units.length;
    const limit = budget - tailText(n, n, n, n).length;
    parts.push(indexHead); used += indexHead.length;
    // Demoted bodies lead the index, so a unit that ALMOST rode stays near the
    // top of what the agent can see.
    for (const d of demoted) {
      if (used + d.line.length > limit) { demotedOmitted += 1; continue; }
      parts.push(d.line); used += d.line.length;
      title.push(d.id);
    }
    for (const u of overflow) {
      const line = indexLine(u, '');
      if (used + line.length > limit) { indexOmitted += 1; continue; }
      parts.push(line); used += line.length;
      title.push(u.id);
    }
  }

  parts.push(tailText(shown, demoted.length - demotedOmitted, demotedOmitted, indexOmitted));
  const served = new Set([...full, ...title]);
  return {
    text: parts.join(''),
    full,
    title,
    // Everything the digest counted but did not serve. Derived from `units`
    // rather than from the omitted counters so a unit dropped by any future
    // branch lands here by default — absent is the safe tier.
    absent: units.map(u => u.id).filter(id => !served.has(id)),
  };
}

function composeDigest(units, opts) {
  return digestTiers(units, opts).text;
}

module.exports = {
  createMemoryStore, composeDigest, digestTiers, serializeMemoryUnit, parseMemoryUnit,
  MEMORY_ID_RE, DIGEST_BUDGET, OPERATOR_PIN_CAP, RECENT_BODY_CAP,
};
