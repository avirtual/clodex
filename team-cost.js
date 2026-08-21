'use strict';

// team-cost.js — per-ticket cost attribution. Pure leaf: no fs, no git, no
// electron. Callers pass the already-read inputs; every function here is a
// projection of them.
//
// Exists because the redesign's governing claim is cost-at-equal-quality, and
// a claim measured only AFTER the change is narrative. The baseline has to be
// collectable before the resolver and the packer land.
//
// `path` and path-confine are the only requires, and both are pure leaves —
// keep it that way: the whole point of this module is that the rollup shapes
// are testable without booting an Electron main process.

const path = require('path');
const { confineOrThrow } = require('./path-confine');

// The wire label is a SINGLE path segment on the proxy route
// (`/agent/<label>/anthropic`), so the `<team>/<ticket>/<role>` of the design
// cannot be spelled with slashes: wire/route.js's AGENT_RE admits only
// [a-zA-Z0-9._-] and stops at the first `/`. Dots carry the hierarchy instead.
const LABEL_SEP = '.';
// `clodex-<label>-<8 hex>` is what proxy-util mints around this, and the whole
// id must survive the 64-char route cap: 7 prefix + 1 + 8 = 16 taken.
const MAX_LABEL = 48;

function sanitizePart(s) {
  const out = String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return out;
}

// Truncation drops from the LEFT (the team, the most redundant part) rather
// than the right: a label cut to `clodex.t293` loses the role, which is the
// field the rollup groups by, while one cut to `293.hand` still attributes.
function clampLabel(label) {
  if (label.length <= MAX_LABEL) return label;
  return label.slice(label.length - MAX_LABEL).replace(/^[.\-_]+/, '');
}

// `<team>.<ticket-id>.<role>` — the ticket seat's wire label.
function wireLabelFor({ team, ticketId, role }) {
  const parts = [sanitizePart(team), sanitizePart(ticketId), sanitizePart(role)].filter(Boolean);
  if (!parts.length) return null;
  return clampLabel(parts.join(LABEL_SEP));
}

// `<team>.<ticket-id>.review-r<N>` — a reviewer spawn. The round is what makes
// two reviews of the same ticket separable in the rollup; without it round 2's
// spend lands on round 1's label and the cache-ordering claim of DESIGN.md §4
// becomes unmeasurable.
function reviewWireLabelFor({ team, ticketId, round }) {
  const n = Number(round);
  const r = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  const parts = [sanitizePart(team), sanitizePart(ticketId), `review-r${r}`].filter(Boolean);
  return clampLabel(parts.join(LABEL_SEP));
}

// A review is NOT ticket-scoped in the code: [agent:team-review] takes free
// text, and no field on the reviewer seat links it to a ticket. So the ticket
// id is recovered from the scope prose, which is where the lead in practice
// names it ("review t289's diff"). Absent one the label degrades to
// `<team>.review-r<N>` rather than inventing an id — a wrong ticket id would
// silently bill one ticket's review to another, which is worse than a review
// that rolls up only team-wide.
function ticketIdFromScope(scope) {
  const m = /\bt(\d+)\b/i.exec(String(scope == null ? '' : scope));
  return m ? `t${m[1]}` : null;
}

// A ticket's `taskDir` is the first line of an AGENT-WRITTEN spec, captured
// verbatim by tickets-store extractTaskDir — so it arrives in any shape an agent
// wrote, relative, tilde-prefixed or absolute, and is never trusted as a path.
// A writer that trusts the field mkdir -p's a literal `~` directory under the
// process cwd, silently, and the artifact never reaches the task dir at all.
//
// Two hazards, both handled here rather than at the write:
//  - shape: `~` must expand and a bare `tasks/…` must resolve against the
//    project's artifact dir (clodex-paths projectDirFor), never against cwd.
//  - containment: the charset extractTaskDir admits includes `.`, so
//    `tasks/../../..` parses fine. This is the first path derived from that
//    text that Clodex WRITES to, so it is confined positively — segment by
//    segment through path-confine, which is the same primitive the stores use
//    and cannot be walked around by a spelling nobody anticipated.
// Returns the resolved absolute dir, or null when it cannot be placed.
// Throws only on an escaping path — a caller treats that as "do not write".
function resolveTaskDir({ taskDir, projectDir, projectsRoot, homedir }) {
  const raw = String(taskDir == null ? '' : taskDir).trim();
  if (!raw) return null;
  let abs;
  if (raw === '~' || raw.startsWith('~/')) {
    if (!homedir) return null;
    abs = path.join(homedir, raw.slice(1));
  } else if (path.isAbsolute(raw)) {
    abs = raw;
  } else {
    if (!projectDir) return null;
    abs = path.join(projectDir, raw);
  }
  abs = stripFileTail(path.resolve(abs));
  if (!projectsRoot) return null;
  return confineUnder(projectsRoot, abs);
}

// A lead routinely writes the SPEC file as the task pointer
// (`…/tasks/wire-off/SPEC.md`), and pointers routinely carry a tail past the
// task name or a trailing slash. ensureDir on those either throws
// (the file exists) or mints a directory named `SPEC.md`, so a file-shaped last
// segment is dropped. Only when something remains under `tasks/`: a task dir
// legitimately named `foo.bar` at the top level is kept, because guessing wrong
// there would place the artifact outside the task's dir entirely.
//
// The extension list is CLOSED, not "any short alnum tail": a dir named
// `round.2` or `v2.beta` is a directory, and eating its last level writes the
// artifact one level up where nothing looks for it. Only what a lead actually
// names a spec with. Widen it by adding an extension, never by loosening it
// back to a charset.
const FILE_TAIL_RE = /\.(?:md|json|txt|log|patch|diff)$/i;
function stripFileTail(p) {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf('tasks');
  if (i < 0 || parts.length - i < 3) return p;
  if (!FILE_TAIL_RE.test(parts[parts.length - 1])) return p;
  return parts.slice(0, -1).join(path.sep);
}

// path-confine admits ONE segment; a task dir is `tasks/<name>[/…]`. Walking
// the relative path segment by segment gives exact subtree containment out of
// the existing primitive: a target outside the root produces leading `..`
// segments, and each one fails the direct-child test at the step that
// introduces it. An empty relative path is the root ITSELF, which is not a task
// dir — writing COST.json there would drop it into the projects root.
function confineUnder(root, target) {
  const base = path.resolve(root);
  const rel = path.relative(base, path.resolve(target));
  if (!rel) throw new Error(`invalid taskDir: ${base} is not a task dir`);
  let cur = base;
  for (const seg of rel.split(path.sep)) cur = confineOrThrow(cur, seg, 'taskDir segment');
  return cur;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

// Sum the persisted per-session ledger across the seat's session history.
//
// `known` is reported rather than hidden for the same reason session-info.js
// reports it: wire-totals.json keeps only the newest 500 sessions, so an old
// seat's earliest spend is genuinely gone and a total that silently omitted it
// would read as authoritative. For a ticket seat — minted, used, closed — known
// should equal total, and a shortfall is the signal that the rollup is a floor.
function sumSessions(totals, sessionIds) {
  const sessions = (totals && totals.sessions) || {};
  const out = {
    usd: 0, requests: 0, turns: 0, refusals: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    known: 0, total: Array.isArray(sessionIds) ? sessionIds.length : 0,
    tokensKnown: 0,
  };
  for (const sid of (sessionIds || [])) {
    const v = sessions[sid];
    if (!v) continue;
    out.known++;
    // Counted separately from `known` because the token fields were added to
    // wire-totals.json by this ticket: every row written before it has a cost
    // but no tokens, num() coerces the absent field to 0, and the sum would
    // read as complete while being a floor. `tokensKnown < known` is the same
    // shortfall signal `known < total` already gives for cost.
    if (typeof v.inputTokens === 'number') out.tokensKnown++;
    out.usd += num(v.cost);
    out.requests += num(v.requests);
    out.turns += num(v.turns);
    out.refusals += num(v.refusals);
    out.inputTokens += num(v.inputTokens);
    out.outputTokens += num(v.outputTokens);
    out.cacheReadTokens += num(v.cacheReadTokens);
    out.cacheWriteTokens += num(v.cacheWriteTokens);
  }
  // round6 mirrors billing.js — summing round6 values keeps them exact.
  out.usd = Math.round(out.usd * 1e6) / 1e6;
  return out;
}

// cache-read / all input the turn was billed for. Separately load-bearing:
// DESIGN.md §4's stable-prefix ordering predicts a HIGH fraction on round-2
// packed reviews, and a low one falsifies it. null (never 0) when no input was
// billed at all — "no data" and "nothing was cached" are different claims.
function cachedFraction({ inputTokens, cacheReadTokens, cacheWriteTokens }) {
  const denom = num(inputTokens) + num(cacheReadTokens) + num(cacheWriteTokens);
  if (denom <= 0) return null;
  return Math.round((num(cacheReadTokens) / denom) * 1e6) / 1e6;
}

const COST_FILE = 'COST.json';
const COST_VERSION = 1;

// The per-ticket rollup written at close. Every argument is already-read data;
// this decides only the shape.
//
// `zeroCommit` is waste counter (a) of DESIGN.md §7.3 — a worktree minted for a
// ticket that closed with no commits. It is only meaningful when a tree was
// actually minted, so it is null (not false) for a ticket that never had one:
// counting an un-minted ticket as "not wasted" would dilute the rate the Phase
// 2a isolation decision is graded on.
// `seatResolved: false` says the seat that spent the money could not be found —
// a ticket assigned to a ROLE keeps `assignee: 'hand'`, and no persistence
// record is stored under a role name. The ledger for an unfindable seat is not
// zero, it is UNKNOWN, so every measured field goes null: `known === total === 0`
// otherwise reads as "complete, nothing spent", and a ticket that burned real
// money would be indistinguishable from a free one. That false zero is the
// class this whole artifact exists to prevent.
//
// `attribution` carries HOW the seat was found, because the resolutions are not
// equally trustworthy and a consumer that cannot separate them averages an
// exact number with an inferred one:
//   'seat'        — the ticket named a persistence record. Exact.
//   'role-closer' — the ticket named a role and the closer held that role.
//   'unknown'     — no seat; the ledger fields are null.
// Unset defaults to 'unknown', never to 'seat': a caller that forgot the
// argument has not resolved anything, and the failure has to be the one that
// under-claims. Defaulting to the value consumers are told is exact would let a
// future call site publish a guess as a measurement by omission.
function costRecord({
  ticket, team, ledger, worktree = null, commits = null, commitsBase = null,
  orphans = null, seatResolved = true, attribution = null, now = Date.now(),
}) {
  const t = ticket || {};
  const openedAt = num(t.openedAt) || null;
  const closedAt = num(t.closedAt) || now;
  const minted = !!(worktree && worktree.path);
  const l = ledger || sumSessions(null, []);
  const measured = (v) => (seatResolved ? v : null);
  return {
    version: COST_VERSION,
    ticket: t.id || null,
    team: team || null,
    role: t.role || null,
    seat: t.assignee || null,
    wireLabel: t.wireLabel || null,
    state: t.state || null,
    openedAt,
    closedAt,
    wallMs: openedAt ? Math.max(0, closedAt - openedAt) : null,
    sessions: {
      ids: l.ids || [], known: l.known, total: l.total,
      tokensKnown: num(l.tokensKnown), seatResolved: !!seatResolved,
      attribution: attribution || 'unknown',
    },
    tokens: {
      input: measured(l.inputTokens),
      output: measured(l.outputTokens),
      cacheRead: measured(l.cacheReadTokens),
      cacheWrite: measured(l.cacheWriteTokens),
      cachedFraction: measured(cachedFraction(l)),
    },
    usd: measured(l.usd),
    requests: measured(l.requests),
    turns: measured(l.turns),
    refusals: measured(l.refusals),
    waste: {
      worktreeMinted: minted,
      commits: minted ? commits : null,
      zeroCommit: minted && typeof commits === 'number' ? commits === 0 : null,
      // Which ref the count was taken against. A commit count is only readable
      // next to its base, and the base varies by what the record carried (a
      // mint-time SHA, else a merge-base) — recording it makes a wrong number
      // auditable instead of silently wrong.
      commitsBase: minted ? (commitsBase || null) : null,
      // Fixed slots, present whether or not the sweep ran, so the artifact's
      // schema does not vary by whether git answered. null is "not swept".
      orphanedCheckouts: orphans ? orphans.orphaned : null,
      unclaimedNonMain: orphans ? orphans.unclaimedNonMain : null,
      claimedByArchived: orphans ? orphans.claimedByArchived : null,
    },
  };
}

// A ticket seat's branch, as _mintTicketSeat spells it: `<ticket-id>` or
// `<ticket-id>-<slug>`.
const TICKET_BRANCH_RE = /^t\d+(-[a-zA-Z0-9._-]+)?$/;

// Waste counter (b): checkouts left behind by the ticket machinery.
//
// SCOPED to the class it grades, and that scoping is the whole correctness
// question. A repo carries the operator's own long-lived trees and other
// tools' (`.claude/worktrees/…`), none of which Clodex minted and none of which
// any persistence record will ever claim — counting those reports a fleet of
// orphans against a clean tree and makes the counter unreadable. So `orphaned`
// counts only trees on a ticket-shaped branch that no live record claims, which
// is exactly the set `78d5a38` was meant to drive to zero.
//
// `unclaimedNonMain` is returned alongside as the unscoped number, so a
// mis-scoped filter cannot hide a real orphan behind a clean count.
//
// A record that ARCHIVED its seat still names the tree, which excluded the
// commonest real leak — record-outlives-seat — from both counters at once. So
// an archived record does not claim: its tree goes to `claimedByArchived`,
// which is the leak's own counter rather than a silence.
//
// `real` is injected (fs.realpathSync at the call site) because git prints
// canonical paths while a record carries the path as created — on macOS
// /tmp vs /private/tmp — and a raw string compare misses the match, reporting
// a live tree as an orphan. Injected rather than required so the module stays
// a pure leaf; absent, it degrades to path.resolve.
function orphanedCheckouts({ worktrees, records, real = null }) {
  const canon = typeof real === 'function' ? real : ((p) => path.resolve(p));
  const claimed = new Set();
  const archivedClaims = new Set();
  for (const r of (records || [])) {
    if (!r || !r.worktree || !r.worktree.path) continue;
    (r.archivedAt ? archivedClaims : claimed).add(canon(r.worktree.path));
  }
  const orphans = [];
  const unclaimed = [];
  const archived = [];
  for (const w of (worktrees || [])) {
    if (!w || !w.path || w.isMain) continue;
    const p = canon(w.path);
    if (claimed.has(p)) continue;
    if (archivedClaims.has(p)) { archived.push(w.path); continue; }
    unclaimed.push(w.path);
    const branch = String(w.branch || '').replace(/^refs\/heads\//, '');
    if (TICKET_BRANCH_RE.test(branch)) orphans.push(w.path);
  }
  return {
    orphaned: orphans.length,
    orphanedPaths: orphans,
    unclaimedNonMain: unclaimed.length,
    unclaimedPaths: unclaimed,
    claimedByArchived: archived.length,
    claimedByArchivedPaths: archived,
  };
}

module.exports = {
  COST_FILE, COST_VERSION, MAX_LABEL, TICKET_BRANCH_RE,
  wireLabelFor, reviewWireLabelFor, ticketIdFromScope, resolveTaskDir,
  sumSessions, cachedFraction, costRecord, orphanedCheckouts,
};
