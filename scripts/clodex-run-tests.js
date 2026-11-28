#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = process.cwd();
const LEAF = path.basename(ROOT);

const HOME_DIR = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
const KEEP_DIR = path.join(HOME_DIR, 'test-failures');
function ledgerEnv(base, keepRoute = false) {
  const env = {
    ...base,
    CLODEX_SUITE_LEDGER: path.join(HOME_DIR, 'logs', 'suite-runs.jsonl'),
    CLODEX_SUITE_KIND: 'hand',
  };
  if (base.CLODEX_SEAT) env.CLODEX_SUITE_SEAT = base.CLODEX_SEAT;
  else delete env.CLODEX_SUITE_SEAT;
  delete env.CLODEX_SUITE_TICKET;
  delete env.CLODEX_SUITE_RUN_ID;
  delete env.CLODEX_SUITE_NAMED;
  if (!keepRoute) {
    delete env.CLODEX_SUITE_ROUTE;
    delete env.CLODEX_SUITE_OVERRIDE;
    delete env.CLODEX_SUITE_ENV_DROPPED;
  }
  return env;
}

function envDroppedLine(raw) {
  let d = null;
  try { d = JSON.parse(String(raw || '')); } catch { return ''; }
  if (!d || !Array.isArray(d.envDropped) || !d.envDropped.length) return '';
  const shown = d.envDropped.filter((x) => x && typeof x.name === 'string' && typeof x.why === 'string').map((x) => `${x.name} (${x.why})`);
  return shown.length ? `team env not applied here: ${shown.join(', ')}${d.envDroppedCut === true ? ', …' : ''}` : '';
}
const KEEP = path.join(KEEP_DIR, 'last.txt');
const KEEP_RED = path.join(KEEP_DIR, 'last-red.txt');
const FAIL_CAP = 2000;
const DIAG_CAP = 400;
const RAW_CAP = 400;
const LOCK_WAIT_MS = 15 * 60 * 1000;
const UNKNOWN_DIGEST_MAX = 1200;

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

function failureRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(FAIL\b|not ok\b|\s*✖)/.test(lines[i])) continue;
    rows.push(lines[i]);
    while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) rows.push(lines[++i]);
  }
  return rows;
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
    const rows = failureRows(lines);
    if (rows.length) {
      out.push('## failing rows (every FAIL / not ok / ✖ line, with its indented continuation, wherever it sat in the stream)');
      out.push(...headCap(rows, FAIL_CAP));
      out.push('');
    }
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

let headSuffix = '';
let tailLine = '';

function emit(msg, code, cap) {
  process.stderr.write((cap ? String(msg).slice(0, cap) : String(msg)) + headSuffix + '\n' + (tailLine ? `${tailLine}\n` : ''));
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
  'test/changelog-section-ratchet.test.js',
  'test/comment-ratchet.test.js',
  'test/create-mint-census.test.js',
  'test/electron-boundary.test.js',
  'test/free-identifier-leaks.test.js',
  'test/no-live-registry-in-tests.test.js',
  'test/packaging-allowlist.test.js',
  'test/plugin-web-parity.test.js',
  'test/preserve-across-restart.test.js',
  'test/prompt-ratchet.test.js',
  'test/release-script.test.js',
  'test/sigkill-pid-census.test.js',
  'test/source-control-bytes.test.js',
  'test/ssh-keepalive.test.js',
  'test/tmp-roots-pin.test.js',
  'test/web-dist-fresh.test.js',
];

const LOCK_BOUND = [
  'cli/test/attach.test.js',
  'cli/test/transport.test.js',
  'test/wirescope-env-gate.test.js',
];

const TEST_ROOTS = ['test', 'cli/test'];

function hostTestRoots(raw) {
  if (!raw) return TEST_ROOTS;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return TEST_ROOTS;
  }
  const ok = Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every((r) => typeof r === 'string'
    && r.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(r) && !r.startsWith('/') && !r.startsWith('-')
    && r.split('/').every((seg) => seg && seg !== '..' && !seg.startsWith('.')));
  return ok ? v : TEST_ROOTS;
}

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

function isPoolDir(rel) {
  return rel.split('/').every((seg) => seg !== 'node_modules' && !seg.startsWith('.') && !/fixture/i.test(seg));
}

const TEST_FILE_RE = /\.test\.[cm]?js$/;

function isPoolPath(rel) {
  return TEST_FILE_RE.test(rel) && isPoolDir(path.posix.dirname(rel));
}

const NAMED_MAX = 20;
const NAMED_PATH_MAX = 300;

function namedSet(measure, files) {
  const refuse = (why) => emit(`[${LEAF}] refused, nothing measured: files ${why}`, 1, 400);
  if (!Array.isArray(files)) refuse(`must be an array of test file paths — ${JSON.stringify(files).slice(0, 80)}`);
  if (files.length < 1 || files.length > NAMED_MAX) refuse(`takes 1 to ${NAMED_MAX} paths — got ${files.length}`);
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string') refuse(`entries must be strings — ${JSON.stringify(f).slice(0, 80)}`);
    const shown = JSON.stringify(f.slice(0, 80));
    if (!f || f.length > NAMED_PATH_MAX) refuse(`entry must be 1 to ${NAMED_PATH_MAX} characters — ${shown}`);
    if (/[\s\x00-\x1f\x7f]/.test(f)) refuse(`entry has whitespace or a control character — ${JSON.stringify(f)}`);
    if (f.startsWith('/') || f.startsWith('-')) refuse(`entry must be repo-relative, not starting with / or - — ${shown}`);
    if (f.split(/[\\/]/).includes('..')) refuse(`entry has a .. segment — ${shown}`);
    if (!isPoolPath(f)) refuse(`entry is not a test file (*.test.js, *.test.mjs, *.test.cjs outside fixture, dot and node_modules dirs) — ${shown}`);
    if (!existsIn(measure, f)) refuse(`entry does not exist in ${measure} — ${shown}`);
    if (!out.includes(f)) out.push(f);
  }
  return {
    files: out,
    counts: null,
    named: true,
    locked: out.some((f) => LOCK_BOUND.includes(f)),
  };
}

function testPool(measure, roots = TEST_ROOTS) {
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
        if (isPoolDir(child)) walk(child);
      } else if (isPoolPath(child)) found.push(child);
    }
  };
  for (const r of roots) walk(r);
  return found.sort();
}

function subjectMatchers(sources) {
  return sources.map((rel) => ({
    rel,
    stem: rel.endsWith('.js') ? rel.slice(0, -3) : null,
    literal: /\.[cm]?js$/.test(rel) || rel.includes('/'),
    base: rel.endsWith('.js') || !rel.includes('/') || rel.startsWith('web-dist/')
      ? null : path.posix.basename(rel),
    joined: rel.includes('/')
      ? new RegExp(rel.split('/').map((seg) => `['"]${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).join('\\s*,\\s*'))
      : null,
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

function selectSet(measure, roots = TEST_ROOTS) {
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
  const changed = live.filter((p) => isPoolPath(p)).sort();
  const sources = live.filter((p) => !isPoolPath(p));
  const seen = new Set(changed);
  const matchers = subjectMatchers(sources);
  const bySubject = [];
  if (matchers.length) {
    for (const t of testPool(measure, roots)) {
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
          || (m.literal && text.includes(m.rel))
          || (m.joined !== null && m.joined.test(text))
          || (m.base !== null && (text.includes(`'${m.base}'`) || text.includes(`"${m.base}"`))),
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

function teamEnvOf(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof v === 'string' && !k.startsWith('CLODEX_')));
}

function reexecInMeasured(measure, rawStdin, routeEnv, teamEnv = {}) {
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
    env: { ...ledgerEnv({ ...process.env, ...teamEnv, CLODEX_RUN_TESTS_REEXEC: '1' }), ...routeEnv },
  });
  if (res.error) emit(`[${LEAF}] own: re-exec of ${theirs} failed: ${res.error.message}`, 1, 400);
  if (res.status === null) {
    emit(`[${LEAF}] own: re-exec of ${theirs} failed: killed by ${res.signal || 'an unknown signal'}`, 1, 400);
  }
  process.exit(res.status);
}

function wallShow(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function lockRefusal(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/another suite run is already going/.test(lines[i])) return lines[i].replace(/^run-tests: /, '');
  }
  return null;
}

module.exports = { TEST_ROOTS, failureRows, isPoolPath, testPool, hostTestRoots, envDroppedLine };
if (require.main !== module) return;

const CHANNEL = typeof process.send === 'function';
const rawStdin = readStdin();
const payload = parsePayload(rawStdin);
const measure = resolveMeasure(payload);
if (!CHANNEL) reexecInMeasured(measure, rawStdin, {});
const runner = path.join(measure, 'scripts', 'run-tests.js');

const hasScope = Object.prototype.hasOwnProperty.call(payload, 'scope');
const hasFiles = Object.prototype.hasOwnProperty.call(payload, 'files');
if (hasFiles && hasScope) {
  emit(`[${LEAF}] refused, nothing measured: files replaces scope — drop "scope" ${JSON.stringify(payload.scope)}`, 1, 180);
}
const scope = hasFiles ? 'own' : hasScope ? payload.scope : 'full';
if (scope !== 'full' && scope !== 'own') {
  emit(
    `[${LEAF}] refused, nothing measured: scope must be "full" or "own" — ${JSON.stringify(scope)}`,
    1,
    180,
  );
}
const named = hasFiles ? namedSet(measure, payload.files) : null;

if (!fs.existsSync(runner)) {
  emit(
    `[${LEAF}] no test runner at ${runner} — nothing measured (the merge gate needs the same file)`,
    1,
  );
}

const selected = named || (scope === 'own' ? selectSet(measure, hostTestRoots(process.env.CLODEX_SUITE_TEST_ROOTS)) : null);
const TAG = named ? `named: ${named.files.length} file${named.files.length === 1 ? '' : 's'}: `
  : scope === 'own' ? 'own: ' : '';

function nothingSelected() {
  const at = new Date().toISOString();
  const id = require('crypto').randomUUID();
  const ledger = path.join(HOME_DIR, 'logs', 'suite-runs.jsonl');
  const rows = [{
    id,
    phase: 'start',
    kind: 'hand',
    scope: 'own',
    named: 0,
    ticket: null,
    seat: process.env.CLODEX_SEAT || null,
    tree: measure,
    sha: gitRead(measure, ['rev-parse', 'HEAD']) || null,
    dirty: gitRead(measure, ['status', '--porcelain', '--untracked-files=no']) !== '',
    pid: process.pid,
    where: 'none',
    route: null,
    override: null,
    queuedAt: at,
    startedAt: at,
  }, {
    id, phase: 'end', outcome: 'pass', pass: 0, fail: 0, tests: 0, endedAt: at, durationMs: 0,
  }];
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  } catch {}
  emit(`[${LEAF}] own: 0 test files selected for this branch (nothing run)`, 0);
}

if (!named && selected && !selected.files.length) nothingSelected();

const headLine = `${gitRead(measure, ['rev-parse', '--abbrev-ref', 'HEAD'])} ${gitRead(measure, ['log', '-1', '--format=%h %s'])}`.trim();
const headBefore = gitRead(measure, ['rev-parse', 'HEAD']);
let startedIso = nowIso();
let startedAt = Date.now();

function runLocal(routeEnv, teamEnv = {}) {
  startedIso = nowIso();
  startedAt = Date.now();
  const childEnv = {
    ...ledgerEnv({ ...process.env, ...teamEnv }, process.env.CLODEX_RUN_TESTS_REEXEC === '1'),
    ...routeEnv,
    CLODEX_TEST_LOCK_DIR: path.join(ROOT, '.test-digest.lock'),
    CLODEX_TEST_LOCK_WAIT_MS: String(LOCK_WAIT_MS),
    CLODEX_TEST_LOCK_NOTE_FD: '3',
  };
  if (selected && selected.locked) childEnv.CLODEX_TEST_LOCK = '1';
  else delete childEnv.CLODEX_TEST_LOCK;
  if (selected && !selected.locked) childEnv.CLODEX_TEST_SLOW_ADVISORY = '1';
  else delete childEnv.CLODEX_TEST_SLOW_ADVISORY;
  if (named) childEnv.CLODEX_SUITE_NAMED = String(named.files.length);
  tailLine = envDroppedLine(childEnv.CLODEX_SUITE_ENV_DROPPED);
  const res = spawnSync(process.execPath, [runner, '--reporter=dot', ...(selected ? selected.files : [])], {
    cwd: measure,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe', 2],
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  digest(res, Date.now() - startedAt, null);
}

function askHost() {
  const flags = {};
  if (selected && selected.locked) flags.CLODEX_TEST_LOCK = '1';
  if (selected && !selected.locked) flags.CLODEX_TEST_SLOW_ADVISORY = '1';
  let answered = false;
  process.on('disconnect', () => {
    if (!answered) emit(`[${LEAF}] ${TAG}result unknown — the host closed the suite channel before it answered`, 1, 300);
  });
  process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (typeof m.progress === 'string') {
      process.stderr.write(`${m.progress.slice(0, 400)}\n`);
      return;
    }
    if (answered) return;
    answered = true;
    if (m.run === 'refused') emit(`[${LEAF}] refused, nothing measured: ${m.why}`, 1, 300);
    if (m.run === 'local') {
      const routeEnv = { CLODEX_SUITE_ROUTE: String(m.why || '') };
      if (m.override) routeEnv.CLODEX_SUITE_OVERRIDE = String(m.override);
      if (Array.isArray(m.envDropped) && m.envDropped.length) {
        routeEnv.CLODEX_SUITE_ENV_DROPPED = JSON.stringify({ envDropped: m.envDropped, ...(m.envDroppedCut === true ? { envDroppedCut: true } : {}) });
      }
      const teamEnv = teamEnvOf(m.env);
      reexecInMeasured(measure, rawStdin, routeEnv, teamEnv);
      runLocal(routeEnv, teamEnv);
      return;
    }
    if (m.run !== 'remote' || m.unknown) {
      if (typeof m.note === 'string' && m.note) headSuffix += ` ${m.note}`;
      emit(`[${LEAF}] ${TAG}result unknown — the suite did not complete on runner ${m.runner || '?'}: ${m.unknown || `unexpected reply ${JSON.stringify(m.run)}`}`, 1, UNKNOWN_DIGEST_MAX);
    }
    const hops = Array.isArray(m.moved) && m.moved.length ? [m.moved[0].from, ...m.moved.map((x) => x.to)].join(' -> ') : null;
    const via = m.rerouted && m.rerouted.from ? `(rerouted from ${m.rerouted.from} to ${m.rerouted.to})`
      : hops && m.runner ? `(runner ${m.runner}, moved ${hops})` : m.runner ? `(runner ${m.runner})` : null;
    const box = m.box && typeof m.box === 'object'
      ? `(box ${m.box.isolation || 'unstamped'}${m.box.imageId ? `, image ${String(m.box.imageId).replace(/^sha256:/, '').slice(0, 12)}` : ''})` : null;
    digest({
      status: m.status, signal: m.signal, stdout: m.stdout, stderr: m.stderr, error: null,
      recorded: m.output === 'unavailable' ? m.recorded : null,
    }, Date.now() - startedAt, [via, box, m.note].filter(Boolean).join(' ') || null);
  });
  startedIso = nowIso();
  startedAt = Date.now();
  process.send({
    op: 'suite', measure, scope, files: selected ? selected.files : [], flags, local: payload.local === true,
    ...(named ? { named: true } : {}),
  });
}

if (CHANNEL) askHost();
else runLocal({});

function recordedTotals(rec) {
  if (!rec || typeof rec !== 'object' || (rec.outcome !== 'pass' && rec.outcome !== 'fail')) return null;
  const { pass, fail, tests } = rec;
  if (![pass, fail, tests].every((n) => Number.isInteger(n) && n >= 0) || pass + fail > tests) return null;
  return { outcome: rec.outcome, pass, fail, tests };
}

function digest(res, wallMs, note) {
  const headAfter = gitRead(measure, ['rev-parse', 'HEAD']);
  if (headBefore && headAfter && headAfter !== headBefore) {
    headSuffix = ` (HEAD moved to ${headAfter.slice(0, 9)} during the queue; the suite measured the tree at its start)`;
  }
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';

  let totals = null;
  const TOTALS_RE = /TOTALS: (\d+) pass, (\d+) fail, (\d+) tests/g;
  for (let m = TOTALS_RE.exec(stdout); m; m = TOTALS_RE.exec(stdout)) totals = m;
  const recorded = totals ? null : recordedTotals(res.recorded);
  if (recorded) {
    totals = [null, recorded.pass, recorded.fail, recorded.tests];
    headSuffix += ' (output unavailable; the counts are the runner\'s record)';
  }
  if (note) headSuffix += ` ${note}`;
  const code = recorded ? (recorded.outcome === 'pass' && recorded.fail === 0 ? 0 : res.status || 1) : res.status;
  const exitCode = code || 1;

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
    const breakdown = selected && selected.counts ? ` — ${selected.counts}` : '';
    const ADVISORY_RE = /^SLOW \(advisory, unlocked run\): (\d+)ms (.+)$/gm;
    const advised = [];
    for (let m = ADVISORY_RE.exec(stdout); m; m = ADVISORY_RE.exec(stdout)) {
      const name = m[2].length > 60 ? `${m[2].slice(0, 59)}…` : m[2];
      advised.push(` — SLOW(advisory): ${name} ${m[1]}ms`);
    }
    const slow = advised.slice(0, 3).join('') + (advised.length > 3 ? `; +${advised.length - 3} more` : '');
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
      const at = keptFor(`${pass}/${tests} green, 0 failing — slow gate`, false);
      emit(
        `[${LEAF}] ${TAG}${pass}/${tests} green, 0 failing${at} — SLOW GATE (not a test failure): ${shown}`
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
    `[${LEAF}] ${TAG}${pass}/${tests} green, ${fail} failing (${wallShow(wallMs)})${at}${names.length ? `: ${names.join('; ')}` : ''}`,
    exitCode,
    180,
  );
}
