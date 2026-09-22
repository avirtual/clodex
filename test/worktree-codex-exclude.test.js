'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ignoreCodexDir } = require('../team-tickets');
const { mkTmpRoot } = require('./lib/tmp-roots');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function mkRepoWithWorktree() {
  const root = mkTmpRoot('t1076-exclude-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 'x@y');
  git(repo, 'config', 'user.name', 'x');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 't-branch', wt, 'master');
  return { repo, wt };
}

test('t1076: ignoreCodexDir hides .codex/ from git status in the worktree and leaves the shared info/exclude alone', () => {
  const { repo, wt } = mkRepoWithWorktree();
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');
  const excludeBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : null;
  assert.strictEqual(ignoreCodexDir(fs, wt), null);
  fs.writeFileSync(path.join(wt, '.codex', 'hooks.json'), '{}');
  assert.strictEqual(git(wt, 'status', '--porcelain'), '', 'the hook file and the marker are invisible to git');
  git(wt, 'add', '-A');
  assert.strictEqual(git(wt, 'diff', '--cached', '--name-only'), '', 'git add -A stages nothing under .codex/');
  const excludeAfter = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : null;
  assert.strictEqual(excludeAfter, excludeBefore, 'the repository-wide exclude list is untouched');
  fs.mkdirSync(path.join(repo, '.codex'));
  fs.writeFileSync(path.join(repo, '.codex', 'hooks.json'), '{}');
  assert.match(git(repo, 'status', '--porcelain'), /\.codex\//, 'the main checkout still sees its own .codex/');
});

test('t1076: a second call leaves one byte-identical marker', () => {
  const { wt } = mkRepoWithWorktree();
  ignoreCodexDir(fs, wt);
  const file = path.join(wt, '.codex', '.gitignore');
  const stat = fs.statSync(file);
  assert.strictEqual(ignoreCodexDir(fs, wt), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '*\n');
  assert.strictEqual(fs.statSync(file).mtimeMs, stat.mtimeMs, 'not rewritten');
  assert.deepStrictEqual(fs.readdirSync(path.join(wt, '.codex')), ['.gitignore']);
});

test('t1076: a failure is returned as a sentence, never thrown', () => {
  const { wt } = mkRepoWithWorktree();
  fs.writeFileSync(path.join(wt, '.codex'), 'a file where the directory should be');
  const e = ignoreCodexDir(fs, wt);
  assert.match(e, /could not write .*\.codex\/\.gitignore/);
  assert.match(e, /will show \.codex\/ as untracked/);
});
