'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { excludeInTree } = require('../git-worktree');
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

test('t1076: excludeInTree hides .codex/ from git status in the worktree', async () => {
  const { repo, wt } = mkRepoWithWorktree();
  const r = await excludeInTree(wt, '.codex/');
  assert.deepStrictEqual(r, { ok: true, added: true });
  fs.mkdirSync(path.join(wt, '.codex'));
  fs.writeFileSync(path.join(wt, '.codex', 'hooks.json'), '{}');
  assert.strictEqual(git(wt, 'status', '--porcelain'), '', 'the hook file is invisible to git in the worktree');
  const file = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'info/exclude').trim());
  assert.strictEqual(fs.realpathSync(file), fs.realpathSync(path.join(repo, '.git', 'info', 'exclude')),
    'git keeps ONE info/exclude per repository — the worktree has no exclude file of its own, so the line lands in the shared one');
});

test('t1076: a second call does not duplicate the exclude line', async () => {
  const { wt } = mkRepoWithWorktree();
  await excludeInTree(wt, '.codex/');
  const r = await excludeInTree(wt, '.codex/');
  assert.deepStrictEqual(r, { ok: true, added: false });
  const file = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'info/exclude').trim());
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l === '.codex/');
  assert.strictEqual(lines.length, 1);
});

test('t1076: an existing exclude file without a trailing newline gets the line on its own row', async () => {
  const { wt } = mkRepoWithWorktree();
  const file = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'info/exclude').trim());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'other/');
  await excludeInTree(wt, '.codex/');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'other/\n.codex/\n');
});
