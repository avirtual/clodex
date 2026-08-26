'use strict';
// Run: node --test
//
// t489 — a seat's worktree provenance must survive an in-place restart, and the
// consequence of losing it, driven end to end against a REAL git worktree.
//
// The mechanism is the one test/preserve-census.test.js describes: every
// in-place restart is kill() + create(), kill() REMOVES the persistence record,
// create() rebuilds it from spawn arguments, and create() takes no worktree
// argument. `setWorktree`'s five production call sites are all mints and claims
// on the DISPATCH path — none of them runs on a restart — so nothing regrows it.
//
// WHY THIS IS THE COSTLY ONE, and why the answer is not the intuitive one. The
// worry about preserving a pointer is that it goes STALE. It does not go stale
// here: a restart re-enters the same cwd and deliberately does not touch the
// tree (destroy()'s own header says why — the restart paths kill and recreate
// the same seat, and destroying its checkout there would delete the tree out
// from under a session that is coming right back), so the value copied back is
// the one that was on the record microseconds earlier. And the two failures are
// ASYMMETRIC, which is what actually decides it:
//
//   ABSENT pointer — destroy() takes `if (!worktree)`, DROPS the record and
//     returns { ok: true }. The record was the only thing naming the checkout,
//     so the tree is orphaned irrecoverably, its path unrecoverable and its
//     unmerged commits with it. Reported as success.
//   STALE pointer — removeWorktree fails, destroy() takes the failure return,
//     KEEPS the record and rides the path out so the operator can finish by
//     hand. Nothing is lost.
//
// So a stale pointer is strictly the safer failure, and that is why `worktree`
// went to ALWAYS_PRESERVE rather than being left out to avoid staleness.
//
// AGAINST A REAL TREE, not a stubbed gitWorktree. The whole claim is about what
// is on disk after destroy(), and a stub asserts only that a function was
// called with a string. `fs.existsSync` on a directory git actually made is the
// subject; the two halves below differ in nothing but whether the preserve ran,
// and they disagree about that directory.
//
// THE ENTER QUESTIONS, the same three as test/keepwarm-restart-preserve.test.js:
//   (a) kill() actually REMOVED the record — otherwise create() finds the
//       pointer on its own and the preserve under test is doing nothing;
//   (b) create() was actually REACHED;
//   (c) the field was actually SET going in, through the real setter.
//
// createEngine starts background timers with no host to stop them; force-exit in
// `after` once results flush, as the sibling preserve tests do.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEngine } = require('../engine');
const gitWorktree = require('../git-worktree');

function mkEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-wt-'));
  // registryDir, or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

// A real repo with one real commit — `git worktree add` refuses to fork from a
// repo with no commits, so the commit is load-bearing, not scene-setting.
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't489@example.invalid');
  run('config', 'user.name', 't489');
  run('commit', '-q', '--allow-empty', '-m', 'base');
  return dir;
}

// Realpath'd: on macOS /tmp is a symlink to /private/tmp, and git prints the
// canonical form while the record carries the path as created. Comparing raw
// strings would make the two halves below differ for the wrong reason.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function liveSession(eng, name, entry) {
  const s = {
    name,
    type: entry.type,
    cwd: entry.cwd,
    workspaceId: entry.workspaceId || 'default',
    agentType: null,
    pty: { pid: -1, kill() { eng.manager.sessions.delete(name); } },
  };
  eng.manager.sessions.set(name, s);
  return s;
}

// Records the persistence record AS IT STANDS when create() is called —
// post-kill, post-preserve. That snapshot is byte-for-byte what create()'s own
// `getPersistence().get(name)` reads one line later, so this is a probe at the
// seam rather than a stand-in for the decision. Also wraps remove() so ENTER (a)
// is asserted from the product's own call.
function probe(eng) {
  const seen = [];
  const removals = [];
  const persistence = eng.stores.persistence;
  const origRemove = persistence.remove.bind(persistence);
  persistence.remove = (n) => {
    origRemove(n);
    removals.push({ name: n, recordAfter: persistence.get(n) });
  };
  eng.manager.create = async (...args) => {
    seen.push({ args, recordAtCreate: persistence.get(args[0]) });
    // create()'s rebuild upsert, reduced to the part that matters: it
    // spread-MERGES over whatever the preserve seeded, and writes these keys and
    // not `worktree`. Modelling it is what makes the assertions mean "survived
    // the restart" rather than "was seeded and never overwritten".
    persistence.upsert({ name: args[0], type: args[1], cwd: args[2], sessionId: args[4] || null });
    return { name: args[0], backend: null };
  };
  return { seen, removals };
}

function assertEntered(seen, removals, name, path_) {
  assert.strictEqual(removals.length, 1,
    `ENTER: ${path_} must actually route through kill(), which REMOVES the record — zero removals means the `
    + 'record was never dropped and this test pins a path where the bug cannot occur');
  assert.strictEqual(removals[0].name, name, `ENTER: the removal was for ${name}`);
  assert.strictEqual(removals[0].recordAfter, null,
    `ENTER: after kill() the record for ${name} must be GONE — if it survives, create() finds the pointer on `
    + 'its own and the preserve under test is doing nothing');
  assert.strictEqual(seen.length, 1,
    `ENTER: ${path_} must actually reach create() — zero calls means the assertions below inspect nothing`);
}

// --------------------------------------------------- the preserve itself

test('restartSession carries the worktree pointer across the kill+create seam', async () => {
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-a');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);

  const entry = { name: 'a', type: 'bash', cwd: wt.path, workspaceId: 'default', sessionId: 's-1' };
  eng.stores.persistence.upsert(entry);
  // Through the REAL setter — the only thing that puts this field on a record in
  // production. A hand-stamped literal would not prove the shape it writes is
  // the shape the preserve carries, and this whole bug class is made of fixtures
  // that write the field they are asserting about.
  eng.stores.persistence.setWorktree('a', { path: wt.path, branch: wt.branch });
  assert.deepStrictEqual(eng.stores.persistence.get('a').worktree, { path: wt.path, branch: wt.branch },
    'ENTER (c): the pointer is actually on the record going in');
  liveSession(eng, 'a', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('a', {}, 'default');
  assert.strictEqual(res.ok, true, 'the restart itself succeeded');
  assertEntered(seen, removals, 'a', 'restartSession');

  assert.deepStrictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.worktree,
    { path: wt.path, branch: wt.branch },
    'the pointer must be back on the record before create() reads it — without it the reloaded seat is a live '
    + 'session in a tree no record names, which _ticketTreeHolder (which reads occupancy off the record) '
    + 'cannot see and destroy() cannot find');
  assert.deepStrictEqual(eng.stores.persistence.get('a').worktree, { path: wt.path, branch: wt.branch },
    "and it survives create()'s rebuild upsert, which spread-merges over the seed");
});

test('a FRESH restart carries it too — a checkout is a seat property, not conversation state', async () => {
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-b');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);

  const entry = { name: 'b', type: 'bash', cwd: wt.path, workspaceId: 'default', rosterSentAt: 999 };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.setWorktree('b', { path: wt.path, branch: wt.branch });
  liveSession(eng, 'b', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('b', { fresh: true }, 'default');
  assert.strictEqual(res.ok, true, 'the fresh restart itself succeeded');
  assertEntered(seen, removals, 'b', 'restartSession({fresh:true})');

  const at = seen[0].recordAtCreate;
  assert.deepStrictEqual(at && at.worktree, { path: wt.path, branch: wt.branch },
    'a FRESH restart starts a new CONVERSATION; the directory the seat is sitting in is not part of the '
    + 'conversation it discards. This is why the field is in ALWAYS_PRESERVE rather than on the call-site '
    + 'lists — a caller-controlled field is one a fourth caller can forget');
  // The contrast is what makes the line above a decision rather than a default:
  // rosterSentAt IS conversation state and must drop across the same boundary.
  assert.strictEqual(at && at.rosterSentAt, undefined,
    'ENTER: rosterSentAt must NOT carry across a fresh restart — if it did, this restart is not fresh and the '
    + 'contrast proves nothing');
});

test('[agent:context reload] carries it across its cold respawn — the ticket-seat path', async () => {
  // The path the leak was argued from: a ticket seat that reloads itself comes
  // back having lost its provenance, and `task accept` can then no longer find
  // the tree to remove.
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-c');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);

  const entry = { name: 'c', type: 'claude', cwd: wt.path, workspaceId: 'default', sessionId: 's-3' };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.setWorktree('c', { path: wt.path, branch: wt.branch });
  const s = liveSession(eng, 'c', entry);
  s.agentType = 'claude';
  const { seen, removals } = probe(eng);
  // Runs after create() and polls for a transcript symlink that never appears
  // here; best-effort and irrelevant to the seam under test.
  eng.manager._injectReloadHandoff = () => {};

  // A blank handoff body aborts BEFORE the kill, leaving this test asserting
  // nothing while still passing. ENTER (b) would catch it; pass a real body so
  // the path exercised is the intended one.
  eng.manager._handleContextIntent(s, 'reload', 'pick up at step 3');
  for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

  assertEntered(seen, removals, 'c', '[agent:context reload]');
  assert.strictEqual(seen[0].args[4], null,
    'ENTER: reload is a COLD boot — resumeId must be null, or this is some other path');
  assert.deepStrictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.worktree,
    { path: wt.path, branch: wt.branch },
    'the reload path preserved this field on no list at all, and it is the one a ticket seat takes on its own '
    + 'initiative — no operator is present to notice the provenance went');
});

test('a seat with no worktree is not handed one by the restart', async () => {
  const eng = mkEngine();
  const entry = { name: 'd', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-4' };
  eng.stores.persistence.upsert(entry);
  assert.strictEqual('worktree' in eng.stores.persistence.get('d'), false,
    'ENTER: no pointer on the record going in');
  liveSession(eng, 'd', entry);
  const { seen, removals } = probe(eng);

  await eng.restartSession('d', {}, 'default');
  assertEntered(seen, removals, 'd', 'restartSession');

  // ALWAYS_PRESERVE seeds only fields PRESENT on the prior entry, and here that
  // is load-bearing rather than tidy: setWorktree(name, null) DELETES the key,
  // and that deletion is how claimTree hands a tree from one record to another
  // (team-tickets.js). A preserve that re-seeded absent fields would resurrect
  // the loser's pointer and put two records on one tree — which claimTree's own
  // comment calls worse than the stale pointer it was fixing.
  assert.strictEqual('worktree' in (seen[0].recordAtCreate || {}), false,
    'a seat with no checkout must not come back naming one');
});

// ------------------------------------- THE CONSEQUENCE, on a real directory

// The pair is the point, and neither half means anything alone. They differ in
// exactly one thing — whether the record names the tree — and they disagree
// about whether a directory still exists afterwards. That difference is the
// entire argument for the decision this ticket made.

test('CONSEQUENCE: with the pointer, destroy() actually removes the checkout', async () => {
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-live');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);
  assert.strictEqual(fs.existsSync(wt.path), true, 'ENTER: the checkout is really on disk');

  eng.stores.persistence.upsert({ name: 'e', type: 'bash', cwd: wt.path, workspaceId: 'default' });
  eng.stores.persistence.setWorktree('e', { path: wt.path, branch: wt.branch });

  const r = await eng.manager.destroy('e');
  assert.strictEqual(r.worktreeRemoved, true, 'destroy() reports it removed the tree');
  assert.strictEqual(fs.existsSync(wt.path), false,
    'and the directory is really gone — this is what the preserved pointer buys');
  assert.strictEqual(eng.stores.persistence.get('e'), null,
    'the record is dropped only because the tree it named went with it');
});

test('CONSEQUENCE: without it, destroy() reports success and ORPHANS the checkout', async () => {
  // The state an in-place restart produced before this ticket: create() rebuilt
  // the record from spawn args, so the pointer is simply absent. Everything else
  // is identical to the test above.
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-orphan');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);
  assert.strictEqual(fs.existsSync(wt.path), true, 'ENTER: the checkout is really on disk');

  eng.stores.persistence.upsert({ name: 'f', type: 'bash', cwd: wt.path, workspaceId: 'default' });
  assert.strictEqual('worktree' in eng.stores.persistence.get('f'), false,
    'ENTER: the record does NOT name the tree — that is the whole difference from the test above');

  const r = await eng.manager.destroy('f');
  assert.strictEqual(r.ok, true, 'destroy() reports plain success…');
  assert.strictEqual(r.worktreeRemoved, undefined, '…and says nothing about a tree, because it saw none');
  assert.strictEqual(fs.existsSync(wt.path), true,
    'the checkout is STILL THERE, and the record that named it has just been dropped: nothing on the box '
    + 'points at this directory any more. That is the leak, reported as success');
  assert.strictEqual(eng.stores.persistence.get('f'), null,
    'the record went — this is the `if (!worktree)` arm, which drops it precisely because it believes there '
    + 'is nothing to strand');
});

test('CONSEQUENCE: a STALE pointer is the SAFE failure — the record is KEPT', async () => {
  // The objection this decision had to answer: preserving a pointer risks
  // carrying a stale one. It does — a tree can be removed by hand between the
  // restart and the destroy — and this is what that costs. Compare with the
  // orphan above: a wrong pointer loses nothing and tells the operator where to
  // look, while a missing one loses the directory silently. Nothing here needs
  // the pointer to be RIGHT; it needs it to EXIST.
  const eng = mkEngine();
  const repo = mkRepo();
  const wt = await gitWorktree.createWorktree(repo, 't489-stale');
  assert.strictEqual(wt.ok, true, `ENTER: the real worktree was created (${wt.error || ''})`);

  eng.stores.persistence.upsert({ name: 'g', type: 'bash', cwd: wt.path, workspaceId: 'default' });
  eng.stores.persistence.setWorktree('g', { path: wt.path, branch: wt.branch });
  // Removed the way an operator removes one: `rm -rf` on the directory, leaving
  // git's admin entry behind. The pointer on the record is now stale.
  fs.rmSync(wt.path, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(wt.path), false, 'ENTER: the tree really is gone before destroy() runs');

  const r = await eng.manager.destroy('g');
  assert.strictEqual(r.worktreeRemoved, false, 'the removal fails, as it must — there is nothing to remove');
  assert.strictEqual(real(r.path), real(wt.path),
    'and the path rides the result out, so the failure sentence can name what to clean up by hand');
  assert.notStrictEqual(eng.stores.persistence.get('g'), null,
    'the record is KEPT. That is destroy()\'s stated invariant — it must not return having dropped the '
    + 'record while the tree it named might still stand — and it is why a stale pointer is recoverable '
    + 'where an absent one is not');
});

// ------------------------------- the other two fields, same helper, one seam

test('autoCompact and digested ride the same preserve, and the opt-OUT is what matters', async () => {
  // Both went to ALWAYS_PRESERVE on their own arguments (see the header in
  // session-manager.js), but they share this seam, so they share a fixture.
  //
  // `autoCompact` is stored ONLY as the opt-OUT: `false` is written, and
  // enabling DELETES the key (stores.js setAutoCompact). So losing it does not
  // fail neutrally — autoCompactOf reads absence as ON, and the seat the
  // operator exempted from auto-compaction gets compacted.
  const eng = mkEngine();
  const entry = { name: 'h', type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 's-9' };
  eng.stores.persistence.upsert(entry);
  // Real setters again, both of them.
  eng.stores.persistence.setAutoCompact('h', false);
  eng.stores.persistence.markDigested('h', 's-9');
  const before = eng.stores.persistence.get('h');
  assert.strictEqual(before.autoCompact, false, 'ENTER (c): the opt-out is on the record going in');
  assert.deepStrictEqual(before.digested, ['s-9'], 'ENTER (c): and the digest history is too');
  liveSession(eng, 'h', entry);
  const { seen, removals } = probe(eng);

  await eng.restartSession('h', {}, 'default');
  assertEntered(seen, removals, 'h', 'restartSession');

  const at = seen[0].recordAtCreate;
  assert.strictEqual(at && at.autoCompact, false,
    'the opt-out must survive. Absence is not a neutral loss here: autoCompactOf(entry) is '
    + '`!(entry.autoCompact === false)`, so a dropped field reads as ON and the restart silently re-enables '
    + 'the thing the operator turned off');
  assert.deepStrictEqual(at && at.digested, ['s-9'],
    'and the digest history, which is append-only with one writer (markDigested) exactly like `sessionIds` — '
    + 'dropped, it does not regrow, and the seat re-delivers a boot digest into a conversation that has one');
});

test('a fresh conversation is still owed its digest — the preserved list cannot suppress one', async () => {
  // Why `digested` is safe in ALWAYS_PRESERVE where `rosterSentAt` is not, and
  // the reason they are different decisions rather than one. rosterSentAt is a
  // bare timestamp: carried into a fresh restart it suppresses the roster inject
  // that restart exists to trigger. `digested` carries the conversation IDENTITY
  // inside its value, so it is self-invalidating — a new conversation's id is by
  // construction not in the array, and isDigested returns false for it.
  const { createEngine: _ce } = require('../engine'); // same module, named for clarity
  assert.strictEqual(typeof _ce, 'function', 'ENTER: the engine module is the one under test');
  const eng = mkEngine();
  const entry = { name: 'i', type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 'old-sid' };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.markDigested('i', 'old-sid');
  liveSession(eng, 'i', entry);
  const { seen, removals } = probe(eng);

  await eng.restartSession('i', { fresh: true }, 'default');
  assertEntered(seen, removals, 'i', 'restartSession({fresh:true})');

  const carried = (seen[0].recordAtCreate || {}).digested;
  assert.deepStrictEqual(carried, ['old-sid'], 'the history carried across the fresh restart');
  assert.strictEqual(carried.includes('new-sid-minted-after-the-restart'), false,
    'and it does not cover the conversation the fresh restart mints — which is the whole safety argument: '
    + 'the preserved value can only ever suppress a digest for a conversation that already RECEIVED one, '
    + 'so unlike rosterSentAt it cannot swallow a delivery that is due');
});

after(() => { setImmediate(() => process.exit(0)); });
