'use strict';
// Run: node --test test/accept-standing-seat.test.js
//
// t482 — `task accept` retires only the seats the ticket loop MINTED, and never
// force-removes a tree that still holds work.
//
// The defect: `_taskAccept` resolved `ephemeral` off the record in exactly one
// of its four arms (the no-branch one). The three branch-carrying arms tore down
// whatever `ticket.assignee` named — the two non-terminal arms with archive()
// (kills the pty), the merged arm with destroy(), which kills the seat, drops
// its persistence record and `git worktree remove --force`s the checkout the
// record names, with no dirty-check at all.
//
// A standing seat reaches those arms by two ORDINARY lead moves, which is why
// this is not a corner: `_resolveAssignee` accepts a live seat name, and when a
// worktree seat dies `_ticketAssigneeSeat` refuses to degrade the worktree pin,
// so the natural recovery — reassign to a standing role — carries the ticket's
// branch onto the operator's persistent seat. The merge fact then licensed
// deleting the operator's checkout.
//
// BOTH DIRECTIONS ARE PINNED HERE, deliberately. The ephemeral subjects are not
// context: a fix that simply disabled teardown would satisfy every
// standing-seat assertion below and ship green, and the whole value of the
// change is the DISTINCTION. `.claude/CLAUDE.md` documents that vacuity shape
// under Tests, with seven recorded instances in this repo.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

// A REAL repo with REAL worktrees, for the reason reviewer-round-end.test.js
// gives about the accept arms: every assertion below is about what survived on
// DISK — a tree still standing, a tree removed — and a stubbed gitWorktree would
// let a subject claim the merged arm while asserting against whatever the stub
// was written to return. `landed` is an ancestor of master; `pending` carries a
// commit master does not have.
function mkRepo() {
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t482-repo-'));
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

// Every tmp dir a fixture makes, so `t.after` can reap them. Each subject builds
// a real repo AND a real linked worktree; left behind that is a pile of them per
// run, and the destructive subjects are precisely the ones that would NOT clean
// up after themselves if the code under test regressed.
function mkFixture(t, { gitWorktree: gwOverride = null } = {}) {
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t482-'));
  const repoDir = mkRepo();
  const tmpDirs = [home, repoDir];
  if (t) t.after(() => { for (const d of tmpDirs) { try { fsReal.rmSync(d, { recursive: true, force: true }); } catch {} } });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repoDir, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
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
  const replies = [];
  const logs = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
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
    // Real by default — every disk assertion depends on it. An override exists
    // only for the arm whose subject is git FAILING, which cannot be staged on a
    // healthy repo.
    gitWorktree: gwOverride || require('../git-worktree'),
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
  m._injectText = () => {};
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = () => ({ queued: true });
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m._reconcileTickets = () => {};
  m._advanceSeat = () => null;
  m._writeTicketCost = () => {};
  m._retireReviewSeatsFor = () => {};
  m.create = async () => {};
  // kill() stubbed exactly as reviewer-round-end.test.js stubs it, and for the
  // same reason: the real one SIGKILLs a pid this fixture fakes. The STATE it
  // leaves is what the assertions read — record removed, session out of the map.
  //
  // destroy() is deliberately NOT stubbed. It is the destructive verb under
  // test: it reads the worktree off the record before killing, then really runs
  // `git worktree remove --force`. Stubbing it would leave the tree assertions
  // measuring the stub.
  //
  // The `!m.sessions.has` early return mirrors the real kill()'s `if (!s)
  // return;` and is load-bearing, not tidiness: a stub that dropped the record
  // unconditionally would drop it for an ALREADY-DEAD seat too, which is the
  // exact state t486 fixed in destroy(). Every dead-seat subject below would
  // then pass against the unfixed code — vacuous in the way `.claude/CLAUDE.md`
  // describes, and silently so.
  m.kill = async (name) => {
    if (!m.sessions.has(name)) return;
    killed.push(name); persistence.remove(name); m.sessions.delete(name);
  };
  m.archive = async (name) => { archived.push(name); persistence.setArchived(name, true); };
  const seat = (name, cwd = repoDir) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  // A real linked worktree on `branch`, recorded the way _spawnTicketSeat records
  // one. `ephemeral` is THE fact under test, so it is always passed explicitly.
  const worktreeSeat = (name, branch, { ephemeral }) => {
    const wtPath = pathReal.join(osReal.tmpdir(), `clodex-t482-wt-${name}-${Date.now()}`);
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-q', wtPath, branch], { encoding: 'utf8' });
    tmpDirs.push(wtPath);
    persistence.upsert({ name, cwd: wtPath, ephemeral, worktree: { path: wtPath, branch } });
    seat(name, repoDir);
    return wtPath;
  };
  return {
    m, team, home, repoDir, tstore, persistence, replies, logs, killed, archived, seat, worktreeSeat,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
  };
}

const doneTicket = (f, { id = 't1', assignee, branch }) => {
  f.tstore.save(f.team.root, [{
    id, state: 'done', spec: `spec for ${id}`, assignee, role: 'hand',
    taskDir: `tasks/${id}-fixture/SPEC.md`,
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: assignee,
    lastActivityAt: 2,
    worktree: { branch },
  }]);
  return f.one(id);
};

const accept = (f, id, note = '') => {
  let out = null;
  return f.m._taskAccept(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'accept', id, who: null, body: note },
    (msg) => { out = msg; f.replies.push(msg); })
    .then(() => out);
};

const exists = (p) => fsReal.existsSync(p);
const branches = (f) => execFileSync('git', ['-C', f.repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
  { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);

// ── direction 1: an EPHEMERAL ticket seat is still torn down, exactly as before ──
//
// This is the behaviour the whole loop depends on, and it is the half that makes
// the standing-seat assertions mean anything.

test('an ephemeral ticket seat on a merged branch is still destroyed and its tree removed', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  assert.ok(exists(wt), 'ENTER: the ticket seat has a real worktree on disk to lose');
  assert.ok(f.persistence.get('team-hand-t1'), 'ENTER: and a persistence record naming it');
  assert.ok(branches(f).includes('landed'), 'ENTER: the merged branch exists to be deleted');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, ['team-hand-t1'], 'the one-shot seat is killed');
  assert.strictEqual(f.persistence.get('team-hand-t1'), null, 'its record is dropped');
  assert.strictEqual(exists(wt), false, 'its worktree is removed');
  assert.strictEqual(branches(f).includes('landed'), false, 'and its merged branch is deleted');
  assert.match(msg, /retired and its worktree removed/, 'the reply reports the teardown it performed');
  assert.strictEqual(f.one('t1').closedOut, true, 'the merged arm is terminal');
});

// ── direction 2: a STANDING seat named as assignee survives ────────────────────

test('a standing seat on a merged branch keeps its session, its record and its tree', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  // No `ephemeral` on the record — the shape a seat the OPERATOR spawned has.
  const wt = f.worktreeSeat('helper', 'landed', { ephemeral: false });
  doneTicket(f, { assignee: 'helper', branch: 'landed' });

  assert.ok(f.m.sessions.has('helper'), 'ENTER: the standing seat is live');
  assert.ok(exists(wt), 'ENTER: with a real checkout that a force-remove would delete');
  assert.strictEqual(f.one('t1').assignee, 'helper', 'ENTER: and it is the ticket assignee, so teardown resolves to it');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, [], 'acceptance kills no seat it did not mint');
  assert.deepStrictEqual(f.archived, [], 'and does not archive it either — archive kills the pty');
  assert.ok(f.m.sessions.has('helper'), 'the operator\'s seat is still running');
  assert.ok(f.persistence.get('helper'), 'its persistence record survives');
  assert.strictEqual(exists(wt), true, 'and its checkout is still on disk');
  assert.match(msg, /LEFT RUNNING/, 'the reply says the seat was kept, rather than claiming a retire');
  assert.strictEqual(f.one('t1').closedOut, true, 'the ticket still closes out — the BRANCH did merge');
});

test('a standing seat is not archived on the not-merged arm either', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('helper', 'pending', { ephemeral: false });
  doneTicket(f, { assignee: 'helper', branch: 'pending' });

  assert.ok(f.m.sessions.has('helper'), 'ENTER: the standing seat is live');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.archived, [], 'the unmerged arm archives only a seat the loop minted');
  assert.ok(f.m.sessions.has('helper'), 'the standing seat keeps running');
  assert.strictEqual(exists(wt), true, 'its tree is kept (as it is for any seat on this arm)');
  assert.ok(branches(f).includes('pending'), 'ENTER: and the unmerged branch is kept — this is the NOT-merged arm');
  assert.match(msg, /left running \(not a one-shot ticket seat\)/, 'the reply names what happened to the seat');
  assert.strictEqual(f.one('t1').closedOut, undefined, 'ENTER: which is the non-terminal arm — another accept is invited');
});

// The same arm, other direction — otherwise "not archived" above is equally true
// of a fix that stopped archiving anyone.
test('an ephemeral seat IS still archived on the not-merged arm', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'pending', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'pending' });

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.archived, ['team-hand-t1'], 'the one-shot seat is archived as before');
  assert.deepStrictEqual(f.killed, [], 'archived, never destroyed: its tree and branch are kept for the merge');
  assert.match(msg, /was archived \(resumable\)/, 'and the reply says so');
  assert.strictEqual(f.one('t1').closedOut, undefined, 'ENTER: still the non-terminal arm');
});

// ── the dirty downgrade, on the intended (ephemeral) path ─────────────────────

test('a DIRTY tree downgrades the merged-arm destroy to an archive, keeping the tree', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  // Uncommitted work: exactly what `git worktree remove --force` would delete
  // and what the merge fact says nothing about.
  fsReal.writeFileSync(pathReal.join(wt, 'uncommitted.txt'), 'not yet committed\n');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  const dirty = require('../git-worktree').isDirty;
  const d = await dirty(wt);
  assert.deepStrictEqual(d, { ok: true, dirty: true }, 'ENTER: git agrees the tree has work to lose');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, [], 'a dirty tree is never destroyed, even for a one-shot seat');
  assert.deepStrictEqual(f.archived, ['team-hand-t1'], 'the teardown downgrades to the recoverable verb');
  assert.strictEqual(exists(pathReal.join(wt, 'uncommitted.txt')), true, 'the uncommitted file survives');
  assert.ok(f.persistence.get('team-hand-t1'), 'and the record that points at the tree survives with it');
  assert.match(msg, /ARCHIVED, not retired/, 'the reply does not claim a retire it downgraded');
  assert.match(msg, /has uncommitted work/, 'and names the reason, so the lead can go commit it');
  // The recovery is the SAME verb again, not manual cleanup: `closedOut` is not
  // a gate on accept (only `ticket.state` is), so a re-accept after committing
  // finishes the teardown. Telling the lead to remove it by hand sent them to do
  // work the app would have done.
  assert.match(msg, /\[agent:task accept t1\] again to finish the cleanup/,
    'and points at the verb that actually completes it');
  assert.doesNotMatch(msg, /by hand/, 'rather than manual cleanup the app does not require');
  // The ref that recovery depends on must still be there. `git branch -d`
  // usually refuses while the kept tree has it checked out, but not always — a
  // pruned registration or a tree on another branch lets it through, and then
  // the second accept finds no branch, takes the check-failed arm, and the tree
  // can never be reclaimed by the verb this reply just named.
  assert.ok(branches(f).includes('landed'), 'the branch survives, so the invited re-accept can still run');
  assert.match(msg, /branch landed was KEPT \(the accept above is unfinished\)/,
    'and the reply says the ref was kept rather than claiming a deletion');
});

test('a CLEAN tree on the same path is still destroyed — the downgrade is the exception', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  const d = await require('../git-worktree').isDirty(wt);
  assert.deepStrictEqual(d, { ok: true, dirty: false }, 'ENTER: git agrees this tree is clean');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.archived, [], 'nothing to preserve, so no downgrade');
  assert.deepStrictEqual(f.killed, ['team-hand-t1'], 'the seat is destroyed');
  assert.strictEqual(exists(wt), false, 'and the clean tree is reclaimed');
  assert.match(msg, /retired and its worktree removed/, 'the reply reports the teardown');
});

// ── the third case the two non-merged arms must tell apart ────────────────────
//
// Ephemeral AND not live. Keying the kept-seat sentence on "did an archive run"
// collapses this into the standing case and reports a dead one-shot seat as
// "left running (not a one-shot ticket seat)" — false about liveness and false
// about the distinction this ticket ships. Reachable two ordinary ways: a hand
// that exits naturally after `task done` keeps its record (session-manager.js
// drops records only for `!agentType` seats), and the second accept THIS ARM
// INVITES arrives after the first one's archive() left `this.sessions`.
test('an ephemeral seat that is already gone is not described as a standing seat', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'pending', { ephemeral: true });
  // The seat exited; the RECORD survives, which is what production leaves behind.
  f.m.sessions.delete('team-hand-t1');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'pending' });

  assert.strictEqual(f.m.sessions.has('team-hand-t1'), false, 'ENTER: the seat is not live');
  assert.strictEqual(f.persistence.get('team-hand-t1').ephemeral, true,
    'ENTER: but its record still says the loop minted it — the case that collapses');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.archived, [], 'nothing to archive — it is already gone');
  assert.doesNotMatch(msg, /left running/, 'a dead seat is never reported as left running');
  assert.doesNotMatch(msg, /not a one-shot ticket seat/, 'and never as a standing seat — its record says otherwise');
  assert.match(msg, /is not running, so nothing was archived/, 'it gets the sentence that is true of it');
  assert.strictEqual(exists(wt), true, 'its tree is kept, as on any non-merged arm');
});

// nit 5: the same wording on the OTHER non-merged arm. Cheap here because the
// only difference is which answer isMerged gives, and it is the arm the fix
// above touches.
test('the check-failed arm makes the same standing-vs-ephemeral distinction', async (t) => {
  // A merge check that cannot RUN — absence of evidence, treated as not merged.
  // Only isMerged is replaced; removeWorktree and the rest stay real, so a
  // teardown that wrongly fired would still really delete the tree below.
  const realGw = require('../git-worktree');
  const f = mkFixture(t, {
    gitWorktree: { ...realGw, isMerged: async () => ({ ok: false, error: 'git exploded' }) },
  });
  f.seat('lead');
  const wt = f.worktreeSeat('helper', 'landed', { ephemeral: false });
  doneTicket(f, { assignee: 'helper', branch: 'landed' });
  const msg = await accept(f, 't1');

  assert.match(msg, /merge check could NOT run/, 'ENTER: this really is the check-failed arm');
  assert.deepStrictEqual(f.archived, [], 'a standing seat is not archived when the check cannot run either');
  assert.deepStrictEqual(f.killed, [], 'and certainly not destroyed');
  assert.ok(f.m.sessions.has('helper'), 'the operator\'s seat keeps running');
  assert.strictEqual(exists(wt), true, 'its checkout is untouched');
  assert.match(msg, /left running \(not a one-shot ticket seat\)/, 'and the reply names it as the standing seat it is');
});

// The OTHER downgrade direction: git cannot look at the tree at all. `ok:false`
// is not evidence of a clean one, so it archives and KEEPS the record rather
// than destroying — and that is not an inert branch. The commonest way to reach
// it is the ordinary "tree already removed by hand" case, which this flips from
// retire-and-drop-the-record to archive-and-keep-it.
test('an UNREADABLE tree also downgrades the destroy, and says which of the two it was', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  // The tree is gone, but the RECORD still points at it — exactly the state an
  // operator leaves by deleting a worktree directory by hand.
  fsReal.rmSync(wt, { recursive: true, force: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  const d = await require('../git-worktree').isDirty(wt);
  assert.strictEqual(d.ok, false, 'ENTER: git cannot inspect the tree, so this is the unreadable arm');
  assert.strictEqual(f.persistence.get('team-hand-t1').worktree.path, wt,
    'ENTER: and the record still names it — otherwise no probe would run at all');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, [], 'an unreadable tree is not evidence of a clean one, so nothing is destroyed');
  assert.deepStrictEqual(f.archived, ['team-hand-t1'], 'the seat is archived — the recoverable direction');
  assert.ok(f.persistence.get('team-hand-t1'), 'and its record survives, rather than being dropped');
  assert.match(msg, /could not be inspected/, 'the reply names this downgrade, not the dirty one');
  assert.doesNotMatch(msg, /has uncommitted work/, 'and does not send the lead to commit a tree that is gone');
});

// The fourth case on the non-merged arms, and the one neither the implementer
// nor the lead spotted: NOT ephemeral and NOT live. Two shapes reach it — a
// standing seat that exited (record kept), and an assignee that is a bare ROLE
// KEY with no record at all, where `rec === null` makes `ephemeralSeat` false by
// absence of evidence rather than by evidence of standing. Keyed on
// `!ephemeralSeat` alone the reply says "left running" about a seat that may not
// exist at all.
test('a standing seat that is NOT running is not described as left running', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('helper', 'pending', { ephemeral: false });
  // The operator's helper exited on its own; its record survives.
  f.m.sessions.delete('helper');
  doneTicket(f, { assignee: 'helper', branch: 'pending' });

  assert.strictEqual(f.m.sessions.has('helper'), false, 'ENTER: the seat is not live');
  assert.strictEqual(f.persistence.get('helper').ephemeral, false,
    'ENTER: and its record does NOT mark it one-shot — the branch that over-claimed');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.archived, [], 'still nothing torn down — it is not acceptance\'s seat');
  assert.deepStrictEqual(f.killed, [], 'and nothing destroyed');
  assert.doesNotMatch(msg, /left running/, 'a seat that is not running is never reported as running');
  assert.match(msg, /helper is not running/, 'it gets the sentence that is true of it');
  assert.strictEqual(exists(wt), true, 'its tree is kept either way');
});

// The same predicate, reached with NO record at all — a ticket whose assignee is
// a role key. `ephemeralSeat` is false here by absence of evidence, so this is
// the shape most likely to be described as a standing seat that does not exist.
test('an assignee with no record at all is not described as a running standing seat', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  doneTicket(f, { assignee: 'hand', branch: 'pending' });

  assert.strictEqual(f.persistence.get('hand'), null, 'ENTER: no record — ephemeralSeat is false by absence');
  assert.strictEqual(f.m.sessions.has('hand'), false, 'ENTER: and nothing is live under that name');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual([f.killed, f.archived], [[], []], 'nothing to tear down, and nothing is');
  assert.doesNotMatch(msg, /left running/, 'a seat that does not exist is not reported as running');
  assert.match(msg, /hand is not running/, 'the reply claims only what it can support');
});

// ── t486: the record must die with the tree, on a seat that already exited ────
//
// destroy() -> kill(), and kill() returns at `if (!s) return;` BEFORE its
// `getPersistence().remove()`. On a dead seat that removed the worktree and left
// a record naming a path that no longer exists, while the reply said "retired
// and its worktree removed" — an orphaned record, the "agents vanish" class in
// reverse.
//
// Reached by the route the app itself prescribes: the dirty downgrade archives
// the seat and asks the lead to clear the tree and accept again. The archive
// kills the pty, so the SECOND accept — the one this reply invited — always
// lands on the merged arm with the seat out of `this.sessions`.
test('the second accept the dirty downgrade invites destroys a DEAD seat record and all', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  fsReal.writeFileSync(pathReal.join(wt, 'uncommitted.txt'), 'not yet committed\n');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  const first = await accept(f, 't1');
  assert.match(first, /\[agent:task accept t1\] again to finish the cleanup/,
    'ENTER: the first accept really is the dirty downgrade, and really does invite a second');
  assert.deepStrictEqual(f.archived, ['team-hand-t1'], 'ENTER: which archived the seat rather than destroying it');

  // What the real archive() leaves behind: it kills the pty, and _cleanup drops
  // the name from this.sessions. The fixture's archive stub only flags the
  // record, so the map drop is staged here — without it the second accept would
  // run against a LIVE seat and never reach the branch under test.
  f.m.sessions.delete('team-hand-t1');
  // The lead does what the reply asked. Clearing rather than committing keeps
  // `landed` an ancestor of master, so the second accept reaches the same arm.
  fsReal.rmSync(pathReal.join(wt, 'uncommitted.txt'));

  assert.strictEqual(f.m.sessions.has('team-hand-t1'), false, 'ENTER: the seat is gone, as the archive left it');
  assert.ok(f.persistence.get('team-hand-t1'), 'ENTER: but its record survived the downgrade, pointing at the tree');
  assert.deepStrictEqual(await require('../git-worktree').isDirty(wt), { ok: true, dirty: false },
    'ENTER: and the tree is clean now, so this accept tears down instead of downgrading again');

  const msg = await accept(f, 't1');

  assert.strictEqual(exists(wt), false, 'the worktree is removed, as it was before the fix');
  assert.strictEqual(f.persistence.get('team-hand-t1'), null,
    'and the record goes WITH it — a surviving record names a path that no longer exists, which is what the reply below would then be lying about');
  assert.match(msg, /retired and its worktree removed/, 'the reply claims a full teardown, and now every part of it happened');
  assert.strictEqual(branches(f).includes('landed'), false, 'the merged branch is deleted on this completing accept');
});

// The same drop, reached the other ordinary way: a hand that exits naturally
// after `task done` keeps its record (session-manager.js drops records only for
// `!agentType` seats), so the FIRST accept already finds it dead.
test('a one-shot seat that exited on its own is destroyed record and all', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  f.m.sessions.delete('team-hand-t1');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  assert.strictEqual(f.m.sessions.has('team-hand-t1'), false, 'ENTER: not live');
  assert.strictEqual(f.persistence.get('team-hand-t1').ephemeral, true,
    'ENTER: but its record still marks it the loop\'s, which is what licenses the teardown');

  const msg = await accept(f, 't1');

  assert.strictEqual(exists(wt), false, 'its tree is reclaimed');
  assert.strictEqual(f.persistence.get('team-hand-t1'), null, 'and its record with it');
  assert.match(msg, /retired and its worktree removed/, 'the reply reports the teardown it actually performed');
});

// nit: the merged arm's `left alone (its session is not running)` string had no
// subject at all — the one arm of that ternary nothing exercised.
test('a standing seat that is NOT running is not described as LEFT RUNNING on the merged arm', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('helper', 'landed', { ephemeral: false });
  // The operator's helper exited on its own; its record survives.
  f.m.sessions.delete('helper');
  doneTicket(f, { assignee: 'helper', branch: 'landed' });

  assert.strictEqual(f.persistence.get('helper').ephemeral, false,
    'ENTER: the record says standing, so nothing here is acceptance\'s to tear down');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual([f.killed, f.archived], [[], []], 'nothing torn down — it is not a one-shot seat');
  assert.strictEqual(exists(wt), true, 'and the operator\'s checkout is untouched');
  assert.doesNotMatch(msg, /LEFT RUNNING/, 'a seat that is not running is never reported as running');
  assert.match(msg, /left alone \(its session is not running\)/, 'it gets the sentence that is true of it');
  assert.match(msg, /it is not a one-shot ticket seat/, 'and the record supports the one-shot claim, so it is still made');
  assert.strictEqual(f.one('t1').closedOut, true, 'ENTER: this is the merged arm — the one whose string had no subject');
});

// The fourth cell of the same 2x2, on both arms: LIVE and with NO RECORD.
// `ephemeralSeat` is false there by absence of evidence, so the liveness split
// alone still sends it down the confident "not a one-shot ticket seat" branch —
// a claim about a seat nothing describes.
test('a live seat with no record is not claimed to be a standing seat (merged arm)', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.seat('drifter'); // live, but nothing was ever persisted under that name
  doneTicket(f, { assignee: 'drifter', branch: 'landed' });

  assert.strictEqual(f.persistence.get('drifter'), null, 'ENTER: no record — ephemeralSeat is false by absence');
  assert.ok(f.m.sessions.has('drifter'), 'ENTER: and it IS live, which is the cell the liveness split misses');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual([f.killed, f.archived], [[], []], 'no record, so no licence to tear anything down');
  assert.match(msg, /drifter was LEFT RUNNING/, 'liveness is claimed — that part is observed');
  assert.match(msg, /no record marks it a one-shot ticket seat/, 'but the one-shot claim is reported as the absence it is');
  assert.doesNotMatch(msg, /it is not a one-shot ticket seat/, 'rather than asserted about a seat nothing describes');
});

test('a live seat with no record is not claimed to be a standing seat (not-merged arm)', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.seat('drifter');
  doneTicket(f, { assignee: 'drifter', branch: 'pending' });

  assert.ok(f.m.sessions.has('drifter'), 'ENTER: live with no record, same cell, other arm');
  assert.strictEqual(f.persistence.get('drifter'), null, 'ENTER: and still no record');

  const msg = await accept(f, 't1');

  assert.match(msg, /NOT merged/, 'ENTER: this really is the not-merged arm');
  assert.match(msg, /drifter was left running, and its worktree and branch were KEPT/,
    'the seatClause claims liveness and stops there');
  assert.doesNotMatch(msg, /not a one-shot ticket seat/, 'no record, so no claim about whose seat it is');
});
