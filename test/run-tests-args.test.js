// The suite runner's argument check: a named test path that does not exist must
// not produce a run at all.
//
// WHY THIS EXISTS. While debugging the v5.5.0 regression an agent ran the suite
// against two filenames that DO NOT EXIST. The run reported "7 pass, 0 fail" and
// exited zero, and that green was trusted at the moment trusting it mattered. It
// is the failure shape CLAUDE.md's Tests section names: a run that never reached
// the state it claims, reporting success.
//
// Node splits on the SHAPE of the bad argument, which is why the literal-path
// case alone is not enough to test. Measured on node 25:
//   - a literal missing path -> "Could not find 'x'", no tap written, exit 1
//   - a glob matching NOTHING -> zero tests, a valid tap summary, EXIT 0
// The second is the live false green: the wrapper prints "0 pass, 0 fail" and
// returns success. Unexpanded globs do reach the runner because sh without
// nullglob passes a pattern that matched nothing through literally.
//
// FALSIFICATION (against the runner with the guard block deleted): the two
// refusal tests below fail — the glob case exits 0 with TOTALS, the literal case
// exits 1 for the wrong reason ("the tap stream is missing"), which the
// assertion on the message catches. The three acceptance tests (real file, flag,
// directory) PASS against the unguarded runner by construction: they assert the
// ABSENCE of a refusal only the new code can emit. They are regression guards on
// the flag/path rule, not evidence of the bug.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STUB = "require('node:test').test('stub', () => {});\n";

// A throwaway root, as in test-digest-lock.test.js: the runner locates its lock
// and resolves relative arguments against ITS OWN root, and this file usually
// runs inside a sweep that already holds the real lock.
function runRunner(argsFor, extraFiles = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t279-')));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.writeFileSync(path.join(root, 'stub.test.js'), STUB);
  for (const [rel, body] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  // NODE_TEST_CONTEXT must not reach the child: node --test sees it, decides it
  // is already inside a test run and skips every file, so the run produces no
  // tap and reads as a refusal that never happened.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const res = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'run-tests.js'), ...argsFor(root)],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    return { out: `${res.stdout || ''}${res.stderr || ''}`, code: res.status, root };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('args: a missing file is refused by name, and nothing is run', () => {
  const r = runRunner(() => ['test/files-popover.test.js', 'test/report-panel.test.js']);
  assert.notStrictEqual(r.code, 0, 'a run over files that do not exist must not exit zero');
  assert.match(r.out, /does not exist/,
    'the refusal must say what is wrong; blaming the tap stream sends the reader to the wrapper '
    + 'instead of to their own argument');
  // EVERY missing path, not just the first: fixing one and re-running to
  // discover the next is how a typo'd list gets half-corrected and re-trusted.
  assert.match(r.out, /test\/files-popover\.test\.js/, 'the first missing path is named');
  assert.match(r.out, /test\/report-panel\.test\.js/, 'the second missing path is named too');
  assert.ok(!/TOTALS:/.test(r.out), 'and the suite must not have run at all');
});

test('args: a glob matching nothing is refused — the case that exited ZERO', () => {
  // The only shape here that node itself reports as success. Without the guard
  // this run prints "TOTALS: 0 pass, 0 fail, 0 tests" and exits 0.
  const r = runRunner(() => ['nope-*.test.js']);
  assert.notStrictEqual(r.code, 0,
    'an unmatched glob ran zero tests; reporting that as success is the false green this guards');
  assert.match(r.out, /nope-\*\.test\.js/, 'and the pattern that matched nothing is named');
  assert.ok(!/TOTALS:/.test(r.out), 'a refused run reports no totals');
});

test('args: a real file still runs', () => {
  const r = runRunner((root) => [path.join(root, 'stub.test.js')]);
  assert.match(r.out, /TOTALS:/,
    'ENTER: the runner produced no totals, so every assertion below is about a run that '
    + 'never happened');
  assert.strictEqual(r.code, 0, 'a passing named file exits zero');
  assert.ok(!/does not exist/.test(r.out), 'and is not mistaken for a missing path');
});

test('args: a glob that matches is accepted and runs the files it matched', () => {
  const r = runRunner(() => ['stub*.test.js']);
  assert.match(r.out, /TOTALS:/, 'ENTER: the runner produced no totals');
  assert.match(r.out, /TOTALS: 1 pass/,
    'the matched file actually ran — a guard that resolved the glob to nothing here would refuse '
    + 'valid usage, and one that ran nothing would be the bug wearing a green hat');
  assert.strictEqual(r.code, 0);
});

test('args: a flag is not mistaken for a path', () => {
  // Passthrough legitimately carries node --test flags. A naive existsSync over
  // every argument rejects all of them.
  const r = runRunner((root) => ['--test-concurrency=1', path.join(root, 'stub.test.js')]);
  assert.match(r.out, /TOTALS:/, 'ENTER: the runner produced no totals');
  assert.ok(!/does not exist/.test(r.out),
    '--test-concurrency=1 is a flag, not a path — refusing it would make the guard unusable');
  assert.strictEqual(r.code, 0);
});

test('args: a directory is passed through, never refused as missing', () => {
  // The guard decides EXISTS, not what node does with it. Measured on node 25: a
  // bare directory is loaded as a module and fails, with or without a trailing
  // slash; only a glob beneath it sweeps. That is node's contract and it has
  // moved before, so the assertion here is that the argument reaches node —
  // an is-a-file check would refuse directories outright and could not be
  // undone by a node version that sweeps them again.
  const r = runRunner((root) => [path.join(root, 'sub')], { 'sub/inner.test.js': STUB });
  assert.match(r.out, /TOTALS:/,
    'ENTER: the runner produced no totals, so it never reached node and this proves nothing');
  assert.ok(!/does not exist/.test(r.out),
    'a directory exists; refusing it would make the guard stricter than node');
});
