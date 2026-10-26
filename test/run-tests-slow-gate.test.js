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
  delete env.CLODEX_TEST_SLOW_RETIME;
  delete env.CLODEX_TEST_RETIME_CAP;
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

const firstRunOnly = (name, ms, marker) => `require('node:test').test(${JSON.stringify(name)}, () => {\n`
  + `  const m = require('node:path').join(__dirname, ${JSON.stringify(marker)});\n`
  + '  if (require(\'node:fs\').existsSync(m)) return;\n'
  + '  require(\'node:fs\').writeFileSync(m, \'\');\n'
  + `  ${block(ms)}});\n`;

const stdoutOf = (r) => r.out.slice(0, r.out.length - r.stderr.length);

test('slow gate: a test slow only on its first run is re-timed alone and does not fail the run', () => {
  const r = runRunner({
    files: { 'test/once.test.js': firstRunOnly('the loaded subject', 400, '.once') },
    slowMs: 150,
  });
  const stdout = stdoutOf(r);
  assert.match(stdout, /TOTALS: 2 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.strictEqual(r.code, 0, 'a test that is fast on its own was slow because of the box');
  assert.match(stdout, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms the loaded subject$/m,
    'the re-timed test is named with both durations');
  assert.ok(!/^SLOW: /m.test(stdout), 'nothing is enforced');
  assert.ok(!/✖ the loaded subject/.test(r.stderr), 'and the digest sees no failing test');
  const lines = stdout.split('\n');
  const totals = lines.map((l, i) => (/^TOTALS: \d+ pass, \d+ fail, \d+ tests$/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  assert.strictEqual(lines[totals[totals.length - 1]], 'TOTALS: 2 pass, 0 fail, 2 tests',
    'the last TOTALS line is the main run\'s, which the merge gate reads');
  assert.ok(lines.findIndex((l) => l.startsWith('SLOW (load')) < totals[totals.length - 1],
    'the re-time output sits above the TOTALS line');
});

test('slow gate: a test slow on every run is still enforced after its re-time', () => {
  const r = runRunner({
    files: { 'test/slow.test.js': sleeper('the slow subject', 400) },
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.notStrictEqual(r.code, 0, 'a test slow on its own is a slow test');
  assert.match(r.out, /^SLOW: \d+ms the slow subject$/m, 'and is named on the enforcing line');
  assert.ok(!/re-timed alone/.test(r.out), 'it is not excused as load');
});

test('slow gate: CLODEX_TEST_SLOW_RETIME=0 enforces a first-run-only slow test', () => {
  const r = runRunner({
    files: { 'test/once.test.js': firstRunOnly('the loaded subject', 400, '.once') },
    slowMs: 150,
    extraEnv: { CLODEX_TEST_SLOW_RETIME: '0' },
  });
  assert.match(r.out, /TOTALS: 2 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.notStrictEqual(r.code, 0, 'with the re-time off the gate behaves as before it existed');
  assert.match(r.out, /^SLOW: \d+ms the loaded subject$/m);
  assert.ok(!/re-timed alone/.test(r.out));
});

test('slow gate: offenders in two files are each re-timed against their own file', () => {
  const r = runRunner({
    files: {
      'test/one.test.js': `${FAST}${firstRunOnly('subject in one', 400, '.one')}`,
      'test/two.test.js': firstRunOnly('subject in two', 400, '.two'),
    },
    slowMs: 150,
  });
  assert.match(r.out, /TOTALS: 4 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.strictEqual(r.code, 0, r.out.slice(-800));
  assert.match(r.out, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms subject in one$/m);
  assert.match(r.out, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms subject in two$/m);
});

const SMALL_CAP = { CLODEX_TEST_RETIME_CAP: '2' };

test('slow gate: the re-time cap defaults to twelve, and the knob never reaches a child', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8');
  const m = src.match(/^const RETIME_CAP = (.+);$/m);
  assert.ok(m, 'the over-cap pins run at a cap of 2, so only this pin holds the shipped default');
  const capFor = (v) => new Function('process', `return ${m[1]};`)({ env: v === undefined ? {} : { CLODEX_TEST_RETIME_CAP: v } });
  assert.deepStrictEqual(
    [capFor(undefined), capFor(''), capFor('-1'), capFor('1.5'), capFor('0'), capFor('abc'), capFor('2')],
    [12, 12, 12, 12, 12, 12, 2]);
  assert.match(src, /^delete childEnv\.CLODEX_TEST_RETIME_CAP;$/m,
    'a cap exported to the outer run would otherwise shrink the re-time sample of every nested runner');
});

test('slow gate: past the cap, the slowest clear alone and the run passes', () => {
  const rows = [['crowd a', 200], ['crowd b', 250], ['crowd m', 40]];
  const r = runRunner({
    files: { 'test/crowd.test.js': rows.map(([n, ms], i) => firstRunOnly(n, ms, `.crowd${i}`)).join('') },
    slowMs: 30,
    extraEnv: SMALL_CAP,
  });
  const stdout = stdoutOf(r);
  assert.match(stdout, /TOTALS: 4 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.strictEqual(r.code, 0, stdout.slice(-1200));
  assert.match(stdout, /^SLOW \(load, not re-timed\): \d+ms crowd m$/m,
    'the one offender outside the sample is named as not re-timed');
  assert.strictEqual((stdout.match(/^SLOW \(load, not re-timed\)/gm) || []).length, 1);
  assert.strictEqual((stdout.match(/^SLOW \(load, re-timed alone\)/gm) || []).length, 2);
  assert.match(stdout, /^SLOW \(load\): 3 offenders over the cap of 2; re-timed the 2 slowest alone and all 2 cleared/m);
  assert.ok(!/^SLOW: /m.test(stdout), 'nothing is enforced');
});

test('slow gate: past the cap, one sampled offender slow alone enforces the unsampled ones too', () => {
  const rows = [['crowd a', 200], ['crowd m', 40]];
  const r = runRunner({
    files: {
      'test/crowd.test.js': rows.map(([n, ms], i) => firstRunOnly(n, ms, `.crowd${i}`)).join('')
        + sleeper('crowd always slow', 250),
    },
    slowMs: 30,
    extraEnv: SMALL_CAP,
  });
  const stdout = stdoutOf(r);
  assert.match(stdout, /TOTALS: 4 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.notStrictEqual(r.code, 0, 'a sampled test slow on its own fails the run');
  assert.match(stdout, /^SLOW: \d+ms crowd always slow$/m);
  assert.match(stdout, /^SLOW: \d+ms crowd m$/m, 'the unsampled offender is enforced, not excused');
  assert.ok(!/not re-timed/.test(stdout), 'nothing is excused unsampled');
  assert.match(stdout, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms crowd a$/m,
    'ENTER: the sampled first-run-only offender still cleared');
});

test('slow gate: past the cap, the sample is the slowest offenders, not the first in file order', () => {
  const rows = [['crowd k', 200], ['crowd l', 250]];
  const r = runRunner({
    files: {
      'test/crowd.test.js': sleeper('crowd first and least slow', 40)
        + rows.map(([n, ms], i) => firstRunOnly(n, ms, `.crowd${i}`)).join(''),
    },
    slowMs: 30,
    extraEnv: SMALL_CAP,
  });
  const stdout = stdoutOf(r);
  assert.match(stdout, /TOTALS: 4 pass, 0 fail/, 'ENTER: the run itself must be green');
  assert.strictEqual(r.code, 0, stdout.slice(-1200));
  assert.match(stdout, /^SLOW \(load, not re-timed\): \d+ms crowd first and least slow$/m,
    'the first test in the file is the least slow, so it is the one left out of the sample');
  assert.match(stdout, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms crowd l$/m);
  assert.match(stdout, /^SLOW \(load, re-timed alone\): \d+ms → \d+ms crowd k$/m);
});

test('slow gate: a re-run that hangs is cut at the run deadline, prints TOTALS and stays enforced', () => {
  const body = 'require(\'node:test\').test(\'the hanging subject\', () => {\n'
    + '  const m = require(\'node:path\').join(__dirname, \'.hang\');\n'
    + '  const again = require(\'node:fs\').existsSync(m);\n'
    + '  require(\'node:fs\').writeFileSync(m, \'\');\n'
    + `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, again ? 40000 : 400);\n});\n`;
  const started = Date.now();
  const r = runRunner({
    files: { 'test/hang.test.js': body },
    slowMs: 150,
    extraEnv: { CLODEX_TEST_RUN_TIMEOUT_MS: '8000' },
  });
  assert.match(r.out, /^TOTALS: 2 pass, 0 fail, 2 tests$/m,
    'ENTER: the main run finished inside the deadline and its totals were printed');
  assert.ok(Date.now() - started < 25000, 'the re-run was cut at the run deadline, not its own long timeout');
  assert.notStrictEqual(r.code, 0, 'a re-run that never finished excuses nothing');
  assert.match(r.out, /^SLOW: \d+ms the hanging subject$/m);
  assert.ok(!/re-timed alone/.test(r.out));
});
