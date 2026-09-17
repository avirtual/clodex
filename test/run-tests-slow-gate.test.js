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

function runRunner({
  files = {}, allow = null, allowRaw = null, args = [], slowMs = null, extraEnv = null,
} = {}) {
  const root = fs.realpathSync(mkTmpRoot('clx-t955-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  if (allowRaw !== null) fs.writeFileSync(path.join(root, 'test', 'slow-tests.json'), allowRaw);
  else if (allow) fs.writeFileSync(path.join(root, 'test', 'slow-tests.json'), JSON.stringify(allow, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.CLODEX_TEST_SLOW_ADVISORY;
  if (slowMs !== null) env.CLODEX_TEST_SLOW_MS = String(slowMs);
  if (extraEnv) Object.assign(env, extraEnv);
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

test('slow gate: a test named after an Object.prototype key is not silently exempt', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('toString', 400) },
    allow: { 'something else entirely': 'unrelated' },
    args: ['test/slow.test.js'],
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 1 pass, 0 fail/, 'ENTER: the run produced no totals');
  assert.notStrictEqual(r.code, 0,
    'a membership test that walks the prototype chain exempts toString, constructor, valueOf and '
    + 'hasOwnProperty forever, through a file that never mentions them — and with no entry to go '
    + 'stale, nothing would ever report it');
  assert.match(r.out, /^SLOW: \d+ms toString$/m, 'and the offender is named like any other');
});

const STALE_FILES = { 'test/fast.test.js': FAST };
const STALE_ALLOW = { 'a test that no longer exists': 'it was deleted and nobody pruned this file' };

test('slow gate: a stale allowlist entry fails a SWEEPING run', () => {
  const sweep = runRunner({ files: STALE_FILES, allow: STALE_ALLOW, slowMs: 150 });
  assert.match(sweep.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the sweeping run produced no totals');
  assert.notStrictEqual(sweep.code, 0, 'a stale entry fails the sweep');
  assert.match(sweep.out, /^SLOW: stale allowlist entry a test that no longer exists$/m);
  assert.match(sweep.stderr, / ✖ stale allowlist entry a test that no longer exists/,
    'the stale entry rides the digest too');
});

test('slow gate: a stale allowlist entry is skipped on a NAMED-FILE run', () => {
  const named = runRunner({
    files: STALE_FILES, allow: STALE_ALLOW, args: ['test/fast.test.js'], slowMs: 150,
  });
  assert.match(named.out, /TOTALS: 1 pass, 0 fail/, 'ENTER: the named run produced no totals');
  assert.strictEqual(named.code, 0,
    'a named-file run cannot see every test, so every unlisted entry would look stale — the check '
    + 'must not apply there');
  assert.ok(!/stale allowlist entry/.test(named.out), 'and says nothing about it');
});

test('slow gate: a stale allowlist entry is skipped on a name-FILTERED run', () => {
  const filtered = runRunner({
    files: STALE_FILES, allow: STALE_ALLOW, args: ['--test-name-pattern=fast'], slowMs: 150,
  });
  assert.match(filtered.out, /TOTALS: \d+ pass, 0 fail/, 'ENTER: the filtered run produced no totals');
  assert.strictEqual(filtered.code, 0,
    'a FILTERED run names no file, so `sweeping` is true, yet it sees only the tests the pattern '
    + 'matched — without this leg every deliberately narrowed run goes red with one bogus line per '
    + 'allowlist entry, on a run where nothing failed');
  assert.ok(!/stale allowlist entry/.test(filtered.out),
    'a filter cannot see every test either, so the stale check must not apply to it');
});

test('slow gate: a MALFORMED allowlist names itself instead of surfacing as bogus offenders', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    allowRaw: '{ "unclosed": "quote }\n',
    slowMs: 150,
  });
  assert.notStrictEqual(r.code, 0, 'a malformed allowlist must not yield a green run');
  assert.match(r.out, /test\/slow-tests\.json is not valid JSON/,
    'the refusal names the file that is broken');
  assert.ok(!/SLOW:/.test(r.out),
    'a swallowed parse error leaves the allowlist empty and every real entry comes back as an '
    + 'unrelated SLOW: offender — sending the reader to the tests instead of to the file they broke');
});

function assertNonObjectAllowlist(raw, got) {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    allowRaw: `${raw}\n`,
    slowMs: 150,
  });
  assert.notStrictEqual(r.code, 0, `a ${got} allowlist must not yield a green run`);
  assert.match(r.out, new RegExp(`test/slow-tests\\.json is not a JSON object: got ${got}`),
    'a non-object parses fine, so the malformed-JSON catch never fires — without its own refusal '
    + 'the exemption set is silently empty and every real entry comes back as a bogus SLOW: offender');
}

test('slow gate: an ARRAY allowlist names itself instead of parsing to an empty exemption set', () => {
  assertNonObjectAllowlist('[]', 'an array');
});

test('slow gate: a STRING allowlist names itself instead of parsing to an empty exemption set', () => {
  assertNonObjectAllowlist('"x"', 'a string');
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

const ADVISORY = { CLODEX_TEST_SLOW_ADVISORY: '1' };

test('slow gate: advisory + an UNLOCKED named-file run reports the timing and exits 0', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    args: ['test/slow.test.js'],
    slowMs: 150,
    extraEnv: ADVISORY,
  });
  assert.match(r.out, /TOTALS: 1 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.strictEqual(r.code, 0,
    'a run that took no suite lock cannot tell a slow test from a starved box, so the timing is '
    + 'reported and the exit stays the suite\'s own');
  assert.match(r.out, /^SLOW \(advisory, unlocked run\): \d+ms the slow subject$/m,
    'the offender is still named with its duration, under the advisory prefix');
  assert.match(r.out, /the locked full run still enforces the six-second bar/m,
    'and the reader is told where the bar is still enforced');
  assert.ok(!/^SLOW: /m.test(r.out),
    'the enforcing spelling must not appear: it is what a reader greps for a real refusal');
  assert.ok(!/✖ the slow subject/.test(r.stderr),
    'the ✖ spelling is what scripts/clodex-run-tests.js parses into a FAILING digest — an advisory '
    + 'timing printed there reads as a red run that named a test nothing failed on');
});

test('slow gate: advisory + a LOCKED (sweeping) run still fails on the slow test', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    slowMs: 150,
    extraEnv: ADVISORY,
  });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.notStrictEqual(r.code, 0,
    'a sweeping run holds the suite lock, so nothing else was competing for the box and the timing '
    + 'is the test\'s own — the advisory env must not disarm the gate there');
  assert.match(r.out, /^SLOW: \d+ms the slow subject$/m, 'the offender is named for enforcement');
  assert.ok(!/advisory/.test(r.out), 'and nothing is softened');
  assert.match(r.stderr, / ✖ the slow subject \(\d+ms\)/, 'the ✖ spelling rides the digest');
});

test('slow gate: the advisory branch is conditioned on the lock, not on the env alone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8');
  assert.match(src, /CLODEX_TEST_SLOW_ADVISORY === '1' && !lockHeld/,
    'the env alone would disarm the six-second bar for the merge gate too, whose sweeping run sets '
    + 'no such variable today but inherits whatever the caller exported');
});

test('slow gate: advisory does NOT excuse a stale allowlist entry on a sweeping run', () => {
  const r = runRunner({ files: STALE_FILES, allow: STALE_ALLOW, slowMs: 150, extraEnv: ADVISORY });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the sweeping run produced no totals');
  assert.notStrictEqual(r.code, 0,
    'a stale entry is a config error, not a timing: no amount of machine load can produce one, so '
    + 'the advisory path must never reach it');
  assert.match(r.out, /^SLOW: stale allowlist entry a test that no longer exists$/m);
});

test('slow gate: test/slow-tests.json carries the instance-label engine entry verbatim', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'slow-tests.json'), 'utf8'));
  const key = 'the engine const reads the env: CLODEX_LABEL reaches the wire as hostLabel';
  assert.ok(Object.hasOwn(raw, key),
    'walking the table cannot catch a row that is missing or misspelled — a wrong key reads as a '
    + 'stale entry on a sweeping run and the test it was meant to exempt still fails the gate');
  assert.match(String(raw[key]), /createEngine/,
    'the value is the mechanism the test genuinely waits on, which is what the next reader judges');
});
