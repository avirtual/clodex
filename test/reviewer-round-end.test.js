'use strict';
// Run: node --test test/reviewer-round-end.test.js
//
// t470 — when the LEAD ends a review round, the reviewer seat for that round
// does not outlive it.
//
// The defect this pins was live twice (t378, t355). A reviewer retires ITSELF on
// the normal path — `review-done` fires `session:context-action` retired/discard
// and then kill() — and that was the ONLY teardown. When the lead ended the
// round instead (`task reject` reopens the ticket, `task accept` closes it out),
// nothing retired the seat, so it stayed live still carrying `reviewTicket`.
//
// Why that is not merely untidy: `_landVerdictOnTicket` is guarded by
// `ticketInFlight`, so the stranded seat's verdict cannot land while the ticket
// is open — but the rework round re-closes it to `done` + `loopStep`, and in
// THAT window the stale verdict lands, against a diff that no longer exists, on
// the current round's number.
//
// The opposite arm is asserted here just as hard. `keepHold` escalations
// deliberately keep a reviewer alive because the ticket is STILL IN FLIGHT and
// its verdict may still land; a fix that retired on any round end would break
// them, and without the keepHold subject below it would ship green.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { ticketInFlight } = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

// Copied, not shared, for the reason reviewer-ticket-name.test.js states: these
// assertions are about the seat's LIFETIME, and a shared fixture makes either
// file's edits break the other.
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

// A REAL git repo, for the reason ticket-reminder-binding.test.js gives: the
// accept arms fork on a git fact (merged / not merged / check could not run),
// and a stubbed gitWorktree would let a subject claim to exercise the merged arm
// while taking whichever arm the stub was written to return. `landed` is an
// ancestor of master; `pending` carries a commit master does not have.
function mkRepo() {
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t470-repo-'));
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
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t470-'));
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
  // init. It records the state the not-merged accept arm is asserted on.
  m.archive = async (name) => { archived.push(name); persistence.setArchived(name, true); };
  const seat = (name, cwd = repoDir) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, repoDir, tstore, persistence, injected, gated, contextActions, logs, killed, archived, seat,
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
  // The hand is a seat the LOOP minted, and since t482 the accept arms only
  // archive/destroy a seat whose record says so (_spawnTicketSeat stamps it on
  // every seat it mints). Without the record the hand reads as the operator's
  // standing seat, which accept deliberately leaves alone — and the hand-vs-
  // reviewer teardown assertions below would pass or fail for the wrong reason.
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

function spawnReviewer(f, ticketId) {
  const before = new Set(f.persistence.list().map((e) => e.name));
  f.m._handleTeamReview(f.m.sessions.get('lead'), `review the diff for ${ticketId}`, { ticketId });
  const rec = f.persistence.list().find((e) => !before.has(e.name));
  assert.ok(rec, 'ENTER: a reviewer seat was reserved — otherwise there is no seat to assert about');
  assert.strictEqual(rec.reviewTicket, ticketId, 'ENTER: it carries the ticket link the resolver matches on');
  f.seat(rec.name);
  return rec;
}

// The resolver the fix routes on, so an ENTER can show the seat was findable as
// this ticket's reviewer BEFORE the transition — every absence assertion below
// is equally true of a seat that was never resolvable at all.
const liveFor = (f, id) => f.m._liveReviewSeatsFor(f.team, id).map((s) => s.name);

const reject = (f, id, reason = 'the guard is inverted') =>
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'reject', id, who: null, body: reason });

const accept = (f, id, note = '') =>
  f.m._taskAccept(f.m.sessions.get('lead'), f.team, { type: 'task', sub: 'accept', id, who: null, body: note },
    (msg) => f.injected.push(msg));

// ── reject ends the round, so the seat goes ────────────────────────────────

test('a reject retires the reviewer seat of the round it ends', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');

  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name],
    'ENTER: the seat resolves as t1\'s live reviewer — the absence below is vacuous without this');

  reject(f, 't1');

  assert.deepStrictEqual(liveFor(f, 't1'), [],
    'the seat outlived the round the lead ended, and its stale verdict lands on the rework round');
  assert.strictEqual(f.m.sessions.has(rec.name), false, 'the session is gone');
  assert.strictEqual(f.persistence.get(rec.name), null, 'and so is its record — the name is free for round 2');
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: the reject itself still landed');
  assert.strictEqual(f.one('t1').reworkRound, 1, 'ENTER: and counted a rework round');
});

test('the retire uses review-done\'s own shape — retired/discard, not a bare kill', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');

  reject(f, 't1');

  // A reviewer seat is minted with no worktree of its own, so DISCARD is what
  // `sweepReviewerGraveyard` and the sidebar are written for. An `archive` here
  // would leave an archived ephemeral record behind with nothing to resume into.
  //
  // Filtered to `retired` rather than exact-matching every context-action for
  // this seat: `_handleTeamReview` defers create() into a setImmediate that
  // fires `{action: 'reattach'}` on the SAME channel for the SAME name. This
  // subject is synchronous so that never lands — but an exact match would turn
  // any future `await` here into a failure reporting a wrong DISPOSITION, which
  // points at the wrong cause entirely. The disposition is still asserted
  // exactly, which is the whole subject: `archive` here would leave an archived
  // ephemeral record with nothing to resume into.
  const acts = f.contextActions.filter((a) => a.name === rec.name
    && a.channel === 'session:context-action' && a.payload.action === 'retired');
  assert.deepStrictEqual(acts.map((a) => a.payload), [
    { action: 'retired', name: rec.name, disposition: 'discard' },
  ], 'one retire, discard — the same shape review-done fires');
});

test('the ESCALATED-at-review ticket is rejectable, and its wedged seat goes too', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');

  // The documented recovery, driven through the real arm rather than hand-written:
  // an unbriefed/wedged reviewer escalates with keepHold, which deliberately
  // leaves the ticket `done` at `loopStep: review`. `_taskReject`'s gate is
  // `state === 'done'`, so the lead's prescribed way out of a wedged review was
  // itself a way into a stranded seat.
  f.m._escalateTicket(f.team, 't1', 'review: spawn', 'the seat boots UNBRIEFED', 'a reviewer seat WAS spawned',
    { keepHold: true });

  const held = f.one('t1');
  assert.strictEqual(held.state, 'done', 'ENTER: the escalation held the ticket done');
  assert.strictEqual(held.loopStep, 'review', 'ENTER: at the review step — keepHold did not release it');
  assert.strictEqual(held.verifyHold, undefined, 'ENTER: and stamped no verify hold — this is the review-step arm');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name], 'ENTER: the wedged seat is still live');

  reject(f, 't1');

  assert.deepStrictEqual(liveFor(f, 't1'), [],
    'the documented recovery from a wedged review must not itself strand the seat');
});

test('a reject retires only THIS ticket\'s reviewer', () => {
  const f = mkFixture();
  f.seat('lead'); f.seat('team-hand');
  f.tstore.save(f.team.root, [
    { id: 't1', state: 'done', spec: 'one', assignee: 'team-hand', role: 'hand', taskDir: 'tasks/t1/SPEC.md',
      openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand', lastActivityAt: 2, loopStep: 'review' },
    { id: 't2', state: 'done', spec: 'two', assignee: 'team-hand', role: 'hand', taskDir: 'tasks/t2/SPEC.md',
      openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand', lastActivityAt: 2, loopStep: 'review' },
  ]);
  const r1 = spawnReviewer(f, 't1');
  const r2 = spawnReviewer(f, 't2');
  assert.deepStrictEqual([liveFor(f, 't1'), liveFor(f, 't2')], [[r1.name], [r2.name]],
    'ENTER: two rounds are open, one per ticket');

  reject(f, 't1');

  assert.deepStrictEqual(liveFor(f, 't1'), [], 't1\'s round ended');
  assert.deepStrictEqual(liveFor(f, 't2'), [r2.name],
    'a teardown that swept every ephemeral seat would kill a review nobody ended');
});

// ── the arm that must KEEP working ─────────────────────────────────────────

test('a keepHold escalation does NOT retire the seat', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');

  f.m._escalateTicket(f.team, 't1', 'review: spawn', 'the seat boots UNBRIEFED', 'a reviewer seat WAS spawned',
    { keepHold: true });

  // The hold exists precisely because the ticket is still in flight and this
  // seat's verdict may still land. Retiring here destroys the review the hold was
  // taken to preserve — and this subject is what stops a later over-broad "retire
  // on any round end" from shipping green.
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name],
    'an escalation is not a round end — the lead has not ruled and the verdict may still land');
  assert.strictEqual(f.one('t1').loopStep, 'review', 'and the hold itself is untouched');
  assert.deepStrictEqual(f.killed, [], 'nothing was torn down');
});

// ── accept ends the round too ──────────────────────────────────────────────

test('an accept retires the reviewer, which its own teardowns never reach', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name], 'ENTER: a round is open when the lead accepts');

  await accept(f, 't1');

  // `closedOut`, not `acceptedAt`: finish() stamps acceptedAt on ALL FOUR arms,
  // so an ENTER on it would pass just as happily from the not-merged arm and
  // silently relabel this subject if isMerged ever regressed. Only the merged arm
  // is terminal.
  assert.strictEqual(f.one('t1').closedOut, true, 'ENTER: the accept took the terminal MERGED arm');
  assert.match(f.injected.join('\n'), /branch landed deleted/,
    'ENTER: the branch was DELETED, which only the merged arm does — the other two keep it');
  assert.strictEqual(f.one('t1').loopStep, undefined, 'ENTER: and ended the round');
  // The accept teardowns all target `seatName` — the ticket's ASSIGNEE. A
  // reviewer is resolved off `ephemeral` + `reviewTicket` and never appears as an
  // assignee, so it was reached by nothing here before this fix.
  assert.deepStrictEqual(liveFor(f, 't1'), [], 'the reviewer of an accepted round must not survive it');
  assert.strictEqual(f.persistence.get(rec.name), null, 'record gone');
});

test('the reviewer goes on the NON-terminal accept arm as well', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  // An unmerged branch: the accept archives the hand and invites a second accept.
  // The review round is over either way — `finish()` deletes `loopStep` on all
  // four arms — so a per-arm teardown would leak on exactly this one.
  const all = f.tstore.load(f.team.root);
  all[0].worktree = { branch: 'pending' };
  f.tstore.save(f.team.root, all);
  const rec = spawnReviewer(f, 't1');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name], 'ENTER: a round is open');

  await accept(f, 't1');

  assert.match(f.injected.join('\n'), /is NOT merged/, 'ENTER: this really is the not-merged arm');
  assert.strictEqual(f.one('t1').closedOut, undefined, 'ENTER: which is NOT terminal — another accept is invited');
  assert.deepStrictEqual(liveFor(f, 't1'), [],
    'the round ended (loopStep is gone) even though the ticket did not close out');
  // The two teardowns are different verbs on different seats, and this pins that
  // adding the reviewer's did not displace the hand's: the hand is ARCHIVED
  // (unmerged work, so it must stay resumable) while the reviewer is KILLED.
  assert.deepStrictEqual(f.archived, ['team-hand'], 'the hand was archived, and only the hand');
  assert.deepStrictEqual(f.killed, [rec.name], 'the reviewer was killed, and only the reviewer');
});

// ── the paths that end NO round, and must not tear anything down ───────────

test('a follow-up must-fix on a reopened ticket leaves an in-flight review alone', () => {
  const f = mkFixture();
  f.seat('lead'); f.seat('team-hand');
  // Already open for rework — the gate `_taskRejectFollowUp` is reached through.
  // No review round is open on a ticket in this state (a round exists only while
  // the ticket is `done`), so a seat still resolving here is one whose round
  // something else already ended: retiring it would destroy a review nobody
  // ended, and the board is protected anyway — `ticketInFlight` refuses a verdict
  // on an open ticket and it falls through to the lead in full.
  //
  // The seat is loop-spawned, necessarily: an ad-hoc review carries no
  // `reviewTicket` (the intent path passes no opts) and so is invisible to the
  // resolver. This exact board state is only reachable in production through a
  // round that ended without a teardown — which is what this ticket closes.
  f.tstore.save(f.team.root, [{
    id: 't1', state: 'open', spec: 'one', assignee: 'team-hand', role: 'hand', taskDir: 'tasks/t1/SPEC.md',
    openedAt: 1, startedAt: 1, lastActivityAt: 3, reworkRound: 1,
  }]);
  const rec = spawnReviewer(f, 't1');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name], 'ENTER: a seat is live and linked to t1');

  reject(f, 't1', 'two more things');

  assert.match(f.injected.join('\n'), /already open for rework/, 'ENTER: the follow-up arm was taken, not the reopen');
  assert.strictEqual(f.one('t1').reworkRound, 1, 'ENTER: a follow-up counts no new round');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name],
    'a follow-up ends no round — tearing down here would kill a review still in flight');
});

// ── the close must never fail on the teardown ──────────────────────────────

test('a teardown that throws does not cost the reject', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');
  f.m.kill = () => { throw new Error('pty is gone'); };

  reject(f, 't1');

  // The ticket transition is already saved by the time the teardown runs, so an
  // escaping error would abandon the reply and leave the board ahead of the lead
  // — strictly worse than the leak this fixes.
  assert.strictEqual(f.one('t1').state, 'open', 'the reject still landed');
  assert.strictEqual(f.one('t1').reworkRound, 1, 'and counted its round');
  assert.match(f.injected.join('\n'), /reopened \(rework\)/, 'and the lead still got its confirmation');
  assert.ok(f.logs.some((l) => l.level === 'error' && /pty is gone/.test(l.msg)),
    'the failure is logged rather than swallowed — a seat that could not be retired is still a leak');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name],
    'ENTER: and the seat really did survive, so the arm above is the failing one');
});

// ── the loop's own reject is the documented twin of the lead's ─────────────

test('the LOOP\'s reject retires the reviewer too — the twin must not diverge', () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name], 'ENTER: a seat is live and linked to t1');

  // LATENT in production, pinned anyway: the loop rejects only at
  // `loopStep: 'verify'` with a red suite, and no reviewer exists for the round
  // until the suite goes green. `_rejectTicketFromLoop`'s header states the pair
  // is deliberately identical and that a change to `_taskReject` must follow
  // here — this subject is what makes that claim checkable rather than aspirational.
  const r = f.m._rejectTicketFromLoop(f.team, 't1', 'the suite FAILS on your branch');

  assert.strictEqual(r.ok, true, 'ENTER: the loop reject actually landed — it needs a live seat to reach');
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: and reopened the ticket');
  assert.strictEqual(f.one('t1').reworkRound, 1, 'ENTER: counting a rework round, exactly as the lead\'s reject does');
  assert.deepStrictEqual(liveFor(f, 't1'), [],
    'a pair documented as never diverging had diverged: the lead\'s reject retires, the loop\'s did not');
});

// ── the teardown cannot cost the close, on EITHER failure shape ────────────

test('an ASYNC teardown rejection does not cost the reject either', async () => {
  const f = mkFixture();
  reviewingTicket(f);
  const rec = spawnReviewer(f, 't1');
  // The real kill() is async, so its failure arrives as a REJECTED PROMISE, not a
  // synchronous throw — a different arm from the subject above, which the inner
  // try catches. This one is caught only by the `.catch` on the returned promise.
  f.m.kill = async () => { throw new Error('pty is gone'); };

  reject(f, 't1');
  // Drained before asserting, so this subject FALSIFIES INSIDE ITSELF. Without
  // it every assertion below is equally true with the `.catch` deleted, and the
  // only thing that goes red is the runner's ESCAPES counter — attributed after
  // the test ended, to the file rather than to this arm, and maskable by any
  // later unrelated escape. That is the "green while asserting nothing about the
  // arm in its own title" shape, in the subject written to prevent it.
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.one('t1').state, 'open', 'the reject still landed');
  assert.strictEqual(f.one('t1').reworkRound, 1, 'and counted its round');
  assert.match(f.injected.join('\n'), /reopened \(rework\)/, 'and the lead still got its confirmation');
  // The correction, not merely an error: the summary line says "retiring" while
  // this kill was still pending, so the seat must be named as still live or an
  // operator greps the success and stops looking.
  assert.ok(f.logs.some((l) => l.level === 'error'
    && /did NOT retire after all/.test(l.msg) && l.msg.includes(rec.name) && /pty is gone/.test(l.msg)),
  'the rejected kill is caught and corrected BY NAME — an uncaught one escapes the close entirely');
  // PAIRED, and the pair is the point: the negative below is equally true of an
  // implementation that deletes the summary line outright — which is the other
  // way the operator loses the signal, and an absence assertion is true of the
  // empty set. The positive pins that the line exists and names the seat; the
  // negative pins that it does not overclaim.
  assert.ok(f.logs.some((l) => l.level === 'info'
    && /— retiring \d+ live reviewer seat/.test(l.msg) && l.msg.includes(rec.name)),
  'the summary line exists and names the seat');
  assert.ok(!f.logs.some((l) => l.level === 'info' && /— retired \d+ live reviewer/.test(l.msg)),
    'and no line claims the seat WAS retired: kill() is async, so that claim cannot be true when it is written');
  assert.deepStrictEqual(liveFor(f, 't1'), [rec.name],
    'ENTER: the seat really did survive the failed teardown, so this is the failing arm');
});
