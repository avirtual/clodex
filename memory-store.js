// Agent memory store (the intent-driven MANAGEMENT layer) + the
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
const { atomicWriteFileSync } = require('./fs-util');
const { previewLine } = require('./body-preview');
const { seatPathFor, legacySeatPathFor } = require('./clodex-paths');

// A charset filter, NOT the containment check — it admits `.` and `..`, which
// are spelled entirely in this charset. Containment is enforced positively in
// _dir() via confine(); every verb routes through it. Do not reintroduce this
// regex as a traversal guard if _dir is ever refactored.
const MEMORY_AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/; // mirrors session name rule
// Strict unit-id shape (as minted by remember()). pin/forget resolve ids into
// file paths, so anything looser would be a traversal vector.
const MEMORY_ID_RE = /^mem-\d+-[a-z0-9]+$/;

const CORE_META_KEYS = ['id', 'scope', 'learned_at', 'source'];

function linksToSeatMemory(rootDir, name) {
  const root = path.dirname(path.dirname(rootDir));
  if (legacySeatPathFor(root, name, 'memory') !== path.join(rootDir, name)) return false;
  try {
    const real = fs.realpathSync(path.join(rootDir, name));
    return fs.statSync(real).isDirectory()
      && real === fs.realpathSync(seatPathFor(root, name, 'memory'));
  } catch { return false; }
}

function readUnitFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return null;
    return fs.readFileSync(fd, 'utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

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

const PROFILE_ID = 'profile';
const PROFILE_SECTIONS = ['game', 'notes'];
const PROFILE_KEY_RE = /^[a-z0-9_-]+$/;
const PROFILE_KEY_MAX = 64;
const PROFILE_CAP = 4096;
const PROFILE_NOTES_CAP = 2048;
const PROFILE_NOT_UNIT = 'profile is not a unit';

const PROFILE_TYPE_WORDS = /^(?:true|false|null|yes|no|on|off|y|n|~|[-+]?\.inf|\.nan)$/i;
const PROFILE_LEAD_SPECIAL = /^[-?:,[\]{}#&*!|>'"%@` ]/;
const PROFILE_CTRL = /[\u0000-\u001F\u007F]/;
const PROFILE_PLAIN_NESTED_KEY = /^[A-Za-z0-9_](?:[A-Za-z0-9 _.'-]*[A-Za-z0-9_.'-])?$/;
const PROFILE_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const PROFILE_KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^:]*?):(?:[ \t]+(.*))?$/;

function profileNumericLooking(s) {
  return /^[-+]?0[xXoObB][0-9a-fA-F_]+$/.test(s)
    || /^[-+]?\d+(?::[0-5]?\d)+(?:\.\d*)?$/.test(s)
    || (/^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?$/.test(s) && /[0-9]/.test(s));
}

function profileNeedsQuote(s) {
  return s === ''
    || PROFILE_TYPE_WORDS.test(s)
    || profileNumericLooking(s)
    || PROFILE_LEAD_SPECIAL.test(s)
    || /[ :]$/.test(s)
    || s.includes(': ')
    || s.includes(' #')
    || PROFILE_CTRL.test(s);
}

function profileQuote(s) {
  return JSON.stringify(s).replace(/\u007F/g, '\\u007f');
}

function profileScalarText(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return profileNeedsQuote(v) ? profileQuote(v) : v;
}

function profileNestedKeyText(k) {
  return PROFILE_PLAIN_NESTED_KEY.test(k) && !profileNeedsQuote(k) ? k : profileQuote(k);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isProfileScalar(v) {
  return v === null || typeof v === 'string' || typeof v === 'boolean'
    || (typeof v === 'number' && Number.isFinite(v));
}

function checkNestedKey(k, where) {
  if (typeof k !== 'string' || k.length === 0 || k.length > PROFILE_KEY_MAX || PROFILE_CTRL.test(k) || k === '__proto__') {
    throw new Error(`${where}: bad key ${JSON.stringify(k)}`);
  }
}

function checkProfileValue(v, where) {
  if (isProfileScalar(v)) return;
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      if (!isProfileScalar(item)) throw new Error(`${where}[${i}]: list items must be scalars`);
    });
    return;
  }
  if (isPlainObject(v)) {
    for (const [k, item] of Object.entries(v)) {
      checkNestedKey(k, where);
      if (!isProfileScalar(item)) throw new Error(`${where}.${k}: nesting deeper than one level`);
    }
    return;
  }
  throw new Error(`${where}: unsupported value`);
}

function checkProfileInput(input) {
  if (!isPlainObject(input)) throw new Error('profile must be an object with game and/or notes');
  for (const key of Object.keys(input)) {
    if (!PROFILE_SECTIONS.includes(key)) throw new Error(`unknown profile section: ${key}`);
  }
  for (const section of PROFILE_SECTIONS) {
    const map = input[section];
    if (map === undefined) continue;
    if (!isPlainObject(map)) throw new Error(`${section}: must be a map`);
    for (const [k, v] of Object.entries(map)) {
      if (!PROFILE_KEY_RE.test(k) || k.length > PROFILE_KEY_MAX || k === '__proto__') throw new Error(`${section}: bad key ${JSON.stringify(k)}`);
      checkProfileValue(v, `${section}.${k}`);
    }
  }
}

function cloneProfileValue(v) {
  if (Array.isArray(v)) return v.slice();
  if (isPlainObject(v)) return { ...v };
  return v;
}

function serializeProfile(profile) {
  const lines = [];
  for (const section of PROFILE_SECTIONS) {
    const map = (profile && profile[section]) || {};
    const keys = Object.keys(map);
    if (!keys.length) continue;
    lines.push(`${section}:`);
    for (const k of keys) {
      const v = map[k];
      if (Array.isArray(v)) {
        if (!v.length) { lines.push(`  ${k}: []`); continue; }
        lines.push(`  ${k}:`);
        for (const item of v) lines.push(`    - ${profileScalarText(item)}`);
      } else if (isPlainObject(v)) {
        const inner = Object.keys(v);
        if (!inner.length) { lines.push(`  ${k}: {}`); continue; }
        lines.push(`  ${k}:`);
        for (const ik of inner) lines.push(`    ${profileNestedKeyText(ik)}: ${profileScalarText(v[ik])}`);
      } else {
        lines.push(`  ${k}: ${profileScalarText(v)}`);
      }
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function parseProfileValueText(text, where) {
  const t = String(text == null ? '' : text).trim();
  if (t === '' || t.startsWith('#')) return { kind: 'empty' };
  const c = t[0];
  if (c === '&' || c === '*') throw new Error(`${where}: anchors and aliases are not allowed`);
  if (c === '!') throw new Error(`${where}: tags are not allowed`);
  if (c === '|' || c === '>') throw new Error(`${where}: block scalars are not allowed`);
  if (c === '"') {
    const m = t.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!m) throw new Error(`${where}: bad double-quoted string`);
    try { return { kind: 'scalar', value: JSON.parse(`"${m[1]}"`) }; }
    catch { throw new Error(`${where}: bad double-quoted string`); }
  }
  if (c === "'") {
    const m = t.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!m) throw new Error(`${where}: bad single-quoted string`);
    return { kind: 'scalar', value: m[1].replace(/''/g, "'") };
  }
  const hash = t.search(/\s#/);
  const s = hash >= 0 ? t.slice(0, hash).trimEnd() : t;
  if (s === '[]') return { kind: 'list' };
  if (s === '{}') return { kind: 'map' };
  if (c === '[' || c === '{') throw new Error(`${where}: flow collections are not allowed (only [] and {})`);
  if (s === '-' || s.startsWith('- ')) throw new Error(`${where}: a list must start on its own line`);
  if (/^(?:null|Null|NULL|~)$/.test(s)) return { kind: 'scalar', value: null };
  if (/^(?:true|True|TRUE)$/.test(s)) return { kind: 'scalar', value: true };
  if (/^(?:false|False|FALSE)$/.test(s)) return { kind: 'scalar', value: false };
  if (PROFILE_NUMBER.test(s)) return { kind: 'scalar', value: Number(s) };
  if (s.includes(': ') || s.endsWith(':')) throw new Error(`${where}: nested mapping is not allowed here`);
  return { kind: 'scalar', value: s };
}

function parseProfileKey(raw, at) {
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { throw new Error(`${at}: bad key`); }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.trimEnd();
}

function parseProfileYaml(text) {
  const out = { game: {}, notes: {} };
  const seenSections = new Set();
  let section = null;
  let entry = null;
  let nested = null;
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const close = () => {
    if (entry && entry.pending) out[section][entry.key] = null;
    entry = null;
    nested = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `line ${i + 1}`;
    const lead = line.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) throw new Error(`${at}: tabs are not allowed in indentation`);
    const body = line.slice(lead.length);
    if (body === '' || body.trim() === '' || body.startsWith('#')) continue;
    if (lead.length === 0 && (/^(?:---|\.\.\.)(?:\s|$)/.test(body) || body.startsWith('%'))) {
      throw new Error(`${at}: multi-document streams and directives are not allowed`);
    }
    const indent = lead.length;
    if (indent === 0) {
      close();
      const m = body.match(PROFILE_KEY_LINE);
      if (!m) throw new Error(`${at}: expected game: or notes:`);
      const key = parseProfileKey(m[1], at);
      if (!PROFILE_SECTIONS.includes(key)) throw new Error(`${at}: unknown top-level key ${JSON.stringify(key)} (only game: and notes:)`);
      if (seenSections.has(key)) throw new Error(`${at}: duplicate key ${key}`);
      const v = parseProfileValueText(m[2], at);
      if (v.kind !== 'empty' && v.kind !== 'map') throw new Error(`${at}: ${key} must be a map`);
      seenSections.add(key);
      section = key;
      continue;
    }
    if (!section) throw new Error(`${at}: content before game: or notes:`);
    const isItem = body === '-' || body.startsWith('- ');
    if (indent === 2 && !isItem) {
      close();
      const m = body.match(PROFILE_KEY_LINE);
      if (!m) throw new Error(`${at}: expected key: value`);
      const key = parseProfileKey(m[1], at);
      if (!PROFILE_KEY_RE.test(key) || key.length > PROFILE_KEY_MAX || key === '__proto__') throw new Error(`${at}: bad key ${JSON.stringify(key)}`);
      if (Object.prototype.hasOwnProperty.call(out[section], key)) throw new Error(`${at}: duplicate key ${key}`);
      const v = parseProfileValueText(m[2], at);
      if (v.kind === 'empty') { entry = { key, pending: true }; out[section][key] = null; continue; }
      out[section][key] = v.kind === 'list' ? [] : v.kind === 'map' ? {} : v.value;
      entry = null;
      continue;
    }
    if ((indent === 2 && isItem) || indent === 4) {
      if (!entry) throw new Error(`${at}: ${indent === 4 ? 'nesting deeper than one level' : 'list item outside a list'}`);
      if (isItem) {
        if (entry.kind === 'map') throw new Error(`${at}: cannot mix list items and keys`);
        if (entry.listIndent != null && entry.listIndent !== indent) throw new Error(`${at}: inconsistent list indentation`);
        const rest = body === '-' ? '' : body.slice(2);
        if (/^-(?:\s|$)/.test(rest.trim()) || PROFILE_KEY_LINE.test(rest.trim())) throw new Error(`${at}: list items must be scalars`);
        const v = parseProfileValueText(rest, at);
        if (v.kind === 'list' || v.kind === 'map') throw new Error(`${at}: list items must be scalars`);
        if (entry.pending) { out[section][entry.key] = []; entry.pending = false; entry.kind = 'list'; entry.listIndent = indent; }
        out[section][entry.key].push(v.kind === 'empty' ? null : v.value);
        continue;
      }
      if (entry.kind === 'list') throw new Error(`${at}: cannot mix list items and keys`);
      const m = body.match(PROFILE_KEY_LINE);
      if (!m) throw new Error(`${at}: expected key: value`);
      const key = parseProfileKey(m[1], at);
      checkNestedKey(key, at);
      if (entry.pending) { out[section][entry.key] = {}; entry.pending = false; entry.kind = 'map'; }
      const map = out[section][entry.key];
      if (Object.prototype.hasOwnProperty.call(map, key)) throw new Error(`${at}: duplicate key ${key}`);
      const v = parseProfileValueText(m[2], at);
      if (v.kind === 'list' || v.kind === 'map') throw new Error(`${at}: nesting deeper than one level`);
      map[key] = v.kind === 'empty' ? null : v.value;
      nested = key;
      continue;
    }
    if (indent > 4 && nested !== null) throw new Error(`${at}: nesting deeper than one level`);
    throw new Error(`${at}: bad indentation (two spaces per level)`);
  }
  close();
  return out;
}

function parseProfileValue(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) throw new Error('value required (drop removes a key)');
  if (lines.length === 1) return lines[0].trim();
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  const doc = ['notes:', '  v:', ...lines.map((l) => `    ${l.slice(pad)}`)].join('\n');
  let parsed;
  try { parsed = parseProfileYaml(doc); }
  catch (e) { throw new Error(e.message.replace(/^line (\d+)/, (_, n) => `line ${Number(n) - 2}`)); }
  const value = parsed.notes.v;
  if (value === null) throw new Error('value required (drop removes a key)');
  return value;
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
        .filter((e) => (e.isDirectory()
          || (e.isSymbolicLink() && linksToSeatMemory(rootDir, e.name)))
          && MEMORY_AGENT_RE.test(e.name))
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
        if (!f.endsWith('.md') || f === `${PROFILE_ID}.md`) continue;
        const raw = readUnitFile(path.join(dir, f));
        if (raw === null) continue;
        try {
          const { meta, body } = parseMemoryUnit(raw);
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
    remember(agent, { scope = '', tags = '', text, source = '', pinned = false, operatorPinned = false }) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      const body = String(text ?? '').trim();
      if (!body) throw new Error('empty memory text');
      if (operatorPinned) this._checkOperatorPinCap(agent, null);
      fs.mkdirSync(this._dir(agent), { recursive: true, mode: 0o700 });
      const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const meta = { id, scope: String(scope || '').trim(), learned_at: new Date().toISOString(), source: source || agent };
      // Omitted when empty so untagged units keep the pre-tags byte shape on
      // disk, matching how `pinned` is written only when set.
      if (String(tags || '').trim()) meta.tags = String(tags).trim();
      if (pinned) meta.pinned = 'true';
      if (operatorPinned) meta.operator_pinned = 'true';
      atomicWriteFileSync(this._file(agent, id), serializeMemoryUnit(meta, body));
      const { operator_pinned: _op, ...shown } = meta;
      return { id, ...shown, pinned: !!pinned, operatorPinned: !!operatorPinned, body };
    },
    update(agent, id, { text } = {}) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return { ok: false, error: `invalid agent name: ${agent}` };
      if (String(id) === PROFILE_ID) return { ok: false, error: PROFILE_NOT_UNIT };
      if (!MEMORY_ID_RE.test(String(id || ''))) return { ok: false, error: `invalid unit id: ${id}` };
      const next = String(text ?? '').trim();
      if (!next) return { ok: false, error: 'empty memory text' };
      const file = this._file(agent, id);
      const raw = readUnitFile(file);
      if (raw === null) return { ok: false, error: `no unit ${id}` };
      const { meta } = parseMemoryUnit(raw);
      if (!meta.id) meta.id = id;
      atomicWriteFileSync(file, serializeMemoryUnit(meta, next));
      return { ok: true, id };
    },
    recall(agent, arg) {
      return this.recallMany(agent, arg, 1)[0] || null;
    },
    recallMany(agent, arg, limit = 3) {
      const units = this.list(agent);
      const q = String(arg || '').trim();
      if (!q) return [];
      const exact = units.find(u => u.id === q);
      if (exact) return [exact];
      const ql = q.toLowerCase();
      const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      return units
        .filter(u => (u.scope + '\n' + u.tags + '\n' + u.body).toLowerCase().includes(ql))
        .sort((a, b) => cmp(String(b.learned_at), String(a.learned_at)) || cmp(b.id, a.id))
        .slice(0, Math.max(0, limit));
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
      if (on) this._checkOperatorPinCap(agent, id);
      return this._setFlag(agent, id, 'operator_pinned', on);
    },
    _checkOperatorPinCap(agent, id) {
      const already = this.list(agent).filter(u => u.operatorPinned && u.id !== id);
      if (already.length >= OPERATOR_PIN_CAP) {
        throw new Error(`operator pin limit reached (${OPERATOR_PIN_CAP}) — unpin one first`);
      }
    },
    _setFlag(agent, id, key, on) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      if (!MEMORY_ID_RE.test(String(id || ''))) throw new Error(`invalid unit id: ${id}`);
      const file = this._file(agent, id);
      const raw = readUnitFile(file);
      if (raw === null) throw new Error(`no unit ${id}`);
      const { meta, body } = parseMemoryUnit(raw);
      if (on) meta[key] = 'true'; else delete meta[key];
      if (!meta.id) meta.id = id;
      atomicWriteFileSync(file, serializeMemoryUnit(meta, body));
      return { id, [key === 'pinned' ? 'pinned' : 'operatorPinned']: !!on };
    },
    forget(agent, id) {
      if (!MEMORY_AGENT_RE.test(agent || '')) throw new Error(`invalid agent name: ${agent}`);
      if (String(id) === PROFILE_ID) throw new Error(PROFILE_NOT_UNIT);
      if (!MEMORY_ID_RE.test(String(id || ''))) throw new Error(`invalid unit id: ${id}`);
      try { fs.unlinkSync(this._file(agent, id)); }
      catch { throw new Error(`no unit ${id}`); }
    },
    _readProfile(agent) {
      const raw = readUnitFile(this._file(agent, PROFILE_ID));
      if (raw === null) return null;
      const { meta, body } = parseMemoryUnit(raw);
      return { profile: parseProfileYaml(body), updatedAt: meta.updated_at || null };
    },
    _profileView(stored) {
      if (!stored) return { ok: true, profile: null };
      const yaml = serializeProfile(stored.profile);
      return { ok: true, profile: stored.profile, yaml, bytes: Buffer.byteLength(yaml), updatedAt: stored.updatedAt };
    },
    profileGet(agent) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return { ok: false, error: `invalid agent name: ${agent}` };
      try { return this._profileView(this._readProfile(agent)); }
      catch (e) { return { ok: false, error: `stored profile unreadable: ${e.message}` }; }
    },
    profileSet(agent, input, { merge = true, seat = false } = {}) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return { ok: false, error: `invalid agent name: ${agent}` };
      try { checkProfileInput(input); }
      catch (e) { return { ok: false, error: e.message }; }
      let current;
      try { current = merge ? this._readProfile(agent) : null; }
      catch (e) { return { ok: false, error: `stored profile unreadable: ${e.message}` }; }
      const base = current ? current.profile : { game: {}, notes: {} };
      const next = { game: { ...base.game }, notes: { ...base.notes } };
      for (const section of PROFILE_SECTIONS) {
        const src = input[section];
        if (src === undefined) continue;
        for (const [k, v] of Object.entries(src)) {
          if (merge && v === null) delete next[section][k];
          else next[section][k] = cloneProfileValue(v);
        }
      }
      const yaml = serializeProfile(next);
      if (!yaml) {
        const gone = this.profileDelete(agent);
        return gone.ok ? { ok: true, profile: null } : gone;
      }
      const bytes = Buffer.byteLength(yaml);
      if (bytes > PROFILE_CAP) return { ok: false, error: `profile exceeds ${PROFILE_CAP} bytes (${bytes})` };
      if (seat === true) {
        const notesBytes = Buffer.byteLength(serializeProfile({ notes: next.notes }));
        const baseNotes = Buffer.byteLength(serializeProfile({ notes: base.notes }));
        if (notesBytes > PROFILE_NOTES_CAP && notesBytes > baseNotes) return { ok: false, error: `notes exceed ${PROFILE_NOTES_CAP} bytes (${notesBytes}) — drop a note first` };
      }
      const updatedAt = new Date().toISOString();
      const doc = ['---', `id: ${PROFILE_ID}`, `type: ${PROFILE_ID}`, `updated_at: ${updatedAt}`, '---', '', yaml].join('\n');
      fs.mkdirSync(this._dir(agent), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(this._file(agent, PROFILE_ID), doc);
      return this._profileView({ profile: next, updatedAt });
    },
    profileDelete(agent) {
      if (!MEMORY_AGENT_RE.test(agent || '')) return { ok: false, error: `invalid agent name: ${agent}` };
      try {
        fs.unlinkSync(this._file(agent, PROFILE_ID));
        return { ok: true, existed: true };
      } catch (e) {
        if (e && e.code === 'ENOENT') return { ok: true, existed: false };
        return { ok: false, error: e.message };
      }
    },
  };
}

// --- Boot digest ---------------------------------------------------------------
// What a NEW conversation learns about its memory store, delivered via the
// SessionStart hook's additionalContext (source startup/clear/compact — resumes
// already carry it in history; see setupClaudeHook in cli-hooks.js).
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
  parseProfileYaml, parseProfileValue, serializeProfile, PROFILE_CAP, PROFILE_NOTES_CAP, PROFILE_KEY_RE,
  MEMORY_ID_RE, DIGEST_BUDGET, OPERATOR_PIN_CAP, RECENT_BODY_CAP, fmtAge,
};
