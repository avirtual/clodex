// Run: node --test
// Covers git-scm: the porcelain-v1 -z status parser (pure), and the live status/
// stage/unstage/commit loop against a real throwaway repo. Skipped without git.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const scm = require('../git-scm');

function gitOk() { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-scm-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t.co'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  return dir;
}

test('parseStatus: branch header + staged/unstaged/untracked classification', () => {
  // Two NUL-terminated records + branch line: M staged, ?? untracked.
  const z = '## main...origin/main [ahead 1, behind 2]\0M  staged.js\0?? new.txt\0';
  const r = scm.parseStatus(z);
  assert.strictEqual(r.branch, 'main');
  assert.strictEqual(r.upstream, 'origin/main');
  assert.strictEqual(r.ahead, 1);
  assert.strictEqual(r.behind, 2);
  const staged = r.files.find((f) => f.path === 'staged.js');
  assert.ok(staged.staged && !staged.untracked);
  const untr = r.files.find((f) => f.path === 'new.txt');
  assert.ok(untr.untracked && !untr.staged);
});

test('parseStatus: rename entry consumes the old-path NUL field', () => {
  const z = '## main\0R  new.js\0old.js\0';
  const r = scm.parseStatus(z);
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'new.js');
  assert.strictEqual(r.files[0].oldPath, 'old.js');
});

test('status → stage → commit round-trip on a real repo', { skip: !gitOk() }, async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n'); // modify tracked
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');       // untracked

  let st = await scm.status(repo);
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.files.length, 2);
  assert.ok(st.files.every((f) => !f.staged), 'nothing staged yet');

  assert.strictEqual((await scm.stage(repo, ['a.txt', 'b.txt'])).ok, true);
  st = await scm.status(repo);
  assert.ok(st.files.every((f) => f.staged), 'both staged after add');

  assert.strictEqual((await scm.unstage(repo, ['b.txt'])).ok, true);
  st = await scm.status(repo);
  assert.strictEqual(st.files.find((f) => f.path === 'b.txt').staged, false);

  const c = await scm.commit(repo, 'add two + b', {});
  assert.strictEqual(c.ok, true, c.error);
  st = await scm.status(repo);
  // Only b.txt remains (untracked, unstaged) after committing a.txt.
  assert.deepStrictEqual(st.files.map((f) => f.path), ['b.txt']);
});

test('commit refuses an empty message', { skip: !gitOk() }, async () => {
  const repo = makeRepo();
  const c = await scm.commit(repo, '   ', {});
  assert.strictEqual(c.ok, false);
  assert.match(c.error, /message is required/i);
});

test('discard restores a tracked file (destructive)', { skip: !gitOk() }, async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'clobbered\n');
  assert.strictEqual((await scm.discard(repo, 'a.txt', {})).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\n');
});

test('status: non-repo → ok:false, isRepo:false', async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-nr-'));
  const r = await scm.status(notRepo);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.isRepo, false);
});
