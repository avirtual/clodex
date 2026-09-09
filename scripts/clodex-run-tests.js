#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = process.cwd();
const LEAF = path.basename(ROOT);

function emit(msg, code) {
  process.stderr.write(String(msg).slice(0, 180) + '\n');
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

function resolveMeasure(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'tree')) return ROOT;
  const want = typeof payload.tree === 'string' ? payload.tree : '';
  const refuse = () => emit(
    `[${LEAF}] refused, nothing measured: not a worktree of this repo — ${want || '(empty)'}`,
    1,
  );
  if (!want) refuse();
  const wantAbs = real(want);
  if (!wantAbs) refuse();
  if (!worktrees().includes(wantAbs)) refuse();
  return wantAbs;
}

const payload = parsePayload(readStdin());
const measure = resolveMeasure(payload);
const runner = path.join(measure, 'scripts', 'run-tests.js');

if (!fs.existsSync(runner)) {
  emit(
    `[${LEAF}] no test runner at ${runner} — nothing measured (the merge gate needs the same file)`,
    1,
  );
}

const res = spawnSync(process.execPath, [runner, '--reporter=dot'], {
  cwd: measure,
  env: {
    ...process.env,
    CLODEX_TEST_LOCK_DIR: path.join(ROOT, '.test-digest.lock'),
    CLODEX_TEST_LOCK_WAIT_MS: '30000',
  },
  maxBuffer: 64 * 1024 * 1024,
  encoding: 'utf8',
});

const stdout = res.stdout || '';
const stderr = res.stderr || '';
const code = res.status;
const exitCode = code || 1;

let totals = null;
const TOTALS_RE = /TOTALS: (\d+) pass, (\d+) fail, (\d+) tests/g;
for (let m = TOTALS_RE.exec(stdout); m; m = TOTALS_RE.exec(stdout)) totals = m;

if (!totals) {
  const combined = `${stdout}\n${stderr}${res.error ? `\n${res.error.message}` : ''}`;
  const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1].slice(0, 160) : '';
  emit(
    `[${LEAF}] no TOTALS summary from scripts/run-tests.js (exit ${code}) — last line: ${last}`,
    exitCode,
  );
}

const pass = Number(totals[1]);
const fail = Number(totals[2]);
const tests = Number(totals[3]);

if (tests === 0) emit(`[${LEAF}] runner executed ZERO tests (exit ${code})`, 1);

if (code === 0 && fail === 0) emit(`[${LEAF}] ${pass}/${tests} green`, 0);

const names = [];
const NAME_RE = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/gm;
const hay = `${stdout}\n${stderr}`;
for (let m = NAME_RE.exec(hay); m; m = NAME_RE.exec(hay)) names.push(m[1]);

emit(`[${LEAF}] ${pass}/${tests} green, ${fail} failing: ${names.join('; ')}`, exitCode);
