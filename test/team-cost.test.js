// Run: node --test
// team-cost.js — the per-ticket cost rollup (DESIGN.md §7.1) and the two waste
// counters (§7.3). Pure leaf, so everything here is called directly with the
// data the manager would have read.
//
// The load-bearing cases are the ones where a plausible-looking number would be
// WRONG rather than absent: a label that escapes its path segment (unroutable
// seat), a cached fraction of 0 that actually means "no data" (falsifies §4 for
// free), a zero-commit flag on a ticket that never had a worktree (dilutes the
// counter the Phase 2a decision is graded on), and an orphan sweep that counts
// the operator's own trees.
const { test } = require('node:test');
const assert = require('node:assert');
const tc = require('../team-cost');
const { parseAgentPath } = require('../wire/route');
const { AGENT_NAME_RE } = require('../catalogs');

// A label is only useful if the proxy can route it. Round-trip through the real
// router rather than testing the literal: extracting some OTHER string would be
// a different bug wearing the same green tick (same reasoning as
// agent-name-seam.test.js, which this mirrors deliberately).
function routable(label) {
  const id = `clodex-${label}-deadbeef`;
  const parsed = parseAgentPath(`/agent/${id}/v1/messages`);
  return !!parsed && parsed.agent === id && parsed.rest === '/v1/messages';
}

test('wireLabelFor builds <team>.<ticket>.<role> and it survives the router', () => {
  assert.strictEqual(tc.wireLabelFor({ team: 'clodex', ticketId: 't293', role: 'hand' }),
    'clodex.t293.hand');
  assert.ok(routable('clodex.t293.hand'));
});

test('reviewWireLabelFor separates rounds — round 2 must not bill onto round 1', () => {
  const r1 = tc.reviewWireLabelFor({ team: 'clodex', ticketId: 't289', round: 1 });
  const r2 = tc.reviewWireLabelFor({ team: 'clodex', ticketId: 't289', round: 2 });
  assert.strictEqual(r1, 'clodex.t289.review-r1');
  assert.strictEqual(r2, 'clodex.t289.review-r2');
  assert.notStrictEqual(r1, r2);
  // A missing/garbage round must still produce a DISTINCT, routable label
  // rather than collapsing onto r1's — but it defaults to r1 by design.
  assert.strictEqual(tc.reviewWireLabelFor({ team: 'clodex', ticketId: 't289' }),
    'clodex.t289.review-r1');
  assert.ok(routable(r2));
});

test('a review with no ticket id in scope degrades, never invents an id', () => {
  assert.strictEqual(tc.ticketIdFromScope('review t289 diff before merge'), 't289');
  assert.strictEqual(tc.ticketIdFromScope('review the messaging refactor'), null);
  // Degraded shape: team + round, no ticket segment. Billing a review to a
  // ticket it is not about is worse than not attributing it at all.
  const label = tc.reviewWireLabelFor({ team: 'clodex', ticketId: null, round: 3 });
  assert.strictEqual(label, 'clodex.review-r3');
  assert.ok(routable(label));
});

test('a label built from hostile parts stays inside one path segment', () => {
  // Every one of these would escape the segment, or fail the creation gate, if
  // the sanitizer let it through — the F004 failure class.
  const nasty = [
    { team: 'a/../b', ticketId: 't1', role: 'hand' },
    { team: 'clodex', ticketId: '../../etc', role: 'hand' },
    { team: 'clodex', ticketId: 't1', role: 'hand/../../root' },
    { team: 'te am', ticketId: 't1', role: 'ha nd' },
    { team: '...', ticketId: '...', role: '...' },
  ];
  const bad = [];
  for (const parts of nasty) {
    const label = tc.wireLabelFor(parts);
    if (label == null) continue;             // refusing outright is fine
    const id = `clodex-${label}-deadbeef`;
    if (!routable(label) || !AGENT_NAME_RE.test(id)) {
      bad.push(`${JSON.stringify(parts)} → ${JSON.stringify(label)}`);
    }
  }
  assert.deepStrictEqual(bad, [],
    'a label that escapes its path segment produces a seat that starts, looks '
    + 'healthy and 400s forever: ' + bad.join('; '));
});

test('a long label is clamped so clodex-<label>-<nonce> still fits the 64-char route cap', () => {
  const label = tc.wireLabelFor({
    team: 'a-very-long-team-name-that-goes-on', ticketId: 't123456',
    role: 'an-extremely-verbose-role-name-here',
  });
  const id = `clodex-${label}-deadbeef`;
  assert.ok(id.length <= 64, `minted id is ${id.length} chars: ${id}`);
  assert.ok(routable(label));
  // Truncation drops the TEAM, not the role: the role is what the rollup groups
  // by, so a label cut to `clodex.t123456` would lose the field it exists for.
  assert.ok(label.endsWith('role-name-here'), `lost the role end: ${label}`);
});

test('sumSessions totals the whole ledger object across a seat history', () => {
  const totals = { sessions: {
    's1': { cost: 1.5, requests: 10, turns: 3, refusals: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 },
    's2': { cost: 0.25, requests: 4, turns: 1, refusals: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
    'other': { cost: 999, requests: 999, turns: 999, refusals: 999 },
  } };
  // Whole object, not field picks: an unwired field arrives as undefined and
  // `undefined + 0` is NaN, which a per-field strictEqual on the fields that
  // DID wire would read straight past.
  assert.deepStrictEqual(tc.sumSessions(totals, ['s1', 's2']), {
    usd: 1.75, requests: 14, turns: 4, refusals: 1,
    inputTokens: 110, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 50,
    known: 2, total: 2,
  });
});

test('sumSessions reports a shortfall rather than hiding it', () => {
  // wire-totals keeps only the newest 500 sessions, so a seat can outlive its
  // own earliest spend. known < total is the signal the number is a FLOOR; a
  // total that silently omitted it would read as authoritative.
  const got = tc.sumSessions({ sessions: { 's1': { cost: 1, requests: 1 } } }, ['s1', 'evicted']);
  assert.strictEqual(got.known, 1);
  assert.strictEqual(got.total, 2);
  // A totally absent ledger is 0/0-of-N, never a throw.
  assert.deepStrictEqual(tc.sumSessions(null, ['a']), {
    usd: 0, requests: 0, turns: 0, refusals: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    known: 0, total: 1,
  });
});

test('cachedFraction distinguishes "nothing cached" from "no data"', () => {
  // DESIGN.md §4's stable-prefix claim is falsified by a LOW round-2 fraction,
  // so a no-data 0 would falsify it for free. null, never 0.
  assert.strictEqual(tc.cachedFraction({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  assert.strictEqual(tc.cachedFraction({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
  assert.strictEqual(tc.cachedFraction({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 }), 0.9);
});

test('costRecord: the whole artifact shape, for a ticket that did work', () => {
  const ledger = tc.sumSessions({ sessions: {
    's1': { cost: 2.5, requests: 20, turns: 6, refusals: 0, inputTokens: 1000, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  } }, ['s1']);
  ledger.ids = ['s1'];
  const rec = tc.costRecord({
    ticket: {
      id: 't293', role: 'hand', assignee: 'clodex-hand-293',
      wireLabel: 'clodex.t293.hand', state: 'done',
      openedAt: 1000, closedAt: 61000,
    },
    team: 'clodex',
    ledger,
    worktree: { path: '/tmp/wt', branch: 't293' },
    commits: 3,
    orphanedCheckouts: 0,
  });
  // The WHOLE object: this is the artifact's schema, and a field that silently
  // stops being written is exactly the failure a field-pick assertion misses.
  assert.deepStrictEqual(rec, {
    version: 1,
    ticket: 't293', team: 'clodex', role: 'hand', seat: 'clodex-hand-293',
    wireLabel: 'clodex.t293.hand', state: 'done',
    openedAt: 1000, closedAt: 61000, wallMs: 60000,
    sessions: { ids: ['s1'], known: 1, total: 1 },
    tokens: { input: 1000, output: 300, cacheRead: 9000, cacheWrite: 0, cachedFraction: 0.9 },
    usd: 2.5, requests: 20, turns: 6, refusals: 0,
    waste: { worktreeMinted: true, commits: 3, zeroCommit: false, orphanedCheckouts: 0 },
  });
});

test('costRecord: the t290 case — a worktree minted, nothing committed', () => {
  const rec = tc.costRecord({
    ticket: { id: 't290', role: 'hand', assignee: 's', state: 'done', openedAt: 1, closedAt: 2 },
    team: 'clodex', ledger: tc.sumSessions(null, []),
    worktree: { path: '/tmp/wt', branch: 't290' }, commits: 0,
  });
  assert.strictEqual(rec.waste.zeroCommit, true);
  assert.strictEqual(rec.waste.worktreeMinted, true);
  assert.strictEqual(rec.waste.commits, 0);
});

test('costRecord: a ticket with no worktree is not counted as un-wasted', () => {
  // false here would dilute the rate the Phase 2a isolation decision is graded
  // on — a ticket that never minted a tree cannot have wasted one.
  const rec = tc.costRecord({
    ticket: { id: 't291', state: 'done', openedAt: 1, closedAt: 2 },
    team: 'clodex', ledger: tc.sumSessions(null, []), worktree: null, commits: null,
  });
  assert.deepStrictEqual(rec.waste, {
    worktreeMinted: false, commits: null, zeroCommit: null, orphanedCheckouts: null,
  });
  // An unknown commit count on a REAL tree is also null, not a false zero —
  // "git failed" must not read as "produced nothing".
  const unknown = tc.costRecord({
    ticket: { id: 't291', state: 'done', openedAt: 1, closedAt: 2 },
    team: 'clodex', ledger: tc.sumSessions(null, []),
    worktree: { path: '/tmp/wt', branch: 't291' }, commits: null,
  });
  assert.strictEqual(unknown.waste.zeroCommit, null);
});

test('orphanedCheckouts counts ticket trees only, and reports the unscoped number too', () => {
  const worktrees = [
    { path: '/repo', branch: 'master', isMain: true },
    { path: '/repo-t292', branch: 't292-some-slug' },      // claimed
    { path: '/repo-t293', branch: 't293' },                 // ORPHAN
    { path: '/repo-audit', branch: 'registry-audit' },      // operator's own
    { path: '/repo/.claude/worktrees/agent-x', branch: 'worktree-agent-x' }, // another tool's
  ];
  const records = [
    { name: 'a', worktree: { path: '/repo-t292', branch: 't292-some-slug' } },
    { name: 'b' },
  ];
  const got = tc.orphanedCheckouts({ worktrees, records });
  // ENTER: the orphan under test survived the filter. Every assertion below is
  // about a count, and a filter that dropped this row would leave them all
  // trivially true over an empty set.
  assert.ok(got.orphanedPaths.includes('/repo-t293'),
    'the ticket-shaped orphan must survive the scoping filter');
  assert.deepStrictEqual(got, {
    orphaned: 1,
    orphanedPaths: ['/repo-t293'],
    unclaimedNonMain: 3,
    unclaimedPaths: ['/repo-t293', '/repo-audit', '/repo/.claude/worktrees/agent-x'],
  });
});

test('orphanedCheckouts: a fully claimed tree reports zero, main never counts', () => {
  const got = tc.orphanedCheckouts({
    worktrees: [
      { path: '/repo', branch: 'master', isMain: true },
      { path: '/repo-t1', branch: 't1' },
    ],
    records: [{ name: 'a', worktree: { path: '/repo-t1' } }],
  });
  assert.strictEqual(got.orphaned, 0);
  assert.strictEqual(got.unclaimedNonMain, 0);
  // Empty inputs are 0, not a throw.
  assert.strictEqual(tc.orphanedCheckouts({ worktrees: null, records: null }).orphaned, 0);
});
