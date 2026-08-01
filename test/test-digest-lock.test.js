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
