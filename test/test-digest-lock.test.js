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
const { execFileSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'test-digest.sh');

// The lock block, lifted out of the script and pointed at a stub `node`, so the
// protocol under test is the SHIPPED text rather than a paraphrase of it. If the
// script's lock changes shape, this extraction fails loudly instead of silently
// testing nothing.
function lockHarness(dir, sleepSeconds) {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const start = src.indexOf('LOCK=".test-digest.lock"');
  const end = src.indexOf('out=$(node --test');
  assert.ok(start > 0 && end > start,
    'the lock block was not found in test-digest.sh — this test is extracting it by anchor and '
    + 'those anchors have moved');
  const block = src.slice(start, end);
  return `#!/bin/sh\ncd "${dir}" || exit 1\n${block}\nsleep ${sleepSeconds}\necho held >&2\nexit 0\n`;
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

test('lock: the shipped script still declares the timeout the exec entry must respect', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // The wait cap and the exec's timeoutMs are two numbers that must stay
  // related: if the script can wait longer than the exec allows, the exec dies
  // first and reports a timeout for what is actually a queued run.
  assert.match(src, /waited" -ge 120/,
    'the script caps its wait at 120s; the clodex-run-tests exec entry allows 120000ms');
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
    const res = require('node:child_process').spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js'), stub],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    );
    check(`${res.stdout || ''}${res.stderr || ''}`, lockDir);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('lock: npm test and the digest share ONE lock dir, or the mutex is not a mutex', () => {
  const shell = fs.readFileSync(SCRIPT, 'utf-8');
  const js = fs.readFileSync(RUNNER, 'utf-8');
  assert.match(shell, /LOCK="\.test-digest\.lock"/, 'the shell path names the lock dir');
  assert.match(js, /'\.test-digest\.lock'/,
    'run-tests.js must use the SAME dir — a second lock name excludes nothing');
  assert.match(js, /process\.kill\(holder, 0\)/,
    'and the same staleness rule, or a crashed run wedges the other entry point forever');
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

test('lock: npm test reclaims a lock whose holder is dead, and releases on exit', () => {
  // A pid that cannot exist: a killed runner never cleans up, and without
  // reclamation the first crash wedges every later run forever.
  withFakeLock('999999', (out, lockDir) => {
    assert.match(out, /TOTALS:/, 'a stale lock must be reclaimed, not treated as a live holder');
    assert.ok(!fs.existsSync(lockDir), 'and the lock is released when the run finishes');
  });
});
