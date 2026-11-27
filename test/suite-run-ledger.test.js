'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const DIGEST = path.join(ROOT, 'scripts', 'clodex-run-tests.js');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const GREEN = "const { test } = require('node:test');\n"
  + "test('a', () => {});\ntest('b', () => {});\ntest('c', () => {});\n";
const RED = "const { test } = require('node:test');\n"
  + "test('a', () => {});\ntest('b', () => { throw new Error('red'); });\n";

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function mkRunnerRoot(body = GREEN) {
  const root = fs.realpathSync(mkTmpRoot('clx-ledger-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.writeFileSync(path.join(root, 'one.test.js'), body);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']).stdout.trim() };
}

function cleanEnv(extra) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const k of Object.keys(env)) if (k.startsWith('CLODEX_SUITE_') || k.startsWith('CLODEX_TEST_')) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

function runRunner(root, env, args = ['one.test.js']) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-tests.js'), '--reporter=dot', ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000, env: cleanEnv(env),
  });
  const totals = String(res.stdout || '').split('\n').filter((l) => l.startsWith('TOTALS:')).pop() || null;
  return { code: res.status, pid: res.pid, totals, stdout: res.stdout };
}

function readLedger(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function settle(rec, stamps) {
  const out = { ...rec };
  for (const k of stamps) {
    if (k === 'durationMs') assert.ok(Number.isInteger(out[k]) && out[k] >= 0, `durationMs is a non-negative integer: ${out[k]}`);
    else assert.match(out[k], ISO, `${k} is an ISO timestamp`);
    delete out[k];
  }
  return out;
}

test('ledger: unset or empty CLODEX_SUITE_LEDGER writes nothing', () => {
  const { root } = mkRunnerRoot();
  const unset = runRunner(root, {});
  assert.strictEqual(unset.code, 0, 'ENTER: the run itself was green');
  const empty = runRunner(root, { CLODEX_SUITE_LEDGER: '' });
  assert.strictEqual(empty.code, 0);
  const left = fs.readdirSync(root).filter((n) => n.endsWith('.jsonl'));
  assert.deepStrictEqual(left, [], 'no ledger file appears in the measured tree');
});

test('ledger: a green own run writes one start and one end with the same id', () => {
  const { root, sha } = mkRunnerRoot();
  const file = path.join(root, 'logs', 'suite-runs.jsonl');
  const r = runRunner(root, {
    CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-1',
    CLODEX_SUITE_KIND: 'hand', CLODEX_SUITE_SEAT: 'seat-a', CLODEX_SUITE_TICKET: 't9',
  });
  assert.strictEqual(r.totals, 'TOTALS: 3 pass, 0 fail, 3 tests', 'ENTER: the fixture counts are the known ones');
  const recs = readLedger(file);
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(settle(recs[0], ['queuedAt', 'startedAt']), {
    id: 'run-1', phase: 'start', kind: 'hand', scope: 'own', ticket: 't9', seat: 'seat-a',
    tree: root, sha, dirty: false, pid: r.pid, where: 'local', route: null, override: null,
  });
  assert.deepStrictEqual(settle(recs[1], ['endedAt', 'durationMs']), {
    id: 'run-1', phase: 'end', outcome: 'pass', pass: 3, fail: 0, tests: 3,
  });
});

test('ledger: absent kind/seat/ticket read as manual/null/null, a full run is scope full, an edited tree is dirty', () => {
  const { root, sha } = mkRunnerRoot();
  fs.appendFileSync(path.join(root, 'one.test.js'), '\n');
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-2' }, []);
  assert.match(String(r.totals), /^TOTALS: \d+ pass, 0 fail, \d+ tests$/, 'ENTER: the sweep ran to a green TOTALS');
  const [start] = readLedger(file);
  assert.deepStrictEqual(settle(start, ['queuedAt', 'startedAt']), {
    id: 'run-2', phase: 'start', kind: 'manual', scope: 'full', ticket: null, seat: null,
    tree: root, sha, dirty: true, pid: r.pid, where: 'local', route: null, override: null,
  });
});

test('ledger: a red run ends with outcome fail and the TOTALS numbers', () => {
  const { root } = mkRunnerRoot(RED);
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-3' });
  assert.strictEqual(r.totals, 'TOTALS: 1 pass, 1 fail, 2 tests', 'ENTER: the red fixture counted');
  const recs = readLedger(file);
  assert.strictEqual(recs.length, 2);
  assert.deepStrictEqual(settle(recs[1], ['endedAt', 'durationMs']), {
    id: 'run-3', phase: 'end', outcome: 'fail', pass: 1, fail: 1, tests: 2,
  });
});

test('ledger: a run with no TOTALS ends with outcome no-summary', () => {
  const { root } = mkRunnerRoot();
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-4', CLODEX_TEST_RUN_TIMEOUT_MS: '1' });
  assert.strictEqual(r.totals, null, 'ENTER: the runner timed out before printing TOTALS');
  assert.notStrictEqual(r.code, 0);
  const recs = readLedger(file);
  assert.deepStrictEqual(recs.map((x) => x.phase), ['start', 'end']);
  assert.deepStrictEqual(settle(recs[1], ['endedAt', 'durationMs']), {
    id: 'run-4', phase: 'end', outcome: 'no-summary', pass: null, fail: null, tests: null,
  });
});

test('ledger: an unwritable ledger path leaves the exit code and TOTALS line unchanged', () => {
  for (const body of [GREEN, RED]) {
    const { root } = mkRunnerRoot(body);
    const plain = runRunner(root, {});
    const blocked = runRunner(root, { CLODEX_SUITE_LEDGER: path.join(root, 'one.test.js', 'ledger.jsonl') });
    assert.ok(plain.totals, 'ENTER: the plain run printed TOTALS');
    assert.deepStrictEqual({ code: blocked.code, totals: blocked.totals }, { code: plain.code, totals: plain.totals });
  }
});

test('ledger: a file over 5 MB at start is rotated to .1, replacing an older one', () => {
  const { root } = mkRunnerRoot();
  const file = path.join(root, 'ledger.jsonl');
  const big = 5 * 1024 * 1024 + 1;
  fs.writeFileSync(file, Buffer.alloc(big, 0x61));
  fs.writeFileSync(`${file}.1`, 'older\n');
  runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-5' });
  assert.strictEqual(fs.statSync(`${file}.1`).size, big, 'the oversized ledger moved to .1');
  assert.deepStrictEqual(readLedger(file).map((x) => [x.id, x.phase]), [['run-5', 'start'], ['run-5', 'end']]);
});

test('ledger: a file of exactly 5 MB is not rotated', () => {
  const { root } = mkRunnerRoot();
  const file = path.join(root, 'ledger.jsonl');
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024, 0x61));
  runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-6' });
  assert.strictEqual(fs.existsSync(`${file}.1`), false);
  assert.ok(fs.statSync(file).size > 5 * 1024 * 1024, 'the records were appended to the same file');
});

test('ledger: the digest script hands the runner kind hand, the seat and the ledger under CLODEX_HOME/logs', () => {
  const root = fs.realpathSync(mkTmpRoot('clx-ledger-digest-'));
  const probe = path.join(root, 'probe.json');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'run-tests.js'), [
    "const fs = require('fs');",
    'const e = {};',
    "for (const k of Object.keys(process.env)) if (k.startsWith('CLODEX_SUITE_')) e[k] = process.env[k];",
    `fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(e));`,
    "console.log('TOTALS: 1 pass, 0 fail, 1 tests');",
  ].join('\n'));
  const home = path.join(root, 'home', '.clodex');
  const env = cleanEnv({ HOME: path.join(root, 'home'), CLODEX_HOME: home, CLODEX_SEAT: 'hand-7', CLODEX_SUITE_TICKET: 'stale', CLODEX_SUITE_RUN_ID: 'stale', CLODEX_SUITE_NAMED: '1' });
  delete env.CLODEX_RUN_TESTS_REEXEC;
  const res = spawnSync(process.execPath, [DIGEST], { cwd: root, input: '{}', encoding: 'utf8', timeout: 60000, env });
  assert.ok(fs.existsSync(probe), `ENTER: the stub runner ran (${res.stderr})`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(probe, 'utf8')), {
    CLODEX_SUITE_LEDGER: path.join(home, 'logs', 'suite-runs.jsonl'),
    CLODEX_SUITE_KIND: 'hand',
    CLODEX_SUITE_SEAT: 'hand-7',
  });
});

test('ledger: the runner scrubs CLODEX_SUITE_* from the test files it runs, so fixtures cannot write the real ledger', () => {
  const { root } = mkRunnerRoot("const { test } = require('node:test');\n"
    + "test('env', () => { const k = Object.keys(process.env).filter((x) => x.startsWith('CLODEX_SUITE_')); if (k.length) throw new Error(k.join(',')); });\n");
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, {
    CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-7', CLODEX_SUITE_KIND: 'hand', CLODEX_SUITE_SEAT: 's', CLODEX_SUITE_TICKET: 't',
    CLODEX_SUITE_ROUTE: 'hands:off', CLODEX_SUITE_OVERRIDE: 'call', CLODEX_SUITE_NAMED: '1',
  });
  assert.ok(fs.existsSync(file), 'ENTER: the outer run had the ledger set');
  assert.strictEqual(r.totals, 'TOTALS: 1 pass, 0 fail, 1 tests', r.stdout);
});

test('ledger: the start carries where local, queuedAt no later than startedAt, and the route and override the digest handed down', () => {
  const { root } = mkRunnerRoot();
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, {
    CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-8',
    CLODEX_SUITE_ROUTE: 'local:true in the call', CLODEX_SUITE_OVERRIDE: 'call',
  });
  assert.strictEqual(r.totals, 'TOTALS: 3 pass, 0 fail, 3 tests', 'ENTER: the run was green');
  const [start] = readLedger(file);
  assert.deepStrictEqual([start.where, start.route, start.override], ['local', 'local:true in the call', 'call']);
  assert.match(start.queuedAt, ISO);
  assert.ok(Date.parse(start.queuedAt) <= Date.parse(start.startedAt), `${start.queuedAt} <= ${start.startedAt}`);
});

test('ledger: a named run\'s start says named:<file count>, and the digest hands the runner CLODEX_SUITE_NAMED only for files', () => {
  const { root } = mkRunnerRoot();
  const file = path.join(root, 'ledger.jsonl');
  const named = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-9', CLODEX_SUITE_NAMED: '2' });
  assert.strictEqual(named.totals, 'TOTALS: 3 pass, 0 fail, 3 tests', 'ENTER: the named run was green');
  const own = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-10' });
  assert.strictEqual(own.totals, 'TOTALS: 3 pass, 0 fail, 3 tests', 'ENTER: the own run was green');
  const starts = readLedger(file).filter((r) => r.phase === 'start');
  assert.deepStrictEqual(starts.map((r) => [r.id, r.scope, r.named]), [['run-9', 'own', 2], ['run-10', 'own', undefined]]);
  assert.deepStrictEqual(starts.map((r) => [r.id, 'files' in r, 'filesCut' in r]), [['run-9', true, false], ['run-10', false, false]]);

  const probeRoot = fs.realpathSync(mkTmpRoot('clx-ledger-named-'));
  const probe = path.join(probeRoot, 'probe.json');
  fs.mkdirSync(path.join(probeRoot, 'scripts'));
  fs.mkdirSync(path.join(probeRoot, 'test'));
  fs.writeFileSync(path.join(probeRoot, 'test', 'a.test.js'), GREEN);
  fs.writeFileSync(path.join(probeRoot, 'test', 'b.test.js'), GREEN);
  fs.writeFileSync(path.join(probeRoot, 'scripts', 'run-tests.js'), [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(process.env.CLODEX_SUITE_NAMED || null));`,
    "console.log('TOTALS: 1 pass, 0 fail, 1 tests');",
  ].join('\n'));
  const env = cleanEnv({ HOME: path.join(probeRoot, 'home'), CLODEX_HOME: path.join(probeRoot, 'home', '.clodex') });
  delete env.CLODEX_RUN_TESTS_REEXEC;
  const res = spawnSync(process.execPath, [DIGEST], { cwd: probeRoot, input: '{"files":["test/a.test.js","test/b.test.js"]}', encoding: 'utf8', timeout: 60000, env });
  assert.ok(fs.existsSync(probe), `ENTER: the stub runner ran (${res.stderr})`);
  assert.strictEqual(JSON.parse(fs.readFileSync(probe, 'utf8')), '2');
});

test('t2459: a named local run\'s start lists the named files in order; the end keeps only the count', () => {
  const { root } = mkRunnerRoot();
  fs.writeFileSync(path.join(root, 'two.test.js'), GREEN);
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-11', CLODEX_SUITE_NAMED: '2' }, ['two.test.js', 'one.test.js']);
  assert.strictEqual(r.totals, 'TOTALS: 6 pass, 0 fail, 6 tests', 'ENTER: both named files ran');
  const [start, end] = readLedger(file);
  assert.deepStrictEqual([start.phase, start.named, start.files, 'filesCut' in start], ['start', 2, ['two.test.js', 'one.test.js'], false]);
  assert.deepStrictEqual([end.phase, 'files' in end], ['end', false]);
});

test('t2459: a named local run over the limits keeps the first 20 paths, cuts a path to 300 bytes, and says filesCut', () => {
  const { root } = mkRunnerRoot();
  const longDir = `${'d'.repeat(50)}/`.repeat(6);
  fs.mkdirSync(path.join(root, longDir), { recursive: true });
  const long = `${longDir}x.test.js`;
  fs.writeFileSync(path.join(root, long), GREEN);
  const rest = Array.from({ length: 20 }, (_, i) => `f${i}.test.js`);
  for (const f of rest) fs.writeFileSync(path.join(root, f), GREEN);
  const file = path.join(root, 'ledger.jsonl');
  const r = runRunner(root, { CLODEX_SUITE_LEDGER: file, CLODEX_SUITE_RUN_ID: 'run-12', CLODEX_SUITE_NAMED: '21' }, [long, ...rest]);
  assert.strictEqual(r.totals, 'TOTALS: 63 pass, 0 fail, 63 tests', 'ENTER: all 21 named files ran');
  const [start] = readLedger(file);
  assert.deepStrictEqual([start.named, start.filesCut, start.files.length], [21, true, 20]);
  assert.strictEqual(start.files[0], `${'d'.repeat(50)}/`.repeat(5) + 'd'.repeat(45));
  assert.deepStrictEqual(start.files.slice(1), ['f0.test.js', 'f1.test.js', 'f2.test.js', 'f3.test.js', 'f4.test.js', 'f5.test.js', 'f6.test.js', 'f7.test.js', 'f8.test.js', 'f9.test.js', 'f10.test.js', 'f11.test.js', 'f12.test.js', 'f13.test.js', 'f14.test.js', 'f15.test.js', 'f16.test.js', 'f17.test.js', 'f18.test.js']);
});
