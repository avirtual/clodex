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

// --- t305: the merge gate that licenses every destructive cleanup step ---

// ONE repo, TWO branches, opposite answers. A fixture where both branches are
// ancestors (or neither is) exercises one arm twice and stays green while the
// gate is broken in the direction that deletes unmerged work — so the ancestry
// of each is asserted with raw git BEFORE isMerged is asked, and the two answers
// are pinned against each other.
test('isMerged: merged vs unmerged, proved distinct before the question is asked', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  const base = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

  const inTree = await wt.createWorktree(repo, 't900-merged');
  assert.equal(inTree.ok, true, inTree.error);
  fs.writeFileSync(path.join(inTree.path, 'merged.txt'), 'work\n');
  execFileSync('git', ['-C', inTree.path, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', inTree.path, 'commit', '-qm', 'ticket work'], { stdio: 'ignore' });

  const outTree = await wt.createWorktree(repo, 't901-unmerged');
  assert.equal(outTree.ok, true, outTree.error);
  fs.writeFileSync(path.join(outTree.path, 'unmerged.txt'), 'work\n');
  execFileSync('git', ['-C', outTree.path, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', outTree.path, 'commit', '-qm', 'unreviewed work'], { stdio: 'ignore' });

  run('merge', '-q', '--no-ff', '-m', 'merge the ticket', 't900-merged');

  // ENTER, both directions: raw git, independent of the function under test.
  // Without these the two assertions below could be agreeing about one branch.
  const ancestor = (b) => {
    try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', b, base], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  assert.strictEqual(ancestor('t900-merged'), true, 'ENTER: the merged branch really IS an ancestor of the base');
  assert.strictEqual(ancestor('t901-unmerged'), false, 'ENTER: the unmerged branch really is NOT');

  const yes = await wt.isMerged(repo, 't900-merged');
  assert.deepStrictEqual([yes.ok, yes.merged, yes.base], [true, true, base]);
  const no = await wt.isMerged(repo, 't901-unmerged');
  assert.deepStrictEqual([no.ok, no.merged, no.base], [true, false, base]);

  await wt.removeWorktree(inTree.path);
  await wt.removeWorktree(outTree.path);
  fs.rmSync(repo, { recursive: true, force: true });
});

// `ok:false` is the third outcome and must never collapse onto `merged`. Every
// degradation here would, if read as merged, license deleting a tree.
test('isMerged: an unanswerable check is ok:false, never merged', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const gone = await wt.isMerged(repo, 'no-such-branch');
  assert.strictEqual(gone.ok, false, 'a branch that does not resolve is unknown');
  assert.notStrictEqual(gone.merged, true, 'and above all not merged');
  assert.match(gone.error, /does not resolve/);

  const noBranch = await wt.isMerged(repo, null);
  assert.deepStrictEqual([noBranch.ok, noBranch.merged], [false, undefined]);

  const noRepo = await wt.isMerged(os.tmpdir(), 't1');
  assert.deepStrictEqual([noRepo.ok, noRepo.merged], [false, undefined]);

  const badBase = await wt.isMerged(repo, 'HEAD', 'no-such-base');
  assert.strictEqual(badBase.ok, false, 'an unresolvable BASE is unknown too');
  assert.notStrictEqual(badBase.merged, true);

  fs.rmSync(repo, { recursive: true, force: true });
});

// -d, not -D: git's own merged-check is a second gate behind the caller's, and
// the two disagreeing means the caller's premise was wrong.
test('deleteBranch: removes a merged branch and REFUSES an unmerged one', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  const branches = () => execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const inTree = await wt.createWorktree(repo, 't902-merged');
  fs.writeFileSync(path.join(inTree.path, 'm.txt'), 'work\n');
  execFileSync('git', ['-C', inTree.path, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', inTree.path, 'commit', '-qm', 'work'], { stdio: 'ignore' });
  const outTree = await wt.createWorktree(repo, 't903-unmerged');
  fs.writeFileSync(path.join(outTree.path, 'u.txt'), 'work\n');
  execFileSync('git', ['-C', outTree.path, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', outTree.path, 'commit', '-qm', 'work'], { stdio: 'ignore' });
  run('merge', '-q', '--no-ff', '-m', 'merge', 't902-merged');
  // The trees must go first: git refuses to delete a branch checked out anywhere.
  await wt.removeWorktree(inTree.path);
  await wt.removeWorktree(outTree.path);

  // ENTER: both branches exist right now, so a later absence is this call's doing.
  assert.ok(branches().includes('t902-merged') && branches().includes('t903-unmerged'),
    'ENTER: both branches are present before either delete');

  const ok = await wt.deleteBranch(repo, 't902-merged');
  assert.strictEqual(ok.ok, true, ok.error);
  assert.ok(!branches().includes('t902-merged'), 'the merged branch is gone');

  const refused = await wt.deleteBranch(repo, 't903-unmerged');
  assert.strictEqual(refused.ok, false, 'an unmerged branch is refused, not forced');
  assert.ok(branches().includes('t903-unmerged'), 'and it survives the refusal');

  fs.rmSync(repo, { recursive: true, force: true });
});

// `--is-ancestor` answers NO by exiting 1, which is indistinguishable from a
// failure through `ok` alone. isMerged's three-way split is built on this field.
test('git(): carries the exit code, so "no" is separable from "could not tell"', { skip: !gitAvailable() }, async () => {
  const repo = makeRepo();
  const okr = await wt.isMerged(repo, 'HEAD', 'HEAD');
  assert.deepStrictEqual([okr.ok, okr.merged], [true, true], 'HEAD is trivially its own ancestor (exit 0)');
  fs.rmSync(repo, { recursive: true, force: true });
});
