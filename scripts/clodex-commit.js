#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = process.cwd();

function emit(msg, code) {
  process.stderr.write(`${String(msg).slice(0, 400)}\n`);
  process.exit(code);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function worktrees() {
  let out = '';
  try {
    out = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => real(l.slice('worktree '.length).trim()))
    .filter(Boolean);
}

function resolveTree(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'tree')) return real(ROOT) || ROOT;
  const want = typeof payload.tree === 'string' ? payload.tree : '';
  const refuse = () => emit(`refused, nothing committed: not a worktree of this repo — ${want || '(empty)'}`, 1);
  if (!want) refuse();
  const wantAbs = real(want);
  if (!wantAbs) refuse();
  if (!worktrees().includes(wantAbs)) refuse();
  return wantAbs;
}

function git(tree, args) {
  return spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8' });
}

const payload = parsePayload(readStdin());
const tree = resolveTree(payload);

const rawPaths = payload.paths;
if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
  emit('refused: `paths` must be a non-empty array of relative file paths', 1);
}
const message = typeof payload.message === 'string' ? payload.message : '';
if (!message.trim()) emit('refused: `message` must be a non-empty string', 1);

const paths = [];
for (const raw of rawPaths) {
  if (typeof raw !== 'string' || !raw.trim()) emit(`refused: not a path — ${JSON.stringify(raw)}`, 1);
  const p = raw.trim();
  if (path.isAbsolute(p)) emit(`refused: path must be relative to the tree — ${p}`, 1);
  const abs = path.resolve(tree, p);
  if (abs !== tree && !abs.startsWith(tree + path.sep)) {
    emit(`refused: path escapes the tree — ${p}`, 1);
  }
  let st;
  try { st = fs.lstatSync(abs); } catch { emit(`refused: no such file in the tree — ${p}`, 1); }
  if (st.isDirectory()) emit(`refused: a directory is not a file — ${p}`, 1);
  paths.push(path.relative(tree, abs));
}

const mb = git(tree, ['merge-base', 'master', 'HEAD']);
if (mb.status !== 0 || !String(mb.stdout || '').trim()) {
  emit('refused: no merge-base between master and HEAD — nothing to ratchet against', 1);
}
const base = String(mb.stdout).trim();

const deltaScript = path.join(tree, 'scripts', 'comment-delta.js');
if (!fs.existsSync(deltaScript)) emit(`refused: ${deltaScript} is missing — nothing ratcheted`, 1);
const delta = spawnSync(process.execPath, [deltaScript, base], { cwd: tree, encoding: 'utf8' });
if (delta.status === 2 || delta.status === null) {
  const why = String(delta.stderr || '').trim().split('\n').pop() || 'comment-delta failed';
  emit(`refused: comment ratchet could not run — ${why}`, 1);
}
if (delta.status !== 0) {
  const rows = String(delta.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let added = 0;
  const files = [];
  for (const row of rows) {
    const m = /^(.+): \d+ -> \d+ \(\+(\d+)\)$/.exec(row);
    if (!m) continue;
    files.push(m[1]);
    added += Number(m[2]);
  }
  emit(`refused: comment ratchet +${added} in ${files.join(', ') || '(unnamed file)'}`, 1);
}

const add = git(tree, ['add', '--', ...paths]);
if (add.status !== 0) {
  emit(`refused: git add failed — ${(String(add.stderr || '').trim().split('\n').pop() || '').slice(0, 200)}`, 1);
}

const staged = git(tree, ['diff', '--cached', '--name-only']);
const stagedFiles = String(staged.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
if (!stagedFiles.length) emit('refused: nothing to commit for the given paths', 1);

const commit = git(tree, ['commit', '-q', '-m', message]);
if (commit.status !== 0) {
  const why = `${String(commit.stderr || '').trim()}\n${String(commit.stdout || '').trim()}`
    .split('\n').map((l) => l.trim()).filter(Boolean).pop() || `exit ${commit.status}`;
  emit(`refused: git commit failed — ${why.slice(0, 200)}`, 1);
}

const sha = String(git(tree, ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
const subject = message.split('\n')[0].trim();
emit(`committed ${sha}: ${stagedFiles.length} file(s) — ${subject}`, 0);
