'use strict';
// test-escapes.test.js — the guard on our own verification path (t29).
//
// An error thrown on an async continuation that outlives its test is counted
// PASS by `node --test`. Node names it in a diagnostic that every reporter
// carries EXCEPT `dot` — which is the one our digest pipeline ran, so the suite
// could go green while broken. scripts/test-escapes.js parses that diagnostic
// back out and scripts/run-tests.js refuses to report green when it finds one.
//
// Two halves:
//   1. parser — fixture reporter text in, structured escapes out. The fixtures
//      are REAL runner output (captured from node 25), not hand-written, so a
//      wording change in Node fails these rather than silently returning [].
//   2. wrapper — spawn it against a scratch test file that really escapes, and
//      assert on what it prints and what it exits with. This is the half that
//      would actually have caught t25.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseEscapes, formatEscapes, MARK } = require('../scripts/test-escapes.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.js');

// Captured verbatim from `node --test --test-reporter=tap` on node 25.8.1.
const TAP_ATTRIBUTED =
  '# Error: Test "clicking an item toggles through host.setEnabled and persists" at test/app-menus-plugins.test.js:245:1 generated asynchronous activity after the test ended. This activity created the error "TypeError: app.setAboutPanelOptions is not a function" and would have caused the test to fail, but instead triggered an uncaughtException event.';
// The ownerless shape: fires after every test in the file has finished.
const TAP_OWNERLESS =
  '# Error: A resource generated asynchronous activity after the test ended. This activity created the error "Error: BOOM ownerless" which triggered an uncaughtException event, caught by the test runner.';
const SPEC_ATTRIBUTED =
  'ℹ Error: Test "I2 escaping async" at i.test.js:4:1 generated asynchronous activity after the test ended. This activity created the error "Error: BOOM invisible" and would have caused the test to fail, but instead triggered an unhandledRejection event.';

// ── Parser ──────────────────────────────────────────────────────────────────

test('an attributed escape yields the test, file and line — the payload is WHO', () => {
  // A report that says "1 escape" and makes the reader go hunting has recreated
  // the problem it was built to solve.
  const [e] = parseEscapes(TAP_ATTRIBUTED);
  assert.strictEqual(e.test, 'clicking an item toggles through host.setEnabled and persists');
  assert.strictEqual(e.file, 'test/app-menus-plugins.test.js');
  assert.strictEqual(e.line, 245);
  assert.strictEqual(e.error, 'TypeError: app.setAboutPanelOptions is not a function');
  assert.strictEqual(e.event, 'uncaughtException');
});

test('the ownerless shape parses with NULL attribution, not an invented owner', () => {
  // "A resource generated…" has no test to blame, and its message ends with
  // `which triggered` rather than `and would have caused`. Both differences
  // have to be handled or this line returns garbage instead of an escape.
  const [e] = parseEscapes(TAP_OWNERLESS);
  assert.strictEqual(e.test, null);
  assert.strictEqual(e.file, null);
  assert.strictEqual(e.line, null);
  assert.strictEqual(e.error, 'Error: BOOM ownerless');
  assert.strictEqual(e.event, 'uncaughtException');
});

test('the spec reporter renders the same diagnostic and parses identically', () => {
  // The wrapper reads tap, but the marker has to survive whichever stream a
  // future caller points at it — the reporters differ only in decoration.
  const [e] = parseEscapes(SPEC_ATTRIBUTED);
  assert.strictEqual(e.test, 'I2 escaping async');
  assert.strictEqual(e.file, 'i.test.js');
  assert.strictEqual(e.event, 'unhandledRejection');
});

test('ordinary reporter output yields NO escapes', () => {
  // The other direction: a parser that fires on healthy output would make every
  // green run red, and would be turned off within a week.
  const clean = [
    'TAP version 13',
    'ok 1 - a passing test',
    'not ok 2 - a REAL failure',
    '  ---',
    '  error: \'this test failed normally\'',
    '  ...',
    '# tests 2', '# pass 1', '# fail 1',
  ].join('\n');
  assert.deepStrictEqual(parseEscapes(clean), []);
});

test('several escapes in one run are all reported, not just the first', () => {
  // The runner collapses them: N escapes in a file produce at most ONE
  // file-level entry. Reporting one of four would repeat t25's arithmetic.
  const text = [TAP_ATTRIBUTED, 'ok 1 - unrelated', TAP_OWNERLESS, SPEC_ATTRIBUTED].join('\n');
  assert.strictEqual(parseEscapes(text).length, 3);
});

test('parseEscapes THROWS on a non-string rather than returning []', () => {
  // Returning [] on bad input is the failure mode that matters here: it reads
  // as "nothing escaped" and the wrapper would report green off a missing file.
  assert.throws(() => parseEscapes(undefined), /needs the reporter text as a string/);
  assert.throws(() => parseEscapes(Buffer.from(TAP_ATTRIBUTED)), /got object/);
});

test('formatEscapes prints the test name, location and error for each escape', () => {
  const out = formatEscapes(parseEscapes(TAP_ATTRIBUTED));
  assert.match(out, /ESCAPES: 1/);
  assert.match(out, /clicking an item toggles through host\.setEnabled and persists/);
  assert.match(out, /test\/app-menus-plugins\.test\.js:245/);
  assert.match(out, /app\.setAboutPanelOptions is not a function/);
});

test('formatEscapes says ESCAPES: 0 on a clean run', () => {
  assert.strictEqual(formatEscapes([]), 'ESCAPES: 0');
});

test('MARK is the substring Node actually emits, in every reporter', () => {
  // The whole mechanism hangs off this string. Pin it against real output so a
  // Node wording change fails HERE rather than by silently finding nothing.
  for (const line of [TAP_ATTRIBUTED, TAP_OWNERLESS, SPEC_ATTRIBUTED]) {
    assert.ok(line.includes(MARK), `marker missing from: ${line.slice(0, 60)}…`);
  }
});

// ── Wrapper ─────────────────────────────────────────────────────────────────

function scratch(body) {
  const dir = mkTmpRoot('clodex-escape-');
  const file = path.join(dir, 'scratch.test.js');
  fs.writeFileSync(file, body);
  return { dir, file, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// NODE_TEST_CONTEXT must be stripped: node:test sets it in every test process,
// and a `node --test` that sees it inherited refuses to run files ("run() is
// being called recursively within a test file"). We are spawning an
// INDEPENDENT runner, not nesting one, so the child gets a clean env.
function runWrapperWithEnv(extraEnv, ...args) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, '--reporter=dot', ...args], { encoding: 'utf8', env });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
}

function runWrapper(...args) {
  return runWrapperWithEnv({}, ...args);
}

test('THE t25 CASE: an escape alongside a real failure in the same file is named', () => {
  // This is the reconstruction of what actually happened. Node emits the
  // file-level ✖ only when the file has no other failure to report — so with a
  // real failure beside it the escape produces NO counter entry at all. Two
  // tests failed by name; two more were equally broken; the totals said two.
  const s = scratch(`
    const test = require('node:test');
    const assert = require('node:assert');
    test('a REAL failure, the one we saw', () => { assert.strictEqual(1, 2, 'seen'); });
    test('an ESCAPE, the one we did not', () => {
      (async () => { throw new Error('unseen breakage'); })();
      assert.ok(true);
    });
  `);
  try {
    const { out, code } = runWrapper(s.file);
    assert.match(out, /ESCAPES: 1/, `escape not reported:\n${out}`);
    assert.match(out, /an ESCAPE, the one we did not/, 'the escaping test is not named');
    assert.match(out, /unseen breakage/, 'the error message is missing');
    assert.notStrictEqual(code, 0, 'a run with an escape must not exit 0');
  } finally { s.clean(); }
});

test('an escape ALONE (no other failure) is reported and red', () => {
  const s = scratch(`
    const test = require('node:test');
    const assert = require('node:assert');
    test('passes honestly', () => { assert.ok(true); });
    test('escapes', () => { (async () => { throw new Error('lone escape'); })(); assert.ok(true); });
  `);
  try {
    const { out, code } = runWrapper(s.file);
    assert.match(out, /ESCAPES: 1/);
    assert.match(out, /lone escape/);
    assert.notStrictEqual(code, 0);
  } finally { s.clean(); }
});

test('a clean run reports ESCAPES: 0 and exits 0', () => {
  // The wrapper must not turn healthy runs red — the property that keeps it in
  // the pipeline at all.
  const s = scratch(`
    const test = require('node:test');
    const assert = require('node:assert');
    test('honest pass', () => { assert.ok(true); });
  `);
  try {
    const { out, code } = runWrapper(s.file);
    assert.match(out, /ESCAPES: 0/);
    assert.strictEqual(code, 0, `a clean run must exit 0:\n${out}`);
  } finally { s.clean(); }
});

test('a plain failing test still exits non-zero and reports no escape', () => {
  const s = scratch(`
    const test = require('node:test');
    const assert = require('node:assert');
    test('ordinary failure', () => { assert.strictEqual(1, 2); });
  `);
  try {
    const { out, code } = runWrapper(s.file);
    assert.match(out, /ESCAPES: 0/, 'an ordinary failure is not an escape');
    assert.notStrictEqual(code, 0);
  } finally { s.clean(); }
});

test('a run that produced no tap stream says so LOUDLY and claims NO verdict', () => {
  // The swallowing failure mode ruled out explicitly: when the wrapper cannot
  // read the stream it analyses, it must not conclude "nothing escaped".
  //
  // Asserted on the MESSAGE, not the exit code, deliberately: `node --test`
  // exits non-zero on this by itself, so an exit-code assertion here would pass
  // with the guard deleted and prove nothing. The absence of `ESCAPES:` is the
  // part only this wrapper can get wrong.
  //
  // Reached via a bad node flag, not a nonexistent path: the argument check
  // refuses a missing path BEFORE the spawn, so the old route no longer gets
  // here and this test would have been asserting the wrong refusal. A real
  // scratch file rides along so the run is not classified as a sweep — a
  // flag-only passthrough takes the suite lock and would block on the parent.
  const s = scratch("require('node:test').test('never runs', () => {});");
  try {
    const { out, code } = runWrapper('--bogus-node-flag', s.file);
    assert.match(out, /run-tests: the tap stream is missing/);
    assert.doesNotMatch(out, /ESCAPES:/, 'a run it could not read must not be given an escape verdict');
    assert.notStrictEqual(code, 0);
  } finally { s.clean(); }
});

test('a refusing run removes its own tmp dir — the silent leak (t500)', () => {
  // The runner mints a `clodex-test-*` dir for the tap file before it can know
  // whether the run will refuse, and every refusal between that mint and the
  // analysis leaves through die() -> process.exit. Before t500 those paths
  // leaked it, and nothing anywhere said so: no error, no failed test, no
  // symptom — the pool was found by noticing directories on the box. The
  // subject above DRIVES that exact path once per suite run, so the defect
  // scaled with the number of runs while staying invisible. A regression would
  // be equally silent, which is why the property is pinned rather than trusted.
  //
  // Measured in both directions against the tap-missing refusal: the fixed
  // runner leaves the private TMPDIR empty, the runner with t500's
  // `process.on('exit')` handler deleted leaves exactly one dir.
  //
  // The temp root is PRIVATE to this child, and that is the whole measurement
  // method: os.tmpdir() honours it, so the child's dir lands somewhere only
  // this subject can have written. Set all three vars — os.tmpdir() reads
  // TMPDIR on POSIX but TEMP/TMP on Windows, and dropping either Windows name
  // aims the measurement at the SHARED temp while the assertion reads an
  // empty private dir. The ENTER assertion does not catch that: the run still
  // refuses correctly, only the count is pointed elsewhere.
  // A before/after count of the shared temp dir would
  // be a delta against a directory other agents on this box are also filling,
  // and has already produced one false regression here. Emptiness of a
  // directory we own is attributable by construction.
  const privateTmp = mkTmpRoot('clodex-leakpin-');
  // Same driving trick as the subject above, and for the same reason: a bad
  // node flag to force the refusal, plus a real scratch file so the run is not
  // classified as a sweep and does not block on the parent run's suite lock.
  const s = scratch("require('node:test').test('never runs', () => {});");
  try {
    const { out } = runWrapperWithEnv({ TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp }, '--bogus-node-flag', s.file);
    // ENTER: the leaking path was actually reached. A run that REPORTS cleans
    // its dir up on the ordinary path too, so without this the assertion below
    // would still pass if `--bogus-node-flag` ever stopped being refused — a
    // green over a case nothing exercised.
    assert.match(out, /run-tests: the tap stream is missing/, 'did not reach the refusal being pinned');
    const left = fs.readdirSync(privateTmp).filter((n) => n.startsWith('clodex-test-'));
    assert.deepStrictEqual(left, [], 'a refusing run left its tmp dir behind');
  } finally { s.clean(); }
});

test('a file that explodes at load is passed through as a failure, not as an escape', () => {
  // A load-time throw is an ordinary failure with a summary attached; the
  // wrapper must report on it normally rather than mistaking it for the
  // async-escape shape.
  const s = scratch("throw new Error('this file explodes at load');");
  try {
    const { out, code } = runWrapper(s.file);
    assert.match(out, /ESCAPES: 0/);
    assert.notStrictEqual(code, 0, `a broken run must not exit 0:\n${out}`);
  } finally { s.clean(); }
});

test('npm test routes through the wrapper, not bare node --test', () => {
  // The wrapper only protects runs that go through it. If package.json drifts
  // back to `node --test`, everything above still passes while the real
  // verification path goes blind again — which is the defect, not a detail.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /scripts\/run-tests\.js/);
});
