'use strict';
// Run: node --test test/review-cost-durable.test.js
//
// t479 — review spend must be attributable per ticket and per ROUND, and must
// survive the reviewer seat's teardown.
//
// The defect this file pins is a JOIN, not a missing report. Two halves existed
// and never met:
//
//   - `reviewWireLabelFor` writes `<team>.<ticket>.review-rN` onto the reviewer
//     seat's PERSISTENCE RECORD, which also carries its sessionIds;
//   - `wire-totals.json` holds the money, keyed by sessionId, with no label and
//     no agent name in the row.
//
// The record is the only thing joining them, and `_handleReviewDone` kills the
// seat — dropping that record — on both of its arms, with
// `sweepReviewerGraveyard` behind it as a second reaper. So the label and the
// cost never coexisted anywhere on disk and no aggregation over them was
// possible, then or later.
//
// EVERY subject here therefore runs the teardown and asserts AFTERWARDS. A read
// taken while the seat is still live proves nothing at all: that read succeeded
// before this ticket too. `assertReaped` is the gate each one goes through, and
// it asserts the record and the session are BOTH gone — a fixture whose kill
// stub forgot one would otherwise let every assertion below pass against a seat
// that was never actually torn down.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');
const clodexPaths = require('../clodex-paths');
const teamCost = require('../team-cost');
const { intentEnabled } = require('../intent-catalog');

const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {},
};

function mkFixture(extra = {}) {
  const home = mkTmpRoot('clodex-rcost-');
  const userData = mkTmpRoot('clodex-rcost-ud-');
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
    setSessionId: () => {},
    setArchived: () => {},
  };
  const injected = [];
  const gated = [];
  const logs = [];
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
    // The real one, because _reviewLedger reads `wire-totals.json` out of it and
    // the whole subject is which bytes it found there.
    getUserDataPath: () => userData,
    AGENT_NAME_RE: require('../catalogs').AGENT_NAME_RE,
    DEFAULT_WORKSPACE_ID: require('../catalogs').DEFAULT_WORKSPACE_ID,
    log: {
      info: (tag, msg) => logs.push({ level: 'info', tag, msg }),
      warn: (tag, msg) => logs.push({ level: 'warn', tag, msg }),
      error: (tag, msg) => logs.push({ level: 'error', tag, msg }),
      debug: () => {},
    },
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    ...extra,
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
  m._reconcileTickets = () => {};
  m._queueAutoMerge = () => {};
  m.create = async () => {};
  // Stubbed because the real kill() SIGKILLs a pid and these seats carry a fake
  // one. The STATE it leaves is what every assertion reads, so a teardown that
  // reaped the wrong name cannot pass by having merely been called.
  //
  // The record removal is kill()'s own synchronous effect; dropping the session
  // from the map is NOT — that happens on pty exit, in _cleanup. This stub
  // collapses the two because the subject is the join key's lifetime and the
  // record is the join key. Do not read it as a model of kill()'s timing.
  m.kill = async (name) => { killed.push(name); persistence.remove(name); m.sessions.delete(name); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, userData, tstore, persistence, injected, gated, logs, killed, seat,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
    taskDir: (id) => pathReal.join(clodexPaths.projectDirFor(home, team.root), 'tasks', `${id}-fixture`),
  };
}

// A ticket sitting at the review step, written straight onto the board: the
// subject is the transition OUT of a review, and driving `_taskDone` to get in
// would fire the whole loop (real git, a real suite run).
function reviewingTicket(f, id = 't1') {
  f.seat('lead');
  f.tstore.save(f.team.root, [{
    id, state: 'done', spec: `spec for ${id}`, assignee: 'team-hand', role: 'hand',
    taskDir: pathReal.join(clodexPaths.projectDirFor(f.home, f.team.root), 'tasks', `${id}-fixture`, 'SPEC.md'),
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand',
    lastActivityAt: 2, loopStep: 'review',
    worktree: { branch: 'landed' },
  }]);
  return f.one(id);
}

// Spawn a reviewer the way a lead does, then give it the session identity a real
// one acquires on its first main-line turn. The name is READ back off the record
// rather than assumed: the mint loop bumps on collision, and a hardcoded name
// would make round 2's assertions address round 1's seat.
function spawnReviewer(f, ticketId, sessionId) {
  const before = new Set(f.persistence.list().map((e) => e.name));
  f.m._handleTeamReview(f.m.sessions.get('lead'), `review the diff for ${ticketId}`, { ticketId });
  const rec = f.persistence.list().find((e) => !before.has(e.name));
  assert.ok(rec, 'ENTER: a reviewer seat was reserved — otherwise there is no record to join by');
  assert.ok(rec.wireLabel, 'ENTER: the seat carries the wire label; it is one half of the join this file is about');
  if (sessionId) f.persistence.upsert({ name: rec.name, sessionId });
  const s = f.seat(rec.name);
  s.sessionId = sessionId || null;
  return f.persistence.get(rec.name);
}

// The persisted ledger, written as wire-telemetry's `_save` writes it.
function writeTotals(f, sessions) {
  fsReal.writeFileSync(pathReal.join(f.userData, 'wire-totals.json'),
    JSON.stringify({ version: 1, sessions }));
}

const row = (over = {}) => ({
  cost: 1.25, requests: 40, turns: 12, refusals: 0,
  inputTokens: 3000, outputTokens: 900, cacheReadTokens: 60000, cacheWriteTokens: 4000,
  ts: Date.now(), ...over,
});

// THE gate. Every subject calls it before reading anything, because a read taken
// against a live seat is exactly the read that already worked.
function assertReaped(f, seatName) {
  assert.strictEqual(f.persistence.get(seatName), null,
    'ENTER: the reviewer record is GONE — this is the teardown the whole finding is about');
  assert.strictEqual(f.m.sessions.get(seatName), undefined,
    'ENTER: the reviewer session is GONE too — a half teardown would leave a live join key');
}

const readRows = (f, id) => {
  const file = pathReal.join(f.taskDir(id), teamCost.REVIEW_COST_FILE);
  if (!fsReal.existsSync(file)) return null;
  return fsReal.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// ── the property ───────────────────────────────────────────────────────────

test('a review\'s cost is readable from the ticket AFTER the reviewer seat is reaped', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row() });

  // The join key, demonstrated to exist BEFORE the teardown — otherwise the
  // absence asserted right after is equally true of a seat that never had one.
  assert.deepStrictEqual(
    require('../session-info').trackedSessionIds(f.persistence.get(rec.name)), ['sess-r1'],
    'ENTER: the record maps this seat to the session the money is filed under');

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: REWORK\n\nMUST-FIX\n- the guard is inverted');

  assertReaped(f, rec.name);

  const rows = readRows(f, 't1');
  assert.ok(rows, 'the review cost file exists after the seat is gone');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].usd, 1.25, 'the money survived the seat that spent it');
  assert.strictEqual(rows[0].ticket, 't1');
  assert.strictEqual(rows[0].round, 1);
  assert.strictEqual(rows[0].seat, rec.name);
  assert.strictEqual(rows[0].verdict, 'REWORK');
  assert.strictEqual(rows[0].mustFix, 1);
  assert.strictEqual(rows[0].wireLabel, rec.wireLabel, 'the label rides the row, which is the join the wire ledger lacks');
  assert.deepStrictEqual(rows[0].sessions.ids, ['sess-r1']);
  assert.strictEqual(rows[0].sessions.resolved, true);
});

test('the OLD route is genuinely dead after teardown — the file is the only surviving path', async () => {
  // The negative half of the subject above. Without it, that test passes on a
  // system where the record still exists and nothing was actually fixed.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 2 }) });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  // The ledger file still holds the money — it was never the missing half.
  const totals = JSON.parse(fsReal.readFileSync(pathReal.join(f.userData, 'wire-totals.json'), 'utf8'));
  assert.strictEqual(totals.sessions['sess-r1'].cost, 2, 'the cost is still on disk, keyed by session');
  // And it is unattributable from there: no label, no agent name, no ticket.
  assert.deepStrictEqual(
    Object.keys(totals.sessions['sess-r1']).filter((k) => /label|agent|ticket|round/i.test(k)), [],
    'the wire row carries nothing that names the reviewer, its ticket or its round — that is the finding');
  // Nothing on the board recovers it either: the ticket never held a session id.
  assert.ok(!JSON.stringify(f.one('t1')).includes('sess-r1'),
    'the ticket record does not carry the session id, so the board cannot join either');

  assert.strictEqual(readRows(f, 't1')[0].usd, 2, 'only the artifact this ticket adds can answer');
});

test('rounds ACCUMULATE — round 2 does not clobber round 1', async () => {
  const f = mkFixture();
  reviewingTicket(f);

  const r1 = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 1 }) });
  await f.m._handleReviewDone(f.m.sessions.get(r1.name), 'VERDICT: REWORK\n\nMUST-FIX\n- a\n- b');
  assertReaped(f, r1.name);

  // The ticket goes back through a round the way the loop does: the verdict
  // stamped reviewRound=1, and the seat is gone, so the next spawn is round 2.
  const t = f.one('t1');
  t.loopStep = 'review';
  f.tstore.save(f.team.root, [t]);

  const r2 = spawnReviewer(f, 't1', 'sess-r2');
  assert.notStrictEqual(r2.name, r1.name, 'ENTER: round 2 is a DIFFERENT seat — the rounds are separable at all');
  writeTotals(f, { 'sess-r1': row({ cost: 1 }), 'sess-r2': row({ cost: 3 }) });
  await f.m._handleReviewDone(f.m.sessions.get(r2.name), 'VERDICT: ACCEPT');
  assertReaped(f, r2.name);

  const rows = readRows(f, 't1');
  assert.strictEqual(rows.length, 2, 'both rounds are on file — an overwriting writer would leave one');
  assert.deepStrictEqual(rows.map((r) => r.round), [1, 2]);
  assert.deepStrictEqual(rows.map((r) => r.usd), [1, 3],
    'each round carries its OWN spend; a shared key would have round 2 report round 1\'s number');
  assert.deepStrictEqual(rows.map((r) => r.verdict), ['REWORK', 'ACCEPT']);
  assert.deepStrictEqual(rows.map((r) => r.mustFix), [2, 0]);
  assert.notStrictEqual(rows[0].wireLabel, rows[1].wireLabel,
    'the labels differ by round — this is what made round 2 unmeasurable when they collided');
});

test('the in-process ledger overrides the debounced file for the CURRENT session', async () => {
  // wire-totals.json is written on a 1s debounce, and this handler runs inside
  // the intent of the reviewer's LAST turn — so the file is always missing that
  // turn, which is the verdict itself and the most expensive one.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 1, requests: 10, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }) });
  f.m._wireTelemetry = {
    payload: () => ({
      sessionId: 'sess-r1', cost: { usd: 4.5, requests: 44 }, turns: 20, refusals: 1,
      tokens: { input: 5000, output: 1500, cacheRead: 90000, cacheWrite: 7000 },
    }),
  };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.usd, 4.5, 'the fresher in-process figure won, not the stale file\'s 1');
  assert.strictEqual(r.requests, 44);
  assert.strictEqual(r.turns, 20);
  assert.strictEqual(r.refusals, 1);
  // The payload nests cost under `cost.usd` and tokens under `tokens.input`,
  // while sumSessions reads a flat wire-totals ROW. Handing the payload straight
  // in reads every field as absent and contributes a silent zero, so these pin
  // that the conversion happened rather than that a value merely changed.
  assert.deepStrictEqual(r.tokens, {
    input: 5000, output: 1500, cacheRead: 90000, cacheWrite: 7000,
    cachedFraction: teamCost.cachedFraction({ inputTokens: 5000, cacheReadTokens: 90000, cacheWriteTokens: 7000 }),
  });
});

test('the capture runs while the seat is still resolvable BY NAME', async () => {
  // The ordering claim, pinned on the mechanism rather than on a clock. Merely
  // deferring the capture still finds the artifact if you wait — the ticket's
  // task dir does not move. What DOES die at teardown is name resolution: both
  // `_wireTelemetry.payload(name)` (a map `prune()` clears for names absent from
  // `sessions`) and `getPersistence().get(name)`. A capture that ran after the
  // reap would read a pruned telemetry map and silently fall back to the stale
  // debounced file, which is a wrong number rather than a missing one.
  //
  // So: the telemetry double answers ONLY while the session is in the map, the
  // way the real prune behaves. The overlay's figure appearing in the row is
  // proof the read happened before the kill.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 1 }) });
  const probed = [];
  f.m._wireTelemetry = {
    payload: (name) => {
      const live = f.m.sessions.has(name);
      probed.push({ name, live });
      if (!live) return null; // pruned, exactly as the poller would leave it
      return {
        sessionId: 'sess-r1', cost: { usd: 7, requests: 70 }, turns: 7, refusals: 0,
        tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      };
    },
  };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');

  assert.deepStrictEqual(probed, [{ name: rec.name, live: true }],
    'the ledger was read exactly once, while the seat was still in the sessions map');
  assertReaped(f, rec.name);
  assert.strictEqual(readRows(f, 't1')[0].usd, 7,
    'the overlay figure landed — a post-reap capture would have banked the stale 1 instead');
});

test('a wire payload for a DIFFERENT session is not applied', async () => {
  // The counter-named fallback seat (`<team>-reviewer-<n>`) is reused across
  // rounds, and _wireTelemetry's per-name map is pruned on poller ticks rather
  // than at kill — so an ungated overlay can bill a dead round's ledger to a
  // live seat holding the same name.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 1 }) });
  f.m._wireTelemetry = {
    payload: () => ({
      sessionId: 'sess-SOMEONE-ELSE', cost: { usd: 999, requests: 1 }, turns: 1, refusals: 0,
      tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    }),
  };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  assert.strictEqual(readRows(f, 't1')[0].usd, 1, 'the mismatched payload was ignored; the file answered');
});

test('a payload whose cost the wire never observed does not DISCARD the recorded row', async () => {
  // sumSessions REPLACES the file's row with the overlay rather than adding to
  // it, and wire-telemetry's `_lifetime` yields `cost: null` when it had neither
  // a persisted base nor a turn snapshot — on a payload that still carries the
  // matching sessionId. Applied, that null does not merely fail to freshen the
  // figure: it drops a real recorded spend and republishes it as zero.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 4.2, requests: 40, turns: 12 }) });
  const nulled = {
    sessionId: 'sess-r1', cost: { usd: null, requests: null }, turns: null, refusals: 0,
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
  };
  f.m._wireTelemetry = { payload: () => nulled };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.usd, 4.2, 'the recorded spend survived; an applied null overlay publishes 0 here');
  assert.strictEqual(r.requests, 40);
  assert.strictEqual(r.turns, 12);
  assert.strictEqual(r.sessions.resolved, true, 'the file answered, so the round IS priced');

  // ENTER: this fixture's payload really does clear the `sessionId === currentId`
  // gate. Same seat, same ids, cost swapped for a number — it overrides. Without
  // this the test above passes on a fixture that never reached the branch at all,
  // which is the shape that tests nothing.
  const g = mkFixture();
  reviewingTicket(g);
  const grec = spawnReviewer(g, 't1', 'sess-r1');
  writeTotals(g, { 'sess-r1': row({ cost: 4.2, requests: 40, turns: 12 }) });
  g.m._wireTelemetry = { payload: () => ({ ...nulled, cost: { usd: 9.5, requests: 95 }, turns: 30 }) };
  await g.m._handleReviewDone(g.m.sessions.get(grec.name), 'VERDICT: ACCEPT');
  assert.strictEqual(readRows(g, 't1')[0].usd, 9.5,
    'ENTER: the overlay branch is reachable with these ids — so the 4.2 above is the cost check, not a missed gate');
});

test('a NaN cost is not applied either', async () => {
  // The same discard through a narrower door. NaN passes `typeof === "number"`,
  // and num() then coerces it to 0 while `known` still increments — so an
  // applied NaN overlay publishes a confident zero for a spend that was
  // recorded, which is the false-zero-with-resolved-true the null case above
  // removed. Number.isFinite is what closes it, and it matches num()'s own rule.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 4.2, requests: 40, turns: 12 }) });
  f.m._wireTelemetry = {
    payload: () => ({
      sessionId: 'sess-r1', cost: { usd: NaN, requests: NaN }, turns: NaN, refusals: 0,
      tokens: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
    }),
  };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.usd, 4.2, 'the recorded spend survived; an applied NaN overlay publishes 0 here');
  assert.strictEqual(r.requests, 40);
  assert.strictEqual(r.turns, 12);
  assert.strictEqual(r.sessions.resolved, true, 'the file answered, so the round IS priced');
});

// ── the honest-absence half ────────────────────────────────────────────────

test('a reviewer with NO findable ledger reports null, never a false zero', async () => {
  // A Codex reviewer, or one killed before its first main-line turn: no wire row
  // exists. Zero would be indistinguishable from a free review, and a consumer
  // averaging those would report review spend as cheaper than it is.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'some-other-session': row() });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.sessions.resolved, false);
  assert.strictEqual(r.usd, null, 'unknown, NOT zero');
  assert.strictEqual(r.requests, null);
  assert.strictEqual(r.turns, null);
  assert.deepStrictEqual(r.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, cachedFraction: null });
  // The row is still WRITTEN: that the round happened and could not be priced is
  // itself the measurement. A skipped row would read as a round that never ran.
  assert.strictEqual(r.round, 1);
  assert.strictEqual(r.seat, rec.name);
});

test('a seat whose wire saw NO cost and whose file has no row publishes null, not zero', async () => {
  // The other half of the same defect. Here there is nothing to discard, but the
  // null-cost payload is still a truthy row: applied, it increments `known`, so
  // `resolved` goes TRUE and every measured field publishes a confident 0 for a
  // review whose spend is simply unknown.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'some-other-session': row() });
  const nulled = {
    sessionId: 'sess-r1', cost: { usd: null, requests: null }, turns: null, refusals: 0,
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
  };
  f.m._wireTelemetry = { payload: () => nulled };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.sessions.resolved, false, 'no ledger was found — an applied null overlay reports true');
  assert.strictEqual(r.sessions.known, 0, 'and the id is not counted as answered');
  assert.strictEqual(r.usd, null, 'unknown, NOT zero');
  assert.strictEqual(r.requests, null);
  assert.strictEqual(r.turns, null);
  assert.deepStrictEqual(r.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, cachedFraction: null });

  // ENTER: the absence above is the cost check, not a fixture that missed the
  // id gate — which would assert the same `resolved: false` with no gate at
  // all, there being no file row here either. Same ids, cost swapped for a
  // number: it overrides, and the round prices off the overlay alone.
  const g = mkFixture();
  reviewingTicket(g);
  const grec = spawnReviewer(g, 't1', 'sess-r1');
  writeTotals(g, { 'some-other-session': row() });
  g.m._wireTelemetry = { payload: () => ({ ...nulled, cost: { usd: 3.5, requests: 20 }, turns: 6 }) };
  await g.m._handleReviewDone(g.m.sessions.get(grec.name), 'VERDICT: ACCEPT');
  const gr = readRows(g, 't1')[0];
  assert.strictEqual(gr.usd, 3.5,
    'ENTER: the overlay branch is reachable with these ids — so the null above was refused, not missed');
  assert.strictEqual(gr.sessions.resolved, true, 'ENTER: and an applied overlay does resolve the round');
});

test('an UNPARSED verdict still books its round — the seat is reaped either way', async () => {
  // The fall-through arm: the verdict names neither ACCEPT nor REWORK, so
  // nothing lands on the ticket and the prose goes to the lead. The seat is
  // killed all the same, so skipping the capture here would make the ledger
  // cheapest exactly where the loop is least efficient.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 5 }) });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'I have some thoughts but no verdict line');

  assert.strictEqual(f.one('t1').verdict, undefined, 'ENTER: nothing landed on the ticket — this IS the fall-through arm');
  assert.strictEqual(f.gated.length, 1, 'ENTER: the prose went to the lead instead');
  assertReaped(f, rec.name);

  const r = readRows(f, 't1')[0];
  assert.strictEqual(r.usd, 5, 'the round was priced even though its verdict was unusable');
  assert.strictEqual(r.verdict, null, 'and it is recorded as having produced no verdict, not as an ACCEPT');
  assert.strictEqual(r.mustFix, null);
  // The counter never bumped, so a raw read of `reviewRound` would file this
  // round's spend under the previous round's number.
  assert.strictEqual(r.round, 1);
});

// ── the booking is bound to the reap, not to the handler ───────────────────

test('an undeliverable verdict books NOTHING while the seat stays live', async () => {
  // `_gatedDeliver` failing returns without killing and tells the reviewer to
  // re-fire. Nothing is destroyed, so nothing needs booking yet — and booking
  // here is what makes the re-fire below double-count.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 3 }) });
  f.m._gatedDeliver = () => ({ error: 'lead unreachable' });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'thoughts, but no verdict line');

  assert.ok(f.persistence.get(rec.name), 'ENTER: the seat is STILL LIVE — this is the arm that does not kill');
  assert.strictEqual(readRows(f, 't1'), null,
    'nothing booked: the join key is intact, so the round can still be priced later');
});

test('a re-fired review-done books the round exactly ONCE', async () => {
  // The double-book. The handler instructs the reviewer to re-fire, and on the
  // re-fire `landedOn` is still null and the round recomputes identically — so a
  // booking taken up front appends a second row and a consumer summing `usd`
  // reads this ticket's review at ~2x.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 3 }) });

  f.m._gatedDeliver = () => ({ error: 'lead unreachable' });
  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'thoughts, but no verdict line');
  assert.ok(f.persistence.get(rec.name), 'ENTER: the first fire left the seat live, as its reply promised');

  // The lead comes back and the reviewer does what it was told to do.
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { queued: true }; };
  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'thoughts, but no verdict line');

  assertReaped(f, rec.name);
  const rows = readRows(f, 't1');
  assert.strictEqual(rows.length, 1, 'ONE row for one review — two would report this round at double its cost');
  assert.strictEqual(rows[0].usd, 3);
  assert.strictEqual(rows[0].round, 1);
});

test('an ad-hoc review writes nothing — there is no ticket to attribute it to', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  f.m._handleTeamReview(f.m.sessions.get('lead'), 'is the boot race fix sound?');
  const rec = f.persistence.list().find((e) => e.ephemeral && !e.reviewTicket);
  assert.ok(rec, 'ENTER: an ad-hoc reviewer seat exists and carries NO reviewTicket');
  f.seat(rec.name);
  writeTotals(f, { 'whatever': row() });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assertReaped(f, rec.name);

  assert.strictEqual(readRows(f, 't1'), null,
    'no ticket claimed this spend, and inventing one would bill a real ticket for a review it never had');
});

// ── the round the LEAD ends ────────────────────────────────────────────────

test('a round the lead ends is booked before its seat is reaped', async () => {
  // `_retireReviewSeatsFor` is the second teardown: reject/accept end the round
  // and kill the seat without any verdict ever landing. These are the wedged and
  // abandoned rounds — the expensive ones — so a ledger that skipped them would
  // be biased exactly against the cases it exists to find.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 6 }) });
  assert.deepStrictEqual(f.m._liveReviewSeatsFor(f.team, 't1').map((s) => s.name), [rec.name],
    'ENTER: the seat is findable as this ticket\'s reviewer — every absence below is otherwise vacuous');

  f.m._retireReviewSeatsFor(f.team, 't1', 'rejected');

  assertReaped(f, rec.name);
  const rows = readRows(f, 't1');
  assert.ok(rows, 'the round was priced even though nobody ever delivered a verdict');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].usd, 6);
  assert.strictEqual(rows[0].round, 1, 'reviewRound never moved, so this round is its value plus one');
  assert.strictEqual(rows[0].verdict, null, 'no verdict existed — recorded as absent, not invented');
  assert.strictEqual(rows[0].mustFix, null);
  assert.strictEqual(rows[0].seat, rec.name);
});

test('two seats on one round produce two distinguishable rows', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  const a = spawnReviewer(f, 't1', 'sess-a');
  const b = spawnReviewer(f, 't1', 'sess-b');
  assert.notStrictEqual(a.name, b.name, 'ENTER: two distinct seats hold the same round');
  writeTotals(f, { 'sess-a': row({ cost: 2 }), 'sess-b': row({ cost: 5 }) });

  f.m._retireReviewSeatsFor(f.team, 't1', 'accepted');

  assertReaped(f, a.name);
  assertReaped(f, b.name);
  const rows = readRows(f, 't1');
  assert.strictEqual(rows.length, 2, 'each seat is priced — collapsing them would lose one seat\'s spend');
  assert.deepStrictEqual(rows.map((r) => r.seat).sort(), [a.name, b.name].sort());
  assert.deepStrictEqual(rows.map((r) => r.usd).sort(), [2, 5]);
  assert.deepStrictEqual([...new Set(rows.map((r) => r.round))], [1],
    'both are round 1 — honest, and the seat name is what separates them');
});

test('no round can be booked by BOTH teardown paths', async () => {
  // The interaction between the two fixes: a seat review-done already reaped must
  // not be returned to the retire path and booked a second time.
  //
  // The RECORD is what has to carry that, and this subject exists to prove it
  // does. `_liveReviewSeatsFor` walks `this.sessions.values()` FIRST and only
  // then consults `getPersistence().get`, so a fixture whose kill drops the
  // session short-circuits before the record check is ever reached — the
  // emptiness would then be produced by the session deletion, and deleting the
  // record check from the production function would leave this green while every
  // accepted ticket double-books.
  //
  // So kill is overridden here to do what the REAL one does and nothing more:
  // remove the record, leave the session in the map (production defers that to
  // _cleanup on pty exit). The seat therefore survives the `sessions` walk and
  // only the record check can exclude it, which is the claim.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 4 }) });
  f.m.kill = async (name) => { f.killed.push(name); f.persistence.remove(name); };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');
  assert.strictEqual(readRows(f, 't1').length, 1, 'ENTER: review-done booked the round');
  assert.ok(f.m.sessions.get(rec.name),
    'ENTER: the session is STILL in the map, as after a real kill() — so the walk cannot be what excludes it');
  assert.strictEqual(f.persistence.get(rec.name), null,
    'ENTER: and the record is gone, which is the only remaining thing that can');

  assert.deepStrictEqual(f.m._liveReviewSeatsFor(f.team, 't1'), [],
    'the reaped seat is not findable — excluded by the record check, on a session the walk still yields');
  f.m._retireReviewSeatsFor(f.team, 't1', 'accepted');

  assert.strictEqual(readRows(f, 't1').length, 1, 'still ONE row — the second path found nothing to book');
});

test('a reviewer retired BY HAND is booked before destroy()', async () => {
  // The third teardown. `[agent:team-retire]` resolves a reviewer as `discard`
  // off `rec.ephemeral` and calls destroy(), which drops the record — and by
  // hand is how a WEDGED reviewer usually dies, so this route sees exactly the
  // expensive rounds the ledger most needs.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row({ cost: 9 }) });
  const destroyed = [];
  f.m.destroy = async (name) => { destroyed.push(name); f.persistence.remove(name); f.m.sessions.delete(name); return {}; };
  f.m.archive = async () => ({});
  f.m._stampTicketRevival = () => {};

  await f.m._handleTeamRetire(rec.name, 'lead');

  assert.deepStrictEqual(destroyed, [rec.name],
    'ENTER: the retire took the DISCARD arm — an archive would keep the record and book nothing');
  assertReaped(f, rec.name);
  const rows = readRows(f, 't1');
  assert.ok(rows, 'the hand-retired round was priced');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].usd, 9);
  assert.strictEqual(rows[0].round, 1);
  assert.strictEqual(rows[0].verdict, null, 'a hand-retired seat produced no verdict');
  assert.strictEqual(rows[0].seat, rec.name);
});

test('a hand-retired HAND is not booked — only reviewers carry a review round', async () => {
  // Ticket seats are ephemeral too, so `ephemeral` alone cannot be what selects
  // a reviewer — booking one would file a hand's whole spend as a review.
  //
  // What actually stops it is DOUBLE: the `rec.reviewTicket` gate, and behind it
  // `_loadTicket(t, undefined)` returning null for a seat that names no review.
  // Widening the gate to `ephemeral` alone leaves this subject green, and that is
  // honest rather than a hole — the second bail is load-bearing on its own. The
  // gate earns its place by making the intent explicit and skipping a pointless
  // board load, not by being the only thing between a hand and a review row.
  const f = mkFixture();
  reviewingTicket(f);
  f.seat('team-hand');
  f.persistence.upsert({ name: 'team-hand', ephemeral: true, sessionId: 'sess-hand', reviewFor: 'lead' });
  writeTotals(f, { 'sess-hand': row({ cost: 50 }) });
  f.m.destroy = async (name) => { f.persistence.remove(name); f.m.sessions.delete(name); return {}; };
  f.m.archive = async () => ({});
  f.m._stampTicketRevival = () => {};
  assert.ok(!f.persistence.get('team-hand').reviewTicket,
    'ENTER: no reviewTicket — this seat held no review round');
  assert.strictEqual(f.persistence.get('team-hand').ephemeral, true,
    'ENTER: but it IS ephemeral, so `ephemeral` alone would have selected it');

  await f.m._handleTeamRetire('team-hand', 'lead');

  assert.strictEqual(readRows(f, 't1'), null,
    'no review row: this seat never held a review round, and its spend is the ticket rollup\'s business');
});

// ── failure is reported, never silent and never fatal ──────────────────────

test('a throwing booking costs neither the verdict nor the seat', async () => {
  // The booking sits between a landed, SAVED verdict and the kill() that retires
  // the seat — the position _landVerdictOnTicket's tail warns about, where an
  // escaping error abandons the handler and leaves a durable verdict with a live
  // reviewer still holding the ticket. Nothing throws there today; this pins that
  // it cannot start to.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row() });
  f.m._writeReviewCost = () => { throw new Error('ledger exploded'); };

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');

  assert.strictEqual(f.one('t1').verdict, 'ACCEPT', 'the verdict was already durable and stays so');
  assertReaped(f, rec.name);
  assert.ok(f.logs.some((l) => l.level === 'error' && /booking threw/.test(l.msg)),
    'and the throw is logged rather than swallowed into a silent no-op');
});

test('a throwing store resolve does not strand the seat it was about to reap', async () => {
  // The booking's own `getPersistence().get` sits ABOVE the kill(), so a throw
  // there would skip the teardown and leave live exactly the seat this function
  // exists to reap — a worse outcome than the unpriced round it was trying to
  // avoid.
  //
  // The throw is armed for the SECOND resolve of this name, not the first:
  // `_liveReviewSeatsFor` resolves the record too, and breaking that one empties
  // the seat list so the loop body never runs. The probe would then pass on a
  // teardown that was never attempted — measuring nothing, which is how this
  // subject failed before it was narrowed.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row() });
  const realGet = f.persistence.get;
  let seen = 0;
  f.persistence.get = (n) => {
    if (n === rec.name) { seen++; if (seen >= 2) throw new Error('store exploded'); }
    return realGet(n);
  };

  f.m._retireReviewSeatsFor(f.team, 't1', 'rejected');

  assert.ok(seen >= 2, 'ENTER: the booking resolve was actually reached — otherwise nothing was tested');
  assert.deepStrictEqual(f.killed, [rec.name],
    'the seat was still reaped: an unpriced round is a loss, a stranded reviewer is a leak');
});

test('an unreadable board on the lead-ended path is logged, not silent', async () => {
  // The `else` arm. Without it an unreadable board is the one way a round leaves
  // the ledger with no trace at all — the review-done path warns on every
  // failure, and a second path that fails quietly is worse than one that fails.
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row() });
  f.m._loadTicket = () => null; // the board will not answer

  f.m._retireReviewSeatsFor(f.team, 't1', 'rejected');

  assert.strictEqual(readRows(f, 't1'), null, 'ENTER: nothing was booked — this is the failing arm');
  assert.ok(f.logs.some((l) => l.level === 'warn' && /review cost not captured/.test(l.msg) && /unrecoverable/.test(l.msg)),
    'the loss is on the record: the seat is about to be reaped and this round can never be priced again');
});

test('an unwritable destination costs the row, not the verdict', async () => {
  const f = mkFixture();
  const t = reviewingTicket(f);
  // A taskDir that escapes the projects root: resolveTaskDir refuses it, which
  // is the same refusal the diff and COST.json take.
  t.taskDir = '../../../../etc/nope';
  f.tstore.save(f.team.root, [t]);
  const rec = spawnReviewer(f, 't1', 'sess-r1');
  writeTotals(f, { 'sess-r1': row() });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');

  assert.strictEqual(f.one('t1').verdict, 'ACCEPT', 'the verdict landed — a rollup never costs the output that matters');
  assertReaped(f, rec.name);
  assert.ok(f.logs.some((l) => l.level === 'warn' && /review cost/.test(l.msg) && /unrecoverable/.test(l.msg)),
    'and the loss is logged: the seat is gone, so this round can never be priced again');
});
