'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeGitArgs } = require('../git-safe');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function plantedRepo() {
  const repo = mkTmpRoot('clx-gitsafe-');
  const run = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t.co');
  run('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'a\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'README.md'), 'b\n');
  return { repo, run };
}

test('safeGitArgs: status gets the config prefix and nothing else', () => {
  assert.deepStrictEqual(safeGitArgs(['status']), [
    '-c', 'core.fsmonitor=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh',
    '-c', 'core.pager=cat',
    'status',
  ]);
});

test('safeGitArgs: diff/show/log get --no-ext-diff --no-textconv ahead of any pathspec separator', () => {
  const prefix = [
    '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
    '-c', 'core.sshCommand=ssh', '-c', 'core.pager=cat',
  ];
  assert.deepStrictEqual(safeGitArgs(['diff', 'HEAD']), [...prefix, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'diff', 'HEAD', '--', 'f']),
    [...prefix, '-C', '/r', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'f']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'show', 'x']), [...prefix, '-C', '/r', 'show', '--no-ext-diff', '--no-textconv', 'x']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'log', '-1']), [...prefix, '-C', '/r', 'log', '--no-ext-diff', '--no-textconv', '-1']);
  assert.deepStrictEqual(safeGitArgs(['-C', '/r', 'rev-parse', 'HEAD']), [...prefix, '-C', '/r', 'rev-parse', 'HEAD']);
});

test('safeGitArgs keepHooks drops only the hooksPath override', () => {
  assert.deepStrictEqual(safeGitArgs(['merge', 'b'], { keepHooks: true }), [
    '-c', 'core.fsmonitor=', '-c', 'diff.external=', '-c', 'core.sshCommand=ssh', '-c', 'core.pager=cat', 'merge', 'b',
  ]);
});

test('a planted core.fsmonitor command does not run under safeGitArgs, and does without it', (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-fsmonitor-ran`);
  run('config', 'core.fsmonitor', `touch '${marker}'; false`);
  try {
    execFileSync('git', safeGitArgs(['-C', repo, 'status', '--porcelain']), { stdio: 'ignore' });
    assert.strictEqual(fs.existsSync(marker), false, 'fsmonitor ran under safeGitArgs');
    try { execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore' }); } catch {}
    if (!fs.existsSync(marker)) {
      console.log('# control skipped: this git did not invoke the core.fsmonitor hook on status');
      return;
    }
    assert.strictEqual(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a planted diff.external command does not run under safeGitArgs, and does without it', (t) => {
  if (!hasGit()) { t.skip('git not installed'); return; }
  const { repo, run } = plantedRepo();
  const marker = path.join(repo, '..', `${path.basename(repo)}-extdiff-ran`);
  run('config', 'diff.external', `sh -c "touch '${marker}'"`);
  try {
    const out = execFileSync('git', safeGitArgs(['-C', repo, 'diff', 'HEAD', '--no-color', '--', 'README.md']), { encoding: 'utf8' });
    assert.strictEqual(fs.existsSync(marker), false, 'diff.external ran under safeGitArgs');
    assert.match(out, /^\+b$/m);
    try { execFileSync('git', ['-C', repo, 'diff', 'HEAD', '--', 'README.md'], { stdio: 'ignore' }); } catch {}
    assert.strictEqual(fs.existsSync(marker), true, 'control: the planted diff.external runs on a raw diff');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

const SAFE_SITES = ['engine.js', 'git-worktree.js', 'session-meta.js', 'plugins/workbench/git-scm.js', 'plugins/git-branches/engine.js'];
const GIT_SPAWN_RE = /\b(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*'git',\s*([A-Za-z[]\w*\(?)/g;
const UNWRAPPED_ALLOWED = [];

test('every git spawn in the app-process git sites goes through safeGitArgs', () => {
  const seen = [];
  const bad = [];
  for (const rel of SAFE_SITES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(GIT_SPAWN_RE)) {
      seen.push(rel);
      if (m[1] !== 'safeGitArgs(' && !UNWRAPPED_ALLOWED.includes(`${rel}:${m[0]}`)) bad.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  assert.deepStrictEqual([...new Set(seen)].sort(), [...SAFE_SITES].sort(), 'ENTER: each listed file has a git spawn');
});

test('the plugin copies of git-safe.js match the root module byte for byte', () => {
  const root = fs.readFileSync(path.join(ROOT, 'git-safe.js'), 'utf8');
  for (const rel of ['plugins/workbench/git-safe.js', 'plugins/git-branches/git-safe.js']) {
    assert.strictEqual(fs.readFileSync(path.join(ROOT, rel), 'utf8'), root, rel);
  }
});
