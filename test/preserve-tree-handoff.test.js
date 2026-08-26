'use strict';
// Run: node --test
//
// t491 — a restarting seat can have its tree claimed underneath it, and the
// preserve must not put the pointer back.
//
// THE WINDOW, and why it is not theoretical. `kill()` removes the persistence
// record SYNCHRONOUSLY and then only signals the pty; the session leaves
// `this.sessions` much later, in `ptyProc.onExit`. Between those two moments the
// seat is LIVE IN ITS TREE AND NAMED BY NO RECORD, and `_ticketTreeHolder` reads
// occupancy off the RECORD — so it cannot see it. Every in-place restart then
// sits in that state for the whole of `waitForSessionExit`, which polls on a
// 100ms timer for up to 8 seconds. A `[agent:task assign` landing there:
//
//   1. `_ticketTreeHolder` returns null, so the occupancy refusal does not fire;
//   2. `_existingTicketTree` asks the same question and reuses the tree;
//   3. `claimTree` writes the new seat's pointer and scans the record set to
//      clear every OTHER record naming that tree — and the restarting seat has
//      no record to clear;
//   4. `_preserveAcrossRestart` re-seeds `worktree` from the PRE-KILL snapshot.
//
// Two records, one tree. `session:kill` reads `entry.worktree` to know what to
// remove, so Delete Session… on the restarted row `worktree remove --force`s the
// checkout the other seat is committing in — the state claimTree's own comment
// (team-tickets.js) calls worse than the orphan it was fixing.
//
// NOT INTRODUCED BY t489. engine.js's restart CATCH arm re-upserts the whole
// pre-kill snapshot, `worktree` included, and predates ALWAYS_PRESERVE entirely.
// t489 widened the set of paths that re-seed the field, not the window.
//
// AGAINST THE REAL DISPATCH PATH. The subject is an interleaving between two
// subsystems, so a fixture that models either half proves nothing about the
// seam: this drives the real `_handleTask`, the real `_spawnTicketSeat`, the
// real `claimTree`, the real `restartSession`, a real `team.json` and a real git
// repo. `create()` and the pty are the only stubs, and the pty stub exists
// precisely to hold the window open the way a real CLI's shutdown does.
//
// ORDERING. `startRestart()` returns after ONE macrotask, which is what puts the
// seat in the invisible state; the dispatch is fired from there. Both interleave
// orderings are broken WITHOUT the guard and in DIFFERENT ways — claim-then-seed
// leaves two records, seed-then-claim leaves the restarted seat naming nothing —
// which is why the assertion is on the record SET and not on one row.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEngine } = require('../engine');
const clodexPaths = require('../clodex-paths');
const { createTicketsStore } = require('../tickets-store');

// Realpath'd: on macOS /tmp is a symlink to /private/tmp, and git prints the
// canonical form while a record can carry the path as created. The guard under
// test compares canonically for exactly this reason, so the fixture must not
// accidentally make the two agree by string luck.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// A real repo with one real commit — `git worktree add` refuses to fork from a
// repo with no commits — plus the team manifest the dispatch resolves against.
// Two worktree-dispatch roles: the collision needs the re-dispatch to mint a
// DIFFERENT seat name, and the name is derived from the role.
function mkWorld() {
  const tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t491-')));
  const registryDir = path.join(tmp, 'clodex-home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't491@example.invalid');
  git('config', 'user.name', 't491');
  git('commit', '-q', '--allow-empty', '-m', 'base');

  fs.mkdirSync(path.join(registryDir, 'teams', 'team'), { recursive: true });
  fs.writeFileSync(path.join(registryDir, 'teams', 'team', 'team.json'), JSON.stringify({
    name: 'team', root: repo, lead: 'lead', version: 3,
    roles: {
      lead: { brief: 'the lead', dispatch: 'standing' },
      hand: { brief: 'the hand', dispatch: 'worktree' },
      builder: { brief: 'the builder', dispatch: 'worktree' },
    },
  }));

  const eng = createEngine({
    userDataPath: tmp,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const P = eng.stores.persistence;
  const m = eng.manager;
  const tstore = createTicketsStore({ clodexHome: registryDir });

  // The pty stub is the load-bearing one. `kill()` signals and returns; the
  // session leaves the map only when the process actually dies. Deferring the
  // map delete by a timer is what reproduces the real gap between "record gone"
  // and "session gone" — a stub that deleted synchronously would close the
  // window in the fixture and the test would pass against the bug.
  const seat = (name, cwd) => {
    const s = {
      name, type: 'claude', agentType: 'claude', cwd, workspaceId: 'default',
      activityState: 'idle',
      pty: { pid: 1, kill() { setTimeout(() => m.sessions.delete(name), 30); } },
    };
    m.sessions.set(name, s);
    return s;
  };
  m.create = async (...args) => {
    seat(args[0], args[2]);
    // create()'s rebuild upsert, reduced to the part that matters: it
    // spread-MERGES over whatever the preserve seeded and writes these keys and
    // NOT `worktree`. Modelling it is what makes the assertions read as
    // "survived the restart" rather than "was seeded and never overwritten".
    P.upsert({ name: args[0], type: args[1], cwd: args[2], sessionId: args[4] || null });
    return { name: args[0], backend: null };
  };
  const said = [];
  m._injectText = (_s, t) => { said.push(t); return { queued: true }; };
  m._gatedDeliver = (_t, _s, body) => { said.push(`GATED:${body}`); return { queued: true }; };
  m._broadcast = () => {};
  m._sendToSession = () => {};

  return { tmp, repo, registryDir, eng, P, m, tstore, seat, said };
}

async function until(cond, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// A dispatched ticket with a live worktree seat sitting in its tree. Returns the
// tree as the TICKET records it, which is what the re-dispatch will reuse.
async function dispatch(w) {
  w.P.upsert({ name: 'lead', type: 'claude', cwd: w.repo, workspaceId: 'default' });
  w.seat('lead', w.repo);
  const lead = w.m.sessions.get('lead');
  w.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  // The dispatch precondition every worktree fixture in this suite supplies: a
  // ticket with no `tasks/…` path is refused before it mints anything, and the
  // refusal is about artifact resolution, not the seam under test.
  const ts = w.tstore.load(w.repo);
  for (const t of ts) {
    if (!t.taskDir) t.taskDir = path.join(clodexPaths.projectDirFor(w.registryDir, w.repo), 'tasks', `${t.id}-fixture`, 'SPEC.md');
  }
  w.tstore.save(w.repo, ts);
  w.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.ok(await until(() => w.m.sessions.has('team-hand-1')),
    `ENTER: the worktree dispatch must have spawned its seat — replies: ${JSON.stringify(w.said)}`);
  const tree = (w.tstore.load(w.repo).find((t) => t.id === 't1') || {}).worktree;
  assert.ok(tree && tree.path, 'ENTER: the ticket must name a real tree, or there is nothing to contend');
  assert.ok(fs.existsSync(tree.path), 'ENTER: and git actually made it');
  assert.strictEqual(w.m._ticketTreeHolder(tree.path), 'team-hand-1',
    'ENTER: the occupancy gate resolves the seat BEFORE the restart — this is the answer the window changes');
  return tree;
}

// Begins the restart and returns with the seat in the invisible state: record
// removed by kill(), session still in the map. Returns the pending promise; the
// caller fires the dispatch into the gap and awaits it afterwards.
function startRestart(w, name) {
  const p = w.eng.restartSession(name, {}, 'default');
  return p;
}

// The records naming `treePath`, canonically, sorted. The record SET is the
// subject: which single row wins is an ordering detail, "more than one" is the
// bug.
function namingTree(P, treePath) {
  return P.list()
    .filter((e) => e && e.worktree && e.worktree.path && real(e.worktree.path) === real(treePath))
    .map((e) => e.name)
    .sort();
}

test('a tree claimed while its seat restarts is NOT re-seeded onto the restarted record', async () => {
  const w = mkWorld();
  const tree = await dispatch(w);
  const restart = startRestart(w, 'team-hand-1');
  // One macrotask past kill(). Not a "give it a moment" sleep: this is the state
  // the whole ticket is about, and the three ENTERs below are what prove the
  // test reached it rather than racing past it.
  await new Promise((r) => setTimeout(r, 5));

  assert.strictEqual(w.P.get('team-hand-1'), null,
    'ENTER: kill() must have REMOVED the record — with it present, claimTree finds a row to clear and the '
    + 'window this test is about does not exist');
  assert.ok(w.m.sessions.has('team-hand-1'),
    'ENTER: and the seat must still be LIVE — a seat already out of the map is an ordinary dead-seat handoff, '
    + 'not the mid-restart window');
  assert.strictEqual(w.m._ticketTreeHolder(tree.path), null,
    'ENTER: so the occupancy gate is BLIND to it. If this ever resolves, the re-dispatch below is refused and '
    + 'every assertion after it passes without a collision ever having existed');

  w.said.length = 0;
  w.m._handleTask(w.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  assert.ok(await until(() => w.m.sessions.has('team-builder-1')),
    `ENTER: the re-dispatch must actually have spawned a second seat — replies: ${JSON.stringify(w.said)}`);
  assert.ok(w.said.some((t) => /WORK IN: /.test(t) && t.includes(tree.path)),
    'ENTER: and it must have been handed THE SAME TREE — a second seat on a fresh checkout is not a collision');

  const res = await restart;
  assert.strictEqual(res.ok, true, `ENTER: the restart itself must have completed (${res.error || ''})`);
  // The claim and the preserve are on independent async paths; sample after both
  // have certainly run, or a clean read is only clean because nothing happened yet.
  await until(() => namingTree(w.P, tree.path).length > 0);
  await new Promise((r) => setTimeout(r, 50));

  assert.deepStrictEqual(namingTree(w.P, tree.path), ['team-builder-1'],
    'exactly ONE record may name the tree, and it must be the seat that now holds it. Two rows let Delete '
    + 'Session… on the restarted seat `worktree remove --force` the checkout the other seat is committing in');
  assert.ok(w.m.sessions.has('team-hand-1'),
    'and the restarted seat is back — the guard drops a stale POINTER, never the seat or its record');
  assert.notStrictEqual(w.P.get('team-hand-1'), null,
    'its record survives too: `worktree` is one key of the seed, and dropping it must not suppress the rest');
  fs.rmSync(w.tmp, { recursive: true, force: true });
});

// The other half, and the one that decides the guard's SHAPE. The spec proposed
// skipping the seed whenever another RECORD names the tree. That condition is
// also true of a stale pointer left by an ARCHIVED seat — archive KEEPS the
// record, and t488 found eight such pointers on the live board and ruled them
// expected state. Under the literal condition an ordinary restart of the genuine
// holder would drop its own pointer and land in the ABSENT state ALWAYS_PRESERVE
// calls the dangerous one: destroy() then takes `if (!worktree)`, drops the
// record and reports success over an orphaned checkout. `_ticketTreeHolder`
// requires the other seat to be LIVE, which is what tells the two cases apart.
test('a stale pointer from an ARCHIVED seat does not block the restart from keeping its own', async () => {
  const w = mkWorld();
  const tree = await dispatch(w);
  // Archive, not kill: the record is KEPT and goes on naming the tree while the
  // session is gone. That is the shape a raw record scan cannot distinguish.
  w.P.upsert({ name: 'ghost', type: 'claude', cwd: w.repo, workspaceId: 'default' });
  w.P.setWorktree('ghost', { path: tree.path, branch: tree.branch });
  assert.deepStrictEqual(namingTree(w.P, tree.path), ['ghost', 'team-hand-1'],
    'ENTER: a second, ARCHIVED record names the tree going in — without it this test is the one above');
  assert.ok(!w.m.sessions.has('ghost'), 'ENTER: and its seat is NOT live, which is the whole distinction');

  const res = await w.eng.restartSession('team-hand-1', {}, 'default');
  assert.strictEqual(res.ok, true, `ENTER: the restart completed (${res.error || ''})`);

  const holder = w.P.get('team-hand-1');
  assert.deepStrictEqual(holder && holder.worktree && real(holder.worktree.path), real(tree.path),
    'the genuine holder keeps its pointer across an ordinary restart. A guard keyed on "another record names '
    + 'it" would drop this one for a seat that has not existed in hours — trading a collision that is not '
    + 'happening for the absent pointer that orphans the checkout irrecoverably');
  fs.rmSync(w.tmp, { recursive: true, force: true });
});

after(() => { setImmediate(() => process.exit(0)); });
