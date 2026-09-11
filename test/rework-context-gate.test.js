'use strict';
// Run: node --test test/rework-context-gate.test.js
//
// t827 — a rework is never delivered into a ticket seat whose context is past the
// compact threshold. The loop archives that seat and spawns a fresh one onto the
// SAME branch and the SAME worktree, and the reject reply names both.
//
// The defect this closes was measured, not imagined: hand-825 took two rework
// rounds starting at 200k+ tokens and reached 320k before the operator compacted
// it by hand. It was never nudged, because the ctx tick suppresses `ctxwarn` for
// every `ephemeral` seat on the reasoning that a seat retired at `done` would
// pay a compact for context its rework needs. That reasoning is right while the
// seat is finishing its own round and inverts at the instant new work arrives:
// what a rework needs is the BRANCH — the commits and JOURNAL.md, which a fresh
// seat reads for the price of a diff — and not the transcript, which the heavy
// seat re-bills on every turn. This gate is the counterweight on that one path;
// the suppression itself is deliberately untouched.
//
// AGAINST A REAL TREE. The subject is "the fresh seat lands on the SAME tree",
// and a fixture with a fabricated worktree record could not tell a reuse from a
// silent re-creation — the two differ only in whether git was asked. So the
// fixture makes a real repo, a real `git worktree add`, and lets the real
// `_existingTicketTree` answer. `create()` and the pty are the only stubs.
//
// THE SPAWN IS DEFERRED and the reject handlers are SYNCHRONOUS: the rework text
// rides the fresh seat's spec dispatch (the only write that reaches a seat still
// booting), so every assertion about what the seat was told is made after
// `settle()` has let the setImmediate run.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { initStores } = require('../stores');
const { createRemindScheduler } = require('../remind-scheduler');
const { createTeamManifest } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { assertTicketDepsCovered } = require('./lib/loop-fixture-deps');
const { CTX_REMINDER_NUDGE_TOKENS } = require('../ctx-reminder');

const SEED_DIR = mkTmpRoot('clodex-t827-seed-');

const real = (p) => { try { return fsReal.realpathSync(p); } catch { return pathReal.resolve(p); } };

const OVER = 200_000;
const UNDER = 100_000;

// One commit, then a real linked worktree on the ticket's branch holding a second
// commit — the shape a hand leaves behind. The second commit matters: the rework
// prefix names the branch HEAD, and a tree whose HEAD equalled master's could not
// tell a read of the tree from a read of the root.
function mkWorld() {
  const home = mkTmpRoot('clodex-t827-home-');
  const userData = mkTmpRoot('clodex-t827-ud-');
  const repo = real(mkTmpRoot('clodex-t827-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't827@example.invalid');
  git('config', 'user.name', 't827');
  fsReal.writeFileSync(pathReal.join(repo, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').trim();
  const treePath = real(mkTmpRoot('clodex-t827-tree-')) + '-wt';
  git('worktree', 'add', '-q', '-b', 't1-work', treePath, 'HEAD');
  fsReal.writeFileSync(pathReal.join(treePath, 'work.txt'), 'the hand did this\n');
  execFileSync('git', ['-C', treePath, 'add', 'work.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', treePath, 'commit', '-q', '-m', 'round one'], { stdio: 'pipe' });
  const head = execFileSync('git', ['-C', treePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { home, userData, repo, treePath, baseSha, head };
}

function mkFixture(world) {
  const { home, userData, repo, treePath } = world;
  const manifest = createTeamManifest({ fs: fsReal, clodexHome: home });
  const scheduler = createRemindScheduler({
    now: () => Date.now(),
    setTimer: () => null,
    clearTimer: () => {},
    store: initStores(userData, { log: console, registryDir: SEED_DIR }).reminders,
    deliver: () => {},
  });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repo, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { brief: 'the lead', dispatch: 'standing' },
      hand: { brief: 'the hand', dispatch: 'worktree' },
      reviewer: { brief: 'the reviewer', dispatch: 'standing' },
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
    setWorktree: (n, wt) => {
      const e = store.find((x) => x.name === n);
      if (e) e.worktree = wt;
    },
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };
  const injected = [];
  const gated = [];
  const logs = [];
  let uiSettings = {};
  // The worktree is a SIBLING of the root, not a child, so the prefix test the
  // light fixtures use would report the fresh seat as belonging to no team and
  // `_ticketAssigneeSeat` could never resolve it. Both paths resolve to this team.
  const inTeam = (cwd) => !!(cwd && (cwd.startsWith(repo) || cwd.startsWith(treePath)));
  const deps = {
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => uiSettings }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    listAllTemplates: () => [],
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
    resolveTeam: (cwd) => (inTeam(cwd) ? team : null),
    findProjectRoot: (cwd) => (inTeam(cwd) ? repo : null),
    AGENT_NAME_RE: require('../catalogs').AGENT_NAME_RE,
    DEFAULT_WORKSPACE_ID: require('../catalogs').DEFAULT_WORKSPACE_ID,
    getRemindScheduler: () => scheduler,
    getUserDataPath: () => userData,
    isAlive: () => true,
    addRole: manifest.addRole,
    setRole: manifest.setRole,
    removeRole: manifest.removeRole,
    renameRole: manifest.renameRole,
    setTeamWatchdog: manifest.setTeamWatchdog,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const archived = [];
  const killed = [];
  const created = [];
  const seat = (name, cwd, ctxInfo = null) => {
    m.sessions.set(name, {
      name, type: 'claude', agentType: 'claude', cwd, workspaceId: 'default',
      pty: { pid: 1 }, activityState: 'idle', ...(ctxInfo ? { ctxInfo } : {}),
    });
    return m.sessions.get(name);
  };
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
  m._advanceSeat = () => null;
  m._writeTicketCost = () => {};
  m._retireReviewSeatsFor = () => [];
  // Seats the session the way create() does, so the deferred spec dispatch can
  // resolve the fresh seat. Its cwd is whatever _spawnTicketSeat computed, which
  // is the tree — asserting on it is how "spawned INTO the tree" is measured.
  m.create = async (name, type, cwd) => { created.push({ name, cwd }); seat(name, cwd); };
  // Stubbed for the reason every loop fixture stubs it: the real one arms a 5s
  // SIGKILL against this fixture's fake `pid: 1`, which is init. The STATE it
  // leaves — record kept, `archivedAt` set — is what the subjects read.
  m.archive = async (name) => { archived.push(name); persistence.setArchived(name, true); };
  m.kill = async (name) => { killed.push(name); persistence.remove(name); m.sessions.delete(name); };
  return {
    m, team, tstore, persistence, injected, gated, logs, archived, killed, created, seat, deps,
    setUiSettings: (v) => { uiSettings = v; },
    one: (id = 't1') => tstore.load(team.root).find((t) => t.id === id),
  };
}

// The board a rework lands on: the hand has closed, the loop verified, the ticket
// is `done` at `loopStep: 'review'` and pinned to a seat holding a real tree.
//
// `tok`/`ephemeral` are the two inputs the gate reads; `standing` drops the
// persistence record's `ephemeral` flag, which is what a lead's own long-lived
// seat looks like.
function ready(f, world, { tok = OVER, standing = false, noCtx = false, noTree = false } = {}) {
  f.seat('lead', world.repo);
  f.persistence.upsert({ name: 'lead', ephemeral: false });
  f.seat('team-hand-1', world.treePath, noCtx ? null : { tok, pct: 50, size: 1000000 });
  f.persistence.upsert({
    name: 'team-hand-1',
    ...(standing ? { ephemeral: false } : { ephemeral: true }),
    worktree: { path: world.treePath, branch: 't1-work', main: world.repo },
  });
  f.tstore.save(f.team.root, [{
    id: 't1', state: 'done', spec: 'the original spec body', assignee: 'team-hand-1', role: 'hand',
    taskDir: 'tasks/t1-fixture/SPEC.md',
    openedAt: 1, startedAt: 1, closedAt: 2, closedBy: 'team-hand-1',
    lastActivityAt: 2, loopStep: 'review',
    ...(noTree ? {} : { worktree: { path: world.treePath, branch: 't1-work', baseSha: world.baseSha } }),
  }]);
  return f.one();
}

const leadReject = (f, reason = 'the guard is inverted') =>
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: reason });

// `_spawnTicketSeat` defers everything past the synchronous record stub into a
// setImmediate and then awaits real git, so a single tick is not enough.
async function settle() {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
}

const FRESH = 'team-hand-1-r2';

test('mkFixture injects every dep team-tickets.js reads', () => {
  const f = mkFixture(mkWorld());
  assertTicketDepsCovered(assert, f.deps, {
    optional: ['ticketSuiteTimeoutMs', 'resolveSystemPromptFile', 'gatherTeam',
      'createTeam', 'kitCatalog', 'resolveKit', 'setLead', 'teamsDir', 'listTeams', 'loadManifest',
      'refreshAppMenu', 'getSandboxManager', 'fetch'],
  });
});

// ── (a) the lead's reject, seat past the threshold ─────────────────────────

test("a lead reject at 200k archives the heavy seat and spawns a fresh one on the SAME branch and tree", async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  const t0 = ready(f, world, { tok: OVER });
  assert.strictEqual(t0.assignee, 'team-hand-1', 'ENTER: the ticket is pinned to the heavy seat');
  assert.ok(OVER >= CTX_REMINDER_NUDGE_TOKENS,
    `ENTER: ${OVER} is past the shipped nudge threshold — otherwise this subject measures the under-threshold arm`);

  leadReject(f);
  await settle();

  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: the reject landed and reopened the ticket');
  assert.strictEqual(t.assignee, FRESH, 'the ticket is re-pinned to the fresh seat');
  assert.strictEqual(t.role, 'hand', 'and still filed under the role, so the resolver and the rollup still see it');
  assert.deepStrictEqual(f.archived, ['team-hand-1'],
    'the heavy seat was ARCHIVED — the tree it is sitting in must survive');
  assert.deepStrictEqual(f.killed, [],
    'and never killed or destroyed: kill removes the record and destroy removes the TREE, '
    + 'which is the only thing the previous round left behind');
  const rec = f.persistence.get('team-hand-1');
  assert.ok(rec, 'the archived seat keeps its persistence record, so the operator can unarchive it');
  assert.ok(typeof rec.archivedAt === 'number' && rec.archivedAt > 0, 'and the record says archived');

  // The tree identity, read off the BOARD rather than off the spawn's arguments:
  // a re-created tree would have taken a fresh path from createWorktree's
  // numeric disambiguation and overwritten this.
  assert.strictEqual(t.worktree.path, world.treePath, 'the ticket still names the SAME worktree path');
  assert.strictEqual(t.worktree.branch, 't1-work', 'on the same branch');
  assert.strictEqual(t.worktree.baseSha, world.baseSha,
    'and keeps its fork point — losing it silently disables the loop (loopEligible reads branch && baseSha)');
  const spawn = f.created.find((c) => c.name === FRESH);
  assert.ok(spawn, 'the fresh seat was really spawned, not merely pinned');
  assert.strictEqual(real(spawn.cwd), world.treePath, 'INTO the existing tree');
  // The commit the previous seat left is still there: a reset or a re-create
  // would have taken the branch back to the fork point.
  assert.ok(fsReal.existsSync(pathReal.join(world.treePath, 'work.txt')),
    "the previous seat's committed work is still in the tree — the reuse arm neither recreated nor reset it");
});

test("the fresh seat's first write opens with the rework prefix, ahead of the spec", async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: OVER });

  leadReject(f, 'the retry bound is still off by one');
  await settle();

  const to = f.gated.filter((g) => g.target === FRESH);
  assert.strictEqual(to.length, 1,
    'exactly ONE write reaches the fresh seat: a second write into a booting CLI destroys the first one\'s draft');
  const body = to[0].body;
  assert.ok(body.startsWith('REWORK on a FRESH seat: the previous seat (team-hand-1) was replaced at ~200k tokens.'),
    `the body OPENS with the replacement notice, before anything else — got: ${body.slice(0, 120)}`);
  assert.match(body, /Your branch t1-work at [0-9a-f]{7,40} carries its commits/,
    'and names the branch and the HEAD sha the commits are at');
  assert.ok(body.includes(`git log --oneline ${world.baseSha}..HEAD`),
    'with the log range anchored on the recorded fork point, not a guess');
  assert.match(body, /JOURNAL\.md in your tree before touching anything/,
    'and points at the journal, which is the whole substitute for the discarded transcript');
  assert.match(body, /the retry bound is still off by one/, 'the must-fixes themselves ride the same write');
  assert.match(body, /the original spec body/, 'as does the spec, so the fresh seat needs no second dispatch');
  assert.ok(body.indexOf('REWORK on a FRESH seat') < body.indexOf('the retry bound is still off by one'),
    'prefix BEFORE must-fixes');
  assert.ok(body.includes(`WORK IN: ${world.treePath}`),
    'and the WORK IN: line rides it, so the fresh seat knows where the branch is checked out');

  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand-1'), [],
    'the ARCHIVED seat is told nothing: it is being retired, and a rework written into it is a rework nobody reads');
});

test("the lead's reply and the log name both seats, so the lead can see where the ticket went", async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: OVER });

  leadReject(f);
  await settle();

  const reply = f.injected.find((x) => x.includes('reopened (rework)'));
  assert.ok(reply, 'ENTER: the reject replied at all');
  assert.match(reply, /seat team-hand-1 replaced by team-hand-1-r2/, 'the reply names the seat that went and the one that came');
  assert.match(reply, /context ~200k, past the 175k compact threshold/, 'with the number and the line it crossed');
  assert.match(reply, /same branch and tree/, 'and says the work was not lost, which is the lead\'s first question');
  const line = f.logs.find((l) => l.msg && l.msg.startsWith('task reject t1'));
  assert.ok(line && line.msg.includes('replaced by team-hand-1-r2'),
    'the log carries the same sentence — a reply and a log that disagree about the holder is the drift this renderer exists to prevent');
});

test('the replacement is stamped on the ticket, so a later reader can see the round changed hands', async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: OVER });

  leadReject(f);
  await settle();

  const stamps = f.one().seatReplacements;
  assert.ok(Array.isArray(stamps) && stamps.length === 1, 'one stamp for one replacement');
  assert.strictEqual(stamps[0].prev, 'team-hand-1');
  assert.strictEqual(stamps[0].next, FRESH);
  assert.strictEqual(stamps[0].tokens, OVER, 'the measurement that drove it, not a re-derivation');
  assert.strictEqual(typeof stamps[0].at, 'number', 'and when');
});

// ── (b)(c)(d) the three arms that must NOT replace ─────────────────────────

for (const arm of [
  {
    what: 'a seat under the threshold',
    opts: { tok: UNDER },
    why: 'a seat with room left is cheaper to keep than to re-brief',
  },
  {
    what: 'a seat that has never reported a context size',
    opts: { noCtx: true },
    why: 'unknown is not heavy — a codex seat and one that has not taken a turn both look like this',
  },
  {
    what: 'a STANDING seat at 200k',
    opts: { tok: OVER, standing: true },
    why: "a standing seat is the operator's own long-lived session, not the loop's to archive",
  },
  {
    what: 'a ticket with no worktree at 200k',
    opts: { tok: OVER, noTree: true },
    why: 'the prefix promises commits on a branch, and a spawn seat has neither — '
      + 'its work is UNCOMMITTED in the shared checkout and replacing it would discard exactly that',
  },
]) {
  test(`${arm.what} keeps the rework: ${arm.why}`, async () => {
    const world = mkWorld();
    const f = mkFixture(world);
    ready(f, world, arm.opts);

    leadReject(f, 'the guard is inverted');
    await settle();

    const t = f.one();
    assert.strictEqual(t.state, 'open', 'ENTER: the reject landed — otherwise this passes by having done nothing');
    assert.strictEqual(t.assignee, 'team-hand-1', 'the ticket stays pinned to the seat that has it');
    assert.deepStrictEqual(f.archived, [], 'nothing was archived');
    assert.deepStrictEqual(f.created, [], 'and no fresh seat was spawned');
    assert.strictEqual(t.seatReplacements, undefined, 'no replacement stamp');
    const to = f.gated.filter((g) => g.target === 'team-hand-1');
    assert.strictEqual(to.length, 1, 'the rework went to the existing seat, once');
    assert.ok(!to[0].body.startsWith('REWORK on a FRESH seat'),
      'and it is an ordinary rejection, with no replacement notice in front of it');
    assert.match(to[0].body, /the guard is inverted/, 'carrying the must-fixes');
    const reply = f.injected.find((x) => x.includes('reopened (rework)'));
    assert.ok(reply && !reply.includes('replaced by'), 'and the reply claims no replacement');
  });
}

// ── an operator-lowered threshold governs this gate too ────────────────────

test('an operator threshold below the shipped one replaces a seat the default would have kept', async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: UNDER });
  assert.ok(UNDER < CTX_REMINDER_NUDGE_TOKENS,
    'ENTER: this seat is UNDER the shipped threshold, so only the override can move it');
  f.setUiSettings({ ctxReminderThresholds: { default: { nudge: 80_000, escalate: 120_000 } } });

  leadReject(f);
  await settle();

  assert.strictEqual(f.one().assignee, FRESH,
    'the gate reads the operator override at decision time, exactly as the ctx watcher does — '
    + 'a memoized threshold would ignore an edit until a restart');
  assert.match(f.injected.find((x) => x.includes('reopened (rework)')), /past the 80k compact threshold/,
    'and reports the threshold that actually applied, not the shipped one');
});

// ── (e) the loop's reject path ─────────────────────────────────────────────

test("the loop's reject replaces a heavy seat the same way the lead's does", async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: OVER });

  const r = f.m._rejectTicketFromLoop(f.team, 't1', 'SUITE RED: three failures in widget.test.js');
  await settle();

  assert.strictEqual(r.ok, true, 'ENTER: the loop reject succeeded');
  assert.strictEqual(r.seat, FRESH, 'and reports the seat the rework actually reached, not the one it found');
  assert.strictEqual(f.one().assignee, FRESH, 'the ticket is re-pinned to the fresh seat');
  assert.deepStrictEqual(f.archived, ['team-hand-1'], 'the heavy seat was archived');
  const to = f.gated.filter((g) => g.target === FRESH);
  assert.strictEqual(to.length, 1, 'one write, carrying both the prefix and the spec');
  assert.ok(to[0].body.startsWith('REWORK on a FRESH seat'), 'with the replacement notice first');
  assert.match(to[0].body, /SUITE RED: three failures in widget\.test\.js/, 'and the loop\'s reason inside it');
  const line = f.logs.find((l) => l.msg && l.msg.includes('rejected by the loop'));
  assert.ok(line && line.msg.includes('replaced by team-hand-1-r2'),
    'the loop logs the same replacement sentence the lead\'s reply carries');
  const toLead = f.gated.find((g) => g.target === 'lead' && g.body.includes('REJECTED by the loop'));
  assert.ok(toLead, 'ENTER: the lead was notified at all');
  assert.match(toLead.body, /sent back to team-hand-1-r2 for rework \(round 1\) — seat team-hand-1 replaced by/,
    'and the notice names the FRESH seat as the holder — naming the archived one would send the lead to a dead row');
});

// ── a follow-up must-fix is new work too ───────────────────────────────────

test('a follow-up must-fix onto a heavy seat replaces it, exactly as a reopen does', async () => {
  const world = mkWorld();
  const f = mkFixture(world);
  ready(f, world, { tok: UNDER });

  leadReject(f, 'round one: the guard is inverted');
  await settle();
  assert.strictEqual(f.one().assignee, 'team-hand-1',
    'ENTER: the first reject kept the seat, so the ticket is open for rework on the seat under test');

  // The seat has been working the round and is now heavy — the state hand-825
  // was in when its SECOND round of must-fixes arrived.
  f.m.sessions.get('team-hand-1').ctxInfo = { tok: OVER, pct: 60, size: 1000000 };
  leadReject(f, 'and the empty case is still wrong');
  await settle();

  assert.match(f.injected.join('\n'), /already open for rework/, 'ENTER: the follow-up arm was taken, not a second reopen');
  assert.strictEqual(f.one().assignee, FRESH, 'the follow-up went to a fresh seat');
  assert.deepStrictEqual(f.archived, ['team-hand-1'], 'and the heavy one was archived');
  const to = f.gated.filter((g) => g.target === FRESH);
  assert.strictEqual(to.length, 1, 'one write');
  assert.ok(to[0].body.startsWith('REWORK on a FRESH seat'), 'opening with the replacement notice');
  assert.match(to[0].body, /and the empty case is still wrong/, 'and carrying the new must-fixes');
  assert.strictEqual(f.one().reworkRound, 1,
    'the follow-up still opens no round: replacing the seat is about WHO holds the work, not about how many times it was sent back');
});

// ── the merged-nudge backstop is not spent by round 1 ──────────────────────
//
// `_sweepMergedUnaccepted` gates on `mergedNudgedAt` being absent, so a stamp
// left on the record by round 1 silences the backstop for every later round —
// and the later rounds are where an unaccepted merge is most likely, because the
// lead has already moved on once.

for (const arm of [
  { what: "the lead's reject", run: (f) => leadReject(f, 'the guard is inverted') },
  { what: "the loop's reject", run: (f) => f.m._rejectTicketFromLoop(f.team, 't1', 'SUITE RED') },
]) {
  test(`${arm.what} clears the merged-nudge stamp, so a later round is nudged again`, async () => {
    const world = mkWorld();
    const f = mkFixture(world);
    ready(f, world, { tok: UNDER });
    const board = f.tstore.load(f.team.root);
    board[0].mergedAt = Date.now() - (60 * 60 * 1000);
    board[0].mergedNudgedAt = Date.now() - (30 * 60 * 1000);
    f.tstore.save(f.team.root, board);
    assert.strictEqual(typeof f.one().mergedNudgedAt, 'number',
      'ENTER: round 1 has already spent its nudge — the state that silenced every later round');

    arm.run(f);
    await settle();

    assert.strictEqual(f.one().mergedNudgedAt, undefined,
      'the reopen clears it with the accept stamps beside it: the stamp describes the round this reject just ended');

    // And the sweep really does fire again, rather than the field merely being
    // absent: the gate is what the deletion exists to re-open.
    const t2 = f.tstore.load(f.team.root);
    t2[0].state = 'done';
    t2[0].mergedAt = Date.now() - (60 * 60 * 1000);
    t2[0].acceptedBy = 'lead';
    f.tstore.save(f.team.root, t2);
    f.gated.length = 0;
    f.m._sweepMergedUnaccepted(f.team, f.tstore.load(f.team.root), Date.now());
    const nudge = f.gated.find((g) => g.target === 'lead' && g.body.includes('merged'));
    assert.ok(nudge && nudge.body.includes('not accepted'),
      'round 2 gets its own nudge — with the stamp left behind this sweep would have skipped the ticket silently');
  });
}
