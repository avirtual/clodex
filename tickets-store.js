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

// Optional artifact link: if the spec text's FIRST LINE names a task dir,
// capture it verbatim (string only — no fs validation). Links ticket → on-disk
// spec/journal. Absent → null.
//
// Both forms are accepted because artifacts moved out of the project repo to
// ~/.clodex/projects/<leaf>-<hash>/tasks/ (clodex-paths.taskDirFor), and every
// ticket written before that move carries the bare `tasks/<dir>` form. Matching
// the absolute form FIRST matters: `tasks/` appears inside it, so trying the
// bare pattern first would truncate an absolute path to its tail.
const TASK_DIR_ABS_RE = /(?:~|\/)[A-Za-z0-9._/-]*\/tasks\/[A-Za-z0-9._/-]+/;
const TASK_DIR_REL_RE = /tasks\/[A-Za-z0-9._/-]+/;

function extractTaskDir(specText) {
  const firstLine = String(specText == null ? '' : specText).split('\n')[0] || '';
  const abs = firstLine.match(TASK_DIR_ABS_RE);
  if (abs) return abs[0];
  const m = firstLine.match(TASK_DIR_REL_RE);
  return m ? m[0] : null;
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
// The trailing lookahead is what makes this a HEADER matcher rather than a
// first-token matcher, and it is load-bearing in one direction: a must-fix ITEM
// whose first token is a section word (`- NITS are being treated as blocking`)
// closed the section, and when that item was the FIRST one the whole extraction
// returned null — an empty rework round, which tells the hand nothing. Requiring
// a separator or end-of-line after the keyword is what separates the item from
// the header, since the bullet/quote decoration is identical on both.
// A lookahead, not consumed, so `h[0]` still ends at the keyword and the
// inline-tail slice below keeps working unchanged.
//
// Both branches spell out the horizontal run rather than sharing one `[ \t]*`
// before a negated class: `[ \t]*` backtracks to zero width, and then a plain
// "not a letter" lookahead is satisfied by the very space it was meant to skip
// — which passes every item this guard exists to reject.
const VERDICT_SECTION_RE = /^\s*[-*>\s]*(?:\*\*|__)?\s*(MUST[-\s]?FIX|NITS?|CHECKED|VERDICT)\b(?=(?:\*\*|__)?(?:[ \t]*[^ \tA-Za-z0-9]|[ \t]*$))/i;

function extractMustFix(verdictText) {
  const lines = String(verdictText == null ? '' : verdictText).split('\n');
  const body = [];
  let inSection = false;
  for (const line of lines) {
    const h = VERDICT_SECTION_RE.exec(line);
    if (h) {
      const isMustFix = /^MUST/i.test(h[1]);
      if (inSection && !isMustFix) break;   // the next section closes this one
      if (isMustFix) {
        inSection = true;
        // The header line carries the first item when the reviewer wrote it
        // inline (`MUST-FIX: the guard is inverted`), which is the common shape
        // for a single-item list.
        const tail = line.slice(h.index + h[0].length).replace(/^(?:\*\*|__)?\s*[:\-—]?\s*/, '').trim();
        if (tail) body.push(tail);
        continue;
      }
      continue;
    }
    if (inSection) body.push(line);
  }
  const out = body.join('\n').trim();
  if (!out) return null;
  return /^(?:none|n\/a|-+|—)\.?$/i.test(out) ? null : out;
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

module.exports = { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, extractMustFix, ticketStarted, branchSlug, TICKETS_FILE };
