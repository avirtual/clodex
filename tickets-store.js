'use strict';

// tickets-store.js — the PROJECT ticket registry (Task 25; moved off the team in
// t301). Formal tickets let a LEAD attach tasks to members as tracked envelopes
// (opened, assigned, closed by clodex itself) instead of
// lifecycle-by-dm-and-lead-discipline. It FORMALIZES, not replaces, the
// <task-dir>/spec.md + notes.md artifact convention: the ticket is registry +
// lifecycle + notification; specs/journals stay files (an optional `taskDir`
// links the two). Those files live outside the user's repo — see
// clodex-paths.taskDirFor.
//
// Storage: <clodexHome>/projects/<leaf>-<hash8>/tickets.json — a flat array of
// ticket records, keyed by the PROJECT ROOT and resolved through
// clodex-paths.projectDirFor, which is the single authority on that grammar (do
// not re-join it here). It sits beside the project's task artifacts because a
// ticket is a durable unit of work that outlives, and does not require, any
// team: teams are one source of assignees, not the reason the board exists. It
// lives under ~/.clodex, NOT userData, because it must be shared/visible to the
// clodex-team exec (a standalone process). Atomic temp+rename write
// (fs-util.atomicWriteFileSync) per the stores.js persistence idiom. Pure leaf
// (electron-free): required directly like team-manifest's formatters. fs/path
// are injectable for tests but default to the real modules (tickets are real
// on-disk state — tests point clodexHome at a temp dir).
//
// INVARIANT (single-board id resolution): id-only verbs resolve as (sender's
// project, id) — NEVER a global scan. Two teams rooted at one project now share
// this board, which is why ids are never renumbered on a merge: an id is a
// PUBLIC reference (branch names, artifact dirs, commit messages), so a
// re-issued one still resolves, just to the wrong work. See tickets-migrate.js.

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

  // Best-effort load: a missing/unreadable/invalid file is an empty registry (a
  // project that has never opened a ticket has no file). Never throws.
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

// Monotonic `t<N>` id: max existing N + 1. Records are KEPT on close (done/
// cancelled stay in the array for history), so max+1 never reuses an id even
// after cancels. A registry with a hand-broken id is ignored for the max, never
// throws.
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

// The ticket TITLE = the first non-empty line of the spec text, trimmed and
// capped (the list summary column). Empty spec → '(untitled)'.
function ticketTitle(specText) {
  const lines = String(specText == null ? '' : specText).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  return '(untitled)';
}

// Optional artifact link: the task dir named ANYWHERE in the spec text, captured
// verbatim (string only — no fs validation). Links ticket → on-disk
// spec/journal. Absent → null.
//
// Both forms are accepted because artifacts moved out of the project repo to
// ~/.clodex/projects/<leaf>-<hash>/tasks/ (clodex-paths.taskDirFor), and every
// ticket written before that move carries the bare `tasks/<dir>` form. Matching
// the absolute form FIRST matters: `tasks/` appears inside it, so trying the
// bare pattern first would truncate an absolute path to its tail.
const TASK_DIR_ABS_RE = /(?:~|\/)[A-Za-z0-9._/-]*\/tasks\/[A-Za-z0-9._/-]+/;
const TASK_DIR_REL_RE = /tasks\/[A-Za-z0-9._/-]+/;

// Scanned LINE BY LINE, earliest line wins, abs-before-rel within each line.
// Not a single match against the whole text, and the difference is not stylistic:
// applied globally, abs-before-rel would let an absolute path further down beat a
// bare `tasks/foo` on line 1, CHANGING the answer for tickets that resolve today.
// Line-by-line is a strict superset — a spec whose first line matches gets the
// byte-identical result it got when only that line was read.
//
// It reads the whole spec because a path under a title (line 3, the natural
// place) was invisible: measured at ~86% of a live seven-ticket queue, and the
// loop then computed a diff up to 78kB before finding it had nowhere to write it.
//
// The first line's OTHER two consumers are unaffected by construction, and that
// is what makes this widening safe: `ticketTitle` reads line 1 itself, and
// `branchSlug` is only ever called on that title — so nothing downstream of the
// slug can see a path this function found on line 3.
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

// The branch-name half of the ticket's first line, which serves three consumers
// with incompatible needs: it is the human title, it is where extractTaskDir
// reads the artifact link, and it is what the branch is slugged from. Fixing
// the SLUG rather than the line is deliberate — the line's shape is load-bearing
// for the other two.
//
// Two spans are removed before slugging, both observed producing bad branches:
//   - the task-dir path, because the documented dispatch format invites one onto
//     exactly this line (it produced `t302-tasks-t302-migration-resync-spec-md-the`);
//   - a LEADING ticket id, because the caller prepends the real id anyway. The
//     lead cannot know the id before dispatch, so a title carrying one is either
//     a duplicate or — as seen when a lead guessed the next id — a DIFFERENT id
//     than the board minted, leaving a branch name that asserts two.
// The id strip is case-INSENSITIVE, so a title legitimately opening with a
// design label ("T5 — …") loses it. That is the accepted cost: a wrong id in a
// branch name misroutes a `merge-base --is-ancestor` run by hand, a missing
// label reads no worse than the rest of the slug.
function branchSlug(title) {
  let s = String(title == null ? '' : title);
  s = s.replace(TASK_DIR_ABS_RE, ' ').replace(TASK_DIR_REL_RE, ' ');
  s = s.replace(/^[^A-Za-z0-9]*t\d+\b/i, ' ');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 40) {
    const cut = s.slice(0, 41);
    const at = cut.lastIndexOf('-');
    // Word-boundary truncation, but only when a boundary leaves something to
    // read: a first word longer than the cap has no `-` to cut on, and one at
    // position 0 would empty the slug entirely.
    s = at > 0 ? cut.slice(0, at) : s.slice(0, 40);
  }
  return s.replace(/^-+|-+$/g, '');
}

// The MUST-FIX section of a reviewer verdict, verbatim, or null when there is
// none. Sectioned by HEADER LINE rather than by scanning for the first `NITS`
// anywhere: a must-fix item routinely names the word (`this nit is blocking`,
// `CHECKED nothing here`), and a substring cut there silently truncates the
// blocking list — which is the half the rework round is built from.
//
// A section whose body is only a "none" placeholder returns null, so a reviewer
// writing `MUST-FIX: none` beside an ACCEPT does not hand the loop an empty
// rework body to deliver.
// Header-vs-item is decided by BULLET AND BOLD, not by what follows the keyword.
// A separator rule cannot do it: `- CHECKED: I could not verify this` (an item)
// and `MUST-FIX: the ordering is wrong` (a header carrying its only item inline)
// are the same shape under "keyword then punctuation", so any such rule either
// drops the blocking list or stops reading inline headers. Six real item shapes
// were extracting to null this way.
//
// The discriminator comes from the producer — resources/library/prompts/system/
// clodex-team-reviewer.md's "Verdict format" section — where headers are bold and
// unbulleted (`**MUST-FIX**`, `**VERDICT**: ACCEPT`) and items carry a bullet or
// a number and are not bold-wrapped:
//   bold-delimited keyword  -> header wherever it appears, bullet or not;
//   bulleted/numbered       -> header only if the keyword is the WHOLE line;
//   neither                 -> header unless a word follows the keyword, which is
//                              prose (`VERDICT parsing accepts a quoted line`).
// The third arm is the only one where the separator carries any weight, and it
// is kept precisely because there is no bullet there to read instead.
//
// `*` is consumed as a bullet only when it is not the first half of `**`, or
// `**MUST-FIX**` reads as a bulleted line whose remainder is `MUST-FIX**` and the
// most common header form in the corpus stops matching.
const LINE_MARKER_RE = /^[ \t]*(?:(?:[-+>]|\*(?!\*)|\d+[.)])[ \t]*)+/;
const SECTION_KEYWORD_RE = /^(MUST[-\s]?FIX|NITS?|CHECKED|VERDICT)\b/i;
const INLINE_LEAD_RE = /^[ \t]*(?:\*\*|__)?[ \t]*[:\-—]?[ \t]*/;

// null for an item/prose line, else { keyword, tail } — `tail` is the inline
// first item (`MUST-FIX: the guard is inverted`), '' when the header stands alone.
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
      if (inSection && !isMustFix) break;   // the next section closes this one
      if (isMustFix) {
        inSection = true;
        // The header line carries the first item when the reviewer wrote it
        // inline (`MUST-FIX: the guard is inverted`), which is the common shape
        // for a single-item list.
        if (h.tail) body.push(h.tail);
      }
      continue;
    }
    if (inSection) body.push(line);
  }
  const out = body.join('\n').trim();
  if (!out) return null;
  return /^(?:none|n\/a|-+|—)\.?$/i.test(out) ? null : out;
}

// How many must-fixes, for a notification that must state a NUMBER without
// carrying the prose. Counts leading list markers (`- `, `* `, `1. `, `1) `)
// because that is how the reviewer template asks for the section; an
// unmarked block is one item, which is also the shape `extractMustFix`
// documents for the inline `MUST-FIX: <text>` header.
//
// Derived on read rather than stored: a second field on the record could
// disagree with `mustFix` after any edit, and the blob is the thing a human
// acts on.
//
// A non-null blob can still mean NONE. `extractMustFix`'s placeholder test is
// anchored bare (`none`, `n/a`, `-`), so any wrapping survives it: `(none)` —
// the shape a live record actually carried — reaches here as a string with no
// list marker, and an unguarded floor of 1 then announces `ACCEPT … 1 must-fix`.
// A verdict that contradicts its own count is the false premise this
// notification exists to stop, so the placeholder is re-tested here, wrapped.
const MUSTFIX_PLACEHOLDER_RE = /^[\s(\[]*(?:none|n\/a|nothing|-+|—)[\s.)\]]*$/i;

// The first-line form drops the dash arms. A body whose whole content is `---`
// means no must-fixes, but a body OPENING with `---` is a markdown rule above a
// real list — inheriting the dash arms there would count `---\n- item\n- item`
// as zero and silence the gate over genuine must-fixes, which is the failure
// this counter exists to prevent, arriving through its own fix.
const MUSTFIX_PLACEHOLDER_WORD_RE = /^[\s(\[]*(?:none|n\/a|nothing)[\s.)\]]*$/i;

// Emphasis is normalized off the line before the patterns above see it, rather
// than added to their character classes. `*(none)*` was the THIRD spelling to
// refuse a live ACCEPT; the space of ways a model writes "nothing here" is
// open-ended, so enumerating wrappers one incident at a time loses by
// construction. Stripping collapses that family onto the two cases already
// reasoned about.
//
// Both halves of the shape carry anti-widening weight, and dropping either one
// silences the gate over genuine must-fixes:
//   - the run is BALANCED (`\1`), so an unclosed run is not a wrapper —
//     `**MF1**: the guard is inverted` keeps its leading `**` and stays one
//     must-fix, and a bare `*` / `**` / backtick never becomes a placeholder;
//   - the interior neither opens nor closes with whitespace, which is what
//     keeps the LIST ITEM `* (none) *` a list item rather than a wrapper.
//
// The run is BOUNDED because a backreference under an unbounded greedy run
// backtracks cubically, and `countMustFix` runs on the main process's verdict
// path: an unbounded `[*_`]+` against a long run followed by a long non-matching
// body stalled the app for seconds (test-pinned). Nothing is lost by the bound —
// `stripEmphasis`'s loop already unwraps longer and nested runs a pass at a time,
// so raising it back to `+` buys no spelling and re-arms the stall.
//
// The TRAILING edge tolerates `[\s.]*` outside the closing run, because
// `**(none)**.` is a spelling a reviewer plausibly writes and the punctuation is
// the same whack-a-mole family one layer out. It is not a widening: the class is
// whitespace-and-period only, so `**(none)*` stays unbalanced and `*MF1*.` strips
// to `MF1`, which is no placeholder word. Adding `*`/`_`/backtick here WOULD
// widen it — an unbalanced run would become a wrapper.
//
// The LEADING edge is anchored by design: `> *(none)*` stays one must-fix. Line
// decoration is the caller's to strip, and tolerating it here would make a
// quoted or prefixed line a placeholder.
const EMPHASIS_WRAP_RE = /^([*_`]{1,6})(\S(?:.*\S)?)\1[\s.]*$/;

// Nested wrappers unwrap outside-in (`**_(none)_**`). Terminates by
// construction: each pass returns a strictly shorter middle.
function stripEmphasis(line) {
  let s = line;
  for (let m = EMPHASIS_WRAP_RE.exec(s); m; m = EMPHASIS_WRAP_RE.exec(s)) s = m[2];
  return s;
}

function countMustFix(mustFixText) {
  if (mustFixText == null) return 0;
  const text = String(mustFixText);
  const lines = text.split('\n');
  // The placeholder is matched against the section's FIRST line, not the whole
  // blob: a reviewer who writes `MUST-FIX: (none)` and then explains himself
  // underneath leaves prose that no section header closes, so `extractMustFix`
  // appends it to the same body and a whole-blob test stops firing. The bullets
  // inside that prose then count as items — a live ACCEPT was refused for
  // "6 items" over a body reading `(none)`. A section that OPENS with the
  // placeholder declares no must-fixes, whatever follows it.
  //
  // Matching only the first line is what keeps this from being a widening: a
  // real list still counts, so an ACCEPT that genuinely lists must-fixes is
  // still the contradiction the merge gate refuses.
  const nonEmpty = lines.filter((l) => l.trim());
  // Only the line under TEST is normalized. The item count below still runs on
  // the original lines, so a `*` list marker stays a list marker.
  const firstLine = nonEmpty.length ? stripEmphasis(nonEmpty[0].trim()) : '';
  const re = nonEmpty.length > 1 ? MUSTFIX_PLACEHOLDER_WORD_RE : MUSTFIX_PLACEHOLDER_RE;
  if (re.test(firstLine)) return 0;
  let n = 0;
  for (const line of lines) if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)) n++;
  // The floor: a bare unmarked item is one must-fix, not zero. Only reached
  // once the placeholder test above has ruled out "no items at all".
  return n > 0 ? n : (text.trim() ? 1 : 0);
}

// Has this ticket been DISPATCHED? First-class state, because everything
// downstream of the add/start split keys off it, and inferring it from
// `dispatch:'worktree'` plus the absence of `ticket.worktree` is a derived
// signal that goes silently wrong the moment a non-worktree role needs the same
// distinction.
//
// The three legacy arms exist because every ticket in a live tickets.json was
// dispatched by the OLD `add` and carries no `startedAt`. Reading those as
// never-started drops them out of `_openTicketsFor`, so replay and `_advanceSeat`
// stop seeing real in-flight work on the first launch after upgrade — strictly
// worse than the collision being fixed here.
//
// The KEY'S PRESENCE is the format discriminator, which is why `_taskAdd` writes
// `startedAt: null` explicitly: an unstarted new ticket carries the key holding
// null, a pre-upgrade record has no key at all, and nothing else tells them
// apart. Absent defaults to STARTED because the two errors are not symmetric —
// a false "started" only refuses a `start` (and `assign` still re-sends), while
// a false "unstarted" silently re-delivers in-flight specs into occupied trees.
//
// `parked` carves the one legacy shape that provably never dispatched: the old
// `add` returned before delivering when parked. Without it the documented
// park-then-release flow would refuse to start on the first post-upgrade launch.
//
// `role`/`worktree` are kept as a second reading, not as the primary one: they
// are written only by a dispatch path, but `_repinTicketToSeat` declines to
// write `role` when the assignee is a SEAT NAME rather than a role key, so an
// old name-addressed ticket dispatched with neither field set. Those records are
// caught by the absent-key arm, not by this one.
function ticketStarted(ticket) {
  if (!ticket) return false;
  if (ticket.startedAt != null) return true;
  if (ticket.role || (ticket.worktree && ticket.worktree.path)) return true;
  if (!Object.prototype.hasOwnProperty.call(ticket, 'startedAt')) return !ticket.parked;
  return false;
}

// Is this ticket still in flight — i.e. is anyone expected to act on it?
//
// `open` is the ordinary case. `done` used to be terminal and no longer is: the
// loop closes the ticket BEFORE it runs its checks and spawns the review, so a
// done ticket carrying a `loopStep` has work outstanding, while one without has
// genuinely finished.
//
// Single-sourced deliberately. Three call sites depend on this answer — the
// stall sweep's eligibility test, the sweep's own nudge stamp, and the verdict
// landing — and the failure mode of a divergence is not a wrong answer but a
// silent one: a shape the sweep nudges but the stamp refuses to record re-nudges
// every sweep, and a shape the sweep skips is a ticket nobody is ever told about.
// Two literal copies were the state this replaced; a comment is not enough.
function ticketInFlight(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'open') return true;
  return ticket.state === 'done' && !!ticket.loopStep;
}

// Is this ticket CLOSED OUT — past any point where a verb will name it again?
// Returns the reason as a phrase (for the message that refuses to bind to it),
// or null when the ticket is still live. Predicate and phrasing are one function
// on purpose: a caller that tests the boolean and a caller that prints the
// reason cannot drift into disagreeing about which tickets are terminal.
//
// NOT the same question as ticketInFlight, and the gap between them is real: a
// `done` ticket is not in flight once its loop step is gone, but it is very much
// still live — a reject reopens it, and an accept is still to come.
//
// Terminal is exactly two things:
//   * `cancelled` — _taskCancel refuses any non-open ticket, so nothing can
//     name it again.
//   * `closedOut` — stamped by the accept arms that genuinely close the ticket
//     out (merged, and no-branch-recorded). It CANNOT be inferred from
//     `acceptedAt`: that is stamped on every accept arm including the two that
//     invite a second accept ("Merge it, then accept again"), so a ticket
//     awaiting its merge would read as terminal while it is still live.
function ticketTerminalReason(ticket) {
  if (!ticket) return null;
  if (ticket.state === 'cancelled') return 'cancelled';
  if (ticket.closedOut) return 'accepted and closed out';
  return null;
}

const ticketTerminal = (ticket) => ticketTerminalReason(ticket) !== null;

module.exports = { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, extractMustFix, countMustFix, ticketStarted, ticketInFlight, ticketTerminal, ticketTerminalReason, branchSlug, TICKETS_FILE };
