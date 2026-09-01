'use strict';
// Run: node --test test/ticket-rework-reasons.test.js
//
// t618 — every rework reason a lead or the loop sends to a seat lands on the
// ticket record, grouped by the rework round it was sent during.
//
// The defect: the reason was delivered to the seat and persisted NOWHERE, so the
// next review round was built from a record that could not say why the ticket
// reopened. Measured on the live board, that was worse than a gap — a round-2
// scope following an ACCEPT the lead rejected anyway renders the stored `(none)`
// placeholder verbatim, telling the reviewer affirmatively that round 1 found
// nothing blocking, while nothing anywhere says what it was sent back for.
//
// Three reject paths write this and they do NOT agree about the round number,
// deliberately. `_taskReject`'s reopen arm and `_rejectTicketFromLoop` each open
// a round and file under the bumped number; `_taskRejectFollowUp` opens no round
// and files under the one already running. The subjects below assert that
// disagreement as the intended behaviour rather than working around it, because
// a follow-up filed under an invented round would tell the next reviewer it was
// sent back once more than it was.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { appendReworkReason } = require('../tickets-store');
const { ticketInFlight } = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { initStores } = require('../stores');
const { createRemindScheduler } = require('../remind-scheduler');
const { createTeamManifest } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { assertTicketDepsCovered } = require('./lib/loop-fixture-deps');

// Copied rather than shared, for the reason reviewer-round-end.test.js states
// about its own copy: these assertions are about what the reject paths WRITE,
// and a shared fixture makes either file's edits break the other.
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

const SEED_DIR = mkTmpRoot('clodex-t618-seed-');

function mkRepo() {
  const dir = mkTmpRoot('clodex-t618-repo-');
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 'T']);
  fsReal.writeFileSync(pathReal.join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  git(['commit', '-q', '-m', 'base']);
  git(['branch', 'landed']);
  git(['checkout', '-q', '-b', 'pending']);
  fsReal.writeFileSync(pathReal.join(dir, 'work.txt'), 'work\n');
  git(['add', 'work.txt']);
  git(['commit', '-q', '-m', 'work']);
  git(['checkout', '-q', 'master']);
  return dir;
}

function mkFixture() {
  const home = mkTmpRoot('clodex-t618-');
  const userData = mkTmpRoot('clodex-t618-ud-');
  const manifest = createTeamManifest({ fs: fsReal, clodexHome: home });
  const scheduler = createRemindScheduler({
    now: () => Date.now(),
    setTimer: () => null,
    clearTimer: () => {},
    store: initStores(userData, { log: console, registryDir: SEED_DIR }).reminders,
    deliver: () => {},
  });
  const repoDir = mkRepo();
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repoDir, lead: 'lead', watchdogMs: null,
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
    setArchived: (n, archived) => {
      const e = store.find((x) => x.name === n);
      if (e) e.archivedAt = archived ? Date.now() : null;
    },
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };
  const injected = [];
  const gated = [];
  const contextActions = [];
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
    pathFor: require('../clodex-paths').pathFor,
    runDirFor: require('../clodex-paths').runDirFor,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    gitWorktree: require('../git-worktree'),
    childProcess: require('node:child_process'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: {
      info: (tag, msg) => logs.push({ level: 'info', tag, msg }),
      warn: (tag, msg) => logs.push({ level: 'warn', tag, msg }),
      error: (tag, msg) => logs.push({ level: 'error', tag, msg }),
      debug: () => {},
    },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(repoDir) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(repoDir) ? repoDir : null),
    // t581 widened t574's audit to this file. Two of these were REACHED and
    // their absence swallowed:
    //
    //   getRemindScheduler — `_cancelTicketReminders` catches the TypeError into
    //     `sched = null` and returns '', so no accept here ever cancelled a
    //     ticket-bound reminder or rendered the clause reporting it.
    //   DEFAULT_WORKSPACE_ID — `resolveSeatShape` resolves every reviewer spawn's
    //     workspaceId through it, and this fixture's seats carry no workspaceId,
    //     so every spawn resolved `undefined`. Invisible because `create` is a
    //     stub that records nothing.
    //
    // The rest are reached by no subject here. The five manifest verbs go through
    // `loadManifest`, which reads `<home>/teams/team/team.json`; this fixture
    // never writes that file, so a subject reaching one gets `no team manifest
    // at …` and must write it first rather than read the error as a broken verb.
    AGENT_NAME_RE: require('../catalogs').AGENT_NAME_RE,
    DEFAULT_WORKSPACE_ID: require('../catalogs').DEFAULT_WORKSPACE_ID,
    getRemindScheduler: () => scheduler,
    getUserDataPath: () => userData,
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    addRole: manifest.addRole,
    setRole: manifest.setRole,
    removeRole: manifest.removeRole,
    renameRole: manifest.renameRole,
    setTeamWatchdog: manifest.setTeamWatchdog,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const killed = [];
  const archived = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = (name, channel, payload) => contextActions.push({ name, channel, payload });
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m._reconcileTickets = () => {};
  m._advanceSeat = () => null;
  m._writeTicketCost = () => {};
  m.create = async () => {};
  // The reap, verbatim from kill()'s own behaviour: the record is REMOVED and the
  // session drops out of the map. Stubbed rather than real because the real one
  // SIGKILLs a pid, and this fixture's seats carry a fake one — but the STATE it
  // leaves behind is what every assertion below reads, so a teardown that killed
  // the wrong name cannot pass by having been called.
  m.kill = async (name) => { killed.push(name); persistence.remove(name); m.sessions.delete(name); };
  // Stubbed for the same reason kill() is: the real archive() arms a 5s
  // `process.kill(pid, 'SIGKILL')` against this fixture's fake `pid: 1`, which is
  // init.
  m.archive = async (name) => { archived.push(name); persistence.setArchived(name, true); };
  const seat = (name, cwd = repoDir) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, repoDir, tstore, persistence, injected, gated, contextActions, logs, killed, archived, seat, deps,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
  };
}

// The board state a reviewer is spawned from: the hand has closed, the loop has
// verified, and the ticket is `done` at `loopStep: 'review'`.
//
// Written onto the board directly rather than driven through `_taskDone`: that
// verb fires the whole loop — real git, a real suite run — and the subject here
// is the transition OUT of a review round, not the way into one. The ENTER below
// is what makes the shortcut honest.
function reviewingTicket(f, id = 't1') {
  f.seat('lead'); f.seat('team-hand');
  // The seat record the loop stamps on a hand it minted (_spawnTicketSeat), so
  // the board here is the shape the reject paths under test actually run against.
  f.persistence.upsert({ name: 'team-hand', ephemeral: true });
  f.tstore.save(f.team.root, [{
    id, state: 'done', spec: `spec for ${id}`, assignee: 'team-hand', role: 'hand',
    taskDir: `tasks/${id}-fixture/SPEC.md`,
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand',
    lastActivityAt: 2, loopStep: 'review',
    worktree: { branch: 'landed' },
  }]);
  const t = f.one(id);
  assert.ok(ticketInFlight(t), 'ENTER: the ticket is in flight at the review step — the state a reviewer exists in');
  return t;
}

const reject = (f, id, reason = 'the guard is inverted') =>
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'reject', id, who: null, body: reason });

test('mkFixture injects every dep team-tickets.js reads', () => {
  const f = mkFixture();
  assertTicketDepsCovered(assert, f.deps, { optional: ['ticketSuiteTimeoutMs'] });
});

// ── the pair documented as never diverging ─────────────────────────────────

// One subject over BOTH members, driven through a table, so a future edit that
// teaches only one of them to record the reason goes red here. Two separate
// subjects would let the missing one be deleted alone and read as intentional;
// `_rejectTicketFromLoop`'s own header says a change to one belongs in the
// other, and this is what makes that claim checkable.
for (const arm of [
  {
    what: "the lead's reject",
    by: 'lead',
    run: (f) => reject(f, 't1', 'the retry bound is still off by one'),
    reason: 'the retry bound is still off by one',
  },
  {
    what: "the loop's reject",
    by: 'ticket-loop',
    run: (f) => f.m._rejectTicketFromLoop(f.team, 't1', 'SUITE RED: three failures in widget.test.js'),
    reason: 'SUITE RED: three failures in widget.test.js',
  },
]) {
  test(`${arm.what} records its reason on the ticket, attributed and under the round it opens`, () => {
    const f = mkFixture();
    reviewingTicket(f);
    assert.strictEqual(f.one('t1').reworkReasons, undefined,
      'ENTER: nothing on the record before the reject — otherwise this asserts a pre-existing entry');

    arm.run(f);

    const t = f.one('t1');
    assert.strictEqual(t.state, 'open', 'ENTER: the reject actually landed');
    assert.strictEqual(t.reworkRound, 1, 'ENTER: and opened rework round 1');
    assert.strictEqual(Array.isArray(t.reworkReasons) && t.reworkReasons.length, 1,
      'exactly one reason was recorded');
    const e = t.reworkReasons[0];
    // The literal reason per row, not a value this test computes by the rule the
    // code uses: a computed expectation would assert only that the code agrees
    // with itself, and could not express an arm that recorded the wrong text.
    assert.strictEqual(e.reason, arm.reason, 'verbatim, not paraphrased or truncated at rest');
    assert.strictEqual(e.by, arm.by, 'attributed to whoever sent it back');
    assert.strictEqual(e.round, 1, 'filed under the round it OPENED, not the one it ended');
    assert.strictEqual(typeof e.at, 'number', 'and timestamped');
  });
}

// ── append-only: the sequence is the thing a reviewer needs ────────────────

test('a second rework reason never overwrites the first — the record is append-only', () => {
  const f = mkFixture();
  reviewingTicket(f);
  reject(f, 't1', 'round one: the guard is inverted');

  // Back to `done` for a second round, exactly as a rework round ends in
  // production: the hand re-closes and the loop verifies.
  const back = f.tstore.load(f.team.root);
  const t0 = back.find((x) => x.id === 't1');
  t0.state = 'done'; t0.closedAt = 4; t0.closedBy = 'team-hand'; t0.loopStep = 'review';
  f.tstore.save(f.team.root, back);
  assert.ok(ticketInFlight(f.one('t1')), 'ENTER: the ticket is done and in flight again — reject is reachable');

  reject(f, 't1', 'round two: the fix broke the empty case');

  const t = f.one('t1');
  assert.strictEqual(t.reworkRound, 2, 'ENTER: the second reject opened a second round');
  assert.deepStrictEqual(t.reworkReasons.map((r) => [r.round, r.by, r.reason]), [
    [1, 'lead', 'round one: the guard is inverted'],
    [2, 'lead', 'round two: the fix broke the empty case'],
  ], 'both reasons survive, in order, each under its own round');
});

// ── the path that deliberately opens no round ──────────────────────────────

test('a follow-up must-fix files under the round ALREADY open, inventing none', () => {
  const f = mkFixture();
  reviewingTicket(f);
  reject(f, 't1', 'round one: the guard is inverted');

  // The ticket is now `open` with reworkRound 1 — the state `_taskReject` routes
  // to `_taskRejectFollowUp` through.
  reject(f, 't1', 'while you are in there, the empty case too');

  assert.match(f.injected.join('\n'), /already open for rework/,
    'ENTER: the follow-up arm was taken, not a second reopen');
  const t = f.one('t1');
  assert.strictEqual(t.reworkRound, 1, 'ENTER: a follow-up counts no new round');
  assert.deepStrictEqual(t.reworkReasons.map((r) => [r.round, r.reason]), [
    [1, 'round one: the guard is inverted'],
    [1, 'while you are in there, the empty case too'],
  ], 'the follow-up shares round 1 with the reject that opened it — the grouping is what makes it readable');
});

test('a follow-up that never reached the seat records nothing', () => {
  const f = mkFixture();
  reviewingTicket(f);
  reject(f, 't1', 'round one: the guard is inverted');
  const before = f.one('t1').reworkReasons.length;
  f.m._gatedDeliver = () => ({ queued: false, error: 'seat is gone' });

  reject(f, 't1', 'must-fixes nobody will ever read');

  assert.match(f.injected.join('\n'), /did NOT reach/, 'ENTER: the delivery-failure arm was taken');
  assert.strictEqual(f.one('t1').reworkReasons.length, before,
    'the FOLLOW-UP path changes no state, so an undelivered reason leaves no trace either — '
    + 'unlike the two reopening paths, which record whether or not a seat was told');
});

// ── the store helper itself ────────────────────────────────────────────────

test('appendReworkReason ignores an empty reason and never creates the field for one', () => {
  const t = {};
  appendReworkReason(t, { round: 1, by: 'lead', reason: '   ' });
  assert.strictEqual(t.reworkReasons, undefined,
    'an empty reason must not plant an empty array — an absent field is what renders as today');
  appendReworkReason(t, { round: 2, by: 'lead', reason: '  real one  ' });
  assert.deepStrictEqual(t.reworkReasons, [{ round: 2, at: t.reworkReasons[0].at, by: 'lead', reason: 'real one' }]);
});
