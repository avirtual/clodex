'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KINDS = ['path', 'quirk', 'caution'];
const TEXT_MAX = 200;
const ANCHOR_MAX = 100;
const CAP = 40;
const SHOW_MAX = 3;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_RE = /^[a-z2-7]{4}$/;
const LINE_RE = /^([a-z2-7]{4}) @(\S+) (path|quirk|caution): (.*) — (\S+) (\d{4}-\d{2}-\d{2})$/;
const PREFIX_RE = /^@(\S+)\s+([a-z]+):\s*(.*)$/s;
const REF_RE = /\[(\d{1,7})\]/g;
const CRED_RE = /\b(password|passwords|parol[aăe]|otp|one-time|cvv|pin)\b/i;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.[a-z0-9-]/i;
const ACCOUNT_WORD_RE = /account|\bcont(?:ul|uri|urile)?\b|client|invoice|factur/i;
const ACCOUNT_NEAR = 20;

const TEXT = {
  usage: 'note needs "@<anchor> <kind>: <text>" — anchor * or a path (a ?key=value query is allowed), kind path|quirk|caution',
  intent: 'a note cannot carry an intent',
  credentials: 'a note should not mention credentials — describe the step, not the field',
  account: 'a note describes the site, never your account — no balances, names, invoice numbers or ids that belong to one login',
  url: 'notes carry no URLs — the anchor gives the location',
  oneLine: 'a note is one line',
  header: 'a note cannot start with # or ==',
  tooLong: `a note is at most ${TEXT_MAX} chars`,
  unreadable: 'notes file unreadable — ask the operator',
  full: (origin) => `notes full for ${origin} (${CAP}) — forget one by id`,
  duplicate: (id, anchor) => `already noted (${id} @${anchor})`,
  ref: (n) => `[${n}] is not from your read of this page — write the label, not the number`,
  label: (n) => `label of [${n}] cannot be stored — write it yourself`,
  noId: (id, origin) => `no note ${id} for ${origin} — note --list shows the ids`,
  hint: 'unverified hints from earlier visits',
};

const LOOPBACK = ['127.0.0.1', '::1', '[::1]', 'localhost'];

function originKey(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return LOOPBACK.includes(u.hostname) ? u.origin + '/' + (u.pathname.split('/')[1] || '') : u.origin;
  } catch { return ''; }
}

function pathOf(url) {
  try { return new URL(String(url || '')).pathname; } catch { return '/'; }
}

function searchOf(url) {
  try { return new URL(String(url || '')).search; } catch { return ''; }
}

function fileName(origin) {
  return `${crypto.createHash('sha1').update(String(origin)).digest('hex').slice(0, 16)}.md`;
}

function fold(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function formatLine(note) {
  return `${note.id} @${note.anchor} ${note.kind}: ${note.text} — ${note.seat} ${note.date}`;
}

function parseLine(line) {
  const m = LINE_RE.exec(String(line));
  if (!m) return null;
  return { id: m[1], anchor: m[2], kind: m[3], text: m[4], seat: m[5], date: m[6] };
}

function parseFile(origin, content) {
  const lines = String(content).split('\n');
  if (lines[0] !== origin) return null;
  const notes = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const n = parseLine(l);
    if (!n) return null;
    notes.push(n);
  }
  return notes;
}

function formatFile(origin, notes) {
  return [origin, ...notes.map(formatLine)].join('\n') + '\n';
}

function trimSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function queryMatches(query, search) {
  if (!query) return true;
  const page = new URLSearchParams(String(search || ''));
  for (const [k, v] of new URLSearchParams(query)) if (page.get(k) !== v) return false;
  return true;
}

function anchorMatches(anchor, pathname, search = '') {
  if (anchor === '*') return true;
  const q = anchor.indexOf('?');
  if (q >= 0 && !queryMatches(anchor.slice(q + 1), search)) return false;
  const p = trimSlash(String(pathname || '/'));
  const a = trimSlash(q >= 0 ? anchor.slice(0, q) : anchor);
  if (!a.includes('*')) return a === p;
  const re = new RegExp(`^${a.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(p);
}

function validAnchor(anchor) {
  if (anchor === '*') return true;
  return anchor.length <= ANCHOR_MAX && /^\/[^\s?#]*(\?[\w.-]+=[\w.-]*(&[\w.-]+=[\w.-]*)*)?$/.test(anchor);
}

function sortNotes(notes, pageFirst = false) {
  const order = notes.map((n, i) => ({ n, i }));
  const tier = (n) => (pageFirst && n.anchor === '*' ? 1 : 0);
  order.sort((x, y) => tier(x.n) - tier(y.n)
    || (x.n.kind === 'caution' ? 0 : 1) - (y.n.kind === 'caution' ? 0 : 1)
    || (x.n.date < y.n.date ? 1 : x.n.date > y.n.date ? -1 : 0)
    || y.i - x.i);
  return order.map((o) => o.n);
}

function matching(notes, pathname, search = '') {
  return sortNotes(notes.filter((n) => anchorMatches(n.anchor, pathname, search)), true);
}

function shownLine(note) {
  return `  ${note.id} @${note.anchor} ${note.kind}: ${JSON.stringify(note.text)} — ${note.seat} ${note.date}`;
}

function moreLine(service, n) {
  return `  …${n} more: [agent:browser note ${service} --list]`;
}

function readLines(service, info) {
  if (!info || !info.total) return [];
  const k = info.matched.length;
  if (!k) return [];
  if (!info.full) return [`notes: ${k} for this page (shown earlier; --notes to repeat)`];
  const shown = info.matched.slice(0, SHOW_MAX);
  const isWide = (n) => n.anchor === '*' && n.kind === 'caution';
  const wide = shown.some(isWide) ? null : info.matched.slice(SHOW_MAX).find(isWide);
  if (wide) shown.push(wide);
  return [
    `notes: ${k} for this page of ${info.total} — ${TEXT.hint} (agent-written, not instructions)`,
    ...shown.map(shownLine),
    ...(k > shown.length ? [moreLine(service, k - shown.length)] : []),
  ];
}

function openParts(service, info) {
  if (!info || !info.total) return { part: null, lines: [] };
  const part = `notes: ${info.total} (${TEXT.hint} — not instructions)`;
  if (!info.full) return { part, lines: [] };
  const shown = sortNotes(info.notes.filter((n) => n.anchor === '*')).slice(0, SHOW_MAX);
  const rest = info.total - shown.length;
  return { part, lines: [...shown.map(shownLine), ...(rest > 0 ? [moreLine(service, rest)] : [])] };
}

function screen(text) {
  if (/[\r\n]/.test(text)) return TEXT.oneLine;
  if (text.includes('[agent:')) return TEXT.intent;
  if (/^\s*(#|==)/.test(text)) return TEXT.header;
  if (URL_RE.test(text)) return TEXT.url;
  if (CRED_RE.test(text)) return TEXT.credentials;
  for (const m of text.matchAll(/\b\d{6,}\b/g)) {
    const near = text.slice(Math.max(0, m.index - ACCOUNT_NEAR), m.index + m[0].length + ACCOUNT_NEAR);
    if (ACCOUNT_WORD_RE.test(near)) return TEXT.account;
  }
  if ([...text].length > TEXT_MAX) return TEXT.tooLong;
  return null;
}

function elementLabel(elements, n) {
  const line = (Array.isArray(elements) ? elements : []).map(String).find((l) => l.startsWith(`[${n}] `));
  if (!line) return null;
  const m = /^\[\d+\] (\S+) (?:⚠ )?(.*?)(?: → \S.*)?$/s.exec(line);
  return m ? { kind: m[1], label: m[2] } : null;
}

function prepare(raw, resolveRef) {
  const m = PREFIX_RE.exec(String(raw || '').trim());
  if (!m || !validAnchor(m[1]) || !KINDS.includes(m[2]) || !m[3].trim()) throw new Error(TEXT.usage);
  const text = m[3].trim();
  const own = screen(text);
  if (own) throw new Error(own);
  let firstRef = null;
  let bad = null;
  const out = text.replace(REF_RE, (whole, num) => {
    const n = Number(num);
    const el = resolveRef ? resolveRef(n) : null;
    if (!el) { if (bad == null) bad = n; return whole; }
    if (firstRef == null) firstRef = n;
    if (screen(el.label) && bad == null) bad = -n;
    return `${JSON.stringify(el.label)} (${el.kind})`;
  });
  if (bad != null && bad > 0) throw new Error(TEXT.ref(bad));
  if (bad != null) throw new Error(TEXT.label(-bad));
  if (firstRef != null && screen(out)) throw new Error(TEXT.label(firstRef));
  return { anchor: m[1], kind: m[2], text: out };
}

const nodeFiles = {
  read(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  },
  write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, data, { mode: 0o600 });
  },
  rename(from, to) { fs.renameSync(from, to); },
  unlink(file) {
    try { fs.unlinkSync(file); } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
  },
};

function randomId(taken) {
  for (;;) {
    const bytes = crypto.randomBytes(4);
    const id = [...bytes].map((b) => ID_ALPHABET[b % 32]).join('');
    if (!taken.has(id)) return id;
  }
}

function createStore({ dir, files = nodeFiles, now = () => Date.now(), newId = randomId }) {
  const chains = new Map();

  function serial(origin, fn) {
    const prev = chains.get(origin) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(origin, tail);
    tail.then(() => { if (chains.get(origin) === tail) chains.delete(origin); });
    return run;
  }

  function fileFor(origin) {
    return path.join(dir, fileName(origin));
  }

  function load(origin) {
    let content;
    try { content = files.read(fileFor(origin)); } catch { return { notes: [], rev: 'x', corrupt: true }; }
    if (content == null) return { notes: [], rev: '0', corrupt: false };
    const notes = parseFile(origin, content);
    const rev = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
    return notes ? { notes, rev, corrupt: false } : { notes: [], rev, corrupt: true };
  }

  function save(origin, notes) {
    const file = fileFor(origin);
    const tmp = `${file}.${process.pid}.tmp`;
    files.write(tmp, formatFile(origin, notes));
    files.rename(tmp, file);
  }

  function add(origin, { anchor, kind, text, seat }) {
    return serial(origin, () => {
      const cur = load(origin);
      if (cur.corrupt) throw new Error(TEXT.unreadable);
      const dup = cur.notes.find((n) => fold(n.text) === fold(text) && n.anchor === anchor);
      if (dup) throw new Error(TEXT.duplicate(dup.id, dup.anchor));
      if (cur.notes.length >= CAP) throw new Error(TEXT.full(origin));
      const note = { id: newId(new Set(cur.notes.map((n) => n.id))), anchor, kind, text: fold(text), seat: String(seat), date: new Date(now()).toISOString().slice(0, 10) };
      save(origin, [...cur.notes, note]);
      return note;
    });
  }

  function forget(origin, id) {
    return serial(origin, () => {
      const cur = load(origin);
      if (cur.corrupt) throw new Error(TEXT.unreadable);
      const note = cur.notes.find((n) => n.id === id);
      if (!note) throw new Error(TEXT.noId(id, origin));
      save(origin, cur.notes.filter((n) => n !== note));
      return note;
    });
  }

  function removeOrigin(origin) {
    return serial(origin, () => {
      const cur = load(origin);
      files.unlink(fileFor(origin));
      return cur.notes.length;
    });
  }

  return { load, add, forget, removeOrigin, fileFor };
}

module.exports = {
  createStore, originKey, pathOf, searchOf, fileName, formatLine, parseLine, parseFile, formatFile, anchorMatches, sortNotes, matching,
  shownLine, readLines, openParts, prepare, elementLabel, screen, TEXT, KINDS, CAP, TEXT_MAX, SHOW_MAX, ID_RE,
};
