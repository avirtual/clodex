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
    known: 2, total: 2, tokensKnown: 2,
  });
});

test('sumSessions counts token rows separately — a pre-token row is a floor, not a total', () => {
  // The token fields were added to wire-totals.json by this ticket, so every row
  // written before it has a cost and no tokens. num() coerces those to 0 and the
  // sum reads complete while being a floor; tokensKnown < known is the signal.
  const totals = { sessions: {
    'new': { cost: 1, requests: 2, turns: 1, refusals: 0, inputTokens: 100, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 0 },
    'legacy': { cost: 5, requests: 9, turns: 4, refusals: 0 },   // pre-token row
  } };
  const got = tc.sumSessions(totals, ['new', 'legacy']);
  // ENTER: the legacy row was actually summed. Were it dropped, known would be 1
  // and tokensKnown 1 — "complete" — which is the shape this exists to deny.
  assert.strictEqual(got.usd, 6, 'the legacy row must contribute its cost');
  assert.strictEqual(got.known, 2);
  assert.strictEqual(got.tokensKnown, 1, 'only one row carried tokens at all');
  assert.strictEqual(got.inputTokens, 100, 'and the token sum is that row alone — a floor');
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
    known: 0, total: 1, tokensKnown: 0,
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
    commitsBase: 'abc1234',
    orphans: { orphaned: 0, unclaimedNonMain: 2, claimedByArchived: 1 },
    attribution: 'seat',
  });
  // The WHOLE object: this is the artifact's schema, and a field that silently
  // stops being written is exactly the failure a field-pick assertion misses.
  assert.deepStrictEqual(rec, {
    version: 1,
    ticket: 't293', team: 'clodex', role: 'hand', seat: 'clodex-hand-293',
    wireLabel: 'clodex.t293.hand', state: 'done',
    openedAt: 1000, closedAt: 61000, wallMs: 60000,
    sessions: { ids: ['s1'], known: 1, total: 1, tokensKnown: 1, seatResolved: true, attribution: 'seat' },
    tokens: { input: 1000, output: 300, cacheRead: 9000, cacheWrite: 0, cachedFraction: 0.9 },
    usd: 2.5, requests: 20, turns: 6, refusals: 0,
    waste: {
      worktreeMinted: true, commits: 3, zeroCommit: false, commitsBase: 'abc1234',
      orphanedCheckouts: 0, unclaimedNonMain: 2, claimedByArchived: 1,
    },
  });
});

test('costRecord: an unresolved seat measures NOTHING — never an authoritative $0', () => {
  // A ticket assigned to a ROLE keeps assignee:'hand' and no record is stored
  // under a role name, so the ledger comes back empty. known===total===0 is the
  // shape sumSessions defines as "complete, no shortfall", so a ticket that
  // burned real money would report a MEASURED zero. Every measured field must be
  // null instead, and the artifact must say why.
  const rec = tc.costRecord({
    ticket: { id: 't294', role: 'hand', assignee: 'hand', state: 'done', openedAt: 1, closedAt: 2 },
    team: 'clodex', ledger: tc.sumSessions(null, []),
    worktree: { path: '/tmp/wt', branch: 't294' }, commits: 2, commitsBase: 'ff00',
    seatResolved: false,
  });
  assert.strictEqual(rec.sessions.seatResolved, false, 'the artifact must SAY the seat was not found');
  // And WHICH resolution produced it, so a rollup can separate an exact seat
  // attribution from one inferred off the closer — the two are not equally
  // trustworthy and a consumer that cannot tell them apart averages them.
  assert.strictEqual(rec.sessions.attribution, 'unknown');
  assert.deepStrictEqual(
    [rec.usd, rec.requests, rec.turns, rec.refusals],
    [null, null, null, null],
    'an unfindable seat spent an UNKNOWN amount, not zero');
  assert.deepStrictEqual(rec.tokens,
    { input: null, output: null, cacheRead: null, cacheWrite: null, cachedFraction: null });
  // The waste half is still MEASURED: it comes from git, not from the seat, so
  // losing it here would drop the counters for exactly the tickets most likely
  // to have been mis-assigned.
  assert.deepStrictEqual([rec.waste.commits, rec.waste.zeroCommit, rec.waste.commitsBase],
    [2, false, 'ff00']);
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
  // The slots are FIXED — present and null when nothing was swept — so the
  // artifact's schema does not vary by whether git happened to answer.
  assert.deepStrictEqual(rec.waste, {
    worktreeMinted: false, commits: null, zeroCommit: null, commitsBase: null,
    orphanedCheckouts: null, unclaimedNonMain: null, claimedByArchived: null,
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
    claimedByArchived: 0,
    claimedByArchivedPaths: [],
  });
});

test('a tree claimed by an ARCHIVED record is counted, not silently excluded', () => {
  // Record-outlives-seat is the commonest real leak. An archived record still
  // names its tree, so treating it as a claim removed that tree from BOTH
  // counters at once — the leak detector reporting clean over the leak.
  const worktrees = [
    { path: '/repo', branch: 'master', isMain: true },
    { path: '/repo-t1', branch: 't1' },     // claimed by a LIVE record
    { path: '/repo-t2', branch: 't2' },     // claimed by an ARCHIVED one
  ];
  const got = tc.orphanedCheckouts({
    worktrees,
    records: [
      { name: 'live', worktree: { path: '/repo-t1' } },
      { name: 'gone', archivedAt: 123, worktree: { path: '/repo-t2' } },
    ],
  });
  // ENTER: the archived-claim row survived into its own bucket. Without this the
  // three counts below are all satisfied by an empty set.
  assert.deepStrictEqual(got.claimedByArchivedPaths, ['/repo-t2'],
    'the archived claim must land in its own bucket, not vanish');
  assert.strictEqual(got.claimedByArchived, 1);
  assert.strictEqual(got.orphaned, 0, 'it is not an orphan — a record does name it');
  assert.strictEqual(got.unclaimedNonMain, 0, 'nor unclaimed');
});

test('the sweep compares paths canonically — /tmp vs /private/tmp is one tree', () => {
  // git prints realpath'd paths; a record carries the path as created. A raw
  // string compare reports a live, claimed tree as an orphan, which is the
  // counter accusing a clean repo.
  const real = (p) => p.replace(/^\/tmp\//, '/private/tmp/');
  const worktrees = [
    { path: '/repo', branch: 'master', isMain: true },
    { path: '/private/tmp/repo-t7', branch: 't7' },
  ];
  const records = [{ name: 'a', worktree: { path: '/tmp/repo-t7' } }];
  assert.strictEqual(tc.orphanedCheckouts({ worktrees, records, real }).orphaned, 0,
    'the symlinked prefix must resolve to the same tree');
  // And without the resolver it is the false positive this guards.
  assert.strictEqual(tc.orphanedCheckouts({ worktrees, records }).orphaned, 1);
});

// resolveTaskDir — measured against the live store, of 227 tickets carrying a
// taskDir NONE is absolute: 175 are relative and 52 tilde-prefixed. A writer
// that trusts the field mkdir -p's a literal `~` under the process cwd without
// throwing, so the artifact silently never lands anywhere anyone looks.
const RESOLVE_ENV = {
  projectDir: '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a',
  projectsRoot: '/home/u/.clodex/projects',
  homedir: '/home/u',
};

test('resolveTaskDir places the two shapes real tickets actually have', () => {
  // Tilde — 52 of the live store. path.join would treat `~` as a directory name.
  assert.strictEqual(
    tc.resolveTaskDir({ taskDir: '~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/phase0-measure', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/phase0-measure');
  // Bare relative — 175 of them. Resolved against the PROJECT dir, never cwd:
  // against cwd this writes into the user's own repo, which Clodex never does.
  assert.strictEqual(
    tc.resolveTaskDir({ taskDir: 'tasks/phase0-measure', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/phase0-measure');
  // An absolute one inside the root is honored as-is.
  assert.strictEqual(
    tc.resolveTaskDir({ taskDir: '/home/u/.clodex/projects/p-1234abcd/tasks/x', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/p-1234abcd/tasks/x');
  assert.strictEqual(tc.resolveTaskDir({ taskDir: '', ...RESOLVE_ENV }), null);
  assert.strictEqual(tc.resolveTaskDir({ taskDir: null, ...RESOLVE_ENV }), null);
});

test('resolveTaskDir drops a file-shaped tail — a lead names the SPEC, not the dir', () => {
  // 51 live taskDirs carry a tail past the task name and 36 end in a slash;
  // many name a file. ensureDir on those either throws or mints a directory
  // called SPEC.md, and COST.json lands inside it.
  const want = '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/wire-off';
  assert.strictEqual(tc.resolveTaskDir({ taskDir: '~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/wire-off/SPEC.md', ...RESOLVE_ENV }), want);
  assert.strictEqual(tc.resolveTaskDir({ taskDir: 'tasks/wire-off/SPEC.md', ...RESOLVE_ENV }), want);
  assert.strictEqual(tc.resolveTaskDir({ taskDir: 'tasks/wire-off/', ...RESOLVE_ENV }), want, 'a trailing slash is not a segment');
  // A DIRECTORY whose own name has a dot is kept: guessing wrong at the top
  // level would put the artifact outside the task's dir entirely.
  assert.strictEqual(tc.resolveTaskDir({ taskDir: 'tasks/v1.2', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/v1.2');
  // A deeper spec path keeps its intermediate dirs, losing only the file.
  assert.strictEqual(tc.resolveTaskDir({ taskDir: 'tasks/audit/specs/P4.md', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/audit/specs');
  // ...and ONLY for the extensions a lead actually writes. Any-alnum-tail
  // silently eats a level off legitimate deep dirs — `round.2` and `phase.a`
  // are directories, not files, and dropping them writes the artifact one
  // level up where nothing looks for it.
  for (const dir of ['tasks/audit/round.2', 'tasks/audit/phase.a', 'tasks/audit/v2.beta']) {
    assert.strictEqual(tc.resolveTaskDir({ taskDir: dir, ...RESOLVE_ENV }),
      `/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/${dir}`,
      `${dir} is a directory whose name has a dot, not a file`);
  }
  for (const ext of ['md', 'json', 'txt', 'log', 'patch', 'diff']) {
    assert.strictEqual(tc.resolveTaskDir({ taskDir: `tasks/audit/SPEC.${ext}`, ...RESOLVE_ENV }),
      '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/audit',
      `.${ext} is a spec file the lead named instead of the dir`);
  }
});

test('resolveTaskDir refuses to escape the projects root — taskDir is agent-written', () => {
  // The field is captured verbatim from spec text by a regex whose charset
  // includes `.`, so `..` parses fine. This commit makes it the first WRITE
  // target derived from that text; an escape must throw, never resolve.
  const escapes = [
    'tasks/../../../../etc/cron.d',
    '~/.clodex/projects/../../../tmp/pwned',
    '/etc/tasks/x',
    '/home/u/.clodex/projects/../../evil/tasks/y',
  ];
  // ENTER: the resolver EXISTS and places a legitimate path. Without this the
  // loop below is satisfied by a resolver that throws on everything — including
  // one that is not implemented at all, which is how this first passed against
  // the unfixed tree.
  assert.strictEqual(tc.resolveTaskDir({ taskDir: 'tasks/ok', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/ok');
  const leaked = [];
  for (const taskDir of escapes) {
    let out = null;
    try { out = tc.resolveTaskDir({ taskDir, ...RESOLVE_ENV }); }
    catch { continue; }                       // refusing is the correct answer
    if (out) leaked.push(`${taskDir} → ${out}`);
  }
  assert.deepStrictEqual(leaked, [],
    'a taskDir that escapes the projects root must not resolve to a writable path: ' + leaked.join('; '));
  // The projects root ITSELF is not a task dir — writing there scatters
  // COST.json over every project's parent.
  assert.throws(() => tc.resolveTaskDir({ taskDir: '/home/u/.clodex/projects', ...RESOLVE_ENV }));
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
