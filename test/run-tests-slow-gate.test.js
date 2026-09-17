'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');

const FAST = "require('node:test').test('fast one', () => {});\n";

const block = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`;

const sleeper = (name, ms) => `require('node:test').test(${JSON.stringify(name)}, () => {\n`
  + `  ${block(ms)}});\n`;

function runRunner({ files = {}, allow = null, args = [], slowMs = null } = {}) {
  const root = fs.realpathSync(mkTmpRoot('clx-t955-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  if (allow) fs.writeFileSync(path.join(root, 'test', 'slow-tests.json'), JSON.stringify(allow, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (slowMs !== null) env.CLODEX_TEST_SLOW_MS = String(slowMs);
  try {
    const res = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'run-tests.js'), '--reporter=dot', ...args],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    return {
      out: `${res.stdout || ''}${res.stderr || ''}`,
      stderr: res.stderr || '',
      code: res.status,
      root,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('slow gate: a test past the threshold fails an otherwise GREEN run, and is named', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/,
    'ENTER: the run itself must be green, or this measures a failure the gate did not cause');
  assert.notStrictEqual(r.code, 0, 'a green run holding a slow test must still exit non-zero');
  assert.match(r.out, /^SLOW: \d+ms the slow subject$/m, 'the offender is named with its duration');
  assert.match(r.out, /inject the clock or constant through a seam/,
    'and the refusal says what to do about it');
  assert.match(r.stderr, / ✖ the slow subject \(\d+ms\)/,
    'the ✖ spelling on stderr is what scripts/clodex-run-tests.js parses into its one-line digest; '
    + 'without it the digest reports a failing run that names nothing');
});

test('slow gate: the same test listed in test/slow-tests.json passes', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    allow: { 'the slow subject': 'busy-waits on a SharedArrayBuffer to be slow on purpose' },
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the run produced no totals');
  assert.strictEqual(r.code, 0, 'an allowlisted slow test does not fail the run');
  assert.ok(!/SLOW:/.test(r.out), 'and nothing is reported about it');
});

test('slow gate: a stale allowlist entry fails a SWEEPING run and is skipped on a named-file run', () => {
  const files = { 'test/fast.test.js': FAST };
  const allow = { 'a test that no longer exists': 'it was deleted and nobody pruned this file' };

  const sweep = runRunner({ files, allow, slowMs: 150 });
  assert.match(sweep.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the sweeping run produced no totals');
  assert.notStrictEqual(sweep.code, 0, 'a stale entry fails the sweep');
  assert.match(sweep.out, /^SLOW: stale allowlist entry a test that no longer exists$/m);
  assert.match(sweep.stderr, / ✖ stale allowlist entry a test that no longer exists/,
    'the stale entry rides the digest too');

  const named = runRunner({ files, allow, args: ['test/fast.test.js'], slowMs: 150 });
  assert.match(named.out, /TOTALS: 1 pass, 0 fail/, 'ENTER: the named run produced no totals');
  assert.strictEqual(named.code, 0,
    'a named-file run cannot see every test, so every unlisted entry would look stale — the check '
    + 'must not apply there');
  assert.ok(!/stale allowlist entry/.test(named.out), 'and says nothing about it');
});

test('slow gate: the FILE-level tap point is never reported as slow', () => {
  const r = runRunner({
    files: { 'test/idle-heavy.js': block(400), 'test/fast.test.js': FAST },
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 3 pass, 0 fail/,
    'ENTER: the container file must have been swept in and reported as a point of its own, or '
    + 'this run exercises no discount at all');
  assert.strictEqual(r.code, 0,
    'the file spent past the threshold while no test body did — a container is not a slow test');
  assert.ok(!/SLOW:/.test(r.out), 'and no offender is reported');
  assert.ok(!/idle-heavy/.test(r.stderr), 'the file path is never named as an offender');
});

test('slow gate: SLOW_MS is the literal 6000', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8');
  assert.match(src, /^const SLOW_MS = 6000;$/m,
    'the shipped threshold is six seconds; the env override exists only for the pins above, so '
    + 'every one of them stays green against a wrong-threshold ship — this assertion is the only '
    + 'thing that reads the value the suite will actually run under');
});
