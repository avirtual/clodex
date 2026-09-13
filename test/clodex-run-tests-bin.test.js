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
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-run-tests.js');

// realpath because macOS /tmp is a symlink to /private/tmp: the script reads
// process.cwd(), which is already resolved, so an unresolved fixture path would
// mismatch both the leaf name and the lock dir it asserts.
function mkRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crt-')));
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
    '  cwd: process.cwd(),',
    '}));',
    body,
    `process.exit(${exit});`,
  ].join('\n'));
}

function run(root, payload) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    input: payload,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = String(res.stderr || '').split('\n').filter((l) => l.trim());
  return { code: res.status, digest: lines.length ? lines[lines.length - 1] : '', stdout: res.stdout };
}

function stubRecord(root) {
  const p = path.join(root, ARGV_FILE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
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
    assertDigest(r.digest, `[${path.basename(root)}] 2/3 green, 1 failing (${WALL}): alpha`);
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
    assert.strictEqual(r.digest, `[${path.basename(root)}] runner executed ZERO tests (exit 0)`);
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
    assert.ok(new RegExp(`^\\[${path.basename(root)}\\] 0/40 green, 40 failing \\(${WALL_RE}\\): failing-test-name-0`).test(r.digest),
      'the counts and the first names survive the cut — they are the head of the line');
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
