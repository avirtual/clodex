'use strict';

// tickets-store.js — the team-scoped ticket registry (Task 25). Formal tickets
// let a team LEAD attach tasks to members as tracked envelopes (opened, assigned,
// closed by clodex itself) instead of lifecycle-by-dm-and-lead-discipline. It
// FORMALIZES, not replaces, the tasks/NN-name/spec.md + notes.md artifact
// convention: the ticket is registry + lifecycle + notification; specs/journals
// stay files (an optional `taskDir` links the two).
//
// Storage: ~/.clodex/teams/<team>/tickets.json — a flat array of ticket records.
// It lives under ~/.clodex (team-scoped, like team.json), NOT userData, because
// it must be shared/visible to the clodex-team exec (a standalone process). Atomic
// temp+rename write (fs-util.atomicWriteFileSync) per the stores.js persistence
// idiom. Pure leaf (electron-free): required directly like team-manifest's
// formatters. fs/path are injectable for tests but default to the real modules
// (tickets are real on-disk state — tests point teamDir at a temp dir).
//
// INVARIANT (single-team id resolution): a session sits on AT MOST ONE team, so
// id-only verbs resolve as (sender's team, id) — NEVER a global scan. The day
// multi-team seats exist, ids become team-qualified (`clodex/t7`) BEFORE anything
// else does.

const { ensureDir, atomicWriteFileSync } = require('./fs-util');

const TICKETS_FILE = 'tickets.json';

function createTicketsStore({ fs = require('fs'), path = require('path') } = {}) {
  function ticketsPath(teamDir) {
    return path.join(teamDir, TICKETS_FILE);
  }

  // Best-effort load: a missing/unreadable/invalid file is an empty registry (a
  // team that has never opened a ticket has no file). Never throws.
  function load(teamDir) {
    try {
      const arr = JSON.parse(fs.readFileSync(ticketsPath(teamDir), 'utf-8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function save(teamDir, tickets) {
    ensureDir(teamDir);
    atomicWriteFileSync(ticketsPath(teamDir), JSON.stringify(tickets, null, 2));
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

// Optional artifact link: if the spec text's FIRST LINE contains a `tasks/<dir>`
// path, capture it verbatim (string only — no fs validation). Links ticket →
// on-disk spec/journal. Absent → null.
function extractTaskDir(specText) {
  const firstLine = String(specText == null ? '' : specText).split('\n')[0] || '';
  const m = firstLine.match(/tasks\/[A-Za-z0-9._/-]+/);
  return m ? m[0] : null;
}

module.exports = { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, TICKETS_FILE };
