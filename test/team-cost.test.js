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

  // And an unset `attribution` must NOT default to 'seat', the one value
  // consumers are told is exact. A future caller that forgets the argument
  // should under-claim, never over-claim.
  const forgetful = tc.costRecord({
    ticket: { id: 't295', assignee: 'clodex-hand-9', state: 'done' },
    team: 'clodex', ledger: tc.sumSessions({ sessions: { s: { cost: 1 } } }, ['s']),
  });
  assert.strictEqual(forgetful.sessions.attribution, 'unknown',
    'an omitted attribution is a caller that did not resolve, not an exact seat');
  // ENTER: the ledger really did resolve, so the assertion above is about the
  // DEFAULT and not about an empty record.
  assert.strictEqual(forgetful.usd, 1);
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

// resolveTaskDir — the field arrives in whatever shape the agent that wrote the
// ticket used: relative, tilde-prefixed and absolute pointers all occur in the
// live store, so it is resolved and confined, never trusted. A writer that
// trusts it mkdir -p's a literal `~` under the process cwd without throwing, so
// the artifact silently never lands anywhere anyone looks.
const RESOLVE_ENV = {
  projectDir: '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a',
  projectsRoot: '/home/u/.clodex/projects',
  homedir: '/home/u',
};

test('resolveTaskDir places the shapes real tickets actually have', () => {
  // Tilde — path.join would treat `~` as a directory name.
  assert.strictEqual(
    tc.resolveTaskDir({ taskDir: '~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/phase0-measure', ...RESOLVE_ENV }),
    '/home/u/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/phase0-measure');
  // Bare relative — resolved against the PROJECT dir, never cwd: against cwd this
  // writes into the user's own repo, which Clodex never does.
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
  // Live taskDirs routinely carry a tail past the task name or a trailing
  // slash, and many name a file. ensureDir on those either throws or mints a
  // directory called SPEC.md, and COST.json lands inside it.
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

// --- t673: the A/B fields on a review row ------------------------------------
//
// `template`, `model` and `wallMs` exist to compare two reviewer templates on
// real tickets. All three follow the file's measured/null discipline: a review
// whose template, model or spawn time could not be read reports null, never a
// default that would group it with the wrong population or a 0 that drags a
// median down.
//
// `model` is separate from `template` because they vary INDEPENDENTLY — the
// operator moved the default reviewer to another model mid-experiment, so a row
// carrying only the template attributes that switch to the template.

test('t673: reviewCostRecord carries template, model and wallMs as literals', () => {
  const ledger = tc.sumSessions(
    { sessions: { 'sess-1': { cost: 2, requests: 30, turns: 5, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, refusals: 0 } } },
    ['sess-1'],
  );
  const row = tc.reviewCostRecord({
    ticket: 't9', team: 'crew', round: 2, seat: 'crew-reviewer-9-r2',
    verdict: 'ACCEPT', mustFix: 0, ledger, resolved: true, now: 1000,
    template: 'clodex-team-reviewer-shell', model: 'claude-fable-5-1', wallMs: 8 * 60 * 1000,
  });
  assert.strictEqual(row.template, 'clodex-team-reviewer-shell');
  assert.strictEqual(row.model, 'claude-fable-5-1');
  assert.strictEqual(row.wallMs, 480000);
  assert.strictEqual(row.verdict, 'ACCEPT');
  assert.strictEqual(row.usd, 2, 'ENTER: the ledger really was measured, so the new fields sit beside real spend');
});

test('t673: an unknown template, model or spawn time is null, never a default or a zero', () => {
  const row = tc.reviewCostRecord({
    ticket: 't9', team: 'crew', round: 1, seat: 's', ledger: null, resolved: false, now: 1000,
  });
  assert.strictEqual(row.template, null,
    'null groups as "unknown", and review-ab folds it into the default — a DEFAULT written here would be a claim the record cannot make');
  assert.strictEqual(row.model, null,
    'the model is observed on the wire payload; absent means unknown, and naming one here would invent a measurement');
  assert.strictEqual(row.wallMs, null, 'a 0 here would drag every median toward zero');
});

test('t673: an UNRESOLVED ledger still carries the model it was told', () => {
  // The model does not ride measured(): resolved=false says the LEDGER could not
  // be summed, which is not a statement about which model billed. Nulling it
  // here would drop the field on exactly the rows a cost-blind A/B still needs.
  const row = tc.reviewCostRecord({
    ticket: 't9', team: 'crew', round: 1, seat: 's', ledger: null, resolved: false, now: 1000,
    template: 'clodex-team-reviewer', model: 'claude-opus-5',
  });
  assert.strictEqual(row.usd, null, 'ENTER: the ledger really is unresolved, so the model below survives that state');
  assert.strictEqual(row.model, 'claude-opus-5');
});

test('t673: a negative or non-finite wallMs is refused rather than recorded', () => {
  // A clock that moved backwards between spawn and verdict yields a negative
  // duration, and a negative minute in the A/B reads as a fast review.
  for (const bad of [-1, NaN, Infinity, '480000', null, undefined]) {
    const row = tc.reviewCostRecord({ ticket: 't', team: 'c', round: 1, seat: 's', wallMs: bad });
    assert.strictEqual(row.wallMs, null, `${JSON.stringify(bad)} must not be recorded as a duration`);
  }
  // And it accepts a real one, so the rejections above are not universal.
  assert.strictEqual(tc.reviewCostRecord({ ticket: 't', team: 'c', round: 1, seat: 's', wallMs: 1.6 }).wallMs, 2);
});

// ── the team ledger: cost.jsonl, and the rollup over it ─────────────────────
//
// Literal fixtures throughout, not rows built by the writers: the writers are
// pinned separately, and a rollup fed its own producer's output cannot fail the
// way a hand-edited or half-written ledger does — which is the shape this file
// actually meets on disk.

const LEDGER_ROWS = [
  { kind: 'ticket', ticket: 't1', team: 'a', role: 'hand', seat: 'h1', attribution: 'seat', usd: 10, requests: 100, tokens: 5, at: 2000 },
  { kind: 'review', ticket: 't1', team: 'a', round: 1, seat: 'r1', verdict: 'REJECT', usd: 2, at: 3000 },
  { kind: 'review', ticket: 't1', team: 'a', round: 2, seat: 'r2', verdict: 'ACCEPT', usd: 3, at: 4000 },
  { kind: 'ticket', ticket: 't2', team: 'a', role: 'hand', seat: 'h2', attribution: 'seat-lifetime', usd: 594.98, at: 5000 },
  { kind: 'ticket', ticket: 't3', team: 'a', role: 'hand', seat: null, attribution: 'unknown', usd: null, at: 1000 },
  { kind: 'seat', seat: 'lead', team: 'a', role: 'lead', usd: 7, tokens: 9, requests: 4, turns: 2, at: 6000 },
];

const ledgerText = (rows) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;

test('parseTeamLedger keeps the good rows and COUNTS the rest, never dropping silently', () => {
  const { rows, malformed } = tc.parseTeamLedger(ledgerText([
    LEDGER_ROWS[0],
    'not json at all',
    '{"unterminated": ',
    '[1,2,3]',           // valid JSON, not a row
    '"a bare string"',   // ditto
    '{"usd": 5}',        // an object with no kind is not a row either
    LEDGER_ROWS[1],
  ]));
  assert.strictEqual(rows.length, 2, 'both real rows survive');
  assert.strictEqual(malformed, 5, 'and every unusable line is counted, not skipped in silence');
  assert.deepStrictEqual(rows.map((r) => r.kind), ['ticket', 'review']);
});

test('readTeamLedger reads the file, and a MISSING one is empty rather than an error', () => {
  const files = new Map([['/teams/a/cost.jsonl', ledgerText([LEDGER_ROWS[0]])]]);
  const readFile = (p) => {
    if (files.has(p)) return files.get(p);
    const e = new Error(`ENOENT: ${p}`);
    e.code = 'ENOENT';
    throw e;
  };
  const got = tc.readTeamLedger('/teams/a', { readFile });
  assert.strictEqual(got.rows.length, 1);
  assert.strictEqual(got.error, null);

  // A team that has closed no tickets yet has no file, and that is a normal
  // state — reporting it as an error would make every new team look broken.
  const none = tc.readTeamLedger('/teams/b', { readFile });
  assert.deepStrictEqual([none.rows.length, none.error], [0, null]);

  // Any OTHER read failure is reported: a ledger nobody can read is not an
  // empty one, and a $0 total off an EACCES is the false zero this whole
  // artifact exists to refuse.
  const denied = tc.readTeamLedger('/teams/c', {
    readFile: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  });
  assert.strictEqual(denied.rows.length, 0);
  assert.match(denied.error, /EACCES/);
});

test('readTeamLedger REFUSES to invent an fs rather than reading one', () => {
  // The module is a pure leaf (docs/architecture.md), so the reader is injected.
  // Throwing beats defaulting to require('fs'): a caller that forgot would get a
  // silent read of the operator's real ledger from inside a test.
  assert.throws(() => tc.readTeamLedger('/teams/a'), /injected readFile/);
});

test('rollupTeam splits the three kinds and never sums a null as zero', () => {
  const roll = tc.rollupTeam(LEDGER_ROWS);
  assert.strictEqual(roll.usd.tickets, 10, 'only the EXACT ticket row counts');
  assert.strictEqual(roll.usd.reviews, 5, 'both review rounds');
  assert.strictEqual(roll.usd.standing, 7);
  assert.strictEqual(roll.usd.total, 22);
  // ENTER: the two rows deliberately excluded are really in the fixture, or the
  // totals above are trivially right for a set that never contained them.
  assert.ok(LEDGER_ROWS.some((r) => r.attribution === 'seat-lifetime'), 'a lifetime row is in the set');
  assert.ok(LEDGER_ROWS.some((r) => r.usd === null), 'and an unpriced one');
  assert.strictEqual(roll.counts.tickets, 3, 'all three ticket rows are COUNTED');
  assert.strictEqual(roll.counts.unattributed, 2,
    'the lifetime row and the null row are both unattributable — counted, never summed');
});

test('a seat-lifetime ticket contributes its COUNT but not its dollars', () => {
  // $594.98 against a ticket a standing seat merely closed is the number t478
  // stopped publishing as exact. It must not reappear in a total by the back
  // door of a rollup that reads `usd` without reading `attribution`.
  const roll = tc.rollupTeam(LEDGER_ROWS);
  assert.ok(roll.usd.total < 100, `a total of ${roll.usd.total} means the lifetime row was summed`);
  const e = roll.byTicket.get('t2');
  assert.deepStrictEqual([e.hand, e.total, e.attribution], [null, null, 'seat-lifetime'],
    'and the per-ticket row reports it as unknown rather than as its seat\'s whole life');
});

test('byTicket joins a hand to its review rounds', () => {
  const roll = tc.rollupTeam(LEDGER_ROWS);
  const t1 = roll.byTicket.get('t1');
  assert.strictEqual(t1.hand, 10);
  assert.strictEqual(t1.total, 15, 'hand plus both rounds');
  assert.deepStrictEqual(t1.reviews.map((r) => [r.round, r.usd, r.verdict]),
    [[1, 2, 'REJECT'], [2, 3, 'ACCEPT']]);
  assert.strictEqual(t1.requests, 100);
});

test('a ticket with NOTHING priced totals null, not 0', () => {
  const roll = tc.rollupTeam(LEDGER_ROWS);
  assert.strictEqual(roll.byTicket.get('t3').total, null,
    'a ticket whose spend nobody could attribute is UNKNOWN — a 0 would read as free work');
});

test('rollupTeam reports the EARLIEST timestamp as its since', () => {
  // Rows arrive in write order, and the earliest is deliberately not first in
  // the fixture: taking rows[0].at would answer 2000 here.
  assert.strictEqual(tc.rollupTeam(LEDGER_ROWS).since, 1000);
  assert.strictEqual(tc.rollupTeam([]).since, null, 'an empty ledger has no since to claim');
});

test('rollupTeam groups by role, with reviews under their own key', () => {
  const roll = tc.rollupTeam(LEDGER_ROWS);
  assert.strictEqual(roll.byRole.get('hand'), 10);
  assert.strictEqual(roll.byRole.get('lead'), 7);
  assert.strictEqual(roll.byRole.get('review'), 5,
    'review spend is not a role\'s — folding it into the reviewed ticket\'s role would double the hand\'s figure');
});

test('rollupTeam survives junk in the row array', () => {
  const roll = tc.rollupTeam([null, undefined, 42, 'row', { kind: 'nonsense', usd: 999 }, LEDGER_ROWS[0]]);
  assert.strictEqual(roll.usd.total, 10, 'an unknown kind contributes nothing, and nothing throws');
});

// ── the three row builders ──────────────────────────────────────────────────

test('ticketLedgerRow carries the attribution VERBATIM off the COST.json record', () => {
  // The whole point of the ledger row: a consumer decides what to sum from this
  // field, so a builder that dropped or normalised it would make every rollup
  // above sum a lifetime figure as if it were exact.
  const rec = tc.costRecord({
    ticket: { id: 't7', role: 'hand', assignee: 'h1', state: 'done', closedAt: 5 },
    team: 'a', ledger: { usd: 4, requests: 9, known: 1, total: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    attribution: 'seat-lifetime', now: 5,
  });
  const row = tc.ticketLedgerRow(rec, 99);
  assert.deepStrictEqual(
    [row.kind, row.ticket, row.role, row.seat, row.attribution, row.usd, row.requests, row.tokens, row.at],
    ['ticket', 't7', 'hand', 'h1', 'seat-lifetime', 4, 9, 5, 99]);
});

test('an UNRESOLVED ticket record makes a row with null money, never zero', () => {
  const rec = tc.costRecord({
    ticket: { id: 't8', role: 'hand', state: 'done' }, team: 'a', ledger: null,
    seatResolved: false, attribution: 'unknown', now: 1,
  });
  const row = tc.ticketLedgerRow(rec, 2);
  assert.deepStrictEqual([row.usd, row.requests, row.tokens], [null, null, null],
    'nulls survive into the ledger, so the rollup can exclude them with a count');
});

test('reviewLedgerRow keeps the round and the verdict, which is what makes rounds separable', () => {
  const rec = tc.reviewCostRecord({
    ticket: 't7', team: 'a', round: 2, seat: 'r2', verdict: 'ACCEPT',
    ledger: { usd: 3, requests: 11, known: 1, total: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
    now: 5,
  });
  const row = tc.reviewLedgerRow(rec, 88);
  assert.deepStrictEqual(
    [row.kind, row.ticket, row.round, row.seat, row.verdict, row.usd, row.tokens, row.at],
    ['review', 't7', 2, 'r2', 'ACCEPT', 3, 4, 88]);
});

test('seatLedgerRow books the DELTA since the seat was last stamped', () => {
  // The whole mechanism for a standing seat: it has no ticket end, so each
  // boundary books what it spent since the last one. Booking the lifetime would
  // re-add everything already in the ledger at every /clear.
  const row = tc.seatLedgerRow({
    seat: 'lead', team: 'a', role: 'lead', sessionId: 's2', boundary: 'clear',
    lifetime: { usd: 30, tokens: 100, requests: 50, turns: 10 },
    cursor: { usd: 12, tokens: 40, requests: 20, turns: 4 },
    now: 7,
  });
  assert.deepStrictEqual([row.kind, row.seat, row.boundary, row.usd, row.tokens, row.requests, row.turns],
    ['seat', 'lead', 'clear', 18, 60, 30, 6]);
  assert.deepStrictEqual([row.from, row.to], [12, 30],
    'the window is recorded, so a wrong delta is auditable instead of silently wrong');
});

test('a seat with no cursor books its whole life ONCE', () => {
  const row = tc.seatLedgerRow({
    seat: 'lead', lifetime: { usd: 5, tokens: 9, requests: 2, turns: 1 }, cursor: null, now: 1,
  });
  assert.deepStrictEqual([row.usd, row.from, row.to], [5, 0, 5]);
});

test('a boundary that spent NOTHING books no row at all', () => {
  // An idle seat hits exit, clear and compact like any other. A zero row per
  // boundary would bloat the ledger and put a run of $0.00 rows in front of
  // every real one.
  assert.strictEqual(tc.seatLedgerRow({
    seat: 'lead', lifetime: { usd: 12, tokens: 40, requests: 20, turns: 4 },
    cursor: { usd: 12, tokens: 40, requests: 20, turns: 4 },
  }), null);
  assert.strictEqual(tc.seatLedgerRow({ seat: 'lead', lifetime: null }), null, 'and no ledger books nothing');
  assert.strictEqual(tc.seatLedgerRow({ seat: '', lifetime: { usd: 5 } }), null, 'and neither does a nameless seat');
});

test('a lifetime BELOW the cursor books nothing rather than a negative row', () => {
  // Reachable for real: wire-totals keeps only the newest 500 sessions, so a
  // long-lived seat's lifetime figure can fall when old rows age out. A negative
  // row would subtract from the team total money that really was spent.
  assert.strictEqual(tc.seatLedgerRow({
    seat: 'lead', lifetime: { usd: 3, tokens: 1, requests: 1, turns: 1 },
    cursor: { usd: 40, tokens: 90, requests: 9, turns: 9 },
  }), null);
});
