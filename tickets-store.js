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
function extractTaskDir(specText) {
  const firstLine = String(specText == null ? '' : specText).split('\n')[0] || '';
  const abs = firstLine.match(/(?:~|\/)[A-Za-z0-9._/-]*\/tasks\/[A-Za-z0-9._/-]+/);
  if (abs) return abs[0];
  const m = firstLine.match(/tasks\/[A-Za-z0-9._/-]+/);
  return m ? m[0] : null;
}

module.exports = { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, TICKETS_FILE };
