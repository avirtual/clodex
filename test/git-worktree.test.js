// Run: node --test
// Covers git-worktree: create/remove round-trip in a real throwaway repo, the
// main-tree removal guard, branch-name validation, and the null-cwd / non-repo
// degradations. Uses os.tmpdir() and `git init`; skipped cleanly if git is absent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('../git-worktree');

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-wt-'));
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

test('repoToplevel: null for a non-repo path, resolves inside a repo', { skip: !gitAvailable() }, async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-nr-'));
  assert.strictEqual(await wt.repoToplevel(notRepo), null);
  assert.strictEqual(await wt.repoToplevel(null), null);
  const repo = makeRepo();
  assert.strictEqual(fs.realpathSync(await wt.repoToplevel(repo)), fs.realpathSync(repo));
});

test('createWorktree: makes a new branch + dir, removeWorktree tears it down', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const r = await wt.createWorktree(repo, 'agent/feature-x');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.branch, 'agent/feature-x');
  assert.ok(fs.existsSync(r.path) && fs.statSync(r.path).isDirectory());
  // The committed file is present in the new checkout.
  assert.ok(fs.existsSync(path.join(r.path, 'a.txt')));

  const rm = await wt.removeWorktree(r.path);
  assert.strictEqual(rm.ok, true, rm.error);
  assert.ok(!fs.existsSync(r.path));
});

test('removeWorktree: refuses to remove the main working tree', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const rm = await wt.removeWorktree(repo);
  assert.strictEqual(rm.ok, false);
  assert.match(rm.error, /main working tree/i);
});

test('createWorktree: rejects a missing / invalid branch name', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  assert.strictEqual((await wt.createWorktree(repo, '')).ok, false);
  assert.strictEqual((await wt.createWorktree(repo, '  ')).ok, false);
  assert.strictEqual((await wt.createWorktree(repo, 'bad..name')).ok, false);
  assert.strictEqual((await wt.createWorktree(repo, 'has space')).ok, false);
});

test('createWorktree: fails cleanly outside a repo', { skip: !gitAvailable() }, async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-nr2-'));
  const r = await wt.createWorktree(notRepo, 'x');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not inside a git repository/i);
});

test('defaultWorktreePath: sibling of the repo, branch slashes flattened', () => {
  const p = wt.defaultWorktreePath('/tmp/myrepo', 'feature/x');
  assert.strictEqual(p, path.join('/tmp', 'myrepo-feature-x'));
});

test('listWorktrees: main first (isMain), created worktree appears then removed', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  let l = await wt.listWorktrees(repo);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.worktrees.length, 1);
  assert.strictEqual(l.worktrees[0].isMain, true);
  assert.ok(l.worktrees[0].branch, 'main worktree has a branch');

  const created = await wt.createWorktree(repo, 'wt/list-me');
  assert.strictEqual(created.ok, true, created.error);
  l = await wt.listWorktrees(repo);
  assert.strictEqual(l.worktrees.length, 2);
  const linked = l.worktrees.find((w) => !w.isMain);
  assert.strictEqual(linked.branch, 'wt/list-me');

  await wt.removeWorktree(created.path);
  l = await wt.listWorktrees(repo);
  assert.strictEqual(l.worktrees.length, 1);
});

// Deleting a worktree's directory outside git leaves its admin entry standing.
// Both halves of what that costs are pinned here: the listing must still SHOW the
// entry (flagged prunable, so a caller can tell it from a live tree), and the
// branch must remain usable — git refuses to check it out again while the stale
// entry stands, which would make one `rm -rf` block the branch permanently.
test('a worktree dir deleted by hand: listed as prunable, and the branch stays usable', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const created = await wt.createWorktree(repo, 'wt/orphan');
  assert.strictEqual(created.ok, true, created.error);
  fs.rmSync(created.path, { recursive: true, force: true });

  const l = await wt.listWorktrees(repo);
  const stale = l.worktrees.find((w) => w.branch === 'wt/orphan');
  assert.ok(stale, 'ENTER: git still lists a deleted tree — the entry outlives the directory');
  assert.strictEqual(stale.prunable, true, 'and flags it, which is the only way to tell it apart');
  assert.strictEqual(l.worktrees.find((w) => w.isMain).prunable, false, 'a live tree is not flagged');

  const again = await wt.createWorktree(repo, 'wt/orphan');
  assert.strictEqual(again.ok, true, `the branch must be checkout-able again: ${again.error}`);
  assert.ok(fs.existsSync(again.path), 'and the new tree exists on disk');
});

test('listWorktrees: non-repo → ok:false', { skip: !gitAvailable() }, async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-wl-'));
  assert.strictEqual((await wt.listWorktrees(notRepo)).ok, false);
});

test('repoInfo: reports default branch + branch list for a repo, isRepo:false otherwise', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  execFileSync('git', ['-C', repo, 'branch', 'dev'], { stdio: 'ignore' });
  const info = await wt.repoInfo(repo);
  assert.strictEqual(info.isRepo, true);
  assert.ok(['main', 'master'].includes(info.defaultBranch), `default is main/master: ${info.defaultBranch}`);
  assert.ok(info.branches.includes('dev'));
  assert.ok(info.branches.includes(info.defaultBranch));
  // Default branch is listed first.
  assert.strictEqual(info.branches[0], info.defaultBranch);

  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-nri-'));
  assert.strictEqual((await wt.repoInfo(notRepo)).isRepo, false);
});

test('createWorktree: forks the new branch from an explicit base ref', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const initial = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  // Put a distinguishing commit on a `base` branch; the new worktree off it
  // should contain that file, proving the base was honored.
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'base'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'only-on-base.txt'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base commit'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'checkout', '-q', initial], { stdio: 'ignore' });

  const r = await wt.createWorktree(repo, 'agent/from-base', { base: 'base' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.base, 'base');
  assert.ok(fs.existsSync(path.join(r.path, 'only-on-base.txt')), 'worktree forked from base has its file');
  await wt.removeWorktree(r.path);
});

test('createWorktree: rejects a base ref that does not exist', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const r = await wt.createWorktree(repo, 'agent/x', { base: 'no-such-branch' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /base ref not found/i);
});

// commitsOnBranch — waste counter (a) of DESIGN.md §7.3 reads this to find
// worktrees minted for tickets that closed having produced nothing.
test('commitsOnBranch counts a branch\'s own commits against its fork point', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });

  const made = await wt.createWorktree(repo, 't900');
  assert.equal(made.ok, true);

  // A freshly minted tree has produced nothing — 0 with ok:true is the ANSWER
  // the counter grades on, not a failure, so a caller reading falsy as unknown
  // would lose exactly the case this exists for.
  const fresh = await wt.commitsOnBranch(repo, 't900');
  assert.deepEqual([fresh.ok, fresh.count], [true, 0]);

  const runWt = (...a) => execFileSync('git', ['-C', made.path, ...a], { stdio: 'ignore' });
  fs.writeFileSync(path.join(made.path, 'b.txt'), 'work\n');
  runWt('add', '-A');
  runWt('commit', '-qm', 'ticket work');
  const one = await wt.commitsOnBranch(repo, 't900');
  assert.deepEqual([one.ok, one.count], [true, 1]);

  // The base MOVES while a ticket is open. The count must stay the branch's own
  // output — base-side commits are on the excluded side of the range, so a
  // busy master must not inflate a ticket's apparent work.
  fs.writeFileSync(path.join(repo, 'c.txt'), 'master moved\n');
  run('add', '-A');
  run('commit', '-qm', 'unrelated master work');
  const afterDrift = await wt.commitsOnBranch(repo, 't900');
  assert.deepEqual([afterDrift.ok, afterDrift.count], [true, 1]);

  await wt.removeWorktree(made.path);
  fs.rmSync(repo, { recursive: true, force: true });
});

// The base is what makes the count readable, and the repo's live HEAD is the
// one base that answers WRONGLY IN BOTH DIRECTIONS. Both halves are pinned:
// a merged ticket must not read as waste, and a parked HEAD must not make an
// idle ticket look productive.
test('commitsOnBranch never counts against the main checkout\'s live HEAD', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  const forkSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const made = await wt.createWorktree(repo, 't901');
  assert.equal(made.ok, true, made.error);
  // ENTER: the mint captured a fork point at all. Absent, every count below
  // silently falls back to the merge-base path and this test proves nothing
  // about the SHA it is named for.
  assert.equal(made.baseSha, forkSha, 'createWorktree must return the fork SHA it branched from');

  const runWt = (...a) => execFileSync('git', ['-C', made.path, ...a], { stdio: 'ignore' });
  fs.writeFileSync(path.join(made.path, 'b.txt'), 'work\n');
  runWt('add', '-A');
  runWt('commit', '-qm', 'ticket work');

  // (1) MERGED before close. HEAD now contains the branch, so `HEAD..t901` is 0
  // and the counter would accuse the ticket that actually shipped.
  run('merge', '-q', '--no-ff', '-m', 'merge t901', 't901');
  const merged = await wt.commitsOnBranch(repo, 't901', made.baseSha);
  assert.deepEqual([merged.ok, merged.count], [true, 1], 'a merged ticket still did its work');
  // The merge-base FALLBACK cannot do this, and that is a property of merge-base
  // rather than a bug to fix here: once a branch is merged, merge-base(default,
  // branch) IS the branch tip, so the count is 0. Pinned so the limitation is
  // stated rather than discovered — a record with no baseSha (every ticket
  // predating it) reads a merged branch as zero-commit. baseSha is what makes
  // the counter correct; the fallback is only better than counting against HEAD.
  const noSha = await wt.commitsOnBranch(repo, 't901');
  assert.deepEqual([noSha.ok, noSha.count], [true, 0],
    'the fallback bottoms out at the branch tip once merged — legacy records only');

  // (2) HEAD parked on an unrelated branch. Every commit on the ticket's side of
  // the fork would count as its work, and the leak detector reports clean.
  run('checkout', '-q', '-b', 'sidequest', forkSha);
  fs.writeFileSync(path.join(repo, 'side.txt'), 'x\n');
  run('add', '-A');
  run('commit', '-qm', 'unrelated');
  const parked = await wt.commitsOnBranch(repo, 't901', made.baseSha);
  assert.deepEqual([parked.ok, parked.count], [true, 1], 'a parked HEAD must not inflate the count');

  await wt.removeWorktree(made.path);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('commitsOnBranch: a stale base SHA falls through to the merge base', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const made = await wt.createWorktree(repo, 't902');
  assert.equal(made.ok, true, made.error);
  // A mint-time SHA can be rebased or gc'd away. Refusing outright would score a
  // working ticket as unknown for the life of the record.
  const r = await wt.commitsOnBranch(repo, 't902', '0'.repeat(40));
  assert.equal(r.ok, true, 'a vanished base must degrade to the merge base, not fail');
  assert.equal(r.count, 0);
  assert.notEqual(r.base, '0'.repeat(40), 'and the record must name the base it ACTUALLY used');
  await wt.removeWorktree(made.path);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('createWorktree: an EXISTING branch reports no fork point', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const runWt = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  const first = await wt.createWorktree(repo, 't903');
  fs.writeFileSync(path.join(first.path, 'w.txt'), 'work\n');
  runWt(first.path, 'add', '-A');
  runWt(first.path, 'commit', '-qm', 'prior work');
  await wt.removeWorktree(first.path);

  // Checking an existing branch out again lands on a tip that already carries
  // commits. Pinning THAT as the base would report every later count as zero —
  // a working ticket scored as a wasted worktree.
  const again = await wt.createWorktree(repo, 't903');
  assert.equal(again.ok, true, again.error);
  // strictly null, not merely falsy: `undefined` is what a createWorktree that
  // never captured a fork point returns, and loose equality reads the two as the
  // same answer — which is how this first passed against the unfixed tree.
  assert.strictEqual(again.baseSha, null, 'no fork point for a branch this call did not create');
  assert.ok('baseSha' in again, 'the field must be present, so a caller can tell null from absent');
  const c = await wt.commitsOnBranch(repo, 't903', again.baseSha);
  assert.deepEqual([c.ok, c.count], [true, 1], 'the prior commit is still the branch\'s own work');
  await wt.removeWorktree(again.path);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('commitsOnBranch degrades to a null count, never a false zero', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  // "git failed" must not read as "produced nothing" — that would score a
  // working ticket as waste.
  const missing = await wt.commitsOnBranch(repo, 'no-such-branch');
  assert.deepEqual([missing.ok, missing.count], [false, null]);
  const noBranch = await wt.commitsOnBranch(repo, null);
  assert.deepEqual([noBranch.ok, noBranch.count], [false, null]);
  const noRepo = await wt.commitsOnBranch(os.tmpdir(), 't1');
  assert.equal(noRepo.count, null);
  fs.rmSync(repo, { recursive: true, force: true });
});
