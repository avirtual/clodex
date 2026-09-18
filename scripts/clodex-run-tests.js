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
    '# Fixed names, overwritten: last.txt by the next failing run on this box,',
    '# last-red.txt by the next green run that follows one.',
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
  const tmp = `${KEEP}.${process.pid}.tmp`;
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

const OWN_SCANNERS = [
  'test/architecture-map-complete.test.js',
  'test/comment-ratchet.test.js',
  'test/create-mint-census.test.js',
  'test/electron-boundary.test.js',
  'test/free-identifier-leaks.test.js',
  'test/no-live-registry-in-tests.test.js',
  'test/packaging-allowlist.test.js',
  'test/plugin-web-parity.test.js',
  'test/preserve-across-restart.test.js',
  'test/release-script.test.js',
  'test/sigkill-pid-census.test.js',
  'test/source-control-bytes.test.js',
  'test/ssh-keepalive.test.js',
  'test/tmp-roots-pin.test.js',
  'test/tmp-sweep-prefix-coverage.test.js',
  'test/web-dist-fresh.test.js',
];

const LOCK_BOUND = [
  'cli/test/attach.test.js',
  'cli/test/transport.test.js',
  'test/wirescope-env-gate.test.js',
];

const TEST_ROOTS = ['test', 'cli/test'];

function gitLines(measure, args) {
  const out = gitRead(measure, args);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function existsIn(measure, rel) {
  try {
    return fs.statSync(path.join(measure, rel)).isFile();
  } catch {
    return false;
  }
}

function testPool(measure) {
  const found = [];
  const walk = (rel) => {
    let ents;
    try {
      ents = fs.readdirSync(path.join(measure, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!/fixture/i.test(e.name)) walk(child);
      } else if (e.name.endsWith('.test.js')) found.push(child);
    }
  };
  for (const r of TEST_ROOTS) walk(r);
  return found.sort();
}

function subjectMatchers(sources) {
  return sources.map((rel) => ({
    rel,
    stem: rel.endsWith('.js') ? rel.slice(0, -3) : null,
    literal: rel.endsWith('.js') || rel.includes('/'),
  }));
}

function relPathTargets(testRel, text) {
  const dir = path.posix.dirname(testRel);
  const out = new Set();
  for (const m of text.matchAll(/['"](\.\.?\/[^'"]+)['"]/g)) {
    out.add(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  return out;
}

function selectSet(measure) {
  const master = gitRead(measure, ['rev-parse', '--verify', '--quiet', 'master']);
  if (!master) {
    emit(`[${LEAF}] own: nothing measured — \`master\` does not resolve in ${measure}`, 1, 200);
  }
  const base = gitRead(measure, ['merge-base', 'master', 'HEAD']);
  if (!base) {
    emit(`[${LEAF}] own: nothing measured — no merge base between \`master\` and HEAD`, 1, 200);
  }
  const touched = [...new Set([
    ...gitLines(measure, ['diff', '--name-only', `${base}..HEAD`]),
    ...gitLines(measure, ['diff', '--name-only', 'HEAD']),
    ...gitLines(measure, ['ls-files', '--others', '--exclude-standard']),
  ])];
  if (!touched.length) {
    emit(
      `[${LEAF}] own: nothing to compare — branch equals master and the tree is clean`,
      1,
      200,
    );
  }
  const live = touched.filter((p) => existsIn(measure, p));
  const changed = live.filter((p) => p.endsWith('.test.js')).sort();
  const sources = live.filter((p) => !p.endsWith('.test.js'));
  const seen = new Set(changed);
  const matchers = subjectMatchers(sources);
  const bySubject = [];
  if (matchers.length) {
    for (const t of testPool(measure)) {
      if (seen.has(t)) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(measure, t), 'utf8');
      } catch {
        continue;
      }
      const targets = relPathTargets(t, text);
      const hit = matchers.some(
        (m) => (m.stem !== null && targets.has(m.stem))
          || targets.has(m.rel)
          || (m.literal && text.includes(m.rel)),
      );
      if (!hit) continue;
      bySubject.push(t);
      seen.add(t);
    }
  }
  const scanners = [];
  for (const s of OWN_SCANNERS) {
    if (seen.has(s) || !existsIn(measure, s)) continue;
    scanners.push(s);
    seen.add(s);
  }
  const files = [...changed, ...bySubject, ...scanners];
  return {
    files,
    counts: `${files.length} files: ${changed.length} changed, `
      + `${bySubject.length} by subject, ${scanners.length} scanners`,
    locked: files.some((f) => LOCK_BOUND.includes(f)),
  };
}

function readIfFile(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function reexecInMeasured(measure, rawStdin) {
  if (process.env.CLODEX_RUN_TESTS_REEXEC === '1') return;
  const theirs = path.join(measure, 'scripts', 'clodex-run-tests.js');
  const theirBytes = readIfFile(theirs);
  if (!theirBytes) return;
  const ourBytes = readIfFile(__filename);
  if (ourBytes && theirBytes.equals(ourBytes)) return;
  const res = spawnSync(process.execPath, [theirs], {
    cwd: ROOT,
    input: rawStdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, CLODEX_RUN_TESTS_REEXEC: '1' },
  });
  if (res.error) emit(`[${LEAF}] own: re-exec of ${theirs} failed: ${res.error.message}`, 1, 400);
  if (res.status === null) {
    emit(`[${LEAF}] own: re-exec of ${theirs} failed: killed by ${res.signal || 'an unknown signal'}`, 1, 400);
  }
  process.exit(res.status);
}

const rawStdin = readStdin();
const payload = parsePayload(rawStdin);
const measure = resolveMeasure(payload);
reexecInMeasured(measure, rawStdin);
const runner = path.join(measure, 'scripts', 'run-tests.js');

const scope = Object.prototype.hasOwnProperty.call(payload, 'scope') ? payload.scope : 'full';
if (scope !== 'full' && scope !== 'own') {
  emit(
    `[${LEAF}] refused, nothing measured: scope must be "full" or "own" — ${JSON.stringify(scope)}`,
    1,
    180,
  );
}
const TAG = scope === 'own' ? 'own: ' : '';

if (!fs.existsSync(runner)) {
  emit(
    `[${LEAF}] no test runner at ${runner} — nothing measured (the merge gate needs the same file)`,
    1,
  );
}

const selected = scope === 'own' ? selectSet(measure) : null;

const headLine = `${gitRead(measure, ['rev-parse', '--abbrev-ref', 'HEAD'])} ${gitRead(measure, ['log', '-1', '--format=%h %s'])}`.trim();
const startedIso = nowIso();
const startedAt = Date.now();
const childEnv = {
  ...process.env,
  CLODEX_TEST_LOCK_DIR: path.join(ROOT, '.test-digest.lock'),
  CLODEX_TEST_LOCK_WAIT_MS: '30000',
};
if (selected && selected.locked) childEnv.CLODEX_TEST_LOCK = '1';
else delete childEnv.CLODEX_TEST_LOCK;
if (selected && !selected.locked) childEnv.CLODEX_TEST_SLOW_ADVISORY = '1';
else delete childEnv.CLODEX_TEST_SLOW_ADVISORY;
const res = spawnSync(process.execPath, [runner, '--reporter=dot', ...(selected ? selected.files : [])], {
  cwd: measure,
  env: childEnv,
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

const keptFor = (count, structured, body = hay) => (preserve({
  measure, head: headLine, startedIso, count, hay: body, structured,
}) ? ` (${keepShow()})` : '');

if (!totals) {
  const combined = `${hay}${res.error ? `\n${res.error.message}` : ''}`;
  const lines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
  const refusal = lockRefusal(lines);
  if (refusal) emit(refusal, 1, 200);
  const last = lines.length ? lines[lines.length - 1].slice(0, 160) : '';
  const at = keptFor(`no summary (exit ${code})`, false, combined);
  emit(
    `[${LEAF}] ${TAG}no "TOTALS: <n> pass, <n> fail, <n> tests" line (exit ${code})${at}; last: ${last}`,
    exitCode,
  );
}

const pass = Number(totals[1]);
const fail = Number(totals[2]);
const tests = Number(totals[3]);

if (tests === 0) {
  const at = keptFor(`0/0, exit ${code}`, false);
  emit(`[${LEAF}] ${TAG}runner executed ZERO tests (exit ${code})${at}`, 1);
}

if (code === 0 && fail === 0) {
  retireKeep();
  const breakdown = selected ? ` — ${selected.counts}` : '';
  const ADVISORY_RE = /^SLOW \(advisory, unlocked run\): (\d+)ms (.+)$/gm;
  let slow = '';
  for (let m = ADVISORY_RE.exec(stdout); m; m = ADVISORY_RE.exec(stdout)) {
    slow += ` — SLOW(advisory): ${m[2]} ${m[1]}ms`;
  }
  emit(`[${LEAF}] ${TAG}${pass}/${tests} green (${wallShow(wallMs)})${breakdown}${slow}`, 0);
}

const SLOW_RE = /^SLOW: (?:(\d+)ms (.+)|(stale allowlist entry .+))$/gm;
const ESCAPED_RE = /^ESCAPES: [1-9]/m;
if (code !== 0 && fail === 0 && !ESCAPED_RE.test(stdout) && !ESCAPED_RE.test(stderr)) {
  const slow = [];
  for (let m = SLOW_RE.exec(stdout); m; m = SLOW_RE.exec(stdout)) {
    slow.push(m[3] ? m[3] : `${m[2]} ${m[1]}ms`);
  }
  if (slow.length) {
    const shown = slow.slice(0, 3).join('; ') + (slow.length > 3 ? `; +${slow.length - 3} more` : '');
    emit(
      `[${LEAF}] ${TAG}${pass}/${tests} green, 0 failing — SLOW GATE (not a test failure): ${shown}`
      + ' — a test outside your diff tripping the bar is box load: do not re-run, name it in your report',
      exitCode,
    );
  }
}

const names = [];
const NAME_RE = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/gm;
for (let m = NAME_RE.exec(hay); m; m = NAME_RE.exec(hay)) names.push(m[1]);

const at = keptFor(`${pass}/${tests} green, ${fail} failing (exit ${code})`, true);
emit(
  `[${LEAF}] ${TAG}${pass}/${tests} green, ${fail} failing (${wallShow(wallMs)})${at}: ${names.join('; ')}`,
  exitCode,
  180,
);
