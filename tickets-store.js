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

module.exports = { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, branchSlug, TICKETS_FILE };
