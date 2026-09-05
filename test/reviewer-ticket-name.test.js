'use strict';
// Run: node --test test/reviewer-ticket-name.test.js
//
// t337 item 1 — a ticket's reviewer is named for the TICKET AND THE ROUND, and
// the cost label's round is read off the same durable ticket counter.
//
// The defect this pins was live: the seat name came from a mint counter that
// bumps past taken names, and `kill()` removes a retiring reviewer's record — so
// round 2 minted `-reviewer-1` again and `reviewRound = n - 1` labelled its spend
// `review-r1`. Measured on t332 (REWORK r1 then ACCEPT r2, both billed r1). The
// two rounds were therefore inseparable in the rollup, which is the exact
// property the comment above the derivation claimed to provide.
//
// The reap is what makes the case real, so the round-2 tests below assert the
// previous record is GONE before spawning round 2. A test that skipped the reap
// would pass against the old code: with round 1's record still present the mint
// loop bumps to -2 and n-1 is 2 by accident.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { matchSeatRole, formatRoster } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');

// Copied, not shared, for the reason review-verdict-ticket.test.js states: these
// assertions are about the NAME, and a shared fixture makes either file's edits
// break the other.
const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

function mkFixture() {
  const home = mkTmpRoot('clodex-rtn-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: {
        instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
        tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false,
      },
    },
  };
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };
  const injected = [];
  const gated = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [SHIPPED_REVIEWER_TEMPLATE] }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const killed = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async () => {};
  // The reap, verbatim from kill()'s own behaviour: a retiring reviewer's record
  // is REMOVED, which is what frees the name for the next mint.
  m.kill = async (name) => { killed.push(name); persistence.remove(name); m.sessions.delete(name); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, tstore, persistence, injected, gated, killed, seat,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
  };
}

function openTicket(f, body = 'the spec') {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body });
  // Dispatch refuses a ticket whose spec names no `tasks/…` path, and these
  // bodies deliberately carry none — stamped on the record so the bodies stay
  // the subject. Without it `start` is silently refused and every helper below
  // reasons about a ticket that was never dispatched.
  {
    const all = f.tstore.load(f.team.root);
    for (const x of all) if (!x.taskDir) x.taskDir = `tasks/${x.id}-fixture/SPEC.md`;
    f.tstore.save(f.team.root, all);
  }
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', id: 't1', who: null, body: '' });
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket exists on the board');
  assert.ok(t.startedAt, 'ENTER: start really dispatched it — `add` alone satisfies the check above');
  f.gated.length = 0;
  return t;
}

function spawnReviewer(f, scope, opts) {
  const before = new Set(f.persistence.list().map((e) => e.name));
  f.m._handleTeamReview(f.seat('lead'), scope, opts);
  const rec = f.persistence.list().find((e) => !before.has(e.name));
  assert.ok(rec, 'ENTER: the reviewer seat was reserved — otherwise there is no name to assert about');
  f.seat(rec.name);
  return rec;
}

// ── the name ───────────────────────────────────────────────────────────────

test('a ticket review names its seat for the ticket and the round', () => {
  const f = mkFixture();
  openTicket(f);
  const rec = spawnReviewer(f, 'review the diff', { ticketId: 't1' });

  assert.strictEqual(rec.name, 'team-reviewer-1-r1',
    'the seat name must carry the ticket and round, or a watchdog cannot address one review');
});

test('an ad-hoc review keeps the counter name — it has no ticket to scope to', () => {
  const f = mkFixture();
  const rec = spawnReviewer(f, 'review the boot-race fix');

  assert.strictEqual(rec.name, 'team-reviewer-1');
});

test('a scoped name is not derived from a ticket id merely NAMED in the scope', () => {
  const f = mkFixture();
  openTicket(f);
  // Same rule the reviewTicket seed follows: the route is the caller's explicit
  // claim. A name sniffed from prose would address a review of a ticket nobody
  // opened a round on.
  const rec = spawnReviewer(f, 'is the approach in t1 sound?');

  assert.strictEqual(rec.name, 'team-reviewer-1');
});

// ── the falsification: round 2 after round 1's record was reaped ────────────

test('round 2 after the reap is named r2 and LABELLED r2, not r1', async () => {
  const f = mkFixture();
  openTicket(f);

  const r1 = spawnReviewer(f, 'round one', { ticketId: 't1' });
  assert.strictEqual(r1.name, 'team-reviewer-1-r1', 'ENTER: round 1 is the scoped name');
  assert.strictEqual(r1.wireLabel, 'team.t1.review-r1', 'ENTER: round 1 is labelled r1');

  await f.m._handleReviewDone(f.m.sessions.get(r1.name), 'VERDICT: REWORK\nMUST-FIX: the guard is inverted');

  // The reap is the whole point of this test: with round 1's record still on the
  // books the old mint loop bumps to -2 and n-1 is 2 by accident, so the defect
  // hides. Assert it is genuinely gone before round 2 spawns.
  assert.strictEqual(f.persistence.get('team-reviewer-1-r1'), null,
    'ENTER: kill() removed round 1\'s record — the name is free again');
  assert.strictEqual(f.one('t1').reviewRound, 1, 'ENTER: the durable counter stands at 1');

  const r2 = spawnReviewer(f, 'round two', { ticketId: 't1' });

  assert.strictEqual(r2.name, 'team-reviewer-1-r2',
    'a name derived from the mint index would recycle -reviewer-1 here');
  assert.strictEqual(r2.wireLabel, 'team.t1.review-r2',
    'a round derived from the mint index would bill round 2 to round 1 — measured on t332');
});

test('the label round comes from the ticket, so it does not depend on the seat index', async () => {
  const f = mkFixture();
  openTicket(f);

  // Two rounds landed before this one, exactly as a twice-reworked ticket
  // arrives. The mint index is 1 regardless — nothing else is on the books.
  const a = spawnReviewer(f, 'r1', { ticketId: 't1' });
  await f.m._handleReviewDone(f.m.sessions.get(a.name), 'VERDICT: REWORK\nMUST-FIX: one');
  const b = spawnReviewer(f, 'r2', { ticketId: 't1' });
  await f.m._handleReviewDone(f.m.sessions.get(b.name), 'VERDICT: REWORK\nMUST-FIX: two');
  assert.strictEqual(f.one('t1').reviewRound, 2, 'ENTER: two rounds have landed');

  const c = spawnReviewer(f, 'r3', { ticketId: 't1' });
  assert.strictEqual(c.name, 'team-reviewer-1-r3');
  assert.strictEqual(c.wireLabel, 'team.t1.review-r3');
});

test('a taken scoped name falls back to the counter rather than stranding the ticket', () => {
  const f = mkFixture();
  openTicket(f);
  // A live seat already holding round 1's name — a re-review of a round whose
  // verdict has not landed. The loop has no way to act on a refusal here, so the
  // spawn must still happen.
  f.seat('team-reviewer-1-r1');

  const rec = spawnReviewer(f, 'review the diff', { ticketId: 't1' });

  assert.strictEqual(rec.name, 'team-reviewer-1',
    'the fallback is the counter name, and it must still be reserved');
  assert.strictEqual(rec.reviewTicket, 't1',
    'the verdict route survives the fallback — the name changed, not the ticket link');
});

// ── the name stays LEGIBLE to the team machinery ───────────────────────────
//
// The property item 1 actually buys is a watchdoggable seat, and a name is only
// watchdoggable if `matchSeatRole` can decompose it: it is the sole decomposer,
// and every consumer (the roster, the seat's own team block, the fail-CLOSED
// _roleInUse guard) resolves through it. A name it returns null for is WORSE
// than the recycled counter name — the seat is addressable but the roster denies
// a reviewer is running. The first draft of this change shipped exactly that
// name and 700 green tests missed it, because nothing here called the decomposer.

const roleTeam = () => ({
  name: 'shop', lead: 'boss',
  roles: {
    lead: { template: null, prompt: null, brief: null, dispatch: 'standing' },
    hand: { template: null, prompt: null, brief: null, dispatch: 'standing' },
    reviewer: { template: 'sonnet-review', prompt: null, brief: null, dispatch: 'standing' },
  },
});

test('a ticket-scoped reviewer name decomposes to the reviewer role', () => {
  const team = roleTeam();

  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-r2'), 'reviewer',
    'a name the decomposer cannot read spawns a ROLE-LESS reviewer');
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-1-r1'), 'reviewer');
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-r10'), 'reviewer');

  // The `-rN` strip must not become a general lettered-tail escape: a
  // non-numeric tail names a different thing and resolution must not guess.
  assert.strictEqual(matchSeatRole(team, 'shop-reviewer-337-rx'), null);
  assert.strictEqual(matchSeatRole(team, 'shop-hand-wire'), null);
  // And it must not resolve a name that is ONLY the round.
  assert.strictEqual(matchSeatRole(team, 'shop-r1'), null);
});

test('a live ticket-scoped reviewer files under the reviewer row, not "no role"', () => {
  const team = roleTeam();
  const roster = formatRoster(team, [{ name: 'shop-reviewer-337-r1', label: 'working' }], { seat: 'boss' });

  assert.match(roster, /- reviewer \([^)]*\)[^\n]* · live: shop-reviewer-337-r1 \(working\)/,
    'the roster is the only listing a watchdog reads to find the seat');
  assert.ok(!/also live, no role/.test(roster),
    'a role-less bucket here means the roster is denying a reviewer is running');
});

// ── the constraint: the seed and the route are unchanged ───────────────────

test('the scoped name does not disturb the rest of the reservation', () => {
  const f = mkFixture();
  openTicket(f);
  const rec = spawnReviewer(f, 'review the diff', { ticketId: 't1' });

  // Whole-object, per CLAUDE.md: a field-by-field match reads around a seed the
  // rename dropped, and losing reviewFor would make review-done reject the seat.
  assert.deepStrictEqual(rec, {
    name: 'team-reviewer-1-r1', ephemeral: true, reviewFor: 'lead', reviewTicket: 't1',
    wireLabel: 'team.t1.review-r1',
    // t673: which template reviewed, so the review cost row can name the arm of
    // the A/B this round belongs to. Written even when it is the default — the
    // row must say what SPAWNED, not what was overridden.
    reviewerTemplate: 'clodex-team-reviewer',
  });
});
