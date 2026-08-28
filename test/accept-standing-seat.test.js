'use strict';
// Run: node --test test/accept-standing-seat.test.js
//
// t482 — `task accept` retires only the seats the ticket loop MINTED, and never
// force-removes a tree that still holds work.
//
// The defect, as it stood at t482, when `_taskAccept` had four arms (t536 later
// added a fifth, the MERGE FAILED veto): it resolved `ephemeral` off the record
// in exactly one of those four (the no-branch one). The three branch-carrying
// arms tore down whatever `ticket.assignee` named — the two non-terminal arms
// with archive() (kills the pty), the merged arm with destroy(), which kills the
// seat, drops its persistence record and `git worktree remove --force`s the
// checkout the record names, with no dirty-check at all.
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

const doneTicket = (f, { id = 't1', assignee, branch, over = null }) => {
  f.tstore.save(f.team.root, [{
    id, state: 'done', spec: `spec for ${id}`, assignee, role: 'hand',
    taskDir: `tasks/${id}-fixture/SPEC.md`,
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: assignee,
    lastActivityAt: 2,
    worktree: { branch },
    ...(over || {}),
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
  // The prompt tells the lead a delete on this row is an ATTEMPT that
  // "ordinarily fails", and that was prose about git's behaviour with nothing
  // measuring it. Measured here rather than asserted: `git branch -d` refuses
  // while any worktree has the branch checked out, and row 4 keeps the tree by
  // design, so the ref survives an arm that really did try to delete it. Both
  // halves are needed — the survival alone is equally true of a build that
  // stopped attempting the delete, which is the distinction the row draws.
  assert.ok(branches(f).includes('landed'),
    'the merged branch SURVIVES: git branch -d refuses a branch the kept worktree has checked out');
  assert.match(msg, /branch landed could NOT be deleted/,
    'and the reply reports a refused attempt, not a skip — row 4 attempts the delete and git declines');
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

// ── t486 r2: the drop must not outrun the removal ────────────────────────────
//
// r1 dropped the record BEFORE removeWorktree ran. That is the orphan
// destroy()'s own header forbids, reached from the other side: a removal that
// FAILS then leaves a checkout on disk with nothing naming it — path
// unrecoverable, unmerged commits with it. The property is not an arm and not a
// line: destroy() must never RETURN having dropped the record while the tree it
// named still exists.
//
// gitWorktree is overridden only in `removeWorktree`, the way the check-failed
// subject above overrides only `isMerged`: everything else stays real, so the
// tree below is a real tree that really survives.
test('a FAILED worktree removal keeps the record — the tree still on disk must stay named', async (t) => {
  const realGw = require('../git-worktree');
  const f = mkFixture(t, {
    gitWorktree: { ...realGw, removeWorktree: async () => ({ ok: false, error: 'git worktree remove exploded' }) },
  });
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  // The dead-seat path — the one r1 added the drop for, and the one where only
  // destroy()'s own drop can run at all.
  f.m.sessions.delete('team-hand-t1');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  assert.strictEqual(f.m.sessions.has('team-hand-t1'), false, 'ENTER: the seat is dead, so kill() drops nothing');
  assert.ok(f.persistence.get('team-hand-t1'), 'ENTER: and its record is present to be wrongly dropped');

  const msg = await accept(f, 't1');

  assert.strictEqual(exists(wt), true, 'ENTER: the removal really failed, so the tree is really still there');
  assert.ok(f.persistence.get('team-hand-t1'),
    'the record SURVIVES a failed removal: it is the only pointer to a checkout still on disk, and dropping it orphans that tree irrecoverably along with its unmerged commits');
  assert.strictEqual(f.persistence.get('team-hand-t1').worktree.path, wt,
    'and it still names the path, which is what makes the tree recoverable at all');
  assert.match(msg, /could NOT be removed/, 'the reply reports the failure rather than claiming a teardown');
  assert.match(msg, new RegExp(`remove ${wt} by hand`),
    'and names the path, so the operator can finish it — matching _handleTeamRetire\'s discardPath sentence');
});

// The other direction, and the one that keeps the subject above from being
// satisfied by a fix that simply stopped dropping records. Same override shape,
// removal SUCCEEDS.
test('a SUCCESSFUL removal on the same dead-seat path still drops the record', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  f.m.sessions.delete('team-hand-t1');
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  const msg = await accept(f, 't1');

  assert.strictEqual(exists(wt), false, 'ENTER: this time the tree really goes');
  assert.strictEqual(f.persistence.get('team-hand-t1'), null,
    'so the record goes with it — nothing is left pointing at a folder that does not exist');
  assert.match(msg, /retired and its worktree removed/, 'and the reply claims exactly what happened');
  assert.doesNotMatch(msg, /by hand/, 'with no manual cleanup to hand off');
});

// The `!worktree` case, pinned directly on destroy() rather than through accept:
// there is no tree to strand, so the drop must still happen. This is r1's fix
// and the r2 ordering must not regress it — a fix that moved the drop to "only
// after a successful removal" would silently lose this one, since a seat with no
// worktree never reaches a removal at all.
test('destroy() drops a dead seat\'s record when there is no worktree to remove', async (t) => {
  const f = mkFixture(t);
  // No worktree key at all — a plain seat, the shape a non-ticket agent has.
  f.persistence.upsert({ name: 'plain', cwd: f.repoDir, ephemeral: true });
  assert.ok(f.persistence.get('plain'), 'ENTER: the record exists');
  assert.strictEqual(f.m.sessions.has('plain'), false, 'ENTER: and the seat is not live, so kill() returns early');

  const r = await f.m.destroy('plain');

  assert.deepStrictEqual(r, { ok: true }, 'destroy reports the no-tree shape');
  assert.strictEqual(f.persistence.get('plain'), null,
    'and the record is dropped: with no tree to lose there is nothing to strand, which is the r1 fix this ordering must not regress');
});

// The invariant stated as itself, over the real bytes. The subjects above pin
// the two reachable outcomes; this pins the PROPERTY — that no return which
// drops the record can sit after a removal whose failure it ignores. Neither
// behavioural subject sees a THIRD return added later, which is the gap this
// covers.
//
// COMMENTS ARE STRIPPED FIRST, and that is the whole reason this scanner has a
// function rather than being a regex inline. The first version of this pin
// counted raw `dropRecord()` matches and scored 3 — two real calls plus the
// prose in `// NO dropRecord() here …`. Deleting that comment and adding a real
// call before the failure return kept the count at 3, so the pin passed over
// code that strands the tree. A pin that reads as a general guard while being
// defeated by editing a COMMENT is worse than no pin: it tells the next agent
// the property is enforced. `stripComments` is the same idiom, for the same
// forced reason, as test/sender-token-contract.test.js — no parser resolves in
// this repo, so a text scan is the only lane and its discrimination has to be
// asserted rather than assumed.
function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// The scan, as a function of source text, so the planted-violation subject below
// can run it against code that does NOT exist on disk. Returns the facts; the
// assertions live in the callers.
//
// Call sites are counted as `dropRecord()` NOT preceded by `= ` — the closure is
// `const dropRecord = () => {`, which contains no `dropRecord()` token at all,
// so what is counted is exactly the invocations.
//
// `dropsOnFailurePath` is the PROPERTY, and getting it wrong is the r3 defect:
// it asked whether a call sat in the 40 BYTES before the failure return, which
// is a proxy for "is reached on the failure path" and not the same question.
// Moving the no-tree drop down to just above `const error = …` keeps the count
// at 2 and lands outside that window, so the pin passed while both behavioural
// subjects reddened.
//
// The span is everything after the removal call EXCEPT the success block. That
// exception is not a fudge: the success arm's drop sits between `removeAt` and
// `failReturn` by construction, so the plain span reddens correct source (it
// really does — measured: calls [462, 680], removeAt 558, failReturn 1074, so
// the legitimate 680 is inside it). Code after the removal that is NOT inside
// `if (r && r.ok) { … }` is exactly the code a failed removal runs on its way to
// its return, which is the sentence the property is written in.
function scanDestroy(fullSrc) {
  const body = fullSrc.slice(fullSrc.indexOf('async destroy(name)'));
  const end = body.indexOf('\n    async archive(');
  const destroySrc = stripComments(body.slice(0, end > 0 ? end : body.length));
  const failReturn = destroySrc.indexOf('worktreeRemoved: false');
  const removeAt = destroySrc.indexOf('gitWorktree.removeWorktree(');
  const calls = [...destroySrc.matchAll(/dropRecord\(\)/g)].map((mm) => mm.index);

  // Brace-match the success arm so its interior can be excluded by SPAN rather
  // than by counting: a scan that just subtracted "one expected call" would be
  // satisfied by a call moved from inside it to the failure path.
  const okAt = destroySrc.indexOf('if (r && r.ok) {', removeAt);
  let okOpen = -1;
  let okClose = -1;
  if (okAt > 0) {
    okOpen = destroySrc.indexOf('{', okAt);
    let depth = 0;
    for (let i = okOpen; i < destroySrc.length; i += 1) {
      if (destroySrc[i] === '{') depth += 1;
      else if (destroySrc[i] === '}') {
        depth -= 1;
        if (depth === 0) { okClose = i; break; }
      }
    }
  }
  const insideSuccessArm = (i) => okOpen > 0 && okClose > okOpen && i > okOpen && i < okClose;

  return {
    located: end > 0,
    removeAt,
    failReturn,
    successArmClosed: okClose > okOpen && okOpen > 0,
    bareRemoves: (destroySrc.match(/getPersistence\(\)\.remove\(/g) || []).length,
    calls,
    // Any drop reached on the way from a failed removal to its return: after the
    // removal, before that return, and not inside the success arm.
    dropsOnFailurePath: calls.some((i) =>
      removeAt > 0 && failReturn > removeAt && i > removeAt && i < failReturn && !insideSuccessArm(i)),
  };
}

test('t486: destroy() never drops the record before the removal it depends on', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'session-manager.js'), 'utf8');
  const f = scanDestroy(src);
  assert.ok(f.located, 'ENTER: the destroy() body was located, so the assertions below read real bytes');
  assert.ok(f.removeAt > 0 && f.failReturn > f.removeAt,
    'ENTER: both the removal and its failure return are present, in that order');

  assert.strictEqual(f.bareRemoves, 1,
    'the record drop lives in exactly one place (the dropRecord closure) — a second bare remove() in destroy() is the hoisted drop coming back, and it strands the tree on a failed removal');
  assert.strictEqual(f.calls.length, 2,
    'expected exactly 2 dropRecord() CALL SITES (the no-tree return and the removal-succeeded return) — the closure definition contains no such token, so this counts invocations only');
  assert.ok(f.successArmClosed,
    'ENTER: the success arm was brace-matched, so the span below really does exclude it rather than silently excluding nothing');
  assert.strictEqual(f.dropsOnFailurePath, false,
    'no dropRecord() call may be reached on the path from a failed removal to its return: that return leaves a tree on disk, and the record is the only thing naming it');
});

// What makes the green above mean anything. The scanner is a text scan by
// necessity, so its DISCRIMINATION is the risk — and the previous version of
// this pin proved that risk is real rather than theoretical. These plant the
// exact defeating edits against the scanner in memory, so a future weakening of
// it reddens here instead of shipping a pin that cannot fail.
test('t486: the source pin actually discriminates — the edits that must redden it', () => {
  const real = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'session-manager.js'), 'utf8');
  assert.strictEqual(scanDestroy(real).calls.length, 2, 'ENTER: the real source is the passing case');

  // 1. THE EDIT THAT DEFEATED THE FIRST PIN: delete the "NO dropRecord() here"
  //    comment AND add a real call before the failure return. The old scanner
  //    scored 3 both before and after — prose swapped for a call, one for one.
  const bothAtOnce = real
    .replace(/      \/\/ NO dropRecord\(\) here[\s\S]*?operator what to remove by hand\.\n/,
      '      dropRecord();\n');
  assert.ok(!/NO dropRecord\(\) here/.test(bothAtOnce) && bothAtOnce !== real,
    'ENTER: the planted edit really removed the comment and really changed the source');
  const swapped = scanDestroy(bothAtOnce);
  assert.strictEqual(swapped.calls.length, 3,
    'the comment no longer inflates the count, so adding a real call is now VISIBLE as a third call site');
  assert.strictEqual(swapped.dropsOnFailurePath, true,
    'and the property assertion sees the drop that strands the tree — this is the case that shipped green before');

  // 2. The comment deleted ALONE must NOT redden: comments carry no weight now,
  //    which is the point of stripping them. Without this, the pin would just
  //    have traded one prose dependency for another.
  const commentOnly = real
    .replace(/      \/\/ NO dropRecord\(\) here[\s\S]*?operator what to remove by hand\.\n/, '');
  assert.ok(commentOnly !== real, 'ENTER: the comment really was removed');
  assert.strictEqual(scanDestroy(commentOnly).calls.length, 2,
    'deleting a comment changes nothing — the scanner reads code, so prose is not load-bearing on this test');
  assert.strictEqual(scanDestroy(commentOnly).dropsOnFailurePath, false, 'and the property still holds');

  // 3. r1's original bug, once more, through the new scanner: hoisting the drop
  //    above the removal leaves the two calls collapsed into one early one.
  const hoisted = real
    .replace('      if (!worktree) { dropRecord(); return { ok: true }; }',
      '      dropRecord();\n      if (!worktree) { return { ok: true }; }')
    .replace('        dropRecord();\n        log.info', '        log.info');
  assert.ok(hoisted !== real, 'ENTER: the hoist really applied');
  assert.strictEqual(scanDestroy(hoisted).calls.length, 1,
    'the hoisted drop is one unconditional call, not two guarded ones — the count alone catches r1\'s bug');

  // 4. THE EDIT THAT DEFEATED THE r3 PIN, and the only one of these the count
  //    cannot see: the no-tree drop MOVED down onto the failure path, just above
  //    `const error = …`. Two calls before, two calls after — but the second is
  //    now reached by a failed removal, so the tree is stranded. r3 scored this
  //    false because the call missed a 40-byte window before the return; the span
  //    check sees it wherever on the failure path it sits.
  const movedOntoFailurePath = real
    .replace('      if (!worktree) { dropRecord(); return { ok: true }; }',
      '      if (!worktree) { return { ok: true }; }')
    .replace("      const error = (r && r.error) || 'unknown error';",
      "      dropRecord();\n      const error = (r && r.error) || 'unknown error';");
  assert.ok(movedOntoFailurePath !== real, 'ENTER: the move really applied');
  const moved = scanDestroy(movedOntoFailurePath);
  assert.strictEqual(moved.calls.length, 2,
    'ENTER: the COUNT is unchanged at 2 — which is exactly why a count alone cannot pin this property');
  assert.strictEqual(moved.dropsOnFailurePath, true,
    'the span check sees a drop reached on the failure path: the record goes while the tree it names is still on disk');
});

// ── t536: a MERGE FAILED stamp vetoes the teardown the merge gate licensed ──
//
// `isMerged` is `merge-base --is-ancestor`, and the loop undoes a red merge with
// `git revert -m 1`, which ADDS a commit. The merge commit therefore stays an
// ancestor after the undo, the gate still answers merged, and the merged arm
// destroyed the tree and deleted the branch holding the only copy of the work.
// That is not hypothetical: it happened to t537, whose change survived the
// accept only as a reverted commit in the reflog.
//
// The fixture's `landed` branch is a genuine ancestor of master, so these
// subjects reach the merged arm for real — the veto is the only thing standing
// between them and the teardown that
// `an ephemeral ticket seat on a merged branch is still destroyed and its tree
// removed` demonstrates. Named rather than counted or pointed at: the
// not-merged ephemeral subject demonstrates the OPPOSITE (archived, never
// destroyed), so "the two ephemeral subjects" was false of one of them.

test('a MERGE FAILED stamp keeps the tree and the branch on a branch that IS an ancestor', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'suite' } });

  // ENTER on the merge fact itself: without it this subject would pass against a
  // build that simply failed the gate, and the whole point is that the gate PASSES.
  const gw = require('../git-worktree');
  const m = await gw.isMerged(f.repoDir, 'landed');
  assert.deepStrictEqual({ ok: m.ok, merged: m.merged }, { ok: true, merged: true },
    'ENTER: the branch really is an ancestor of master, so the merge gate passes and only the stamp can refuse');
  assert.ok(exists(wt), 'ENTER: the seat has a real worktree that the merged arm would remove');
  assert.ok(branches(f).includes('landed'), 'ENTER: and a branch the merged arm would delete');

  const msg = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, [], 'nothing is destroyed: the ancestor answer does not establish that the work is on master');
  assert.strictEqual(exists(wt), true, 'the worktree survives — it may hold the only copy of the change');
  assert.ok(branches(f).includes('landed'), 'and so does the branch');
  assert.match(msg, /stamped this ticket MERGE FAILED at "suite"/, 'the reply names the mark it is acting on');
  assert.match(msg, /Nothing was removed/, 'and says plainly that it removed nothing');
  assert.doesNotMatch(msg, /merged into master;/, 'and never claims the landing the ancestor test would have supported');
  // This fixture records NO baseSha, which is the shape that reaches the
  // unmeasured count — and on this arm that count is deterministically 0, not
  // merely unreliable: the veto is only entered when the branch is an ancestor
  // of master, and with no usable fork point `commitsOnBranch` falls back to
  // merge-base(master, branch), which for an ancestor IS the branch tip. The
  // reply must therefore never quantify what is at stake here. Asserted as a
  // pair: the UNKNOWN wording, and the absence of the "0 commits" sentence a
  // lead reads as "nothing to lose" on the one reply whose job is the opposite.
  assert.match(msg, /How much it carries is UNKNOWN/,
    'the unmeasured count is reported as UNKNOWN, in the merged arm\'s own vocabulary');
  assert.doesNotMatch(msg, /Its 0 commits beyond/,
    'and never as "0 commits", which is what a fallback base always yields for an ancestor — the phantom merge restated');
});

test('the vetoed accept is terminal and CLEARS the mark, so a second accept can finish the job', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'revert-blocked' } });

  assert.strictEqual(f.one('t1').mergeError, 'revert-blocked', 'ENTER: the mark is on the ticket to be answered');

  const reply1 = await accept(f, 't1');

  // Terminality is the recovery, not a detail. Nothing the lead does to the
  // REPOSITORY clears a mergeError — only an accept that closes out does — so a
  // veto that left the mark standing would refuse for ever and no `task accept`
  // could ever reclaim this tree.
  assert.strictEqual(f.one('t1').closedOut, true, 'the vetoed accept closes the ticket out');
  assert.ok(!('mergeError' in f.one('t1')), 'and retires the mark it just answered');
  // Terminality clears the mark, so the stamp is the ONLY durable trace that a
  // check is still owed. Without it a lead interrupted before the second accept
  // finds a closed-out ticket and a live branch with nothing saying why.
  assert.strictEqual(f.one('t1').revival.mergeVetoed, 'revert-blocked',
    'and leaves the step it vetoed on the revival stamp, which outlives the cleared mark');
  assert.ok(!('mergedInto' in f.one('t1').revival),
    'while withholding mergedInto — the whole arm exists because that merge cannot be shown');
  // This fixture has run `revert-blocked` since the arm was written and asserted
  // nothing about its advice, which is how it emitted the WRONG advice for two
  // rounds. `revert-blocked` is the one step where the loop merged and
  // deliberately did not revert, so "confirm master still carries that merge"
  // answers yes by construction — the lead reads a landing, lets the branch go,
  // then runs the revert the loop asked them for, and the work is in neither
  // master's tree nor a ref. Asserted as a pair: the decision this arm owes, and
  // the absence of the check that would mislead.
  assert.match(reply1, /Decide the revert first/,
    'the revert-blocked arm asks for a DECISION about the owed undo, not a confirmation');
  assert.match(reply1, /deliberately did not revert/,
    'and says why master carries the merge — by design, not as evidence of a landing');
  assert.doesNotMatch(reply1, /still carries that merge/,
    'and never asks the lead to confirm something that is true by construction here');
  assert.doesNotMatch(reply1, /DELETES the branch/,
    'nor promises a delete the second accept may refuse on a kept tree');
  assert.strictEqual(exists(wt), true, 'ENTER: the tree is still there for the second accept to reclaim');

  const second = await accept(f, 't1');

  assert.deepStrictEqual(f.killed, ['team-hand-t1'], 'the second accept takes the ordinary merged path');
  assert.strictEqual(exists(wt), false, 'and removes the tree the first one preserved');
  assert.strictEqual(branches(f).includes('landed'), false, 'and deletes the branch');
  assert.match(second, /retired and its worktree removed/, 'the second reply reports the teardown it performed');
  // The veto's trace must not outlive the check it asked for. `_stampTicketRevival`
  // is write-once, so the merged arm's own stamp call is a no-op here and the
  // supersede is a separate write — without it the ticket keeps saying a merge
  // check is owed on a branch that is now deleted, the stale-mark class t535
  // fixed for `mergeError`.
  assert.ok(!('mergeVetoed' in f.one('t1').revival),
    'the second accept retires the veto trace it answered');
  assert.strictEqual(f.one('t1').revival.mergedInto, 'master',
    'and records the landing in its place, so the stamp says the check completed rather than going silent');
});

test('a demonstrably EMPTY branch is exempt from the veto — there is no work to protect', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  // The recorded fork point IS the branch tip, which is what makes the 0 count
  // evidence of an empty branch rather than of an already-merged one.
  const baseSha = execFileSync('git', ['-C', f.repoDir, 'rev-parse', 'landed'], { encoding: 'utf8' }).trim();
  const wt = pathReal.join(osReal.tmpdir(), `clodex-t536-wt-${Date.now()}`);
  execFileSync('git', ['-C', f.repoDir, 'worktree', 'add', '-q', wt, 'landed'], { encoding: 'utf8' });
  t.after(() => { try { fsReal.rmSync(wt, { recursive: true, force: true }); } catch {} });
  f.persistence.upsert({ name: 'team-hand-t1', cwd: wt, ephemeral: true, worktree: { path: wt, branch: 'landed', baseSha } });
  f.seat('team-hand-t1', f.repoDir);
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'suite' } });

  const msg = await accept(f, 't1');

  assert.match(msg, /has 0 commits beyond/, 'ENTER: the count really was measured against the recorded fork point');
  assert.doesNotMatch(msg, /MERGE FAILED/, 'the veto does not fire: an empty branch carries nothing a revert could have taken');
  assert.strictEqual(exists(wt), false, 'so the empty tree is still reclaimed');
});

// The confirmation sentence is branched on the STEP, and this is the half the
// broad veto makes reachable. `clean-tree` fails before `mergeNoFf` ever runs,
// so the loop made no merge commit at all — and the canonical recovery from it
// (session-manager.test.js's t535 subject) is the lead merging BY HAND and then
// accepting. Telling that lead to check master still carries "that merge", and
// to look for a `Revert "Merge …"` commit, describes a repository that never
// existed. The veto itself stays broad: an allowlist of vetoing steps would
// default a newly-added step to NOT vetoing, which is the unsafe direction.
test('a never-merged step does not advise confirming a merge the loop never made', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'clean-tree' } });

  const msg = await accept(f, 't1');

  assert.match(msg, /stamped this ticket MERGE FAILED at "clean-tree"/, 'ENTER: the never-merged step is the one being reported');
  assert.match(msg, /The loop never merged this branch/, 'the reply says the loop made no merge commit here');
  assert.doesNotMatch(msg, /Revert "Merge/, 'and does not send the lead hunting a revert of a merge that never happened');
  assert.doesNotMatch(msg, /still carries that merge/, 'nor ask them to confirm one');
  // The CAUSAL half, which over-claimed for two rounds. This arm covers every
  // step that is not one of the three named ones, and `merge` is among them —
  // `fail('merge', …)` fires AFTER `mergeNoFf` returned, both on an outright
  // failure and on exit-0-with-HEAD-unmoved. "Fails before the merge runs" is
  // therefore false of it, while "no merge commit came out of it" holds on every
  // step this arm serves. The load-bearing half was never wrong; the reason was.
  assert.match(msg, /no merge commit came out of that step/,
    'the reply claims only the absence of a merge commit, which holds for every step on this arm');
  assert.doesNotMatch(msg, /fails BEFORE the merge runs/,
    'and not the causal claim, which is false of the `merge` step that fails after mergeNoFf returned');
  // The VETO is unchanged by the wording split — this step still refuses teardown.
  assert.deepStrictEqual(f.killed, [], 'the veto still fires: a broad veto is the fail-safe direction');
});

// The other side of that split, so "does not mention a revert" above is not
// equally true of a build that dropped the revert sentence everywhere.
test('a step that DID merge still gets the revert-confirmation sentence', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'suite' } });

  const msg = await accept(f, 't1');

  assert.match(msg, /still carries that merge/, 'the suite step merged before it failed, so the confirmation is about that merge');
  assert.match(msg, /Revert "Merge …"/, 'and names the shape a revert of it leaves behind');
  assert.doesNotMatch(msg, /The loop never merged this branch/, 'and never claims the loop skipped the merge');
});

// The window nit 1 closes. `_taskAccept` loads the board at its top, then awaits
// `isMerged` and `commitsOnBranch` before the veto reads the stamp — and the
// auto-merge loop can stamp inside that window. Reading the stale snapshot there
// takes the TEARDOWN on a ticket that was marked MERGE FAILED microseconds ago,
// which is the residual form of the failure this whole ticket exists to prevent.
//
// Staged through a gitWorktree override rather than a timer: the stamp lands
// from inside the awaited `commitsOnBranch`, which is exactly where a real
// interleaving lands it, and it is deterministic. `isMerged` and `isDirty` are
// the real implementations so the arm still reaches the veto for real reasons.
test('a stamp landing DURING the accept is still seen — the veto re-reads the board', async (t) => {
  const real = require('../git-worktree');
  let stamped = false;
  const f = mkFixture(t, {
    gitWorktree: {
      ...real,
      commitsOnBranch: async (root, branch, base) => {
        // The loop stamps while accept is awaiting the count.
        if (!stamped) { stamped = true; f.m._stampMergeError(f.team, 't1', 'suite'); }
        return real.commitsOnBranch(root, branch, base);
      },
    },
  });
  f.seat('lead');
  const wt = f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  assert.ok(!('mergeError' in f.one('t1')),
    'ENTER: the ticket is UNSTAMPED when accept starts, so the snapshot it loads says teardown is fine');

  const msg = await accept(f, 't1');

  assert.strictEqual(f.one('t1').mergeError, undefined,
    'ENTER: the stamp really landed mid-accept and was then cleared by the terminal close');
  assert.ok(stamped, 'ENTER: the interleaving actually ran');
  assert.deepStrictEqual(f.killed, [], 'the veto sees the fresh stamp, not the snapshot, and destroys nothing');
  assert.strictEqual(exists(wt), true, 'so the tree survives a stamp that arrived mid-flight');
  assert.ok(branches(f).includes('landed'), 'and so does the branch');
  assert.match(msg, /MERGE FAILED at "suite"/, 'and the reply reports the mark that landed during the accept');
});

// nit 2: `unexpected` is the loop's CATCH-ALL and had no subject at all. It fires
// for a throw before `mergeNoFf` as readily as after one — its own escalation
// reads `nothing was merged` on that path — so grouping it with `suite` told the
// lead to confirm a merge, and to look for a `Revert "Merge …"` commit, that may
// never have existed. It gets its own arm: a merge MAY exist, which is not the
// same claim as one that does.
test('the catch-all step claims only that a merge MAY exist, and points at the escalation', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'unexpected' } });

  const msg = await accept(f, 't1');

  assert.match(msg, /MERGE FAILED at "unexpected"/, 'ENTER: the catch-all step is the one being reported');
  assert.match(msg, /whether one exists at all is unknown/,
    'the reply hedges: the catch-all fires on both sides of the merge, so a merge may or may not exist');
  assert.match(msg, /Read the escalation for this ticket first/,
    'and points at the one place that says which — the escalation names the sha where there is one');
  // Neither of the two confident sentences: not the reverted-merge confirmation
  // (there may be no merge), and not the never-merged claim (there may be one).
  assert.doesNotMatch(msg, /still carries that merge/, 'it does not assert a merge exists to be confirmed');
  assert.doesNotMatch(msg, /Revert "Merge …"/, 'nor name a revert commit that may never have existed');
  assert.doesNotMatch(msg, /The loop never merged this branch/, 'nor claim no merge was made, which it cannot know either');
  assert.deepStrictEqual(f.killed, [], 'and the veto still fires — the sentence narrows, the gate does not');
});

// nit 3: the silent erasure. The re-read closes the wide window, but a stamp can
// still land between it and `finish()`, which used to `delete row.mergeError`
// unconditionally on the closed-out arm — acting on the mark as absent and then
// erasing it, so a merge failure that is still true vanished from the board along
// with the branch. The teardown race itself is not fixable by re-reading (a stamp
// can always arrive after destroy()); this erasure is, by comparing before clearing.
test('a stamp landing after the veto read is not silently erased by the close', async (t) => {
  const real = require('../git-worktree');
  let stamped = false;
  const f = mkFixture(t, {
    gitWorktree: {
      ...real,
      // AFTER the veto's re-read: isDirty runs on the teardown path, below it.
      isDirty: async (p) => {
        if (!stamped) { stamped = true; f.m._stampMergeError(f.team, 't1', 'suite'); }
        return real.isDirty(p);
      },
    },
  });
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed' });

  assert.ok(!('mergeError' in f.one('t1')), 'ENTER: unstamped when accept starts, so the veto correctly does not fire');

  await accept(f, 't1');

  assert.ok(stamped, 'ENTER: the interleaving actually ran, after the veto had already read the board');
  assert.strictEqual(f.one('t1').mergeError, 'suite',
    'the mark this accept never saw SURVIVES the close — clearing it would erase a merge failure that is still true');
  assert.strictEqual(f.one('t1').closedOut, true, 'ENTER: on the terminal arm, where the clear runs at all');
});

// nit 3: the veto's trace on a ticket that was ALREADY stamped. `_stampTicketRevival`
// pins on `!t.revival`, so its first stamp wins and every later call is a no-op —
// which is right for the seat and session id it records (they name who did the
// work) and wrong for `mergeVetoed`, whose whole job is to say a check is owed on
// THIS accept. Without the targeted write the trace is missing on exactly the
// tickets that have been round the loop before, while the arm's comment claims it
// is what makes the owed check durable. A prompt caveat would have documented the
// hole; this closes it.
test('the veto stamps its trace even on a ticket an earlier retire already stamped', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });
  doneTicket(f, { assignee: 'team-hand-t1', branch: 'landed', over: { mergeError: 'suite' } });

  // An earlier retire's stamp, carrying the seat identity that must survive.
  const board = f.tstore.load(f.team.root);
  board[0].revival = { seat: 'team-hand-t1', sessionId: 'sess-earlier', branch: 'landed', worktree: '/earlier/path', at: 1 };
  f.tstore.save(f.team.root, board);
  assert.ok(!('mergeVetoed' in f.one('t1').revival),
    'ENTER: the pre-existing stamp carries no veto trace, and _stampTicketRevival will refuse to add one');

  await accept(f, 't1');

  assert.strictEqual(f.one('t1').revival.mergeVetoed, 'suite',
    'the veto writes its trace anyway — the write-once guard must not silence the owed check');
  assert.strictEqual(f.one('t1').revival.sessionId, 'sess-earlier',
    'while the earlier stamp\'s session id survives: only mergeVetoed is touched');
  assert.strictEqual(f.one('t1').revival.worktree, '/earlier/path',
    'and so does its path — that is the record of who did the work');
});

// ── t540: the stamp must find the ticket by ID, not by seat name ──────────────
//
// `_stampTicketRevival` located its ticket with
// `tickets.find((t) => t.assignee === seatName && !t.revival)`. Seat names
// recycle, so once a name is reused while an EARLIER ticket carrying it is still
// un-stamped, `find` returns the older row and the ticket actually being accepted
// gets nothing.
//
// A subject that stamps one ticket and asserts it got stamped passes against the
// unfixed code and proves nothing — the collision is the whole test, so it is
// built explicitly below and its ENTERs assert it really was built.
//
// The merge-veto arm is chosen deliberately over the plainer arms: there the
// stamp is the ONLY durable trace that a check is still owed (the arm is terminal
// and clears the `MERGE FAILED` mark it just acted on), and the targeted fallback
// write beneath it is guarded on `row.revival` ALREADY existing — so a misrouted
// write-once stamp takes the fallback down with it. Both paths fail together, on
// exactly the tickets the arm's comment claims are covered.
test('the stamp lands on the ACCEPTED ticket, not on an older one sharing the recycled seat name', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  f.worktreeSeat('team-hand-t1', 'landed', { ephemeral: true });

  // The collision, built by hand rather than through doneTicket (which writes a
  // one-ticket board): an OLDER ticket the same seat name once worked, still
  // un-stamped, sitting AHEAD of the accepted ticket in board order — which is
  // what makes the un-narrowed `find` return it.
  f.tstore.save(f.team.root, [
    {
      id: 't0', state: 'done', spec: 'the earlier ticket this seat name once worked',
      assignee: 'team-hand-t1', role: 'hand', taskDir: 'tasks/t0-fixture/SPEC.md',
      openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand-t1', lastActivityAt: 2,
      worktree: { branch: 'landed' },
    },
    {
      id: 't1', state: 'done', spec: 'spec for t1',
      assignee: 'team-hand-t1', role: 'hand', taskDir: 'tasks/t1-fixture/SPEC.md',
      openedAt: 10, startedAt: 10, closedAt: 20, closedBy: 'team-hand-t1', lastActivityAt: 20,
      worktree: { branch: 'landed' }, mergeError: 'suite',
    },
  ]);

  const board = f.tstore.load(f.team.root);
  assert.deepStrictEqual(board.map((x) => x.id), ['t0', 't1'],
    'ENTER: the older ticket really is ahead of the accepted one, so a seat-name find returns IT first');
  assert.deepStrictEqual(board.map((x) => x.assignee), ['team-hand-t1', 'team-hand-t1'],
    'ENTER: and both carry the same recycled seat name — without this there is no collision to route around');
  assert.ok(!('revival' in board[0]) && !('revival' in board[1]),
    'ENTER: neither is stamped yet, so the write-once guard excludes neither from the find');
  assert.strictEqual(f.one('t1').mergeError, 'suite',
    'ENTER: the accepted ticket carries the mark that reaches the merge-veto arm, where the stamp is the only durable trace');

  const msg = await accept(f, 't1');

  assert.match(msg, /stamped this ticket MERGE FAILED at "suite"/,
    'ENTER: the veto arm really ran — the arm whose trace the stamp is');
  assert.strictEqual(f.one('t1').closedOut, true,
    'ENTER: and it is terminal, so it cleared the mark and nothing but the stamp still says a check is owed');

  assert.ok(f.one('t1').revival, 'the ACCEPTED ticket is stamped');
  assert.strictEqual(f.one('t1').revival.mergeVetoed, 'suite',
    'and carries the veto trace — the fallback write beneath it is guarded on revival existing, so a misrouted stamp loses this too');
  assert.strictEqual(f.one('t1').revival.seat, 'team-hand-t1', 'naming the seat that did the work');
  // The other direction, and the half that fails against the unfixed code: an
  // assertion that t1 is stamped is equally true of a build that stamped BOTH.
  assert.ok(!('revival' in f.one('t0')),
    'while the older ticket is left alone — it is not the ticket this accept was about');
});

// The constraint that shapes the fix: team-retire has no ticket id to narrow
// with. It is retiring a SEAT, and the seat name is its only handle on the
// ticket — so `ticketId` had to be an optional narrowing rather than a
// replacement. Without this subject an id-scoped signature that quietly stamped
// nothing on retire would ship green, and a discard's stamp is the ONLY
// surviving trace of the session and branch a hotfix would start from.
test('team-retire still stamps by seat name, with no ticket id available to narrow with', async (t) => {
  const f = mkFixture(t);
  f.seat('lead');
  // `team-hand-1` rather than `team-hand-t1`: matchSeatRole strips a numeric
  // tail, so this resolves to the `hand` role and the retire takes the ARCHIVE
  // disposition — no real tree is destroyed by this subject.
  f.worktreeSeat('team-hand-1', 'landed', { ephemeral: false });
  // The id bears no relation to the seat name: nothing at the retire call site
  // could reconstruct it, which is the point.
  f.tstore.save(f.team.root, [{
    id: 't7', state: 'done', spec: 'spec for t7',
    assignee: 'team-hand-1', role: 'hand', taskDir: 'tasks/t7-fixture/SPEC.md',
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand-1', lastActivityAt: 2,
    worktree: { branch: 'landed' },
  }]);

  assert.ok(!('revival' in f.one('t7')),
    'ENTER: the ticket is un-stamped, so a stamp appearing below was written by this retire');
  assert.strictEqual(f.one('t7').assignee, 'team-hand-1',
    'ENTER: and the seat name is the only handle the retire path has on it');

  await f.m._handleTeamRetire('team-hand-1', 'lead');

  assert.ok(f.one('t7').revival, 'the retire found its ticket by seat name alone');
  assert.strictEqual(f.one('t7').revival.disposition, 'archive',
    'ENTER: on the archive disposition — this subject destroys no tree');
  assert.strictEqual(f.one('t7').revival.seat, 'team-hand-1',
    'and the stamp names the seat, which on a discard is the only surviving trace of it');
  assert.strictEqual(f.one('t7').revival.branch, 'landed',
    'along with the branch a hotfix would start from');
});
