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
