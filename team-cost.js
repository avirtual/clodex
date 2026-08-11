'use strict';

// team-cost.js — per-ticket cost attribution. Pure leaf: no fs, no git, no
// electron. Callers pass the already-read inputs; every function here is a
// projection of them.
//
// Exists because the redesign's governing claim is cost-at-equal-quality, and
// a claim measured only AFTER the change is narrative. The baseline has to be
// collectable before the resolver and the packer land.

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
  };
  for (const sid of (sessionIds || [])) {
    const v = sessions[sid];
    if (!v) continue;
    out.known++;
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
function costRecord({
  ticket, team, ledger, worktree = null, commits = null,
  orphanedCheckouts = null, now = Date.now(),
}) {
  const t = ticket || {};
  const openedAt = num(t.openedAt) || null;
  const closedAt = num(t.closedAt) || now;
  const minted = !!(worktree && worktree.path);
  const l = ledger || sumSessions(null, []);
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
    sessions: { ids: l.ids || [], known: l.known, total: l.total },
    tokens: {
      input: l.inputTokens,
      output: l.outputTokens,
      cacheRead: l.cacheReadTokens,
      cacheWrite: l.cacheWriteTokens,
      cachedFraction: cachedFraction(l),
    },
    usd: l.usd,
    requests: l.requests,
    turns: l.turns,
    refusals: l.refusals,
    waste: {
      worktreeMinted: minted,
      commits: minted ? commits : null,
      zeroCommit: minted && typeof commits === 'number' ? commits === 0 : null,
      orphanedCheckouts,
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
function orphanedCheckouts({ worktrees, records }) {
  const claimed = new Set();
  for (const r of (records || [])) {
    if (r && r.worktree && r.worktree.path) claimed.add(r.worktree.path);
  }
  const orphans = [];
  const unclaimed = [];
  for (const w of (worktrees || [])) {
    if (!w || !w.path || w.isMain) continue;
    if (claimed.has(w.path)) continue;
    unclaimed.push(w.path);
    const branch = String(w.branch || '').replace(/^refs\/heads\//, '');
    if (TICKET_BRANCH_RE.test(branch)) orphans.push(w.path);
  }
  return {
    orphaned: orphans.length,
    orphanedPaths: orphans,
    unclaimedNonMain: unclaimed.length,
    unclaimedPaths: unclaimed,
  };
}

module.exports = {
  COST_FILE, COST_VERSION, MAX_LABEL, TICKET_BRANCH_RE,
  wireLabelFor, reviewWireLabelFor, ticketIdFromScope,
  sumSessions, cachedFraction, costRecord, orphanedCheckouts,
};
