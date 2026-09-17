'use strict';
// clodex-run-tests-bin.test.js — the shipped digest bin (scripts/clodex-run-tests.js),
// exercised as the exec dispatcher exercises it: a real spawn, the payload on
// stdin, and the verdict read off the LAST stderr line, which is the only thing
// replyStderr hands back to the seat.
//
// The runner it drives is a STUB scripts/run-tests.js in a tmp dir, not this
// repo's: the whole point of the ticket is that the bin works against any
// project's runner, so a fixture that only runs ours would pin nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-run-tests.js');

// realpath because macOS /tmp is a symlink to /private/tmp: the script reads
// process.cwd(), which is already resolved, so an unresolved fixture path would
// mismatch both the leaf name and the lock dir it asserts.
function mkRoot() {
  return fs.realpathSync(mkTmpRoot('crt-'));
}

const ARGV_FILE = 'stub-argv.json';

// The stub records what it was invoked with BEFORE printing anything, so the
// refusal cases can assert the file's absence as "the runner never ran".
function writeStub(root, { body, exit }) {
  const dir = path.join(root, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-tests.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.writeFileSync(path.join(${JSON.stringify(root)}, ${JSON.stringify(ARGV_FILE)}), JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    '  lockDir: process.env.CLODEX_TEST_LOCK_DIR || null,',
    '  lockWait: process.env.CLODEX_TEST_LOCK_WAIT_MS || null,',
    '  lock: process.env.CLODEX_TEST_LOCK || null,',
    '  advisory: process.env.CLODEX_TEST_SLOW_ADVISORY || null,',
    '  reexec: process.env.CLODEX_RUN_TESTS_REEXEC || null,',
    '  cwd: process.cwd(),',
    '}));',
    body,
    `process.exit(${exit});`,
  ].join('\n'));
}

function run(root, payload, { home = path.join(root, 'home'), env = {} } = {}) {
  const base = { ...process.env, HOME: home, CLODEX_HOME: path.join(home, '.clodex') };
  delete base.CLODEX_RUN_TESTS_REEXEC;
  delete base.CLODEX_TEST_SLOW_ADVISORY;
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...base, ...env },
  });
  const lines = String(res.stderr || '').split('\n').filter((l) => l.trim());
  const dir = path.join(home, '.clodex', 'test-failures');
  const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    code: res.status,
    digest: lines.length ? lines[lines.length - 1] : '',
    stderr: String(res.stderr || ''),
    stdout: res.stdout,
    keepDir: dir,
    kept: readIf(path.join(dir, 'last.txt')),
    keptRed: readIf(path.join(dir, 'last-red.txt')),
  };
}

const KEEP_SHOW = '~/.clodex/test-failures/last.txt';

function stubRecord(root) {
  const p = path.join(root, ARGV_FILE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function keptIndices(kept, re) {
  return [...String(kept).matchAll(re)].map((m) => Number(m[1]));
}

// The digest carries the run's own wall time, which is elapsed real time and so
// cannot be a literal in a fixture. WALL stands in for it and expands to a
// SHAPE — everything else in the line is still matched byte for byte, anchored
// at both ends. Relaxing these subjects to a substring check instead would give
// up exactly what they exist to pin: a line that lost its counts, its tree
// marker or its failing names would still pass.
const WALL = '<WALL>';
const WALL_RE = '\\d+m \\d{2}s';

function assertDigest(actual, expected, message) {
  const pattern = expected
    .split(WALL)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(WALL_RE);
  assert.match(String(actual), new RegExp(`^${pattern}$`), message);
}

test('no scripts/run-tests.js: refuses and names the file the merge gate needs', () => {
  const root = mkRoot();
  try {
    const r = run(root, '{}');
    assert.strictEqual(r.code, 1, 'a project with no runner must not exit 0');
    assert.ok(r.digest.startsWith(`[${path.basename(root)}] no test runner`),
      `the last stderr line must open with the leaf and the reason, got: ${r.digest}`);
    assert.ok(r.digest.includes(path.join(root, 'scripts', 'run-tests.js')),
      'and it must name the path it looked for, or the operator cannot act on it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a green run: the digest counts, exit 0, and --reporter=dot reached the runner', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 3 pass, 0 fail, 3 tests');", exit: 0 });
    const r = run(root, '{}');
    assertDigest(r.digest, `[${path.basename(root)}] 3/3 green (${WALL})`);
    assert.strictEqual(r.code, 0);
    const rec = stubRecord(root);
    // ENTER: without the record the argv assertion below would pass vacuously
    // on a run that never reached the stub at all.
    assert.ok(rec, 'the stub must have run');
    assert.deepStrictEqual(rec.argv, ['--reporter=dot'],
      'the dot reporter is what keeps the runner\'s output bounded; a default reporter is a different run');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a green run whose runner advised a slow test: the digest NAMES it, with no ✖', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        "console.log('SLOW (advisory, unlocked run): 9123ms alpha waits on a real timer');",
        "console.log('SLOW (advisory, unlocked run): this run took no suite lock, so a slow test and "
          + "a busy box look the same here; the locked full run still enforces the six-second bar');",
        "console.log('TOTALS: 1 pass, 0 fail, 1 tests');",
      ].join('\n'),
      exit: 0,
    });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 0, 'the advisory path is green by construction; a nonzero exit fails the hand');
    assertDigest(
      r.digest,
      `[${path.basename(root)}] 1/1 green (${WALL}) — SLOW(advisory): alpha waits on a real timer 9123ms`,
      'the hand reads only this line, so an advisory the runner printed and the digest dropped is invisible',
    );
    assert.ok(!r.digest.includes(' ✖ '),
      'a ✖ here would be read back by the wrapper\'s own NAME_RE and report a green run as failing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a red run: the failing NAMES ride the digest and the exit code survives', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        "console.log(' ✖ alpha (1.2ms)');",
        "console.log('TOTALS: 2 pass, 1 fail, 3 tests');",
      ].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assertDigest(r.digest, `[${path.basename(root)}] 2/3 green, 1 failing (${WALL}) (${KEEP_SHOW}): alpha`);
    assert.strictEqual(r.code, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an EMPTY tree is refused and the runner is never spawned', () => {
  // The shape a caller produces by templating an unset variable, `{"tree":"$WT"}`.
  // Falling through to the root here would hand a caller who asked about a
  // worktree a real, current, green number about master.
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 3 pass, 0 fail, 3 tests');", exit: 0 });
    const r = run(root, JSON.stringify({ tree: '' }));
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, `[${path.basename(root)}] refused, nothing measured: not a worktree of this repo — (empty)`);
    assert.strictEqual(stubRecord(root), null, 'nothing may be measured on the refusal path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a tree outside this repo is refused and the runner is never spawned', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 3 pass, 0 fail, 3 tests');", exit: 0 });
    const r = run(root, JSON.stringify({ tree: '/nope' }));
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest, `[${path.basename(root)}] refused, nothing measured: not a worktree of this repo — /nope`);
    assert.strictEqual(stubRecord(root), null, 'nothing may be measured on the refusal path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the runner inherits the ROOT\'s lock dir, so every checkout shares one mutex', () => {
  // A lock relative to the MEASURED tree gives each worktree its own mutex,
  // which excludes nothing: two suites then reach the port-binding tests
  // together and deadlock at 0% CPU.
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 0, `ENTER: the run must have succeeded, got: ${r.digest}`);
    const rec = stubRecord(root);
    assert.ok(rec, 'the stub must have run');
    assert.strictEqual(rec.lockDir, path.join(root, '.test-digest.lock'));
    assert.strictEqual(rec.lockWait, '30000');
    assert.strictEqual(rec.cwd, root, 'the runner runs in the measured tree');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a runner that prints no TOTALS is reported as "nothing measured", never as green', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.error('boom: cannot start');", exit: 7 });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 7, 'the runner\'s own exit code is the verdict');
    assert.ok(r.digest.startsWith(`[${path.basename(root)}] no "TOTALS:`), r.digest);
    assert.ok(r.digest.includes(`(${KEEP_SHOW})`),
      `the arm with the least information most needs the dump named; got ${r.digest}`);
    assert.ok(r.digest.includes('boom: cannot start'),
      'the runner\'s last line is the only diagnosis the seat gets');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lock refusal reaches the seat WHOLE — the order is what the exec exists to deliver', () => {
  // A refused run produces no TOTALS, so it used to fall into the "no TOTALS
  // summary … last line:" wrapper, which slices the runner's line at 160 with a
  // 79-char prefix in front of it. `[agent:remind in <K>m]` sits at char 149+
  // of the refusal (run-tests.js's die() prefixes `run-tests: `), so the cut
  // landed inside the fragment and the dispatcher's own 200-slice then left the
  // caller "…not starting a s". The entire deliverable was lost on this path,
  // and a seat that cannot read the wait retries every two minutes — the loop
  // the refusal was written to stop.
  const root = mkRoot();
  try {
    const refusal = 'run-tests: another suite run is already going (pid 1234567, running 2:05 of a'
      + ' ~9 min suite) - waited 30s, not starting a second. Do not re-emit: emit'
      + ' [agent:remind in 6m] re-run the suite, END YOUR TURN. Parts of this suite bind real'
      + ' ports, so a second run deadlocks both; if it is wedged: kill 1234567 && rm -rf /x/y';
    writeStub(root, { body: `console.error(${JSON.stringify(refusal)});`, exit: 1 });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 1, 'a refusal is not a green');
    assert.ok(r.digest.includes('[agent:remind in 6m]'),
      `the literal line the caller must emit has to survive; got ${JSON.stringify(r.digest)}`);
    assert.ok(r.digest.includes('END YOUR TURN'),
      `and the instruction to stop being billed; got ${JSON.stringify(r.digest)}`);
    assert.ok(r.digest.length <= 200,
      `the dispatcher delivers 200 chars of the last stderr line, so anything past that never `
      + `arrives; got ${r.digest.length}`);
    assert.ok(!r.digest.startsWith(`[${path.basename(root)}] no "TOTALS:`),
      `the refusal must not be wrapped as an unexplained failure; got ${JSON.stringify(r.digest)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a runner that executed ZERO tests is a failure, not a 0/0 green', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 0 pass, 0 fail, 0 tests');", exit: 0 });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 1, 'exit 0 here would report a green over a run that verified nothing');
    assert.strictEqual(r.digest,
      `[${path.basename(root)}] runner executed ZERO tests (exit 0) (${KEEP_SHOW})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a long failing list is CUT, so the digest fits what the dispatcher returns', () => {
  // replyStderr hands back a bounded slice of the last stderr line. An uncut
  // list would be truncated by the dispatcher instead, past the point where the
  // counts at the head are still readable.
  const root = mkRoot();
  try {
    const names = Array.from({ length: 40 }, (_, i) => `console.log(' ✖ failing-test-name-${i} (1.0ms)');`);
    writeStub(root, {
      body: [...names, "console.log('TOTALS: 0 pass, 40 fail, 40 tests');"].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.digest.length, 180, `the failing line is cut to 180, got ${r.digest.length}`);
    assert.ok(new RegExp(`^\\[${path.basename(root)}\\] 0/40 green, 40 failing \\(${WALL_RE}\\) `
      + `\\(${KEEP_SHOW.replace(/[.]/g, '\\.')}\\): failing-test-name-0`).test(r.digest),
    'the counts, the duration and the preserved PATH survive the cut — a truncated name is still '
      + 'recoverable from the file, a truncated path from nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const DOT_RED = [
  "console.log('.....X');",
  "console.log('');",
  "console.log('Failed tests:');",
  "console.log('');",
  "console.log(' ✖ the failing subtest (1.3ms)');",
  "console.log('  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:');",
  "console.log('  + actual - expected');",
  "console.log('  +   b: 2');",
  "console.log('  -   b: 3');",
  "console.log('      at TestContext.<anonymous> (/x/a.test.js:4:44)');",
  "console.log('TOTALS: 5 pass, 1 fail, 6 tests');",
].join('\n');

test('keep: a failing run preserves the assertion text, diff and stack it produced', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: DOT_RED, exit: 1 });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'a red run preserved nothing: the shipped grant emits 180 chars and '
      + 'the evidence behind them exists nowhere else');
    assert.match(r.kept, /^ *✖ the failing subtest \(1\.3ms\)$/m, 'the failing row is not in the file');
    assert.match(r.kept, /Expected values to be strictly deep-equal/,
      'the assertion text did not survive — it is the half the digest line cannot carry');
    assert.match(r.kept, /\+ {3}b: 2/, 'the diff did not survive');
    assert.match(r.kept, /at TestContext\.<anonymous> \(\/x\/a\.test\.js:4:44\)/,
      'the stack did not survive');
    assert.match(r.kept, /^# tree: {2}/m, 'the dump does not name the tree it measured');
    assert.match(r.kept, /^# count: 5\/6 green, 1 failing \(exit 1\)$/m,
      'the dump does not carry the verdict it is evidence for');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: the dump lands outside the measured tree, under CLODEX_HOME', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: DOT_RED, exit: 1 });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'ENTER: nothing was preserved, so there is no location to judge');
    assert.ok(!fs.existsSync(path.join(root, 'test-failures')),
      'the dump landed INSIDE the measured tree, which is a worktree the loop removes under it');
    assert.ok(r.digest.includes(`(${KEEP_SHOW})`),
      `the digest must name the file or nobody can find it; got ${r.digest}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: a green run retires the red it followed rather than destroying it', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: DOT_RED, exit: 1 });
    const red = run(root, '{}');
    assert.ok(red.kept !== null, 'ENTER: the red run preserved nothing, so the green arm below '
      + 'has no evidence to retire');

    writeStub(root, { body: "console.log('TOTALS: 6 pass, 0 fail, 6 tests');", exit: 0 });
    const green = run(root, '{}');
    assertDigest(green.digest, `[${path.basename(root)}] 6/6 green (${WALL})`,
      'the green line gained a path: it would point at evidence about a DIFFERENT run');
    assert.strictEqual(green.kept, null,
      'the current-run name still holds the older failure, which the next reader takes for '
      + 'evidence about the green run');
    assert.ok(green.keptRed !== null, 'the green run destroyed the red it followed');
    assert.match(green.keptRed, /Expected values to be strictly deep-equal/,
      'the retired file lost the assertion text, which is what made it worth keeping');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: the preserved files are TWO fixed names, overwritten, never a growing set', () => {
  const root = mkRoot();
  const home = path.join(root, 'shared-home');
  try {
    writeStub(root, { body: DOT_RED, exit: 1 });
    run(root, '{}', { home });
    writeStub(root, { body: "console.log('TOTALS: 6 pass, 0 fail, 6 tests');", exit: 0 });
    const first = run(root, '{}', { home });
    assert.ok(first.keptRed !== null, 'ENTER: the first cycle retired nothing to overwrite');

    writeStub(root, {
      body: [
        "console.log('Failed tests:');",
        "console.log(' ✖ a different failing subtest (1.0ms)');",
        "console.log('TOTALS: 5 pass, 1 fail, 6 tests');",
      ].join('\n'),
      exit: 1,
    });
    run(root, '{}', { home });
    writeStub(root, { body: "console.log('TOTALS: 6 pass, 0 fail, 6 tests');", exit: 0 });
    const second = run(root, '{}', { home });
    assert.match(String(second.keptRed), /a different failing subtest/,
      'the second cycle did not overwrite the first: the name now holds stale evidence');
    assert.deepStrictEqual(fs.readdirSync(second.keepDir).sort(), ['last-red.txt'],
      'the dump directory grew a file per cycle — fixed names are what bound it without a prune');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: a lock refusal preserves nothing and destroys nothing — it measured nothing', () => {
  const root = mkRoot();
  const home = path.join(root, 'shared-home');
  try {
    writeStub(root, { body: DOT_RED, exit: 1 });
    const red = run(root, '{}', { home });
    assert.ok(red.kept !== null, 'ENTER: nothing was preserved for the refusal to threaten');

    const refusal = 'run-tests: another suite run is already going (pid 1234567, running 2:05) -'
      + ' waited 30s, not starting a second. Do not re-emit: emit [agent:remind in 6m] re-run the'
      + ' suite, END YOUR TURN.';
    writeStub(root, { body: `console.error(${JSON.stringify(refusal)});`, exit: 1 });
    const r = run(root, '{}', { home });
    assert.ok(r.digest.includes('[agent:remind in 6m]'), 'ENTER: this is not the refusal arm');
    assert.strictEqual(r.kept, red.kept,
      'a refused run rewrote the dump: it ran no tests, so anything it writes replaces real '
      + 'evidence with the text of a run that never started');
    assert.strictEqual(r.keptRed, null, 'and it must not retire one either');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: output with no `Failed tests:` block falls back to a raw tail, never to empty', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        "console.log('some reporter this bin has never seen');",
        "console.log('with a failure described in its own words');",
        "console.log('TOTALS: 5 pass, 1 fail, 6 tests');",
      ].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'an unrecognised reporter cost the evidence entirely');
    assert.match(r.kept, /a failure described in its own words/,
      'the raw tail did not survive, so the file is a confident silence');
    assert.match(r.kept, /raw tail follows/, 'and it does not say that it is a fallback');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const OVER_CAP_FAILS = 2100;

test('keep: an over-cap failing section is CUT, and what survives is its EARLIEST rows', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        "console.log('Failed tests:');",
        `for (let i = 0; i < ${OVER_CAP_FAILS}; i += 1) console.log(' ✖ fail-row-' + i + ' (1.0ms)');`,
        `console.log('TOTALS: 5 pass, ${OVER_CAP_FAILS} fail, ${OVER_CAP_FAILS + 5} tests');`,
      ].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'ENTER: nothing was preserved, so there is no reduction to judge');
    const rows = keptIndices(r.kept, /^ *✖ fail-row-(\d+) \(/gm);
    assert.strictEqual(rows.length, 1999,
      `nothing but this cap bounds the dump an agent reads after a red: ${OVER_CAP_FAILS} failing `
      + 'rows must come out at the 2000-line cap less the `Failed tests:` header that shares it, '
      + `got ${rows.length}`);
    assert.strictEqual(rows[0], 0,
      'the first failing row was cut away: the head is the half a reader opens the file for');
    assert.strictEqual(rows[rows.length - 1], 1998,
      'the surviving rows are not the LEADING ones, so this reduction is a tail or a middle');
    assert.match(r.kept, /^## \(\d+ further failure lines dropped\)$/m,
      'the section was cut without saying so, which reads as a complete failure list');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const OVER_CAP_DIAG = 500;

test('keep: an over-cap diagnostics section keeps BOTH ends and drops its middle', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        `for (let i = 0; i < ${OVER_CAP_DIAG}; i += 1) console.log('diag-' + i + '-end');`,
        "console.log('Failed tests:');",
        "console.log(' ✖ the failing subtest (1.3ms)');",
        "console.log('TOTALS: 5 pass, 1 fail, 6 tests');",
      ].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'ENTER: nothing was preserved, so there is no reduction to judge');
    const diag = keptIndices(r.kept, /^diag-(\d+)-end$/gm);
    assert.strictEqual(diag.length, 400,
      `${OVER_CAP_DIAG} diagnostic lines must come out at the 400-line cap, got ${diag.length}`);
    assert.strictEqual(diag[0], 0,
      'the opening diagnostics were cut, where the run announces what it is doing');
    assert.strictEqual(diag[199], 199, 'the kept head is not the first half of the cap');
    assert.strictEqual(diag[200], 300,
      'the drop did not land in the MIDDLE: this reduction kept a contiguous run, not both ends');
    assert.strictEqual(diag[399], 499,
      'the closing diagnostics were cut, which is where the summary and the escapes sit');
    assert.match(r.kept, /^## \(100 diagnostic lines dropped\)$/m,
      'the section was cut without saying so, or it said the wrong count');
    assert.match(r.kept, /^ *✖ the failing subtest \(1\.3ms\)$/m,
      'the diagnostics cap reached the failing rows, which are buffered apart from it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const OVER_CAP_RAW = 500;

test('keep: an over-cap raw fallback keeps the LATEST lines, never the opening ones', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        `for (let i = 0; i < ${OVER_CAP_RAW}; i += 1) console.log('raw-' + i + '-end');`,
        "console.log('TOTALS: 5 pass, 1 fail, 6 tests');",
      ].join('\n'),
      exit: 1,
    });
    const r = run(root, '{}');
    assert.ok(r.kept !== null, 'ENTER: nothing was preserved, so there is no reduction to judge');
    assert.match(r.kept, /raw tail follows/, 'ENTER: this is not the raw-fallback arm');
    const raw = keptIndices(r.kept, /^raw-(\d+)-end$/gm);
    assert.ok(raw.length <= 400,
      `${OVER_CAP_RAW} unrecognised lines must come out at or under the 400-line cap, got ${raw.length}`);
    assert.strictEqual(raw[raw.length - 1], OVER_CAP_RAW - 1,
      'the final lines were cut: an unrecognised reporter describes its failure at the END');
    assert.ok(raw[0] >= 100,
      `the EARLIEST lines were the ones kept, so this is a head cut: kept from raw-${raw[0]}-end`);
    assert.strictEqual(raw[raw.length - 1] - raw[0], raw.length - 1,
      'the kept lines are not one contiguous run, so this reduction dropped a middle');
    assert.match(r.kept, /^## \(\d+ earlier lines dropped\)$/m,
      'the tail was cut without saying so, which reads as the whole of the run');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the runner\'s stdout is never forwarded — the seat gets one stderr line', () => {
  const root = mkRoot();
  try {
    writeStub(root, {
      body: [
        "console.log('a'.repeat(500));",
        "console.log('TOTALS: 2 pass, 0 fail, 2 tests');",
      ].join('\n'),
      exit: 0,
    });
    const r = run(root, '{}');
    assert.strictEqual(r.stdout, '', 'forwarding the runner\'s stdout would blow the def\'s maxBytes');
    assertDigest(r.digest, `[${path.basename(root)}] 2/2 green (${WALL})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const SCRIPT_TEXT = fs.readFileSync(SCRIPT, 'utf8');

function listFromScript(name) {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(SCRIPT_TEXT);
  assert.ok(m, `${name} is not a literal array in the shipped bin — the fixture cannot read it`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const OWN_SCANNERS = listFromScript('OWN_SCANNERS');
const LOCK_BOUND = listFromScript('LOCK_BOUND');

function git(root, ...args) {
  execFileSync('git', [
    '-C', root,
    '-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { stdio: 'ignore' });
}

function put(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

const EMPTY_TEST = "require('node:test').test('x', () => {});\n";

function mkBranchRepo(root, { extraOnMaster = {}, onBranch = () => {}, stub = {} } = {}) {
  writeStub(root, { body: stub.body || "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: stub.exit ?? 0 });
  git(root, 'init', '-q', '-b', 'master');
  for (const s of OWN_SCANNERS) put(root, s, EMPTY_TEST);
  for (const [rel, body] of Object.entries(extraOnMaster)) put(root, rel, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  onBranch({ put: (rel, body) => put(root, rel, body), git: (...a) => git(root, ...a) });
}

test('scope: the default passes NO positional args — today\'s full run, byte for byte', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root, { onBranch: ({ put: p }) => p('test/alpha.test.js', `${EMPTY_TEST}// edited\n`) });
    const rec = (() => { run(root, '{}'); return stubRecord(root); })();
    assert.deepStrictEqual(rec.argv, ['--reporter=dot'],
      'a default-scope run must still sweep: one positional arg turns off the suite lock');
    assert.strictEqual(rec.lock, null, 'and it must not set the force-lock override');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: the argv is exactly changed ∪ by-subject ∪ scanners, and nothing else', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root, {
      extraOnMaster: {
        'test/alpha.test.js': EMPTY_TEST,
        'test/deleted.test.js': EMPTY_TEST,
        'test/unrelated.test.js': EMPTY_TEST,
        'test/widget-require.test.js': `${EMPTY_TEST}require('../lib/widget');\n`,
        'cli/test/nested.test.js': `${EMPTY_TEST}require('../src/nested');\n`,
        'cli/src/nested.js': 'module.exports = 5;\n',
        'test/shape.test.js': `${EMPTY_TEST}const SUBJECT = 'renderer/renderer.js';\n`,
        'test/fixtures/decoy.test.js': `${EMPTY_TEST}require('../../lib/widget');\n`,
        'lib/widget.js': 'module.exports = 1;\n',
        'renderer/renderer.js': 'module.exports = 2;\n',
      },
      onBranch: ({ put: p, git: g }) => {
        p('test/alpha.test.js', `${EMPTY_TEST}// edited on the branch\n`);
        p('lib/widget.js', 'module.exports = 3;\n');
        p('cli/src/nested.js', 'module.exports = 6;\n');
        p('renderer/renderer.js', 'module.exports = 4;\n');
        g('rm', '-q', 'test/deleted.test.js');
        g('add', '-A');
        g('commit', '-qm', 'branch work');
        p('test/untracked.test.js', EMPTY_TEST);
      },
    });
    const r = run(root, '{"scope":"own"}');
    const rec = stubRecord(root);
    assert.ok(rec, 'ENTER: the runner never ran, so there is no selection to judge');
    assert.ok(rec.argv.includes('test/widget-require.test.js'),
      'ENTER: the by-subject row is empty, so this asserts nothing about subject selection');
    assert.ok(rec.argv.includes('test/shape.test.js'),
      'ENTER: the literal-path row is empty, so the source-shape tests would go unrun');
    assert.ok(rec.argv.includes('cli/test/nested.test.js'),
      'a require target resolves against the TEST\'s own directory: every cli test reaches its '
      + 'subject as `../src/x`, so a repo-relative stem match selects none of them');
    assert.deepStrictEqual(rec.argv, [
      '--reporter=dot',
      'test/alpha.test.js',
      'test/untracked.test.js',
      'cli/test/nested.test.js',
      'test/shape.test.js',
      'test/widget-require.test.js',
      ...OWN_SCANNERS,
    ], 'the selected set is the union in changed → by-subject → scanners order, with no duplicates');
    assert.ok(!rec.argv.includes('test/unrelated.test.js'),
      'a test that names neither a changed module nor the tree is not the branch\'s to run');
    assert.ok(!rec.argv.includes('test/fixtures/decoy.test.js'),
      'a hit inside a fixture directory is a fixture, not a test file');
    assertDigest(r.digest,
      `[${path.basename(root)}] own: 1/1 green (${WALL}) — ${OWN_SCANNERS.length + 5} files: `
      + '2 changed, 3 by subject, ' + `${OWN_SCANNERS.length} scanners`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: a test file the branch DELETED is not handed to the runner', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root, {
      extraOnMaster: { 'test/deleted.test.js': EMPTY_TEST },
      onBranch: ({ git: g }) => {
        g('rm', '-q', 'test/deleted.test.js');
        g('commit', '-qm', 'drop a test');
      },
    });
    const r = run(root, '{"scope":"own"}');
    const rec = stubRecord(root);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.ok(!rec.argv.includes('test/deleted.test.js'),
      'the deletion is in the branch diff, but run-tests.js refuses a whole run over a missing path');
    assertDigest(r.digest,
      `[${path.basename(root)}] own: 1/1 green (${WALL}) — ${OWN_SCANNERS.length} files: `
      + `0 changed, 0 by subject, ${OWN_SCANNERS.length} scanners`,
      'a branch with changes but an empty computed set still reports the scanner floor it ran');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const NON_JS_CASES = [
  {
    what: 'an exec definition',
    subject: 'resources/library/exec/x.json',
    master: '{"type":"shell"}\n',
    branch: '{"type":"shell","timeout_ms":1}\n',
    picks: 'test/names-exec.test.js',
    picksBody: `${EMPTY_TEST}const DEF = 'resources/library/exec/x.json';\n`,
    decoy: 'test/decoy-exec.test.js',
    decoyBody: `${EMPTY_TEST}require('../resources/library/exec/x');\n`,
  },
  {
    what: 'a prompt',
    subject: 'resources/library/prompts/system/x.md',
    master: '# one\n',
    branch: '# two\n',
    picks: 'test/names-prompt.test.js',
    picksBody: `${EMPTY_TEST}const P = 'resources/library/prompts/system/x.md';\n`,
    decoy: 'test/decoy-prompt.test.js',
    decoyBody: `${EMPTY_TEST}require('../resources/library/prompts/system/x');\n`,
  },
  {
    what: 'a JSON reached only by a relative require',
    subject: 'cli/src/data.json',
    master: '{"n":1}\n',
    branch: '{"n":2}\n',
    picks: 'cli/test/requires-json.test.js',
    picksBody: `${EMPTY_TEST}require('../src/data.json');\n`,
    decoy: 'cli/test/decoy-json.test.js',
    decoyBody: `${EMPTY_TEST}require('../src/data');\n`,
  },
];

for (const c of NON_JS_CASES) {
  test(`scope own: a branch changing only ${c.what} selects the test that names it`, () => {
    const root = mkRoot();
    try {
      mkBranchRepo(root, {
        extraOnMaster: {
          [c.subject]: c.master,
          [c.picks]: c.picksBody,
          [c.decoy]: c.decoyBody,
          'test/unrelated.test.js': EMPTY_TEST,
        },
        onBranch: ({ put: p, git: g }) => {
          p(c.subject, c.branch);
          g('commit', '-aqm', 'branch work');
        },
      });
      const r = run(root, '{"scope":"own"}');
      const rec = stubRecord(root);
      assert.ok(rec, 'ENTER: the runner never ran, so there is no selection to judge');
      assert.ok(rec.argv.includes(c.picks),
        `${c.subject} is the only thing the branch changed and ${c.picks} names it: a subject set `
        + 'filtered to .js selects nothing here but scanners');
      assert.ok(!rec.argv.includes(c.decoy),
        `${c.decoy} reaches ${c.subject} only with the extension stripped, which is not a path: a `
        + 'non-.js subject carries no stem, so only its full rel may match');
      assert.ok(!rec.argv.includes('test/unrelated.test.js'),
        'a test that names neither the changed resource nor the tree is not the branch\'s to run');
      assertDigest(r.digest,
        `[${path.basename(root)}] own: 1/1 green (${WALL}) — ${OWN_SCANNERS.length + 1} files: `
        + `0 changed, 1 by subject, ${OWN_SCANNERS.length} scanners`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('scope own: a root-level policy file is no subject — every branch edits CHANGELOG.md', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root, {
      extraOnMaster: {
        'CHANGELOG.md': '## Unreleased\n',
        'test/mentions-changelog.test.js':
          `${EMPTY_TEST}const F = 'CHANGELOG.md';\n`,
        'docs/guide.md': '# guide\n',
        'test/mentions-guide.test.js': `${EMPTY_TEST}const G = 'docs/guide.md';\n`,
      },
      onBranch: ({ put: p, git: g }) => {
        p('CHANGELOG.md', '## Unreleased\n- a bullet\n');
        g('commit', '-aqm', 'branch work');
      },
    });
    const r = run(root, '{"scope":"own"}');
    const rec = stubRecord(root);
    assert.ok(rec, 'ENTER: the runner never ran, so there is no selection to judge');
    assert.ok(!rec.argv.includes('test/mentions-changelog.test.js'),
      'this repo\'s ticket flow REQUIRES a CHANGELOG.md edit, so a bare root-level name matched '
      + 'literally puts every test that mentions it — two of them heavy real-git suites — into '
      + 'every scoped run, which is the cost the scope exists to avoid');
    assertDigest(r.digest,
      `[${path.basename(root)}] own: 1/1 green (${WALL}) — ${OWN_SCANNERS.length} files: `
      + `0 changed, 0 by subject, ${OWN_SCANNERS.length} scanners`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  const nested = mkRoot();
  try {
    mkBranchRepo(nested, {
      extraOnMaster: {
        'docs/guide.md': '# guide\n',
        'test/mentions-guide.test.js': `${EMPTY_TEST}const G = 'docs/guide.md';\n`,
      },
      onBranch: ({ put: p, git: g }) => {
        p('docs/guide.md', '# guide\n\nmore\n');
        g('commit', '-aqm', 'branch work');
      },
    });
    run(nested, '{"scope":"own"}');
    const rec = stubRecord(nested);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.ok(rec.argv.includes('test/mentions-guide.test.js'),
      'a non-.js subject inside a directory is still selected by its literal path: the exclusion '
      + 'is root-level bare names, not every non-.js file');
  } finally { fs.rmSync(nested, { recursive: true, force: true }); }
});

test('scope own: a subject reached only through a quoted relative path outside require()', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root, {
      extraOnMaster: {
        'cli/src/tool.js': 'module.exports = 1;\n',
        'cli/test/spawns-tool.test.js':
          `${EMPTY_TEST}spawnSync(process.execPath, ['../src/tool.js']);\n`,
        'test/unrelated.test.js': EMPTY_TEST,
      },
      onBranch: ({ put: p, git: g }) => {
        p('cli/src/tool.js', 'module.exports = 2;\n');
        g('commit', '-aqm', 'branch work');
      },
    });
    const r = run(root, '{"scope":"own"}');
    const rec = stubRecord(root);
    assert.ok(rec, 'ENTER: the runner never ran, so there is no selection to judge');
    assert.ok(rec.argv.includes('cli/test/spawns-tool.test.js'),
      'the test names its subject in a spawn argv, not a require, and `cli/src/tool.js` never '
      + 'appears literally in it: anchoring the relative-path rule to `require(` loses this row');
    assert.ok(!rec.argv.includes('test/unrelated.test.js'),
      'ENTER: the by-subject row would be non-empty for the wrong reason');
    assertDigest(r.digest,
      `[${path.basename(root)}] own: 1/1 green (${WALL}) — ${OWN_SCANNERS.length + 1} files: `
      + `0 changed, 1 by subject, ${OWN_SCANNERS.length} scanners`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: no `master` branch refuses by name, runner never spawned', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'lib/widget.js', 'module.exports = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const r = run(root, '{"scope":"own"}');
    assert.strictEqual(r.code, 1, 'nothing was measured, so this is not a green');
    assert.strictEqual(
      r.digest,
      `[${path.basename(root)}] own: nothing measured — \`master\` does not resolve in ${root}`,
    );
    assert.strictEqual(stubRecord(root), null,
      'with no base to diff against, a run would select the scanner floor and report a green');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: a branch sharing no history with master refuses, runner never spawned', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    git(root, 'init', '-q', '-b', 'master');
    put(root, 'lib/widget.js', 'module.exports = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-q', '--orphan', 'feature');
    put(root, 'lib/widget.js', 'module.exports = 2;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'unrelated root');
    const shared = (() => {
      try {
        return execFileSync('git', ['-C', root, 'merge-base', 'master', 'HEAD'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { return ''; }
    })();
    assert.strictEqual(shared, '',
      'ENTER: the two histories DO share a commit, so this fixture is not the no-merge-base case');
    const r = run(root, '{"scope":"own"}');
    assert.strictEqual(r.code, 1, 'nothing was measured, so this is not a green');
    assert.strictEqual(
      r.digest,
      `[${path.basename(root)}] own: nothing measured — no merge base between \`master\` and HEAD`,
    );
    assert.strictEqual(stubRecord(root), null,
      'without a merge base the branch diff is the whole history, which is not this branch\'s work');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: a branch equal to master with a clean tree refuses, runner never spawned', () => {
  const root = mkRoot();
  try {
    mkBranchRepo(root);
    const r = run(root, '{"scope":"own"}');
    assert.strictEqual(r.code, 1, 'nothing was measured, so this is not a green');
    assert.strictEqual(
      r.digest,
      `[${path.basename(root)}] own: nothing to compare — branch equals master and the tree is clean`,
    );
    assert.strictEqual(stubRecord(root), null,
      'the runner must not run at all: a scoped run over an empty set would report a green');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scope own: CLODEX_TEST_LOCK is set only when the set reaches a port-binding file', () => {
  const portBound = LOCK_BOUND[0];
  const clean = mkRoot();
  try {
    mkBranchRepo(clean, {
      extraOnMaster: { 'test/alpha.test.js': EMPTY_TEST },
      onBranch: ({ put: p, git: g }) => {
        p('test/alpha.test.js', `${EMPTY_TEST}// edited\n`);
        g('commit', '-aqm', 'branch work');
      },
    });
    run(clean, '{"scope":"own"}');
    const rec = stubRecord(clean);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.strictEqual(rec.lock, null,
      'a set that binds no real port must skip the box-wide mutex — that is the whole point of own');
  } finally { fs.rmSync(clean, { recursive: true, force: true }); }

  const bound = mkRoot();
  try {
    mkBranchRepo(bound, {
      extraOnMaster: { [portBound]: EMPTY_TEST },
      onBranch: ({ put: p, git: g }) => {
        p(portBound, `${EMPTY_TEST}// edited\n`);
        g('commit', '-aqm', 'branch work');
      },
    });
    run(bound, '{"scope":"own"}');
    const rec = stubRecord(bound);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.ok(rec.argv.includes(portBound), `ENTER: ${portBound} was not selected at all`);
    assert.strictEqual(rec.lock, '1',
      `${portBound} binds a real port, so this run must serialize like a full one or both deadlock`);
  } finally { fs.rmSync(bound, { recursive: true, force: true }); }
});

test('scope own: the slow gate is advisory only for an own run that took no lock', () => {
  const unlocked = mkRoot();
  try {
    mkBranchRepo(unlocked, {
      extraOnMaster: { 'test/alpha.test.js': EMPTY_TEST },
      onBranch: ({ put: p, git: g }) => {
        p('test/alpha.test.js', `${EMPTY_TEST}// edited\n`);
        g('commit', '-aqm', 'branch work');
      },
    });
    run(unlocked, '{"scope":"own"}');
    const rec = stubRecord(unlocked);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.strictEqual(rec.advisory, '1',
      'an own run takes no suite lock, so it overlaps the merge gate and an in-memory test can '
      + 'balloon past six seconds on load — failing the hand over a green suite');
  } finally { fs.rmSync(unlocked, { recursive: true, force: true }); }

  const locked = mkRoot();
  try {
    const portBound = LOCK_BOUND[0];
    mkBranchRepo(locked, {
      extraOnMaster: { [portBound]: EMPTY_TEST },
      onBranch: ({ put: p, git: g }) => {
        p(portBound, `${EMPTY_TEST}// edited\n`);
        g('commit', '-aqm', 'branch work');
      },
    });
    run(locked, '{"scope":"own"}', { env: { CLODEX_TEST_SLOW_ADVISORY: '1' } });
    const rec = stubRecord(locked);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.strictEqual(rec.lock, '1', 'ENTER: this set must have taken the lock');
    assert.strictEqual(rec.advisory, null,
      'a locked own run has the box to itself, so its timings are real and an inherited value must '
      + 'not soften the bar');
  } finally { fs.rmSync(locked, { recursive: true, force: true }); }

  const full = mkRoot();
  try {
    writeStub(full, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    run(full, '{}', { env: { CLODEX_TEST_SLOW_ADVISORY: '1' } });
    const rec = stubRecord(full);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.strictEqual(rec.advisory, null,
      'the full run IS the merge gate; an inherited value reaching it disarms the six-second bar '
      + 'for the only run that enforces it');
  } finally { fs.rmSync(full, { recursive: true, force: true }); }
});

const MARKER = 'MEASURED-COPY-RAN';

function writeMeasuredWrapper(root, bytes) {
  const dir = path.join(root, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'clodex-run-tests.js'), bytes);
}

const DIFFERING_WRAPPER = [
  "'use strict';",
  "const fs = require('fs');",
  "let raw = '';",
  'try { raw = fs.readFileSync(0, \'utf8\'); } catch {}',
  "let scope = '(none)';",
  'try { scope = JSON.parse(raw).scope; } catch {}',
  `process.stderr.write('${MARKER} scope=' + scope + '\\n');`,
  'process.exit(3);',
  '',
].join('\n');

test('re-exec: a measured tree whose wrapper differs produces the digest itself', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    writeMeasuredWrapper(root, DIFFERING_WRAPPER);
    const r = run(root, '{}');
    assert.ok(r.stderr.includes(MARKER),
      'the measured tree\'s own wrapper must be the one that emits the digest, or a branch that '
      + 'changes the wrapper is measured by the copy it replaced');
    assert.strictEqual(r.code, 3, 'the child\'s exit status is the run\'s status');
    assert.strictEqual(stubRecord(root), null,
      'the outer wrapper must hand the run over, not spawn the runner itself as well');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('re-exec: a byte-identical measured wrapper costs no extra process', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    writeMeasuredWrapper(root, fs.readFileSync(SCRIPT));
    const r = run(root, '{}');
    assertDigest(r.digest, `[${path.basename(root)}] 1/1 green (${WALL})`);
    assert.strictEqual(r.code, 0);
    const rec = stubRecord(root);
    assert.ok(rec, 'ENTER: the runner never ran');
    assert.strictEqual(rec.reexec, null,
      'every ticket that does not touch the wrapper hits this path — spawning a second node here '
      + 'would tax every scoped run for nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('re-exec: CLODEX_RUN_TESTS_REEXEC=1 stops the handover, so a child never recurses', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    writeMeasuredWrapper(root, DIFFERING_WRAPPER);
    const r = run(root, '{}', { env: { CLODEX_RUN_TESTS_REEXEC: '1' } });
    assert.ok(!r.stderr.includes(MARKER),
      'a child that re-execs again is an unbounded chain of node processes');
    assertDigest(r.digest, `[${path.basename(root)}] 1/1 green (${WALL})`);
    assert.strictEqual(r.code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('re-exec: a SIGNAL-KILLED measured wrapper still produces a digest line', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    writeMeasuredWrapper(root, "'use strict';\nprocess.kill(process.pid, 'SIGKILL');\n");
    const r = run(root, '{}');
    assert.strictEqual(r.code, 1, 'a handover that died is a failed run, not a green one');
    assert.strictEqual(r.digest,
      `[${path.basename(root)}] own: re-exec of ${path.join(root, 'scripts', 'clodex-run-tests.js')}`
      + ' failed: killed by SIGKILL',
      'the seat reads the LAST stderr line as its whole result, and a killed child wrote none of '
      + 'its own — exiting on a null status without a line leaves the run reporting nothing at all');
    assert.strictEqual(stubRecord(root), null, 'and the outer wrapper did not run the runner either');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('re-exec: the stdin payload reaches the measured wrapper intact', () => {
  const root = mkRoot();
  try {
    writeStub(root, { body: "console.log('TOTALS: 1 pass, 0 fail, 1 tests');", exit: 0 });
    writeMeasuredWrapper(root, DIFFERING_WRAPPER);
    const r = run(root, '{"scope":"own"}');
    assert.ok(r.stderr.includes(`${MARKER} scope=own`),
      'stdin is read once and consumed — the child gets no payload at all unless the bytes already '
      + `read are handed to it, got: ${r.stderr.trim()}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('OWN_SCANNERS and LOCK_BOUND name files that exist in THIS repo', () => {
  const repo = path.join(__dirname, '..');
  assert.ok(OWN_SCANNERS.length >= 12, `the scanner list collapsed to ${OWN_SCANNERS.length}`);
  assert.ok(LOCK_BOUND.length >= 1, 'the port-binding list is empty, so no scoped run ever locks');
  for (const rel of [...OWN_SCANNERS, ...LOCK_BOUND]) {
    assert.ok(fs.existsSync(path.join(repo, rel)),
      `${rel} is listed in the shipped bin but no longer exists — every own run would refuse`);
  }
});
