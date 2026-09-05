// The suite runner's mutual exclusion.
//
// WHY THIS EXISTS. Parts of this suite bind real ports and spawn real children
// (cli/test/attach.test.js). Two concurrent `node --test` runs deadlock: both
// processes sit at 0% CPU and neither ever finishes. That was observed for real
// on 2026-08-01, and the damage was not the lost run — it was the diagnosis. A
// wedge is indistinguishable from a slow suite, so it was read as "the suite
// outgrew its timeout" and the exec timeout was raised 60s -> 300s. The suite
// ran in ~24s at the time. Raising the cap made the next collision LONGER
// instead of impossible.
//
// THAT IS NOT AN ARGUMENT AGAINST EVERY RAISE, and this file now contains a
// subject REQUIRING a cap of at least 312000ms — read it (`the exec ceiling
// clears a WHOLE run plus a whole lock wait`) before concluding the two
// disagree. The 2026-08-01 raise was a cap covering for a MISSING mutex, so it
// bought longer deadlocks. The lock now makes concurrent runs impossible, so
// the cap no longer decides whether runs collide — only whether a run that
// legitimately took its turn lives long enough to REPORT. Against a suite
// measured at ~74s, the old 120s cap killed successful runs and threw their
// digest away.
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

// A spawn that never returned an ANSWER, told apart from one that answered
// wrongly — and the distinction is the whole point.
//
// `spawnSync` reports a child it killed at `timeout` as `error.code ===
// 'ETIMEDOUT'` with status null, signal SIGTERM and EMPTY stderr. A fixture
// that reads only stderr and status launders that into "the script wrote
// nothing", which is a statement about the code under test — so a starved
// harness accuses the script. That happened for real (t396, 2026-08-14): the
// gate went red at 5522/5523 on a run reported at 61690ms, the hand had to
// prove by hand that its diff could not reach the test, and a re-run was green
// with no code change. One rework round lost to a message pointing the wrong
// way.
//
// The script itself cannot produce this shape: its only wait arm ALWAYS prints
// "another suite run is already going" before exiting, so a silent death at the
// cap is the harness, never the protocol. The cap has ~100x headroom over the
// measured script budget and is NOT the mechanism (measured 2026-08-14 under
// load, numbers and method in tasks/digest-lock-fixture-starves/journal.md).
// That is why nothing here raises it: a bigger number would only make an
// unexplained failure rarer and harder to catch.
function spawnFailure(res) {
  if (res.error) return `${res.error.code || res.error.message}`;
  // Killed by a signal with no status: a cap or an external kill, not an exit.
  if (res.status === null && res.signal) return `killed by ${res.signal}`;
  return null;
}

// Runs `attempt` and returns its result, retrying ONCE if the spawn produced no
// answer at all.
//
// RETRIED ON `spawnFailure` ALONE, WHICH IS WHY THIS DOES NOT WEAKEN ANYTHING.
// The retry key is "the harness got nothing", never "the script said something
// wrong": a run that completes and emits a bad digest is returned on the first
// attempt and fails its assertions at full strength, exactly as before. The
// tests here exist because two concurrent suites deadlock at 0% CPU, and a
// genuine deadlock times out on BOTH attempts and still goes red — an
// inconclusive spawn is never converted into a pass or a skip, because a
// fixture made robust by dropping what it detects is worse than the flake.
//
// The retry is LOUD on purpose. A silent one hides the very thing that has now
// cost a rework round twice.
function withRetry(what, attempt) {
  const first = attempt();
  const failed = spawnFailure(first);
  if (!failed) return first;
  console.error(`# ${what}: the spawn returned no answer (${failed}) — retrying once`);
  const second = attempt();
  const failedAgain = spawnFailure(second);
  if (failedAgain) {
    // Both attempts died without an answer. NAMED as the harness's own failure,
    // because the alternative is the ENTER guard below reporting "the script
    // wrote nothing to stderr" — which blames the script for the harness not
    // getting a reply, and sends the reader to diff a file that is not at fault.
    assert.fail(
      `${what}: the fixture never got an answer from the script — ${failed}, then ${failedAgain}. `
      + 'This is the HARNESS failing, not the digest script: a real lock wait always prints its '
      + 'refusal before giving up, so a silent death at the cap is not the protocol under test. '
      + 'Do not raise the timeout on this evidence (measured budget is ~0.5s against a 60s cap); '
      + 'look for what blocked the spawn.',
    );
  }
  return second;
}

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
//
// READ FROM THE SHIPPED DEF, never restated here (t440). A copy of the ceiling
// is correct on the day it is written and silently wrong afterwards — and the
// direction that matters is the one that cannot be seen: a def RAISED past a
// stale copy leaves this test passing about a number nobody ships.
const execTimeoutMs = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-run-tests.json'), 'utf-8')).timeoutMs;

test('lock: the script gives up waiting STRICTLY before the exec entry kills it', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = /waited" -ge (\d+)/.exec(src);
  // ENTER: a renamed variable or reshaped condition must fail loudly here rather
  // than skip the comparison below and leave this test asserting nothing.
  assert.ok(m, 'the script still caps its wait with a `waited" -ge <n>` guard');
  const capMs = Number(m[1]) * 1000;
  const execMs = execTimeoutMs();
  assert.ok(typeof execMs === 'number' && execMs > 0,
    `ENTER: the def must carry a real timeoutMs, got ${JSON.stringify(execMs)} — otherwise the `
    + 'comparison below is against undefined and passes vacuously');
  assert.ok(capMs < execMs,
    `the script waits up to ${capMs}ms but the exec entry kills it at ${execMs}ms — `
    + 'equal or greater means the caller gets an uninformative timeout instead of the lock message');
});

test('lock: the exec ceiling clears a WHOLE run plus a whole lock wait, with room to grow', () => {
  // MEASURED, not guessed (t440, 2026-08-19): the full suite runs in 73s wall at
  // root fe8e152 and 74s from a worktree at c1e1b8e, 6000 and 6004 tests. The
  // ceiling that shipped was 120000ms, which cleared that by 46s — and the
  // script's own lock wait (up to 30s) is spent INSIDE it, so the real headroom
  // was 16s and a single queued run blew the ceiling. That is how a SUCCESSFUL
  // run lost its report: the wrapper is SIGKILLed while the suite keeps running
  // and keeps holding the lock, and the digest, which exists only on the killed
  // wrapper's stderr, is never delivered.
  //
  // So the floor asserted here is a whole run PLUS a whole lock wait, times a
  // growth factor. At 420000ms the def tolerates roughly 5x today's wall time
  // (~74s -> ~390s) before it can trip again, i.e. the suite quintupling at
  // today's cost per test. A ceiling chosen to just clear today's number trips
  // again within weeks, because the suite grows monotonically.
  const MEASURED_WALL_MS = 74000;
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = /waited" -ge (\d+)/.exec(src);
  assert.ok(m, 'ENTER: the lock wait must be readable — it is part of the budget asserted here');
  const floor = (MEASURED_WALL_MS + Number(m[1]) * 1000) * 3;
  assert.ok(execTimeoutMs() >= floor,
    `the run-tests ceiling is ${execTimeoutMs()}ms but a run (${MEASURED_WALL_MS}ms) plus a full lock `
    + `wait (${Number(m[1]) * 1000}ms) needs at least ${floor}ms to leave any growth room — a ceiling `
    + 'this tight kills successful runs and loses their digest, which teaches hands to use the '
    + 'UNLOCKED `node scripts/run-tests.js` instead, and two of those deadlock');
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

// ── the refusal's EVIDENCE (t440 / B2) ──────────────────────────────────────
// The refusal was observed naming pid 37692 as the holder when that pid was
// already dead — it was the PREVIOUS wrapper, and a different, genuinely live
// run held the lock. The refusal was CORRECT and its evidence was not, which is
// the worse of the two failures: a dead pid in this message is exactly the
// reasoning that ends in `rm -rf`-ing a valid lock and deadlocking two runs.
//
// Driven by calling the shipped `lock_refusal` function directly rather than by
// waiting out the real 30s loop: a subject that spent 30 real seconds per state
// would add two minutes to the suite to exercise four printf branches. The
// function is EXTRACTED FROM THE SHIPPED FILE by anchor, the same discipline
// lockHarness uses, so a rename fails loudly instead of testing a paraphrase.
function refusalFor(state) {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const start = src.indexOf('lock_refusal() {');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start,
    'lock_refusal() was not found in test-digest.sh — this test extracts it by anchor and that anchor has moved');
  const fn = src.slice(start, end + 3);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-refusal-'));
  const lock = path.join(dir, '.test-digest.lock');
  if (state !== 'released') {
    fs.mkdirSync(lock);
    // OUR OWN pid for the live case: alive by construction, and no process is
    // harmed. 999999 for the dead case — a pid that cannot exist.
    if (state === 'live') fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    if (state === 'dead') fs.writeFileSync(path.join(lock, 'pid'), '999999');
    // state 'nopid' writes nothing: the window between mkdir and the pid write.
  }
  const sh = path.join(dir, 'drive.sh');
  fs.writeFileSync(sh, `#!/bin/sh\n${fn}\nLOCK="${lock}"\nwaited=30\nlock_refusal\n`, { mode: 0o755 });
  const res = spawnSync('/bin/sh', [sh], { encoding: 'utf-8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return (res.stderr || '').trim();
}

test('lock: a refusal against a LIVE holder names that pid and its elapsed time', () => {
  const out = refusalFor('live');
  // ENTER: the live branch is the one that may name a pid, and every assertion
  // in the sibling subjects is about NOT naming one — so pin that this branch
  // is reachable, or those could all be passing over a function that says
  // nothing at all.
  assert.match(out, /another suite run is already going/,
    `the live branch must still produce the plain refusal; got ${JSON.stringify(out)}`);
  assert.match(out, new RegExp(`pid ${process.pid}\\b`), 'and it names the live holder');
  assert.match(out, /waited 30s/, 'and how long it waited');
});

test('lock: a HELD lock whose pid is DEAD does not present that pid as the holder', () => {
  // The observed defect. The pid file lags the real holder — a run that just
  // took the lock has not written its pid yet, and the file may still name the
  // previous wrapper. Reporting it as "the holder" invites clearing a valid lock.
  const out = refusalFor('dead');
  assert.match(out, /HELD but its pid file names no live process/,
    `a dead pid must be reported as evidence that does not match, not as the holder; got ${JSON.stringify(out)}`);
  assert.ok(!/another suite run is already going \(pid 999999/.test(out),
    'the dead pid must NOT be presented in the holder sentence');
  assert.match(out, /Do NOT clear it/, 'and the reader is warned off the rm -rf conclusion outright');
  assert.match(out, /999999/, 'the pid is still SHOWN — as the pid FILE\'s content, which is the actual evidence');
});

test('lock: a lock dir with no pid file yet is the same case, not an unknown holder', () => {
  // The window between `mkdir` and `echo $$ > pid`. The old message printed
  // "pid unknown" inside the holder sentence, which reads as a wedge.
  const out = refusalFor('nopid');
  assert.match(out, /HELD but its pid file names no live process/, 'reported as the lagging-evidence case');
  assert.match(out, /pid: absent/, 'and says the file is not there rather than inventing a holder');
  assert.ok(!/another suite run is already going/.test(out),
    'not the holder sentence, which would claim evidence this branch does not have');
});

test('lock: a lock RELEASED in the instant we gave up says nothing is wedged', () => {
  // The benign race, and the only one of the four where re-running is certain to
  // work. Telling it apart from a wedge is the difference between one re-run and
  // an investigation.
  const out = refusalFor('released');
  assert.match(out, /nothing is wedged, re-run to take it/,
    `a released lock must not read as a wedge; got ${JSON.stringify(out)}`);
  assert.ok(!/Do NOT clear it/.test(out), 'and carries no warning about a lock that is already gone');
});

test('lock: every refusal line fits the 200-char slice the exec dispatcher delivers', () => {
  // The dispatcher replies with the LAST stderr line sliced to 200 chars. The
  // dead-pid line is the longest and the one whose tail is load-bearing — a cut
  // that dropped "Do NOT clear it" would leave a reader holding a dead pid, no
  // warning, and the obvious wrong conclusion. It shipped at 204 chars while
  // being written, which is how this subject came to exist.
  for (const state of ['live', 'dead', 'nopid', 'released']) {
    const out = refusalFor(state);
    assert.ok(out.length > 0, `ENTER: the ${state} branch printed nothing — nothing is being measured`);
    assert.ok(out.length <= 200,
      `the ${state} refusal is ${out.length} chars and the dispatcher delivers 200 — the tail, `
      + `which is where the actionable half lives, would be cut: ${JSON.stringify(out)}`);
  }
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
    const res = withRetry('the fake-lock sweep', () => require('node:child_process').spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js')],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    ));
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
    const res = withRetry('the named-file run past a held lock', () => require('node:child_process').spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js'), stub],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    ));
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
    const res = withRetry('the nested-runner env probe', () => spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js'), stub],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    ));
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
    // Wrapped even though the expected outcome here is a FAILED run: the
    // refusal is an ordinary exit that `spawnFailure` returns null for, so the
    // retry cannot mask it. A timed-out spawn, by contrast, satisfies the
    // no-TOTALS guard vacuously and then fails the match below — pointing the
    // reader at the lock code for a spawn that never answered.
    const res = withRetry('the unwritable-lock-dir refusal', () => spawnSync(
      process.execPath, [path.join(root, 'scripts', 'run-tests.js')],
      { encoding: 'utf-8', cwd: root, timeout: 120000, env },
    ));
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
function runDigest({
  tap, exit, cwd, seed, holdLock,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t88-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'node'),
    `#!/bin/sh\ncat <<'CLX_TAP'\n${tap}\nCLX_TAP\nexit ${exit}\n`, { mode: 0o755 });
  if (holdLock) {
    // The lock is rooted at the script's own checkout, which here is the
    // fixture. OUR pid, so the holder is alive by construction and no process
    // is harmed; the wait loop then spins to its 30s cap and refuses. The cap
    // is real time, so `sleep` is stubbed out on the same PATH the node stub
    // rides — 15 iterations of the SHIPPED loop, none of them waited on.
    const lock = path.join(root, '.test-digest.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  // CLODEX_HOME into the fixture, or a failing case here writes the preserved
  // output into the developer's REAL ~/.clodex and destroys the dump they are
  // most likely reading — the suite must not clobber the artifact it ships.
  const home = path.join(root, 'home');
  const env = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    CLODEX_HOME: home,
  };
  delete env.NODE_TEST_CONTEXT;
  const keep = path.join(home, 'test-failures', 'last.txt');
  if (seed !== undefined) {
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, seed);
  }
  try {
    const res = withRetry('runDigest', () => spawnSync(
      '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: cwd || root, timeout: 60000, env },
    ));
    const lines = (res.stderr || '').split('\n').filter((l) => l.trim() !== '');
    return {
      tree: path.basename(root),
      lines,
      digest: lines[lines.length - 1],
      code: res.status,
      keep,
      kept: fs.existsSync(keep) ? fs.readFileSync(keep, 'utf-8') : null,
    };
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
    digest: (t, k) => `[${t}] 2/3 green, 1 failing (${k}): a failing case`,
  },
  {
    // No summary at all — the runner died before producing one. The path that
    // carries the LEAST information is the one most likely to be read as noise
    // from the wrong place, so it names its tree too.
    what: 'suite did not run',
    tap: ['node: bad option: --test-reporter=tap'].join('\n'),
    exit: 9,
    code: 9,
    digest: (t, k) => `[${t}] suite did not run (${k}): node: bad option: --test-reporter=tap`,
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
    assert.strictEqual(r.digest, c.digest(r.tree, r.keep),
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

// ── the failing run's OUTPUT, not just its verdict ──────────────────────────
// The digest reduced `$out` to counts and names and dropped the rest on exit,
// so the assertion text, diff, stack and anything the test printed died with
// the process. Two agents were each blocked on evidence the run had already
// produced. These tests are about what SURVIVES a failing run.

// REAL runner output, captured by running node against a scratch test file,
// for the reason test/test-escapes.test.js gives about its own fixtures: a
// hand-written approximation cannot tell you what node actually emits, and this
// reducer is a parser of node's TAP. Two shapes below were mis-guessed by hand
// and only the real capture settled them — the bare `...` elision node's assert
// puts INSIDE a big diff, and the fact that a nested test's stdout arrives
// UNINDENTED at top level (so `/^# /` does see it).
//
// Captured rather than pasted: pasting 200+ lines of volatile absolute paths and
// durations dates instantly, and regenerating means a wording change in node
// fails these tests rather than silently passing against a frozen copy.
function captureRealTap({ fillers = 0, bigDiff = false, escape = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t363-cap-'));
  try {
    const src = [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      // Each filler is one more `# Subtest:` diagnostic line, which is how the
      // real suite drowns the diagnostics buffer.
      // The mid-stream marker is printed from a filler in the MIDDLE of the run,
      // so it lands in the window a middle-drop discards. A marker printed at
      // module load sits at the HEAD of the stream and survives that drop, which
      // would demonstrate nothing about eviction.
      //
      // The filler must be ASYNC and must actually yield: node hoists the stdout
      // of SYNCHRONOUS tests to the head of the stream regardless of when it was
      // printed (measured — a marker from filler 300 of 600 landed at line 2),
      // and `await Promise.resolve()` does not yield far enough to change that.
      // `setImmediate` does, and costs nothing measurable.
      `for (let i = 1; i <= ${fillers}; i++) test('filler ' + i, async () => {`,
      '  await new Promise((r) => setImmediate(r));',
      `  if (i === Math.floor(${fillers} / 2)) console.log('MID STREAM STDOUT MARKER');`,
      '});',
      "console.log('TOP LEVEL STDOUT MARKER');",
      escape ? "test('an escaping test', () => { setTimeout(() => { throw new Error('BOOM ESCAPED'); }, 5); });" : '',
      "test('outer suite', async (t) => {",
      "  await t.test('the failing subtest', () => {",
      "    console.log('NESTED STDOUT MARKER');",
      bigDiff
        ? "    const a = {}, b = {}; for (let i = 0; i < 60; i++) { a['k'+i] = i; b['k'+i] = i; } a.zz = 1; b.zz = 2;"
          + '    assert.deepStrictEqual(a, b);'
        : "    assert.deepStrictEqual({ a: 1, b: 2 }, { a: 1, b: 3 });",
      '  });',
      "  await t.test('a passing sibling', () => {});",
      '});',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'cap.test.js'), src);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const res = withRetry('the real-TAP capture', () => spawnSync(
      process.execPath, ['--test', '--test-reporter=tap'],
      { cwd: dir, encoding: 'utf-8', timeout: 60000, env },
    ));
    return `${res.stdout || ''}${res.stderr || ''}`;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A failing TAP fixture with the shape node actually emits: a `not ok` row at
// depth, then the YAML block carrying the evidence, and a passing sibling that
// must NOT be what we keep.
const RICH_FAIL_TAP = [
  'TAP version 13',
  '# STDOUT THE TEST PRINTED',
  '# Subtest: outer suite',
  '    # Subtest: the failing subtest',
  '    not ok 1 - the failing subtest',
  '      ---',
  '      duration_ms: 2.14',
  '      failureType: \'testCodeFailure\'',
  '      error: |-',
  '        Expected values to be strictly deep-equal:',
  '        +   b: 2',
  '        -   b: 3',
  '      code: \'ERR_ASSERTION\'',
  '      stack: |-',
  '        TestContext.<anonymous> (/tmp/a.test.js:6:12)',
  '      ...',
  '    # Subtest: a passing sibling',
  '    ok 2 - a passing sibling',
  '      ---',
  '      duration_ms: 0.07',
  '      ...',
  '    1..2',
  // The parent wrapper node emits for a suite whose subtest failed. It rides
  // along in both the names and the dump; keeping it in the fixture is what
  // makes this TAP the shape node actually produces rather than a tidied one.
  'not ok 1 - outer suite',
  '  ---',
  '  error: \'1 subtest failed\'',
  '  ...',
  '1..2',
  '# tests 4',
  '# pass 2',
  '# fail 2',
].join('\n');

const RICH_FAIL_CASE = { what: 'rich fail', tap: RICH_FAIL_TAP, exit: 1 };

test('keep: a failing run preserves the assertion text, diff and stack it produced', () => {
  const r = runDigest(RICH_FAIL_CASE);
  // ENTER: everything below is about the contents of a file, and a missing file
  // reads as an empty string that no `includes` would match — the whole point of
  // this ticket is that the evidence silently was not there.
  assert.ok(r.kept !== null,
    `ENTER: no file at ${r.keep} after a failing run — the output was discarded, which is the `
    + 'defect this ticket exists to fix');

  // ENTER for the reduction: the file is TRIMMED, and a trimmer that drops the
  // row under test yields a confidently empty dump that every assertion below
  // would be vacuously true of if they were absences. Assert the interesting row
  // survived before asserting anything about what rides with it.
  assert.match(r.kept, /^ *not ok 1 - the failing subtest$/m,
    'the failing subtest\'s own row did not survive the reduction — a reducer that drops the row '
    + 'under test vacuums out every assertion downstream');

  for (const evidence of [
    'Expected values to be strictly deep-equal:',   // the assertion text
    '+   b: 2',                                     // the diff
    'TestContext.<anonymous> (/tmp/a.test.js:6:12)', // the stack
    'STDOUT THE TEST PRINTED',                      // what the test printed
  ]) {
    assert.ok(r.kept.includes(evidence),
      `the preserved file is missing ${JSON.stringify(evidence)} — this is exactly the evidence `
      + 'two agents were blocked on, and keeping the row without it preserves nothing');
  }
});

test('keep: the digest NAMES the preserved file, or nobody can find it', () => {
  const r = runDigest(RICH_FAIL_CASE);
  assert.ok(r.lines.length > 0, 'ENTER: the script wrote nothing to stderr');
  // The WHOLE line. A substring check for the path would also pass on a line
  // that lost the failing NAMES to it — and the names are the half worth more.
  assert.strictEqual(r.digest,
    `[${r.tree}] 2/4 green, 2 failing (${r.keep}): the failing subtest; outer suite`,
    'the digest must name the file AND keep the failing names — a file nothing points at is '
    + 'as good as discarded, and a path that evicts the names makes the line worse');
  assert.strictEqual(r.code, 1, 'preserving the output must not change the verdict');
});

test('keep: a GREEN run writes nothing at all', () => {
  const r = runDigest(PASS_CASE);
  assert.strictEqual(r.digest, `[${r.tree}] 3/3 green`,
    'the green line must stay exactly as it was — no path, nothing to point at');
  assert.strictEqual(r.kept, null,
    'a green run wrote a failure dump: the file would then be a LIE the next reader trusts, '
    + 'showing a failure that is not current');
});

const SENTINEL = 'not ok 1 - A FAILURE FROM AN EARLIER RUN\n';

test('keep: a green run removes the dump an earlier failure left', () => {
  // The dump is one fixed file with no expiry, so after a green run it holds a
  // failure OLDER than the verdict just printed. An agent cats it as evidence
  // about the run it just made and reads a regression that is already fixed —
  // twice on t654/t655. The green arm is where the file stops being true.
  const r = runDigest({ ...PASS_CASE, seed: SENTINEL });
  assert.strictEqual(r.digest, `[${r.tree}] 3/3 green`,
    'ENTER: the green arm did not run, so nothing below is about a green run');
  assert.strictEqual(r.kept, null,
    'a green run left the older failure dump in place, which the next reader takes for evidence '
    + 'about this run');
});

test('keep: a failing run OVERWRITES the older dump rather than being cleared', () => {
  // CONTROL for the green clear: the removal must be the green arm's, not a
  // blanket wipe that costs a failing run the evidence it just captured.
  const r = runDigest({ ...RICH_FAIL_CASE, seed: SENTINEL });
  assert.ok(r.kept !== null, 'ENTER: the failing run preserved nothing, so there is nothing to judge');
  assert.match(r.kept, /^ *not ok 1 - the failing subtest$/m,
    'the current failure is not in the file — the clear reached the failing arm');
  assert.ok(!r.kept.includes('A FAILURE FROM AN EARLIER RUN'),
    'the older dump survived alongside the current one');
});

test('keep: a lock refusal leaves the older dump untouched', () => {
  // CONTROL for the green clear in the other direction: a refusal MEASURED
  // NOTHING, so it has no standing to destroy the last real failure. Only a
  // verdict may invalidate the dump.
  const r = runDigest({ ...PASS_CASE, seed: SENTINEL, holdLock: true });
  assert.match(r.digest || '', /not starting a second/,
    'ENTER: the run was not refused, so this is not exercising the refusal arm at all');
  assert.strictEqual(r.kept, SENTINEL,
    'a refused run changed the dump: it ran no tests, so anything it does to the file replaces '
    + 'real evidence with none');
});

test('keep: a stale dump from an earlier failure is replaced, not appended to', () => {
  // Bounding by SHAPE rather than by a sweep: one fixed file, overwritten. This
  // is what makes it impossible to grow a second t187 (a log measured at
  // 1.16 MB/day). If it ever appends, it grows forever with nothing to prune it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t363-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'node'),
      `#!/bin/sh\ncat <<'CLX_TAP'\n${RICH_FAIL_TAP}\nCLX_TAP\nexit 1\n`, { mode: 0o755 });
    const home = path.join(root, 'home');
    const keep = path.join(home, 'test-failures', 'last.txt');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    const stale = 'not ok 1 - A FAILURE FROM LAST WEEK\n'.repeat(50);
    fs.writeFileSync(keep, stale);
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CLODEX_HOME: home,
    };
    delete env.NODE_TEST_CONTEXT;
    withRetry('stale-dump run', () => spawnSync(
      '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: root, timeout: 60000, env },
    ));
    const after = fs.readFileSync(keep, 'utf-8');
    assert.match(after, /^ *not ok 1 - the failing subtest$/m,
      'ENTER: the current failure is not in the file, so what follows would be about nothing');
    assert.ok(!after.includes('A FAILURE FROM LAST WEEK'),
      'the previous dump survived: this file accumulates, so it grows without bound and a reader '
      + 'cannot tell which failure is the current one');
    assert.ok(!fs.existsSync(`${keep}.tmp`),
      'the staging file was left behind — it is written next to the real one and would accumulate');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: the dump lands outside the measured tree, even when that is a worktree', () => {
  // Not in the user's repo: the measured tree may be a worktree that gets
  // REMOVED (with the evidence in it), and their checkout is not ours to dirty.
  const { base, root, wt } = mkRepo();
  const home = path.join(base, 'home');
  const env = { ...stubNode(base, { tap: RICH_FAIL_TAP, exit: 1 }), CLODEX_HOME: home };
  try {
    const r = runWithPayload(root, JSON.stringify({ tree: wt }), env);
    const keep = path.join(home, 'test-failures', 'last.txt');
    assert.ok(fs.existsSync(keep),
      'ENTER: nothing was preserved when measuring a worktree, so the assertions below are vacuous');
    assert.strictEqual(r.digest,
      `[${path.basename(wt)}] 2/4 green, 2 failing (${keep}): the failing subtest; outer suite`);
    const kept = fs.readFileSync(keep, 'utf-8');
    assert.match(kept, /^ *not ok 1 - the failing subtest$/m,
      'ENTER: the failing row did not survive, so the header check below proves nothing');
    // The dump must say WHICH tree produced it: one fixed path shared by every
    // tree on the box means a reader can otherwise attribute a worktree's
    // failure to the root, which is the same class of error as an unmarked
    // digest line.
    assert.ok(kept.includes(wt),
      'the preserved file does not name the tree it came from — with one file per box, a dump '
      + 'that cannot be attributed is a dump that can be misread as another tree\'s');
    for (const stray of [root, wt]) {
      assert.ok(!fs.existsSync(path.join(stray, 'test-failures')),
        `the dump was written into ${stray} — artifacts must not land in a checkout, which may be `
        + 'removed with the evidence still in it');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('keep: an unwritable destination costs the dump, never the digest', () => {
  // The digest line is the thing the caller actually receives. If preserving the
  // output can break it, this change made the harness worse than the defect.
  // A regular FILE where the directory must go is the cheapest real mkdir -p
  // failure, and needs no permission games that a root-run suite would skip.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t363-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'node'),
      `#!/bin/sh\ncat <<'CLX_TAP'\n${RICH_FAIL_TAP}\nCLX_TAP\nexit 1\n`, { mode: 0o755 });
    const home = path.join(root, 'home');
    fs.writeFileSync(home, 'not a directory');
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CLODEX_HOME: home,
    };
    delete env.NODE_TEST_CONTEXT;
    const res = withRetry('unwritable-destination run', () => spawnSync(
      '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: root, timeout: 60000, env },
    ));
    const lines = (res.stderr || '').split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, 'ENTER: the script wrote no stderr at all');
    assert.strictEqual(lines[lines.length - 1],
      `[${path.basename(root)}] 2/4 green, 2 failing: the failing subtest; outer suite`,
      'when the dump cannot be written the digest must be exactly the old line — and must NOT '
      + 'name a file that is not there, which sends the reader looking for evidence that does '
      + 'not exist');
    assert.strictEqual(res.status, 1, 'and the verdict still stands');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: TAP the trimmer does not recognise falls back to raw, never to empty', () => {
  // A parser that matches nothing must not produce a confidently EMPTY file:
  // that reads as "the runner said nothing", which is the false-negative this
  // whole ticket is about, dressed up as a fix.
  const r = runDigest({
    what: 'unparseable',
    tap: ['TAP version 13', 'something the reducer does not match',
      '# tests 3', '# pass 2', '# fail 1'].join('\n'),
    exit: 1,
  });
  assert.ok(r.kept !== null, 'ENTER: nothing was preserved at all');
  assert.ok(r.kept.includes('something the reducer does not match'),
    'the reduction matched nothing and kept nothing — an empty dump is indistinguishable from a '
    + 'run that produced no output, and hides that the TAP grammar moved');
});

// Runs the SHIPPED script over arbitrary TAP and returns the preserved file.
// Separate from runDigest so a fixture can be built from a real capture.
function keepFor(tap, exit = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t363-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
    fs.mkdirSync(path.join(root, 'bin'));
    // The TAP goes through a FILE, not a heredoc: a capture containing the
    // heredoc terminator or a `$` would otherwise be mangled by the stub.
    fs.writeFileSync(path.join(root, 'tap.txt'), tap);
    fs.writeFileSync(path.join(root, 'bin', 'node'),
      `#!/bin/sh\ncat ${path.join(root, 'tap.txt')}\nexit ${exit}\n`, { mode: 0o755 });
    const home = path.join(root, 'home');
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CLODEX_HOME: home,
    };
    delete env.NODE_TEST_CONTEXT;
    withRetry('keepFor', () => spawnSync(
      '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: root, timeout: 60000, env },
    ));
    const keep = path.join(home, 'test-failures', 'last.txt');
    return fs.existsSync(keep) ? fs.readFileSync(keep, 'utf-8') : null;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('keep: at real suite scale the diagnostics are stdout, not a wall of test names', () => {
  // THE FIXTURE MUST BE BIG, and that is the whole subject. The reducer caps the
  // diagnostics buffer; node emits one `# Subtest:` per test, so on the real
  // ~5300-test suite those names alone are an order of magnitude over the cap
  // and evict the stdout this section advertises. A small fixture certifies the
  // claim while measuring nothing — the failure mode is the cap never binding.
  const FILLERS = 600;
  const tap = captureRealTap({ fillers: FILLERS, escape: true });
  const subtestLines = tap.split('\n').filter((l) => /^# Subtest: /.test(l)).length;
  assert.ok(subtestLines > 400,
    `ENTER: the capture has only ${subtestLines} '# Subtest:' lines, which is under the script's `
    + 'diagnostics cap — this fixture is too small to exercise the eviction it is about');

  const kept = keepFor(tap);
  assert.ok(kept !== null, 'ENTER: nothing was preserved');
  const diag = kept.slice(kept.indexOf('## top-level diagnostics'));
  assert.ok(diag.length > 0, 'ENTER: there is no diagnostics section to judge');

  // The marker printed from the MIDDLE filler, i.e. the window a middle-drop
  // discards. A head-of-stream marker survives that drop and would certify the
  // stdout claim without measuring it.
  // ENTER, and the position is the point: the marker must sit AFTER a large
  // number of `# Subtest:` lines, i.e. inside the window the middle-drop
  // discards. Node hoists synchronous test stdout to the head of the stream,
  // where it survives that drop — a marker at the head would satisfy a mere
  // presence check while measuring nothing about eviction.
  const tapLines = tap.split('\n');
  const mid = tapLines.indexOf('# MID STREAM STDOUT MARKER');
  assert.ok(mid > 0, 'ENTER: the mid-stream marker is not in the capture at all');
  const before = tapLines.slice(0, mid).filter((l) => /^# Subtest: /.test(l)).length;
  assert.ok(before > 200 && before < FILLERS - 200,
    `ENTER: the marker sits after only ${before} of ${FILLERS} '# Subtest:' lines, so it is near `
    + 'an end of the stream that the middle-drop KEEPS — it would survive whether or not the '
    + 'eviction is fixed');
  assert.ok(diag.includes('MID STREAM STDOUT MARKER'),
    'test stdout from the middle of the run was evicted from the diagnostics section at scale — '
    + 'the section header promises stdout and this is the case where it stops delivering it');
  assert.ok(diag.includes('TOP LEVEL STDOUT MARKER'),
    'stdout printed at module load was evicted too');
  // The finding that makes dropping `# Subtest:` SAFE: a nested test's stdout
  // arrives unindented at top level, so the `/^# /` rule still collects it. If
  // node ever indents it, it becomes invisible to that rule and skipping
  // `# Subtest:` would start costing real output.
  assert.ok(diag.includes('NESTED STDOUT MARKER'),
    'a nested test\'s stdout no longer reaches the diagnostics section — it arrives unindented '
    + 'today, which is what makes skipping `# Subtest:` safe; indented, `/^# /` cannot see it');
  assert.match(diag, /# Error: .*asynchronous activity after the test ended/,
    'the escape diagnostic did not survive: that line is the one test/test-escapes.test.js exists '
    + 'to catch, and losing it hides a suite that went green while broken');
  assert.ok(!/^# Subtest: /m.test(diag),
    'per-test `# Subtest:` names are still in the diagnostics buffer — they are already in the '
    + 'failure rows above and at scale they are what starves this section');
  // And the summary tail, at the far end of the same buffer.
  assert.match(diag, /^# fail \d+$/m, 'the summary tail must survive alongside the stdout');
});

test('keep: a bare `...` inside a big diff does not truncate the block early', () => {
  // Node's assert elides the middle of a large deep-equal diff with a bare
  // `...`, indented DEEPER than the YAML block it sits inside. An unanchored
  // terminator ends the block there and drops the rest of the diff, `code:` and
  // the whole `stack:` — on exactly the big-diff failures worth preserving.
  const tap = captureRealTap({ bigDiff: true });
  // AN ELISION IS A `...` WITH NO MATCHING `---`, and the distinction is the
  // whole guard. Every YAML block ends with an indented `...`, so counting
  // indented dots alone is satisfied by any failing TAP, elision or not — it
  // would keep this subject green while node quietly stopped eliding, at which
  // point the assertions below pass against the unanchored terminator too and
  // certify a fix nothing exercises.
  const lines = tap.split('\n');
  const dots = lines.filter((l) => /^[ \t]*\.\.\.[ \t]*$/.test(l));
  const opens = lines.filter((l) => /^[ \t]*---[ \t]*$/.test(l));
  assert.ok(dots.length > opens.length,
    `ENTER: ${dots.length} \`...\` lines against ${opens.length} \`---\` openers, so every one of `
    + 'them is an ordinary block terminator and this capture contains no elision at all — it '
    + 'cannot exercise the early termination it is about, and node may have changed how it '
    + 'elides large deep-equal diffs');

  const kept = keepFor(tap);
  assert.ok(kept !== null, 'ENTER: nothing was preserved');
  assert.match(kept, /^ *not ok 1 - the failing subtest$/m,
    'ENTER: the failing row itself is missing, so everything below is about nothing');
  for (const tail of ['zz: 1', "code: 'ERR_ASSERTION'", 'stack: |-']) {
    assert.ok(kept.includes(tail),
      `the block was cut short before ${JSON.stringify(tail)} — an elision inside the diff ended `
      + 'it early, which silently discards the evidence on the biggest failures');
  }
});

test('keep: the digest shows the home-relative path a reader can actually type', () => {
  // The only form a user ever sees, and no other subject reaches it: every other
  // fixture puts CLODEX_HOME outside $HOME, so the tilde branch never runs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t363-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'test-digest.sh'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'node'),
      `#!/bin/sh\ncat <<'CLX_TAP'\n${RICH_FAIL_TAP}\nCLX_TAP\nexit 1\n`, { mode: 0o755 });
    const home = path.join(root, 'fakehome');
    fs.mkdirSync(home);
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      HOME: home,
      CLODEX_HOME: path.join(home, '.clodex'),
    };
    delete env.NODE_TEST_CONTEXT;
    const res = withRetry('run-dir teardown run', () => spawnSync(
      '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')],
      { encoding: 'utf-8', cwd: root, timeout: 60000, env },
    ));
    const lines = (res.stderr || '').split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, 'ENTER: the script wrote nothing to stderr');
    assert.strictEqual(lines[lines.length - 1],
      `[${path.basename(root)}] 2/4 green, 2 failing (~/.clodex/test-failures/last.txt): `
      + 'the failing subtest; outer suite',
      'under $HOME the digest must abbreviate to ~ — it is the only form users see, and the raw '
      + 'form spends ~20 more chars of a 180-char line that the failing names are competing for');
    assert.ok(fs.existsSync(path.join(home, '.clodex', 'test-failures', 'last.txt')),
      'and the abbreviated path must be where the file actually is, not a cosmetic string');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keep: the preserved path lives outside the run dir that teardown deletes', () => {
  // clodex-paths.js's header is the authority: ~/.clodex/run/<name>/ is rm -rf'd
  // on EVERY exit path, and putting data that must outlive a restart there is
  // the recurring bug it documents. This dump is read by an agent after the run
  // that produced it — quite possibly after that agent's session ended.
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const m = /keep_dir=(\S+)/.exec(src);
  assert.ok(m, 'ENTER: the script no longer sets keep_dir, so this test measures nothing');
  assert.ok(!/\/run\//.test(m[1]),
    `the dump is written under ${m[1]}, inside the per-agent run dir that is rm -rf'd on every `
    + 'exit path — the evidence would be gone before it is read');
  assert.match(m[1], /CLODEX_HOME/,
    'the destination must honour CLODEX_HOME like clodex-paths.js does, or the suite cannot '
    + 'redirect it and every failing test run clobbers the developer\'s own dump');
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
  const res = withRetry('runWithPayload', () => spawnSync(
    '/bin/sh', [path.join(root, 'scripts', 'test-digest.sh')], {
      encoding: 'utf-8', cwd: opts.cwd || root, timeout: 60000, env, input: payload,
    },
  ));
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

// ── the harness's own failure, told apart from the script's ─────────────────
// The guard tests above all reduce to "the script wrote nothing to stderr". A
// spawn the harness KILLED produces exactly that shape while saying nothing
// about the script, so without the classifier below every one of them can
// accuse the code under test of a fault that is the fixture's. That is not
// hypothetical: it cost a rework round on t396.

test('harness: a spawn killed at its cap is classified as a harness failure', () => {
  // The real thing, not a hand-made object: `spawnSync` populating `error` on a
  // timeout is the vendor behaviour the classifier is built on, and a mocked
  // result would pin the mock instead. Cheap because the cap is 200ms.
  const res = spawnSync('/bin/sh', ['-c', 'sleep 10'], { encoding: 'utf-8', timeout: 200 });
  assert.strictEqual(res.stderr, '',
    'ENTER: a timed-out spawn must present as EMPTY stderr, which is the whole reason it is '
    + 'indistinguishable from a silent script — if node started reporting here, this guard is moot');
  assert.strictEqual(spawnFailure(res), 'ETIMEDOUT',
    'a spawn killed at its cap must be NAMED, not laundered into "the script wrote nothing"');
});

test('harness: a script that ran and answered is NOT a harness failure', () => {
  // The other side of the classifier, and the one that keeps it from swallowing
  // real failures: a script that exits NONZERO with a message has answered, so
  // it must pass straight through to the assertions rather than being retried.
  const res = spawnSync('/bin/sh', ['-c', 'echo refused 1>&2; exit 1'],
    { encoding: 'utf-8', timeout: 60000 });
  assert.strictEqual(res.status, 1, 'ENTER: the fixture must have produced a real nonzero exit');
  assert.strictEqual(spawnFailure(res), null,
    'a real answer — even a failing one — must never be treated as a harness fault, or a genuinely '
    + 'broken lock would be retried into silence');
});

test('harness: withRetry retries ONLY a no-answer spawn, and returns a real answer once', () => {
  // The property that makes the retry safe to have at all. A wrong answer must
  // be delivered on the FIRST attempt: retrying one would re-run a genuinely
  // broken lock until it happened to look fine, which is the blind spot the
  // ticket forbids.
  let calls = 0;
  const answered = withRetry('fixture', () => {
    calls += 1;
    return spawnSync('/bin/sh', ['-c', 'echo nope 1>&2; exit 3'], { encoding: 'utf-8' });
  });
  assert.strictEqual(calls, 1, 'a script that answered must be run ONCE, never retried');
  assert.strictEqual(answered.status, 3, 'and its real verdict must survive the wrapper');

  // A no-answer spawn that recovers: retried, and the second answer is used.
  let n = 0;
  const recovered = withRetry('fixture', () => {
    n += 1;
    return n === 1
      ? spawnSync('/bin/sh', ['-c', 'sleep 10'], { encoding: 'utf-8', timeout: 200 })
      : spawnSync('/bin/sh', ['-c', 'echo ok 1>&2; exit 0'], { encoding: 'utf-8' });
  });
  assert.strictEqual(n, 2, 'a spawn that returned no answer must be retried exactly once');
  assert.strictEqual(recovered.status, 0, 'and the answer that did arrive is the one used');
});

test('harness: two no-answer spawns FAIL, naming the harness — never a pass or a skip', () => {
  // THE CONSTRAINT THAT MATTERS. A genuine deadlock — the 0% CPU wedge these
  // tests exist to catch — times out on both attempts, so it must still go RED.
  // A fixture made robust by converting an inconclusive run into a pass or a
  // skip would cost a wedged box, which is far worse than the flake it fixes.
  assert.throws(
    () => withRetry('fixture', () => spawnSync('/bin/sh', ['-c', 'sleep 10'],
      { encoding: 'utf-8', timeout: 200 })),
    (err) => {
      assert.match(err.message, /never got an answer/,
        'the failure must say the harness got no answer');
      assert.match(err.message, /HARNESS failing, not the digest script/,
        'and it must point at the harness, or the reader diffs a script that is not at fault');
      assert.match(err.message, /Do not raise the timeout/,
        'and it must head off the retime, which is the wrong lesson this whole ticket is about');
      return true;
    },
  );
});
