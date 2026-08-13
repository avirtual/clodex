// The suite runner's mutual exclusion.
//
// WHY THIS EXISTS. Parts of this suite bind real ports and spawn real children
// (cli/test/attach.test.js). Two concurrent `node --test` runs deadlock: both
// processes sit at 0% CPU and neither ever finishes. That was observed for real
// on 2026-08-01, and the damage was not the lost run — it was the diagnosis. A
// wedge is indistinguishable from a slow suite, so it was read as "the suite
// outgrew its timeout" and the exec timeout was raised 60s -> 300s. The suite
// actually runs in ~24s. Raising the cap made the next collision LONGER instead
// of impossible.
//
// These tests run the lock protocol against a stub command rather than the real
// suite: a test that shells out to the whole suite would be the slowest thing in
// the suite, and would recurse.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'test-digest.sh');

// The lock block, lifted out of the script and pointed at a stub `node`, so the
// protocol under test is the SHIPPED text rather than a paraphrase of it. If the
// script's lock changes shape, this extraction fails loudly instead of silently
// testing nothing.
function lockHarness(dir, sleepSeconds) {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const start = src.indexOf('LOCK="$root/.test-digest.lock"');
  const end = src.indexOf('out=$(node --test');
  assert.ok(start > 0 && end > start,
    'the lock block was not found in test-digest.sh — this test is extracting it by anchor and '
    + 'those anchors have moved');
  const block = src.slice(start, end);
  // `root` and `measure` are set by the script ABOVE this block and the block
  // reads both (the lock is rooted, the measurement cd's). Supplying them here
  // is what keeps the extraction faithful to the SHIPPED text: without them the
  // lock would resolve to `/.test-digest.lock` and the cd would fail, so the
  // harness would exercise nothing. Both point at the fixture dir, i.e. the
  // default no-parameter case.
  return `#!/bin/sh\ncd "${dir}" || exit 1\nroot="${dir}"\nmeasure="${dir}"\n${block}\n`
    + `sleep ${sleepSeconds}\necho held >&2\nexit 0\n`;
}

function mkHarness(sleepSeconds = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-lock-'));
  const sh = path.join(dir, 'run.sh');
  fs.writeFileSync(sh, lockHarness(dir, sleepSeconds), { mode: 0o755 });
  return { dir, sh, lock: path.join(dir, '.test-digest.lock') };
}

test('lock: a second run does not start while the first holds the lock', async () => {
  const { dir, sh, lock } = mkHarness(2);
  const first = spawn('/bin/sh', [sh], { stdio: 'ignore' });
  // Let the first acquire.
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(lock), 'precondition: the first run holds the lock');
  const holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf-8').trim());
  assert.ok(holder > 0, 'the lock records its holder pid, which is what makes staleness detectable');

  // The second must WAIT, not run concurrently and not fail instantly.
  const t0 = Date.now();
  const second = spawn('/bin/sh', [sh], { stdio: 'ignore' });
  const code = await new Promise((r) => second.on('exit', r));
  const waited = Date.now() - t0;
  assert.strictEqual(code, 0, 'the second run eventually succeeds');
  assert.ok(waited > 1000,
    `the second run returned after ${waited}ms — it must have WAITED for the first, and anything `
    + 'this fast means both suites ran at once, which is the deadlock this prevents');
  first.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: a lock left by a dead process is reclaimed, not waited on', () => {
  const { dir, sh, lock } = mkHarness(0);
  // Exactly what a SIGKILLed runner leaves behind: the directory with a pid that
  // no longer exists. Without staleness detection this wedges every future run
  // forever — strictly worse than the problem the lock solves.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999');

  const t0 = Date.now();
  execFileSync('/bin/sh', [sh], { stdio: 'ignore' });
  const waited = Date.now() - t0;
  assert.ok(waited < 2000,
    `waited ${waited}ms on a lock held by a dead pid — a crashed run must not poison the next one`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: the lock is released when the run finishes', () => {
  const { dir, sh, lock } = mkHarness(0);
  execFileSync('/bin/sh', [sh], { stdio: 'ignore' });
  assert.ok(!fs.existsSync(lock), 'a completed run leaves no lock behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lock: an interrupted run releases the lock via its trap', async () => {
  // Short sleep on purpose: sh does not run a trap until its foreground child
  // returns, so this test costs the full sleep no matter when the signal lands.
  const { dir, sh, lock } = mkHarness(2);
  const child = spawn('/bin/sh', [sh], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(lock), 'precondition: the lock is held');
  // SIGTERM, i.e. Ctrl-C or a timeout killing the runner. The trap covers this;
  // SIGKILL cannot be trapped and is what the staleness check above is for.
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(lock),
    'the EXIT/INT/TERM trap must clean up, or a Ctrl-C leaves a lock whose pid is briefly alive');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The wait cap and the exec's timeoutMs are two numbers that must stay related,
// and STRICTLY so. They shipped EQUAL (120s vs 120000ms), which is the one
// relationship that guarantees the message never arrives: the exec's timer
// SIGKILLs the child at the instant the script would print "another suite run is
// already going", so the caller sees "timed out after 120000ms" and never learns
// a second run was the cause. Three timeouts were misdiagnosed that way.
const EXEC_TIMEOUT_MS = 120000;

test('lock: the script gives up waiting STRICTLY before the exec entry kills it', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = /waited" -ge (\d+)/.exec(src);
  // ENTER: a renamed variable or reshaped condition must fail loudly here rather
  // than skip the comparison below and leave this test asserting nothing.
  assert.ok(m, 'the script still caps its wait with a `waited" -ge <n>` guard');
  const capMs = Number(m[1]) * 1000;
  assert.ok(capMs < EXEC_TIMEOUT_MS,
    `the script waits up to ${capMs}ms but the exec entry kills it at ${EXEC_TIMEOUT_MS}ms — `
    + 'equal or greater means the caller gets an uninformative timeout instead of the lock message');
});

test('lock: the refusal names the holder and how long it has been running', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // "already running" is only actionable if it says WHICH run and SINCE WHEN —
  // otherwise the caller cannot tell a healthy in-flight suite from a wedge, and
  // the lesson taken is "raise the timeout", which makes the next one longer.
  assert.match(src, /another suite run is already going \(pid %s, running %s\)/,
    'the refusal reports the holder pid and its elapsed run time');
  assert.match(src, /ps -o etime= -p/,
    'elapsed time comes from the process table: the holder may be an `npm test` this script never launched');
});

// ── the OTHER entry point ───────────────────────────────────────────────────
// The lock is only a mutex if every path to the suite takes it. `npm test` ->
// scripts/run-tests.js did NOT, so the most obvious command in the repo walked
// straight past the guard the digest path respects. Measured 2026-08-03: four
// concurrent runs, two permanently wedged on cli/test/attach.test.js, the older
// for 13h47m — and the digest that WAS holding the lock then died at its exec
// cap while queued behind the wreckage, reporting a timeout for a suite that
// runs in ~23s.
const RUNNER = path.join(__dirname, '..', 'scripts', 'run-tests.js');
const ROOT = path.join(__dirname, '..');
// The runner's lock lives at ITS ROOT, and this test file usually runs INSIDE a
// suite run that already holds the real one. So the child gets a throwaway root
// (a copy of the runner + its one require) and the assertions never touch the
// lock of the run they are part of.
function withFakeLock(holderPid, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  const lockDir = path.join(root, '.test-digest.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), holderPid);
  const stub = path.join(root, 'stub.test.js');
  fs.writeFileSync(stub, "require('node:test').test('stub', () => {});\n");
  try {
    // NODE_TEST_CONTEXT must not reach the child: node --test sees it, decides it
    // is already inside a test run, and skips every file — the run then produces
    // no tap and reads as a lock failure that never happened.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // NO file argument: the lock guards a SWEEP (the only mode that reaches the
    // port-binding tests), so a named-file run deliberately does not take it.
    // The sweep finds stub.test.js in this throwaway root.
    const res = require('node:child_process').spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js')],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    check(`${res.stdout || ''}${res.stderr || ''}`, lockDir);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('lock: npm test and the digest share ONE lock dir, or the mutex is not a mutex', () => {
  const shell = fs.readFileSync(SCRIPT, 'utf-8');
  const js = fs.readFileSync(RUNNER, 'utf-8');
  // `$root` is the script's OWN checkout, i.e. the team root, and the lock is
  // pinned there absolutely even when a `tree` payload sends the measurement to
  // a worktree. A lock relative to the measured tree would be a per-worktree
  // mutex, which excludes nothing.
  assert.match(shell, /LOCK="\$root\/\.test-digest\.lock"/,
    'the shell path names the lock dir, rooted at its own checkout');
  assert.match(js, /'\.test-digest\.lock'/,
    'run-tests.js must use the SAME dir — a second lock name excludes nothing');
  assert.match(js, /process\.kill\(holder, 0\)/,
    'and the same staleness rule, or a crashed run wedges the other entry point forever');
  // The lock guards a SWEEP only. The suite spawns this runner against explicit
  // files (test-escapes.test.js proves the escape detector; these tests drive a
  // stub), and those children run INSIDE a run that already holds the lock — so
  // taking it for a named-file run deadlocks the suite against itself.
  assert.match(js, /const sweeping = !passthrough\.some/,
    'a named-file run must not take the lock, or the suite blocks on its own children');
});

test('lock: npm test REFUSES while another run holds it, and says how to clear it', () => {
  withFakeLock(String(process.pid), (out) => {   // alive by construction
    assert.match(out, /another suite run is already going/,
      'a second run must be refused, not started — two runs deadlock on the port-binding tests');
    assert.match(out, new RegExp(`kill ${process.pid}`),
      'and the message must name the holder and how to clear it, or the next reflex is to raise a timeout');
    assert.ok(!/TOTALS:/.test(out), 'the refused run must not have executed the suite');
  });
});

// The regression this file could NOT catch until now: these tests and
// test-escapes.test.js spawn the runner, and both pass in ISOLATION. Locking a
// named-file run only fails inside a full sweep, where the parent already holds
// the lock — exactly how it shipped and how the suite went red at 6 failures.
// Reproduced here by holding the lock and running a NAMED FILE, which must still
// run.
test('lock: a named-file run ignores a held lock — the suite spawns this runner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  const lockDir = path.join(root, '.test-digest.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));  // alive: a sweep in flight
  const stub = path.join(root, 'stub.test.js');
  fs.writeFileSync(stub, "require('node:test').test('stub', () => {});\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const res = require('node:child_process').spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js'), stub],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    assert.match(out, /TOTALS:/,
      'a named-file run must proceed while a sweep holds the lock, or the suite blocks on its own children');
    assert.ok(!/another suite run is already going/.test(out), 'and must not be refused');
    assert.ok(fs.existsSync(lockDir), "and must not steal or release the sweep's lock");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── the override must not be inherited ─────────────────────────────────────
// CLODEX_TEST_LOCK_DIR / CLODEX_TEST_LOCK_WAIT_MS are a decision about THIS
// process's lock. Every nested runner is by contract a DIFFERENT run, and this
// file and run-tests-args.test.js both spawn sweeping runners against throwaway
// roots — which take the lock. Inheriting the override points them at the outer
// run's lock, held by a live pid, where they block for the whole inherited wait
// instead of exercising their own fixture. Measured against the unfixed runner:
// 6 tests red and ~12 minutes of spawnSync timeouts, i.e. the ticket loop
// rejecting every ticket for a defect in its own harness.
test('lock: the lock override does NOT leak into the test children', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  // The probe is a TEST FILE: it runs as a grandchild (runner -> node --test ->
  // this file), which is exactly the hop the leak travelled.
  const probe = path.join(root, 'probe.json');
  const stub = path.join(root, 'stub.test.js');
  fs.writeFileSync(stub,
    'require("node:fs").writeFileSync(' + JSON.stringify(probe) + ', JSON.stringify({\n'
    + '  dir: process.env.CLODEX_TEST_LOCK_DIR || null,\n'
    + '  wait: process.env.CLODEX_TEST_LOCK_WAIT_MS || null,\n'
    + '}));\n'
    + "require('node:test').test('stub', () => {});\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A directory that does not exist and a wait long enough to hang the run for
  // minutes if either one reached a child that took a lock.
  env.CLODEX_TEST_LOCK_DIR = path.join(root, 'elsewhere', '.test-digest.lock');
  env.CLODEX_TEST_LOCK_WAIT_MS = '1200000';
  try {
    // A NAMED FILE, so the outer runner does not take a lock either: the claim
    // under test is about env propagation, and a lock wait would only add
    // minutes of noise to it.
    const res = spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js'), stub],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    assert.match(out, /TOTALS:/,
      'ENTER: the runner produced no totals, so the probe below describes a run that never happened');
    assert.ok(fs.existsSync(probe), 'ENTER: the probe test file executed and recorded its environment');
    const got = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.deepStrictEqual(got, { dir: null, wait: null },
      'a nested runner must see the DEFAULT lock: inheriting the override makes it block on a lock '
      + 'the outer run holds, and a sweeping child then wedges until its own spawn timeout kills it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The override can name a directory that cannot be created, and on the ticket
// loop's escalate arm this line IS the whole report — a lead sees it and nothing
// else. Without the named-parent die the same case surfaces one step later as
// `could not take the suite lock: <errno message>`, which blames the acquire
// rather than the configured path; measured, that fallback still embeds a path
// only because node's own ENOTDIR text does, and it points at the lock dir, not
// at the parent that could not be made. Triggered portably with a FILE as a path
// component — ENOTDIR comes from any non-directory parent, so this needs no
// root-owned or /dev path.
test('lock: a lock dir that cannot be created is refused BY NAME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['run-tests.js', 'test-escapes.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  }
  const stub = path.join(root, 'stub.test.js');
  fs.writeFileSync(stub, "require('node:test').test('stub', () => {});\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // stub.test.js is a FILE, so creating anything under it is ENOTDIR.
  const bad = path.join(stub, 'x', '.test-digest.lock');
  env.CLODEX_TEST_LOCK_DIR = bad;
  try {
    // NO file argument: only a SWEEP takes the lock, so only a sweep reaches
    // the failure this pins.
    const res = spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js')],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    assert.ok(!/TOTALS:/.test(out),
      'ENTER: the run must have died on the lock, not gone on to execute the suite');
    assert.match(out, new RegExp(`could not create the lock directory ${path.dirname(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'the refusal must name the directory it could not create, or the loop escalates with a message '
      + 'that points at the lock code instead of at the misconfigured path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lock: npm test reclaims a lock whose holder is dead, and releases on exit', () => {
  // A pid that cannot exist: a killed runner never cleans up, and without
  // reclamation the first crash wedges every later run forever.
  withFakeLock('999999', (out, lockDir) => {
    assert.match(out, /TOTALS:/, 'a stale lock must be reclaimed, not treated as a live holder');
    assert.ok(!fs.existsSync(lockDir), 'and the lock is released when the run finishes');
  });
});

// ── the tree the digest measured ────────────────────────────────────────────
// A wrong-tree run does not look like an error, it looks like a PASS: the
// script cds to its own checkout, so a caller in another worktree gets a real,
// current, green number for code that was never run. A branch that merely
// modifies files leaves no tell at all.
//
// So the fixture has to BE a second tree: the SHIPPED script is copied into a
// scratch checkout whose basename cannot occur anywhere else, with a stub
// `node` on PATH standing in for the suite. Asserting the digest line WHOLE is
// what separates "the script emitted the marker" from "the path happens to
// contain that string" — a spawn error naming the fixture path satisfies any
// substring grep, and does it in the case where the script emitted nothing.
function runDigest({ tap, exit, cwd }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t88-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'node'),
    `#!/bin/sh\ncat <<'CLX_TAP'\n${tap}\nCLX_TAP\nexit ${exit}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  try {
    const res = spawnSync('/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: cwd || root, timeout: 60000, env });
    const lines = (res.stderr || '').split('\n').filter((l) => l.trim() !== '');
    return { tree: path.basename(root), lines, digest: lines[lines.length - 1], code: res.status };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const PASS_CASE = {
  what: 'pass',
  tap: ['TAP version 13', 'ok 1 - a case', '1..1', '# tests 3', '# pass 3', '# fail 0'].join('\n'),
  exit: 0,
  code: 0,
  digest: (t) => `[${t}] 3/3 green`,
};

const DIGEST_CASES = [
  PASS_CASE,
  {
    what: 'fail',
    tap: ['TAP version 13', 'not ok 1 - a failing case', '1..3',
      '# tests 3', '# pass 2', '# fail 1'].join('\n'),
    exit: 1,
    code: 1,
    digest: (t) => `[${t}] 2/3 green, 1 failing: a failing case`,
  },
  {
    // No summary at all — the runner died before producing one. The path that
    // carries the LEAST information is the one most likely to be read as noise
    // from the wrong place, so it names its tree too.
    what: 'suite did not run',
    tap: ['node: bad option: --test-reporter=tap'].join('\n'),
    exit: 9,
    code: 9,
    digest: (t) => `[${t}] suite did not run: node: bad option: --test-reporter=tap`,
  },
];

test('digest: every line the digest can emit names the tree it measured', () => {
  for (const c of DIGEST_CASES) {
    const r = runDigest(c);
    // The digest is the LAST stderr line by contract (the exec dispatcher
    // returns only that one). Reducing to it can yield undefined from a script
    // that never ran, which every assertion below would then be about nothing.
    assert.ok(r.lines.length > 0,
      `ENTER: ${c.what}: the script wrote nothing to stderr, so there is no digest to check`);
    assert.strictEqual(r.digest, c.digest(r.tree),
      `${c.what}: the whole digest line, tree marker included — a number with no statement of `
      + 'what it measured is the false-green this marker exists to prevent');
    assert.strictEqual(r.code, c.code,
      `${c.what}: the script still exits with node's code; the marker must not change the verdict`);
  }
});

test("digest: the tree named is the script's own checkout, not the caller's cwd", () => {
  // The exact shape of the observed bug: caller in one tree, run in another.
  // The marker is only worth anything if it tracks the tree that RAN.
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t88-CALLER-'));
  try {
    const r = runDigest({ ...PASS_CASE, cwd: caller });
    assert.ok(r.lines.length > 0, 'ENTER: the script wrote nothing to stderr');
    assert.strictEqual(r.digest, `[${r.tree}] 3/3 green`);
    assert.ok(!r.digest.includes(path.basename(caller)),
      'the digest must name the tree that ran, never the one that asked — the caller reading its '
      + 'own basename back would confirm exactly the run it cannot distinguish');
  } finally { fs.rmSync(caller, { recursive: true, force: true }); }
});

test('digest: a digest path cannot be added without the tree marker', () => {
  // The three cases above pin today's three lines. This pins the PROPERTY, so a
  // fourth digest path added later cannot ship unmarked with the suite green.
  // Scoped to below the runner invocation on purpose: the two printfs above it
  // (the lock refusal, the not-a-worktree refusal) both report that NOTHING was
  // measured, so a tree marker on them would name a tree no suite ran in.
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const from = src.indexOf('out=$(node --test');
  assert.ok(from > 0,
    'the digest section is extracted by anchor and that anchor has moved');
  const emits = src.slice(from).split('\n').filter((l) => /printf/.test(l) && /1>&2/.test(l));
  assert.ok(emits.length >= 3,
    `ENTER: found ${emits.length} digest emit lines, expected at least the pass, fail and `
    + 'did-not-run paths — the filter is no longer matching what it names');
  for (const line of emits) {
    assert.ok(/\[\$tree\]|\[%s\]/.test(line),
      `a digest line that does not name its tree: ${line.trim()}`);
  }
});

// ── the tree the digest was ASKED to measure ────────────────────────────────
// The tree became a parameter because the `cd` above made it unaskable: every
// seat's exec resolves ${TEAM_ROOT} to the shared checkout, so a worktree hand
// self-verifying its branch measured master and got a real, current, green
// number for code that was never run.
//
// The fixture has to be a REAL git repo with a REAL worktree, because the
// authorization is `git worktree list` — a fake directory tree would let a test
// pass against an allowlist that never ran.
function mkRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t358-')));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'x');
  const wt = path.join(base, 'wt-branch');
  git('worktree', 'add', '-q', '-b', 'feature', wt);
  return { base, root, wt };
}

// A stub `node` standing in for the suite, as above. `holdSeconds` makes the
// measurement itself take time, which is what the serialization test needs.
function stubNode(dir, { tap, exit, holdSeconds = 0 }) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'node'),
    `#!/bin/sh\nsleep ${holdSeconds}\ncat <<'CLX_TAP'\n${tap}\nCLX_TAP\nexit ${exit}\n`,
    { mode: 0o755 });
  return { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` };
}

const GREEN_TAP = ['TAP version 13', 'ok 1 - a case', '1..1',
  '# tests 3', '# pass 3', '# fail 0'].join('\n');

function runWithPayload(root, payload, env, opts = {}) {
  const res = spawnSync('/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')], {
    encoding: 'utf-8', cwd: opts.cwd || root, timeout: 60000, env, input: payload,
  });
  const lines = (res.stderr || '').split('\n').filter((l) => l.trim() !== '');
  return { lines, digest: lines[lines.length - 1], code: res.status };
}

test('tree: a `tree` payload measures THAT worktree, and the digest names it', () => {
  const { base, root, wt } = mkRepo();
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: wt }), env);
    assert.ok(r.lines.length > 0,
      'ENTER: the script wrote nothing to stderr, so there is no digest to check');
    // The WHOLE line: a substring check for the worktree basename would also
    // match a spawn error naming the fixture path, i.e. pass in the case where
    // nothing was measured at all.
    assert.strictEqual(r.digest, `[${path.basename(wt)}] 3/3 green`,
      'the digest must name the requested worktree — naming the root here is the original bug, '
      + 'and it is indistinguishable from a real pass');
    assert.strictEqual(r.code, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tree: no `tree` field still measures the team root, unchanged', () => {
  // The lead's usage. A parameter that silently changed the default would break
  // every existing caller while looking like it worked.
  const { base, root } = mkRepo();
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, '{}', env);
    assert.ok(r.lines.length > 0, 'ENTER: the script wrote nothing to stderr');
    assert.strictEqual(r.digest, `[${path.basename(root)}] 3/3 green`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tree: a path that is not a worktree of this repo is REFUSED, never fallen back', () => {
  // The whole point of the allowlist. A silent fallback to the root rebuilds
  // this ticket's bug exactly: the caller asked about its branch and would read
  // master's green as its own. So the refusal must be loud AND must not measure.
  const { base, root } = mkRepo();
  const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t358-OUTSIDER-'));
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: outsider }), env);
    assert.ok(r.lines.length > 0, 'ENTER: the script wrote nothing to stderr');
    assert.notStrictEqual(r.code, 0, 'a refused tree must fail, not return a green');
    assert.match(r.digest, /refused, nothing measured: not a worktree of this repo/);
    assert.ok(!/green/.test(r.digest),
      'the refusal must not carry a suite result: a number here would be about the root, which is '
      + 'the silent fallback this exists to prevent');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outsider, { recursive: true, force: true });
  }
});

test('tree: a nonexistent path is refused the same way, not resolved to the root', () => {
  const { base, root } = mkRepo();
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: '/no/such/tree/anywhere' }), env);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.digest, /refused, nothing measured/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// THE INVARIANT THE PARAMETER MUST NOT BREAK. The measured tree moved; the lock
// must not have followed it. If it did, each worktree gets its own mutex, which
// excludes nothing — two suites reach the port-binding tests together and
// deadlock at 0% CPU, indistinguishable from a slow suite.
test('tree: two runs naming DIFFERENT trees still serialize on the root lock', async () => {
  const { base, root, wt } = mkRepo();
  // The first run holds for 3s inside the suite, i.e. while holding the lock.
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0, holdSeconds: 3 });
  const lock = path.join(root, '.test-digest.lock');
  try {
    const first = spawn('/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'] });
    first.stdin.end(JSON.stringify({ tree: wt }));   // measures the WORKTREE
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(fs.existsSync(lock),
      'ENTER: the worktree run must hold the ROOT checkout\'s lock — if this dir does not exist the '
      + 'lock followed the measured tree, which is the failure under test');

    const t0 = Date.now();
    // The second measures the ROOT: a different tree, and it must still wait.
    const second = runWithPayload(root, '{}', env);
    const waited = Date.now() - t0;
    assert.strictEqual(second.code, 0, 'the second run eventually succeeds');
    assert.ok(waited > 1500,
      `the second run returned after ${waited}ms — naming a different tree must NOT buy it a `
      + 'separate mutex, or both suites reach the port-binding tests together and deadlock');
    first.kill('SIGKILL');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tree: the lock is the ROOT\'s even when a worktree is measured', () => {
  // Stated as a property of the shipped text as well as the behaviour above: the
  // lock path must be anchored to $root, and absolutely — a relative path would
  // resolve against the measured tree once the script cds, so the EXIT trap
  // would delete nothing and leave the real lock held forever.
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.match(src, /LOCK="\$root\/\.test-digest\.lock"/,
    'the lock is pinned to the script\'s own checkout, not to the measured tree');
  const lockAt = src.indexOf('LOCK="$root/.test-digest.lock"');
  const cdAt = src.indexOf('cd "$measure"');
  assert.ok(lockAt > 0 && cdAt > 0,
    'ENTER: both the lock assignment and the measurement cd must be present, or the ordering '
    + 'assertion below is comparing against something that is not there');
  assert.ok(lockAt < cdAt,
    'the lock must be ACQUIRED before the cd to the measured tree: acquiring afterwards would '
    + 'resolve a relative reclaim against the worktree');
});

// ── the def that carries the parameter ──────────────────────────────────────
// The SHIPPED def, not a copy (same discipline as clodex-monitor.test.js): a
// copy is correct the day it is made and stale after, while the artifact that
// actually gates live payloads drifts away.
const EXEC_DEF_PATH = path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-run-tests.json');

test('def: these tests read the SHIPPED run-tests def, not a copy of it', () => {
  const rel = path.relative(path.join(__dirname, '..'), EXEC_DEF_PATH);
  assert.strictEqual(rel, path.join('resources', 'library', 'exec', 'clodex-run-tests.json'),
    'the def under test IS the seeded artifact — no copy, under any name, can satisfy this');
  // Path identity alone is satisfied by a path that does not exist, which is
  // how this def lived for its whole life: live-only in the operator's library,
  // with nothing in the repo to review or seed from. Existence is the half that
  // catches that.
  assert.ok(fs.existsSync(EXEC_DEF_PATH),
    'the def must EXIST in the repo: a live-only def is unreviewable and unseedable, and a fresh '
    + 'install would grant a command with no definition behind it');
});

test('def: the schema admits `tree` and still admits the empty payload', () => {
  const { parseAndValidate, validateExecDef } = require('../exec-schema');
  const def = JSON.parse(fs.readFileSync(EXEC_DEF_PATH, 'utf-8'));
  assert.deepStrictEqual(validateExecDef(def, 'clodex-run-tests'), { ok: true },
    'ENTER: a def the dispatcher would refuse makes every payload assertion below meaningless');
  assert.strictEqual(parseAndValidate(def, '{}').ok, true,
    'the lead calls this with {} and that must keep working');
  assert.strictEqual(parseAndValidate(def, JSON.stringify({ tree: '/some/worktree' })).ok, true);
  // additionalProperties:false is what turns a typo into a loud bounce instead
  // of a silent measurement of the wrong tree — the bug this ticket is about.
  assert.strictEqual(parseAndValidate(def, JSON.stringify({ treee: '/some/worktree' })).ok, false,
    'a misspelled field must be REFUSED, not ignored into a root measurement');
  assert.strictEqual(parseAndValidate(def, JSON.stringify({ tree: 7 })).ok, false);
});

test('def: the description states which tree the grant measures', () => {
  // A hand reads this line in its prompt before deciding whether to trust the
  // number. A grant that does not say what it measured is how a green about
  // master got read as a green about a branch.
  const def = JSON.parse(fs.readFileSync(EXEC_DEF_PATH, 'utf-8'));
  assert.strictEqual(typeof def.description, 'string');
  assert.match(def.description, /TEAM ROOT/,
    'the default must be stated: with no `tree` this measures the root, not the caller\'s worktree');
  assert.match(def.description, /tree/,
    'and the parameter must be named, or the reader cannot act on the warning');
});

// PRESENCE vs VALUE. `{"tree":""}` is the shape a caller produces by templating
// an unset variable (`{"tree":"$WT"}`), and it is the ticket's own bug wearing
// the fix: the extraction regex matches an empty value, so keying the branch off
// a non-empty VALUE falls through to the root and hands a caller who explicitly
// asked about a worktree a green number about master.
test('tree: an EMPTY `tree` is refused, not silently measured as the root', () => {
  const { base, root } = mkRepo();
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: '' }), env);
    assert.ok(r.lines.length > 0, 'ENTER: the script wrote nothing to stderr');
    assert.notStrictEqual(r.code, 0,
      'an empty tree must fail: exit 0 here is the silent fallback this ticket exists to kill');
    assert.match(r.digest, /refused, nothing measured/,
      'asking for a tree and getting a root measurement back is indistinguishable from a real pass');
    assert.ok(!/green/.test(r.digest),
      'and it must carry no suite number at all — a number here would be about the root');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tree: a whitespace-only `tree` is refused too', () => {
  // Same class, and the one a shell templating `"$WT "` produces. cd " " fails,
  // so it cannot reach the allowlist — but it must refuse, not fall back.
  const { base, root } = mkRepo();
  const env = stubNode(base, { tap: GREEN_TAP, exit: 0 });
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: '   ' }), env);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.digest, /refused, nothing measured/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('def: the schema refuses an empty `tree` before the script ever runs', () => {
  // Belt to the script's braces: the dispatcher bounces this loudly so the
  // script is never spawned. It cannot be the ONLY guard, because until the app
  // restarts the live def is the old one and only the script is in play.
  const def = JSON.parse(fs.readFileSync(EXEC_DEF_PATH, 'utf-8'));
  const { parseAndValidate } = require('../exec-schema');
  const r = parseAndValidate(def, JSON.stringify({ tree: '' }));
  assert.strictEqual(r.ok, false, 'an empty tree must not validate');
  assert.match(r.error, /minLength/,
    'and the bounce must name the reason, or the caller retries the same empty value');
});
