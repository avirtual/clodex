#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = process.cwd();
const LEAF = path.basename(ROOT);

const KEEP_DIR = path.join(process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex'), 'test-failures');
const KEEP = path.join(KEEP_DIR, 'last.txt');
const KEEP_RED = path.join(KEEP_DIR, 'last-red.txt');
const FAIL_CAP = 2000;
const DIAG_CAP = 400;
const RAW_CAP = 400;

function keepShow() {
  const home = os.homedir();
  return home && KEEP.startsWith(`${home}${path.sep}`) ? `~${KEEP.slice(home.length)}` : KEEP;
}

function headCap(lines, cap) {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `## (${lines.length - cap} further failure lines dropped)`];
}

function midCap(lines, cap) {
  if (lines.length <= cap) return lines;
  const h = Math.floor(cap / 2);
  return [
    ...lines.slice(0, h),
    `## (${lines.length - cap} diagnostic lines dropped)`,
    ...lines.slice(lines.length - (cap - h)),
  ];
}

function tailCap(lines, cap) {
  if (lines.length <= cap) return lines;
  return [`## (${lines.length - cap} earlier lines dropped)`, ...lines.slice(lines.length - cap)];
}

function failureSections(lines) {
  const at = lines.findIndex((l) => /^Failed tests:\s*$/.test(l));
  return at === -1 ? null : { diag: lines.slice(0, at), fails: lines.slice(at) };
}

function gitRead(measure, args) {
  try {
    return execFileSync('git', ['-C', measure, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function preserve({
  measure, head, startedIso, count, hay, structured,
}) {
  try { fs.mkdirSync(KEEP_DIR, { recursive: true }); } catch { return false; }
  const lines = hay.split('\n');
  const sections = structured ? failureSections(lines) : null;
  const out = [
    '# clodex clodex-run-tests — preserved output of a FAILING run.',
    '# ONE fixed file, overwritten by the next failing run on this box.',
    `# tree:  ${measure}`,
    `# head:  ${head}`,
    `# start: ${startedIso}`,
    `# when:  ${nowIso()}`,
    `# count: ${count}`,
    '',
  ];
  if (sections) {
    out.push('## failing rows, with the assertion text, diff and stack');
    out.push(...headCap(sections.fails, FAIL_CAP));
    out.push('');
    out.push('## top-level diagnostics (test stdout and the summary)');
    out.push(...midCap(sections.diag, DIAG_CAP));
  } else {
    if (structured) out.push('## no `Failed tests:` block matched — raw tail follows');
    out.push(...tailCap(lines, RAW_CAP));
  }
  const tmp = `${KEEP}.tmp`;
  try {
    fs.writeFileSync(tmp, `${out.join('\n')}\n`);
    fs.renameSync(tmp, KEEP);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

function retireKeep() {
  try { fs.renameSync(KEEP, KEEP_RED); return; } catch {}
  try { fs.rmSync(KEEP, { force: true }); } catch {}
}

function emit(msg, code, cap) {
  process.stderr.write((cap ? String(msg).slice(0, cap) : String(msg)) + '\n');
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
    180,
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

const headLine = `${gitRead(measure, ['rev-parse', '--abbrev-ref', 'HEAD'])} ${gitRead(measure, ['log', '-1', '--format=%h %s'])}`.trim();
const startedIso = nowIso();
const startedAt = Date.now();
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

const wallMs = Date.now() - startedAt;

function wallShow(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const TURN_END = 'END YOUR TURN.';

function lockRefusal(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/another suite run is already going/.test(lines[i])) continue;
    const order = lines[i].replace(/^run-tests: /, '');
    const cut = order.indexOf(TURN_END);
    return cut === -1 ? order : order.slice(0, cut + TURN_END.length);
  }
  return null;
}

const stdout = res.stdout || '';
const stderr = res.stderr || '';
const code = res.status;
const exitCode = code || 1;

let totals = null;
const TOTALS_RE = /TOTALS: (\d+) pass, (\d+) fail, (\d+) tests/g;
for (let m = TOTALS_RE.exec(stdout); m; m = TOTALS_RE.exec(stdout)) totals = m;

const hay = `${stdout}\n${stderr}`;

const keptFor = (count, structured) => (preserve({
  measure, head: headLine, startedIso, count, hay, structured,
}) ? ` (${keepShow()})` : '');

if (!totals) {
  const combined = `${hay}${res.error ? `\n${res.error.message}` : ''}`;
  const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
  const refusal = lockRefusal(lines);
  if (refusal) emit(refusal, 1, 200);
  const last = lines.length ? lines[lines.length - 1].slice(0, 160) : '';
  const at = keptFor(`no summary (exit ${code})`, false);
  emit(
    `[${LEAF}] no "TOTALS: <n> pass, <n> fail, <n> tests" line (exit ${code})${at}; last: ${last}`,
    exitCode,
  );
}

const pass = Number(totals[1]);
const fail = Number(totals[2]);
const tests = Number(totals[3]);

if (tests === 0) {
  const at = keptFor(`0/0, exit ${code}`, false);
  emit(`[${LEAF}] runner executed ZERO tests (exit ${code})${at}`, 1);
}

if (code === 0 && fail === 0) {
  retireKeep();
  emit(`[${LEAF}] ${pass}/${tests} green (${wallShow(wallMs)})`, 0);
}

const names = [];
const NAME_RE = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/gm;
for (let m = NAME_RE.exec(hay); m; m = NAME_RE.exec(hay)) names.push(m[1]);

const at = keptFor(`${pass}/${tests} green, ${fail} failing (exit ${code})`, true);
emit(
  `[${LEAF}] ${pass}/${tests} green, ${fail} failing (${wallShow(wallMs)})${at}: ${names.join('; ')}`,
  exitCode,
  180,
);
