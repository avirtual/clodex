'use strict';

// Storage: <clodexHome>/projects/<leaf>-<hash8>/tickets.json — clodex-paths
// .projectDirFor owns that grammar, do not re-join it here. Under ~/.clodex and
// not userData, because the standalone clodex-team exec reads it.

const { ensureDir, atomicWriteFileSync, writeAllSync } = require('./fs-util');
const { projectDirFor, defaultClodexHome } = require('./clodex-paths');

const TICKETS_FILE = 'tickets.json';
const ARCHIVE_FILE = 'tickets-archive.jsonl';
const ARCHIVE_META_FILE = 'tickets-archive.meta.json';

function createTicketsStore({ fs = require('fs'), path = require('path'), clodexHome, warn = (msg) => console.warn(msg) } = {}) {
  const home = clodexHome || defaultClodexHome();

  function boardDir(projectRoot) {
    return projectDirFor(home, projectRoot);
  }

  function ticketsPath(projectRoot) {
    return path.join(boardDir(projectRoot), TICKETS_FILE);
  }

  function load(projectRoot) {
    try {
      const arr = JSON.parse(fs.readFileSync(ticketsPath(projectRoot), 'utf-8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  const boardCache = new Map();

  function statKey(file) {
    try {
      const st = fs.statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  function sameKey(a, b) {
    return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  function deepFreeze(root) {
    const stack = [root];
    while (stack.length) {
      const o = stack.pop();
      Object.freeze(o);
      for (const k in o) {
        const v = o[k];
        if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) stack.push(v);
      }
    }
    return root;
  }

  function read(projectRoot) {
    const file = ticketsPath(projectRoot);
    const key = statKey(file);
    const hit = boardCache.get(file);
    if (hit && hit.tickets && sameKey(hit.key, key)) return hit.tickets;
    boardCache.delete(file);
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return Object.freeze([]);
    }
    if (!Array.isArray(arr)) return Object.freeze([]);
    deepFreeze(arr);
    if (key) boardCache.set(file, { key, tickets: arr });
    return arr;
  }

  function refuseReason(file) {
    const hit = boardCache.get(file);
    if (hit && sameKey(hit.key, statKey(file))) return null;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      return `unreadable (${(e && e.code) || 'error'})`;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 'not valid JSON';
    }
    return Array.isArray(parsed) ? null : 'not an array';
  }

  function save(projectRoot, tickets) {
    const file = ticketsPath(projectRoot);
    const reason = refuseReason(file);
    if (reason) throw new Error(`tickets board at ${file} is ${reason}; refusing to overwrite`);
    ensureDir(boardDir(projectRoot));
    boardCache.delete(file);
    atomicWriteFileSync(file, JSON.stringify(tickets, null, 2));
    const key = statKey(file);
    if (key) boardCache.set(file, { key, tickets: null });
  }

  function archivePath(projectRoot) {
    return path.join(boardDir(projectRoot), ARCHIVE_FILE);
  }

  function metaPath(projectRoot) {
    return path.join(boardDir(projectRoot), ARCHIVE_META_FILE);
  }

  const archiveCache = new Map();

  function archiveLineOp(line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    if (!rec || typeof rec !== 'object') return null;
    if (rec.op === 'archive' && rec.row && typeof rec.row === 'object' && typeof rec.row.id === 'string' && rec.row.id) {
      return { op: 'archive', id: rec.row.id, row: rec.row };
    }
    if (rec.op === 'restore' && typeof rec.id === 'string' && rec.id) return { op: 'restore', id: rec.id };
    return null;
  }

  function scanArchive(projectRoot) {
    const file = archivePath(projectRoot);
    const key = statKey(file);
    const hit = archiveCache.get(file);
    if (hit && sameKey(hit.key, key)) return hit;
    archiveCache.delete(file);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { rows: new Map(), lastArchived: new Map(), maxId: 0 };
      throw e;
    }
    const lines = raw.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last -= 1;
    const rows = new Map();
    const lastArchived = new Map();
    let bad = 0;
    let maxId = 0;
    for (let i = 0; i <= last; i++) {
      if (!lines[i].trim()) continue;
      const op = archiveLineOp(lines[i]);
      if (!op) {
        if (i !== last) bad += 1;
        continue;
      }
      if (op.op === 'archive') {
        deepFreeze(op.row);
        rows.set(op.id, op.row);
        lastArchived.set(op.id, op.row);
        const m = /^t(\d+)$/.exec(op.id);
        if (m && Number(m[1]) > maxId) maxId = Number(m[1]);
      } else rows.delete(op.id);
    }
    if (bad) warn(`tickets archive ${file}: skipped ${bad} unparseable line(s)`);
    const scan = { key, rows, lastArchived, maxId };
    if (key) archiveCache.set(file, scan);
    return scan;
  }

  function readArchive(projectRoot) {
    return new Map(scanArchive(projectRoot).rows);
  }

  function archivedOffBoard(projectRoot, board) {
    const onBoard = new Set((board || []).map((t) => t && t.id));
    const out = new Map();
    for (const [id, row] of scanArchive(projectRoot).lastArchived) {
      if (!onBoard.has(id)) out.set(id, row);
    }
    return out;
  }

  function archiveMaxId(projectRoot) {
    return scanArchive(projectRoot).maxId;
  }

  function restore(projectRoot, id) {
    const tickets = load(projectRoot);
    if (tickets.some((t) => t && t.id === id)) return null;
    const scan = scanArchive(projectRoot);
    const archived = scan.lastArchived.get(id);
    if (!archived) return null;
    if (scan.rows.has(id)) appendRestore(projectRoot, id);
    const row = JSON.parse(JSON.stringify(archived));
    tickets.push(row);
    save(projectRoot, tickets);
    return row;
  }

  function appendLines(projectRoot, lines) {
    if (!lines.length) return;
    const file = archivePath(projectRoot);
    ensureDir(boardDir(projectRoot));
    let text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
    const fd = fs.openSync(file, 'a+');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) text = `\n${text}`;
      }
      writeAllSync(fd, text, file);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    archiveCache.delete(file);
  }

  function appendArchive(projectRoot, rows) {
    const at = new Date().toISOString();
    appendLines(projectRoot, (rows || []).map((row) => ({ op: 'archive', at, row })));
  }

  function appendRestore(projectRoot, id) {
    appendLines(projectRoot, [{ op: 'restore', at: new Date().toISOString(), id }]);
  }

  function readMeta(projectRoot) {
    let raw;
    try {
      raw = fs.readFileSync(metaPath(projectRoot), 'utf-8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { maxId: 0 };
      throw e;
    }
    try {
      const meta = JSON.parse(raw);
      const maxId = meta && meta.maxId;
      if (Number.isSafeInteger(maxId) && maxId >= 0) return { maxId };
    } catch {}
    return { maxId: 0 };
  }

  function writeMeta(projectRoot, { maxId } = {}) {
    if (!Number.isSafeInteger(maxId) || maxId < 0) throw new Error(`tickets archive meta: invalid maxId ${maxId}`);
    ensureDir(boardDir(projectRoot));
    atomicWriteFileSync(metaPath(projectRoot), JSON.stringify({ maxId }));
  }

  function withArchive(projectRoot, board) {
    const rows = board || read(projectRoot);
    const archived = archivedOffBoard(projectRoot, rows);
    if (!archived.size) return rows;
    return rows.concat([...archived.values()]);
  }

  return { load, read, save, ticketsPath, archivePath, metaPath, readArchive, archivedOffBoard, archiveMaxId, appendArchive, appendRestore, restore, withArchive, readMeta, writeMeta };
}

function nextTicketId(tickets, floor = 0) {
  let max = Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
  for (const t of tickets || []) {
    const m = /^t(\d+)$/.exec(t && t.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `t${max + 1}`;
}

function recordEvent(ticket, ev) {
  const { at, kind, by, ...rest } = ev || {};
  if (typeof kind !== 'string' || !kind) throw new Error('recordEvent: kind required');
  if (typeof by !== 'string' || !by) throw new Error('recordEvent: by required');
  const entry = { at: Number.isFinite(at) ? at : Date.now(), kind, by };
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object') throw new Error(`recordEvent: field ${k} must be a scalar`);
    if (typeof v === 'function') throw new Error(`recordEvent: field ${k} must be a scalar`);
    entry[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  if (!Array.isArray(ticket.events)) ticket.events = [];
  ticket.events.push(entry);
  return entry;
}

// Uncapped. ticketTitle's 80-char cap must not be pushed down here or branchSlug's
// own 40-char word-boundary cap never engages.
function titleLine(specText) {
  const lines = String(specText == null ? '' : specText).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function ticketTitle(specText) {
  const t = titleLine(specText);
  if (!t) return '(untitled)';
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

// Abs before rel: `tasks/` appears inside an absolute path, so rel-first truncates
// it to its tail. Per LINE, not against the whole text — globally, abs-before-rel
// would let a path further down beat a bare `tasks/foo` on line 1.
const TASK_DIR_ABS_RE = /(?:~|\/)[A-Za-z0-9._/-]*\/tasks\/[A-Za-z0-9._/-]+/;
const TASK_DIR_REL_RE = /tasks\/[A-Za-z0-9._/-]+/;

function extractTaskDir(specText) {
  const lines = String(specText == null ? '' : specText).split('\n');
  for (const line of lines) {
    const abs = line.match(TASK_DIR_ABS_RE);
    if (abs) return abs[0];
    const m = line.match(TASK_DIR_REL_RE);
    if (m) return m[0];
  }
  return null;
}

// Fix the SLUG, never the line: the same line is the display title and where
// extractTaskDir reads the artifact link.
function branchSlug(title) {
  let s = String(title == null ? '' : title);
  s = s.replace(TASK_DIR_ABS_RE, ' ').replace(TASK_DIR_REL_RE, ' ');
  s = s.replace(/^[^A-Za-z0-9]*t\d+\b/i, ' ');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 40) {
    const cut = s.slice(0, 41);
    const at = cut.lastIndexOf('-');
    // Only when a boundary leaves something to read: a first word past the cap
    // has no `-` to cut on, and one at position 0 would empty the slug.
    s = at > 0 ? cut.slice(0, at) : s.slice(0, 40);
  }
  return s.replace(/^-+|-+$/g, '');
}

// Sectioned by header LINE, never by scanning for a keyword anywhere: an item
// routinely names `NITS`/`CHECKED` in its prose, and cutting there truncates the
// blocking list. Header-vs-item is bullet-and-bold, not what follows the keyword.
const LINE_MARKER_RE = /^[ \t]*(?:(?:[-+>]|\*(?!\*)|\d+[.)])[ \t]*)+/;
const SECTION_KEYWORD_RE = /^(MUST[-\s]?FIX|NITS?|CHECKED|VERDICT)\b/i;
const INLINE_LEAD_RE = /^[ \t]*(?:\*\*|__)?[ \t]*[:\-—]?[ \t]*/;

function sectionHeader(line) {
  const s = String(line == null ? '' : line);
  const marker = LINE_MARKER_RE.exec(s);
  const rest = marker ? s.slice(marker[0].length) : s.replace(/^[ \t]*/, '');

  const bold = /^(\*\*|__)/.exec(rest);
  const body = bold ? rest.slice(bold[1].length) : rest;
  const kw = SECTION_KEYWORD_RE.exec(body);
  if (!kw) return null;
  const after = body.slice(kw[0].length);

  if (bold) {
    // The closing delimiter may sit after a separator the reviewer bolded along
    // with the keyword (`**MUST-FIX:**`).
    const close = new RegExp(`^[ \\t]*[:\\-—]?[ \\t]*${bold[1] === '**' ? '\\*\\*' : '__'}`).exec(after);
    if (!close) return null;   // an unterminated `**` is emphasis mid-sentence, not a header
    return { keyword: kw[1], tail: after.slice(close[0].length).replace(INLINE_LEAD_RE, '').trim() };
  }
  if (marker) {
    return /^[ \t]*[:.\-—]?[ \t]*$/.test(after) ? { keyword: kw[1], tail: '' } : null;
  }
  return /^[ \t]*(?:[^ \tA-Za-z0-9]|$)/.test(after)
    ? { keyword: kw[1], tail: after.replace(INLINE_LEAD_RE, '').trim() }
    : null;
}

const MUSTFIX_PLACEHOLDER_WORDS = 'none(?:[ \\t—-]+[a-z]+){0,3}|n\\/a|nothing|empty';
const MUSTFIX_BARE_PLACEHOLDER_RE = new RegExp(`^(?:${MUSTFIX_PLACEHOLDER_WORDS}|-+|—)\\.?$`, 'i');

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const VERDICT_LINE_RE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*|__)?[ \t]*\bVERDICT\b\W*\b(ACCEPT|REWORK)\b/i;

const INLINE_SECTION_HEADER_RE = /(\*\*)(MUST[-\s]?FIX|NITS?|CHECKED)(?:[ \t]*:[ \t]*\1|\1[ \t]*:)/gi;

function liveVerdictLines(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let fence = null;
  const entries = lines.map((line, i) => {
    const src = i + 1;
    const f = FENCE_OPEN_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
      return { line, live: false, fenced: true, src };
    }
    if (f) { fence = f[1]; return { line, live: false, fenced: true, src }; }
    if (/^[ \t]*>/.test(line) || /^(?: {4}|[ ]{0,3}\t)/.test(line)) return { line, live: false, fenced: false, src };
    return { line, live: true, fenced: false, src };
  });
  const otherMustFix = entries.some((e) => e.live && !VERDICT_LINE_RE.test(e.line) && isMustFixHeader(e.line));
  if (otherMustFix) return entries;
  return entries.flatMap((e) => {
    if (!e.live || !VERDICT_LINE_RE.test(e.line)) return [e];
    return e.line.replace(INLINE_SECTION_HEADER_RE, (m, _d, _k, off) => (off === 0 ? m : `\n${m}`)).split('\n')
      .flatMap((piece) => (isMustFixHeader(piece) ? splitInlineItems(piece) : piece).split('\n'))
      .map((piece) => ({ line: piece, live: true, fenced: false, src: e.src }));
  });
}

function splitInlineItems(piece) {
  const head = INLINE_SECTION_HEADER_RE.exec(piece);
  INLINE_SECTION_HEADER_RE.lastIndex = 0;
  const cut = head ? head.index + head[0].length : 0;
  let next = 1;
  const tail = piece.slice(cut).replace(/(^[ \t]*|[ \t])\((\d+)\)[ \t]+/g, (m, _lead, n) => {
    if (Number(n) !== next) return m;
    next += 1;
    return `\n${n}. `;
  });
  return piece.slice(0, cut) + tail;
}

const isMustFixHeader = (line) => { const h = sectionHeader(line); return !!h && /^MUST/i.test(h.keyword); };

function scanVerdict(verdictText) {
  const verdicts = [];
  const mustFixHeaders = [];
  liveVerdictLines(verdictText).forEach(({ line, live, src }) => {
    if (!live) return;
    const m = VERDICT_LINE_RE.exec(line);
    if (m) verdicts.push({ value: m[1].toUpperCase(), line: src });
    if (isMustFixHeader(line)) mustFixHeaders.push(src);
  });
  const distinct = [...new Set(verdicts.map((v) => v.value))];
  return {
    verdict: distinct.length === 1 ? distinct[0] : null,
    verdicts,
    mustFixHeaders,
    ambiguous: distinct.length > 1 || mustFixHeaders.length > 1,
  };
}

function extractMustFix(verdictText) {
  const scanned = liveVerdictLines(verdictText);
  const lines = scanned.map((l) => l.line);
  const body = [];
  let inSection = false;
  let start = -1;
  scanned.forEach(({ line, live }, i) => { if (live && isMustFixHeader(line)) start = i; });
  if (start < 0) start = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const h = scanned[i].fenced ? null : sectionHeader(line);
    if (h) {
      const isMustFix = /^MUST/i.test(h.keyword);
      if (inSection && !isMustFix) break;
      if (isMustFix) {
        inSection = true;
        if (h.tail) body.push(h.tail);
      }
      continue;
    }
    if (inSection) body.push(line);
  }
  // The first item's indentation stays: a bare `.trim()` de-indents line 1 only,
  // so countMustFix's relative-depth count collapses a multi-item verdict to 1.
  const out = body.join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  if (!out.trim()) return null;
  return MUSTFIX_BARE_PLACEHOLDER_RE.test(out.trim()) ? null : out;
}

// Derived on read: a stored count would disagree with `mustFix` after any edit.
// The placeholder is re-tested here, wrapped — not redundant with extractMustFix's
// bare-anchored one, and the two must not be merged.
const MUSTFIX_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\S/;

// A markdown rule, which the item regex cannot tell from a list item.
const THEMATIC_BREAK_RE = /^[ \t]*(?:[-*_][ \t]*){3,}$/;

const MUSTFIX_PLACEHOLDER_RE = new RegExp(`^[\\s(\\[]*(?:${MUSTFIX_PLACEHOLDER_WORDS}|-+|—)[\\s.)\\]]*$`, 'i');

// Drops the dash arms: a body OPENING with `---` is a rule above a real list, and
// inheriting them would count `---\n- a\n- b` as zero.
const MUSTFIX_PLACEHOLDER_WORD_RE = new RegExp(`^[\\s(\\[]*(?:${MUSTFIX_PLACEHOLDER_WORDS})[\\s.)\\]]*$`, 'i');

// Normalized off the line rather than added to the patterns' character classes.
// Every half is anti-widening; dropping any of it silences the gate:
//   - balanced (`\1`), so `**MF1**: the guard is inverted` keeps its `**`;
//   - the interior neither opens nor closes with space, keeping `* (none) *` an item;
//   - bounded — a backreference under an unbounded greedy run backtracks cubically
//     and stalled the main process for seconds (test-pinned); the loop below already
//     unwraps longer runs a pass at a time, so `+` buys nothing;
//   - the trailing class is whitespace-and-period only; `*`/`_`/backtick there would
//     make an unbalanced run a wrapper;
//   - the leading edge is anchored, so `> *(none)*` stays one must-fix.
const EMPHASIS_WRAP_RE = /^([*_`]{1,6})(\S(?:.*\S)?)\1[\s.]*$/;

function stripEmphasis(line) {
  let s = line;
  for (let m = EMPHASIS_WRAP_RE.exec(s); m; m = EMPHASIS_WRAP_RE.exec(s)) s = m[2];
  return s;
}

function mustFixItemLines(mustFixText) {
  if (mustFixText == null) return null;
  const text = String(mustFixText);
  const lines = text.split('\n');
  // Tested against the FIRST line, not the whole blob: prose written under a
  // `MUST-FIX: (none)` header is closed by nothing, so its bullets count as items.
  // First-line-only is what keeps this from being a widening.
  const nonEmpty = lines.filter((l) => l.trim());
  // Only the tested line is normalized, so a `*` marker stays a marker below.
  const firstLine = nonEmpty.length ? stripEmphasis(nonEmpty[0].trim()) : '';
  const re = nonEmpty.length > 1 ? MUSTFIX_PLACEHOLDER_WORD_RE : MUSTFIX_PLACEHOLDER_RE;
  if (re.test(firstLine)) return null;
  const found = [];
  for (const line of lines) {
    if (THEMATIC_BREAK_RE.test(line)) continue;
    const m = MUSTFIX_ITEM_RE.exec(line);
    // CommonMark's tab stop, or raw counts make one tab shallower than two spaces
    // and pick the sub-bullets as the top level.
    if (m) { let w = 0; for (const ch of m[1]) w = ch === '\t' ? w + 4 - (w % 4) : w + 1; found.push({ w, line }); }
  }
  let top = Infinity;
  for (const f of found) if (f.w < top) top = f.w;
  return found.filter((f) => f.w === top).map((f) => f.line);
}

function countMustFix(mustFixText) {
  const items = mustFixItemLines(mustFixText);
  if (items === null) return 0;
  return items.length > 0 ? items.length : (String(mustFixText).trim() ? 1 : 0);
}

const MUSTFIX_MARKER_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

function mustFixTitles(mustFixText) {
  const items = mustFixItemLines(mustFixText);
  if (items === null) return [];
  if (items.length) return items.map((line) => line.replace(MUSTFIX_MARKER_RE, '').trim());
  const first = String(mustFixText).split('\n').find((l) => l.trim());
  return first ? [first.trim()] : [];
}

// Append-only, and the array is the point: a later rework reason never
// overwrites an earlier one, because what the next reviewer needs is the
// SEQUENCE of what it was sent back for.
//
// `round` is passed rather than derived from `ticket.reworkRound` here: the
// three reject paths disagree about it deliberately, and the two that bump the
// counter call this after the bump while the follow-up path — which bumps
// nothing — passes the round already open. Deriving it here would make the
// caller's deliberate choice unstatable.
function appendReworkReason(ticket, { round, by, reason, at } = {}) {
  const text = String(reason == null ? '' : reason).trim();
  if (!ticket || !text) return;
  if (!Array.isArray(ticket.reworkReasons)) ticket.reworkReasons = [];
  ticket.reworkReasons.push({
    round: Number(round) || 1,
    at: Number(at) || Date.now(),
    by: String(by == null ? '' : by),
    reason: text,
  });
}

// The KEY'S PRESENCE is the format discriminator, which is why `_taskAdd` writes
// `startedAt: null` explicitly: an unstarted ticket holds the key with null and a
// pre-upgrade record has no key. Absent defaults to started because the errors are
// asymmetric — a false "started" only refuses a `start`, a false "unstarted"
// re-delivers specs into occupied trees.
function ticketStarted(ticket) {
  if (!ticket) return false;
  if (ticket.startedAt != null) return true;
  if (ticket.role || (ticket.worktree && ticket.worktree.path)) return true;
  if (!Object.prototype.hasOwnProperty.call(ticket, 'startedAt')) return !ticket.parked;
  return false;
}

// `done` is not terminal: the loop closes the ticket before its checks and the
// review spawn, so one carrying a `loopStep` still has work out. Single-sourced
// deliberately — the stall sweep's eligibility test, its nudge stamp and the
// verdict landing all read this, and a divergence between them is silent.
function ticketInFlight(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'open') return true;
  return ticket.state === 'done' && !!ticket.loopStep;
}

// Predicate and phrasing are one function on purpose: a caller testing the boolean
// and one printing the reason cannot drift about which tickets are terminal. Not
// the same question as ticketInFlight. `closedOut` cannot be inferred from
// `acceptedAt`, which is stamped on accept arms that do NOT close out — a ticket
// awaiting its merge would read as terminal while still live.
function ticketTerminalReason(ticket) {
  if (!ticket) return null;
  if (ticket.state === 'cancelled') return 'cancelled';
  if (ticket.closedOut) return 'accepted and closed out';
  return null;
}

module.exports = { createTicketsStore, appendReworkReason, nextTicketId, recordEvent, titleLine, ticketTitle, extractTaskDir, TASK_DIR_ABS_RE, TASK_DIR_REL_RE, extractMustFix, scanVerdict, countMustFix, mustFixTitles, ticketStarted, ticketInFlight, ticketTerminalReason, branchSlug, TICKETS_FILE };
