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
