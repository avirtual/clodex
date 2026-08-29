'use strict';

// Storage: <clodexHome>/projects/<leaf>-<hash8>/tickets.json — clodex-paths
// .projectDirFor owns that grammar, do not re-join it here. Under ~/.clodex and
// not userData, because the standalone clodex-team exec reads it.

const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { projectDirFor, defaultClodexHome } = require('./clodex-paths');

const TICKETS_FILE = 'tickets.json';

function createTicketsStore({ fs = require('fs'), path = require('path'), clodexHome } = {}) {
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

  function save(projectRoot, tickets) {
    ensureDir(boardDir(projectRoot));
    atomicWriteFileSync(ticketsPath(projectRoot), JSON.stringify(tickets, null, 2));
  }

  return { load, save, ticketsPath };
}

// Closed records stay in the array so max+1 never reuses an id: an id is a public
// reference (branches, artifact dirs, commits) and a re-issued one still resolves.
function nextTicketId(tickets) {
  let max = 0;
  for (const t of tickets || []) {
    const m = /^t(\d+)$/.exec(t && t.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `t${max + 1}`;
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

function extractMustFix(verdictText) {
  const lines = String(verdictText == null ? '' : verdictText).split('\n');
  const body = [];
  let inSection = false;
  for (const line of lines) {
    const h = sectionHeader(line);
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
  return /^(?:none|n\/a|-+|—)\.?$/i.test(out.trim()) ? null : out;
}

// Derived on read: a stored count would disagree with `mustFix` after any edit.
// The placeholder is re-tested here, wrapped — not redundant with extractMustFix's
// bare-anchored one, and the two must not be merged.
const MUSTFIX_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\S/;

// A markdown rule, which the item regex cannot tell from a list item.
const THEMATIC_BREAK_RE = /^[ \t]*(?:[-*_][ \t]*){3,}$/;

const MUSTFIX_PLACEHOLDER_RE = /^[\s(\[]*(?:none|n\/a|nothing|-+|—)[\s.)\]]*$/i;

// Drops the dash arms: a body OPENING with `---` is a rule above a real list, and
// inheriting them would count `---\n- a\n- b` as zero.
const MUSTFIX_PLACEHOLDER_WORD_RE = /^[\s(\[]*(?:none|n\/a|nothing)[\s.)\]]*$/i;

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

function countMustFix(mustFixText) {
  if (mustFixText == null) return 0;
  const text = String(mustFixText);
  const lines = text.split('\n');
  // Tested against the FIRST line, not the whole blob: prose written under a
  // `MUST-FIX: (none)` header is closed by nothing, so its bullets count as items.
  // First-line-only is what keeps this from being a widening.
  const nonEmpty = lines.filter((l) => l.trim());
  // Only the tested line is normalized, so a `*` marker stays a marker below.
  const firstLine = nonEmpty.length ? stripEmphasis(nonEmpty[0].trim()) : '';
  const re = nonEmpty.length > 1 ? MUSTFIX_PLACEHOLDER_WORD_RE : MUSTFIX_PLACEHOLDER_RE;
  if (re.test(firstLine)) return 0;
  // Minimum indentation present, not a fixed column, and RELATIVE because the
  // direction worth protecting is undercounting: against column 0 a verdict whose
  // items are all indented matches no marker and falls through to the floor below.
  const widths = [];
  for (const line of lines) {
    if (THEMATIC_BREAK_RE.test(line)) continue;
    const m = MUSTFIX_ITEM_RE.exec(line);
    // CommonMark's tab stop, or raw counts make one tab shallower than two spaces
    // and pick the sub-bullets as the top level.
    if (m) { let w = 0; for (const ch of m[1]) w = ch === '\t' ? w + 4 - (w % 4) : w + 1; widths.push(w); }
  }
  // Reduced, not `Math.min(...widths)`: one argument per line is a stack overflow
  // on a long blob.
  let top = Infinity;
  for (const w of widths) if (w < top) top = w;
  let n = 0;
  for (const w of widths) if (w === top) n++;
  // Reached only once the placeholder test above ruled out "no items at all".
  return n > 0 ? n : (text.trim() ? 1 : 0);
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

const ticketTerminal = (ticket) => ticketTerminalReason(ticket) !== null;

module.exports = { createTicketsStore, nextTicketId, titleLine, ticketTitle, extractTaskDir, extractMustFix, countMustFix, ticketStarted, ticketInFlight, ticketTerminal, ticketTerminalReason, branchSlug, TICKETS_FILE };
