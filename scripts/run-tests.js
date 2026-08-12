'use strict';

// run-tests.js — `npm test`. Runs the suite through `node --test` and refuses
// to report green when a failure escaped the counters.
//
// Why a wrapper exists at all: an error thrown on an async continuation that
// outlives its test is counted PASS (see scripts/test-escapes.js). Node's exit
// code is honest about it, but the COUNT is not, and the diagnostic naming the
// test is dropped by the `dot` reporter our digest path used. So the run is
// done with TWO reporters — the caller's on stdout, plus tap into a temp file
// that nothing formats away — and the tap stream is scanned for escapes.
//
//   node scripts/run-tests.js                     # spec reporter (a human)
//   node scripts/run-tests.js --reporter=dot      # one-line digest (the agent)
//   node scripts/run-tests.js [--reporter=X] FILE…
//
// Anything after the flag is passed through to `node --test` verbatim.
//
// This wrapper never converts a bad run into a good one: a named test path that
// does not exist, a spawn failure, a missing or empty tap file, a run that
// produced no summary, or a throw inside the escape analysis all exit non-zero
// with the reason on stderr.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEscapes, formatEscapes } = require('./test-escapes.js');

const ROOT = path.join(__dirname, '..');

let reporter = process.env.CLODEX_TEST_REPORTER || 'spec';
const passthrough = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--reporter=(.+)$/.exec(arg);
  if (m) reporter = m[1];
  else passthrough.push(arg);
}

function die(msg, code) {
  console.error(`run-tests: ${msg}`);
  process.exit(code || 1);
}

// A named path that does not exist must not yield a run at all. Node splits on
// the shape: a literal missing path exits non-zero, but a GLOB matching nothing
// runs ZERO tests and exits 0 — a green report over a run that executed nothing,
// the one thing this wrapper must never emit. Unexpanded globs do reach here:
// sh without nullglob passes a pattern that matched nothing through literally.
// Flag vs path is the leading `-`, the same rule `sweeping` uses below, so the
// file keeps ONE definition of "names a target".
const missing = passthrough.filter((a) => {
  if (a.startsWith('-')) return false;
  // spawnSync runs with cwd: ROOT — resolve against ROOT, not process.cwd().
  if (/[*?[\]{}]/.test(a)) {
    // Without globSync (node < 22) node cannot glob its own test args either,
    // so an unmatched pattern takes the literal path and exits non-zero anyway.
    if (typeof fs.globSync !== 'function') return false;
    // Fails OPEN: a pattern globSync rejects is node's to refuse, with node's
    // own message, not ours to turn into a wrapper stack trace. (It does not
    // throw on the installed node — `foo[bar` returns [] on 25.8.1 — so this is
    // belt-and-braces against a future glob implementation, not a live bug.)
    try {
      return fs.globSync(a, { cwd: ROOT }).length === 0;
    } catch { return false; }
  }
  return !fs.existsSync(path.resolve(ROOT, a));
});
// Name what the path was resolved AGAINST: arguments resolve against the repo
// root, not the caller's cwd, so someone in cli/ otherwise gets "does not exist"
// for a file they can ls.
if (missing.length) {
  die(`named test path does not exist: ${missing.join(', ')} (resolved against ${ROOT})`);
}

// ── the suite mutex, shared with scripts/test-digest.sh ────────────────────
// SAME lock dir and SAME protocol as the digest path, because parts of this
// suite bind real ports (cli/test/attach.test.js) and two concurrent runs
// deadlock at 0% CPU — neither finishes, and the wedge is indistinguishable
// from a slow suite. The digest took this lock from the start; `npm test` did
// not, so the obvious command walked straight past the guard. Measured: four
// concurrent runs, two permanently wedged on attach.test.js, the older one for
// 13h47m. Any new entry point to the suite must take this lock too.
//
// Contention is not the only way to wedge, and reading it as the only way cost
// three misdiagnoses: until 46cd13d a SINGLE run hung on attach.test.js by
// itself, on an unguarded tail close() plus node's infinite default per-test
// timeout, which turned a failing assertion into a silent hang. The lock cannot
// fix that shape and never could.
//
// REFUSES rather than waits. The digest's 120s wait is for a run that is about
// to finish; a human or agent at a prompt wants the reason NOW, and waiting
// only converts a wedge into a timeout somewhere further up (the exec's own cap
// killed the digest before it could report exactly this).
// The lock DIR is overridable because the ticket loop runs a WORKTREE's copy of
// this script while needing the ROOT checkout's lock. Defaulting it to this
// script's own ROOT is what makes a per-checkout lock, and a worktree runner
// taking its own lock is not serialization — it is a second lock, and both runs
// then reach the port-binding tests together. The override is the only way one
// mutex can cover every checkout of the same repo.
const LOCK = process.env.CLODEX_TEST_LOCK_DIR
  ? path.resolve(process.env.CLODEX_TEST_LOCK_DIR)
  : path.join(ROOT, '.test-digest.lock');

// Refuse-vs-wait, defaulting to REFUSE so an unset environment behaves exactly
// as before (a human at a prompt wants the reason now). The loop sets a wait: it
// is not at a prompt, nothing is billed while it blocks, and a ticket that
// closes while another suite runs must QUEUE rather than skip its own
// verification — skipping is the false green this whole check exists to prevent.
const LOCK_WAIT_MS = Math.max(0, Number(process.env.CLODEX_TEST_LOCK_WAIT_MS) || 0);

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  // The PARENT is created recursively (an override may name a dir that does not
  // exist yet); the lock dir itself NEVER is. `recursive: true` does not throw
  // EEXIST on an existing dir, which would turn the atomic test-and-set into an
  // unconditional success and hand the lock to every concurrent run at once.
  try { fs.mkdirSync(path.dirname(LOCK), { recursive: true }); } catch {}
  // Bounded like the original: a reclaim that does not then win the lock means
  // something is racing or the dir is unwritable, and spinning on it forever is
  // a wedge with no message. Waiting on a LIVE holder is not a reclaim and does
  // not consume an attempt.
  let reclaims = 0;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') die(`could not take the suite lock: ${e.message}`);
    }
    let holder = null;
    try { holder = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8').trim()) || null; } catch {}
    // A killed runner never cleans up, so a lock naming a DEAD pid is stale and
    // reclaimed — without this the first crash wedges every later run forever.
    let alive = false;
    if (holder) { try { process.kill(holder, 0); alive = true; } catch {} }
    if (alive) {
      // Sleep SYNCHRONOUSLY: this runs before the suite spawns and the process
      // has nothing else to do, so a busy Atomics.wait costs nothing and keeps
      // the whole acquire path straight-line — an async wait here would have to
      // thread a promise through every die() site above.
      if (Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        continue;
      }
      die(`another suite run is already going (pid ${holder}).\n`
        + '  Parts of this suite bind real ports, so a second run deadlocks both.\n'
        + `${LOCK_WAIT_MS ? `  Waited ${LOCK_WAIT_MS}ms for it to finish.\n` : ''}`
        + '  Wait for it, or if it is wedged: kill '
        + `${holder} && rm -rf ${LOCK}`);
    }
    try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
    if (++reclaims >= 2) die('could not take the suite lock after reclaiming a stale one');
  }
}

let lockHeld = false;
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
}

// The suite spawns this runner ITSELF (test/test-escapes.test.js drives it
// against scratch files to prove the escape detector works, and the lock tests
// drive it against a stub). Those children run inside a run that already holds
// the lock, and they name explicit FILES rather than sweeping the repo — so they
// are not the collision the lock exists to prevent, and taking it would make the
// suite deadlock against itself. The lock guards a full sweep, which is the only
// thing that reaches the port-binding tests.
const sweeping = !passthrough.some((a) => !a.startsWith('-'));
if (sweeping) { acquireLock(); lockHeld = true; }
// Covers the normal exit and the signals a Ctrl-C or a kill delivers; without
// this an interrupted run leaves a lock whose pid is briefly still alive, and
// the next run refuses against a ghost.
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-test-'));
const tapFile = path.join(tmpDir, 'run.tap');

// Both lock variables are scrubbed from the child environment. They are a
// decision about THIS process's lock, and every nested runner is by contract a
// DIFFERENT run: two test files (test/test-digest-lock.test.js,
// test/run-tests-args.test.js) spawn sweeping runners of their own against
// throwaway roots, and inheriting the override points them at the outer run's
// lock — held by a live pid — where they block for the whole inherited wait
// instead of exercising their own fixture. Measured against the unfixed runner:
// 6 tests red and ~12 minutes of spawnSync timeouts, i.e. the ticket loop
// rejecting every ticket for a defect in its own harness. Same discipline the
// tests already apply to NODE_TEST_CONTEXT.
const childEnv = { ...process.env };
delete childEnv.CLODEX_TEST_LOCK_DIR;
delete childEnv.CLODEX_TEST_LOCK_WAIT_MS;

const run = spawnSync(process.execPath, [
  '--test',
  `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
  ...passthrough,
], { cwd: ROOT, stdio: 'inherit', env: childEnv });

if (run.error) die(`could not start node --test: ${run.error.message}`);

let tap = '';
try {
  tap = fs.readFileSync(tapFile, 'utf8');
} catch (e) {
  die(`the tap stream is missing (${e.message}) — cannot tell whether anything escaped`);
}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch { /* a leftover temp dir is not a reason to fail a run */ }

if (!tap.trim()) die('the tap stream is empty — cannot tell whether anything escaped');

const counter = (name) => {
  const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap);
  return m ? Number(m[1]) : null;
};
const tests = counter('tests');
const pass = counter('pass');
const fail = counter('fail');
if (tests === null || pass === null || fail === null) {
  die('the run produced no summary — the suite did not complete');
}

// A filter flag that matched NOTHING is the same false green as a missing path,
// reached through a door no counter watches. Measured on node 25.8.1 over a
// 3-file root: `--test-name-pattern=zzzznope` and `--test-name-pattern=alpha`
// both report `# tests 3 / # suites 0 / # pass 3 / # fail 0 / # skipped 0` and
// exit 0 — byte identical. Node promotes a file whose tests were all filtered
// out to a passing test point and counts it as a PASS, not a skip, so
// `tests === 0` never fires and NO counter separates "ran and passed" from
// "filtered out and never executed". Do not replace this with a counter check.
//
// What DOES separate them is which test points node emits. During a run it
// flattens a test FILE away and reports its tests by their own names — a file
// appears as a test point of its own ONLY when it contributed no executed test,
// and then it is named by its path. So a point named after an existing file is
// a container that ran nothing, and every other point is a test body that ran.
// Two shapes produce such a container, and both must be discounted:
//   `1..0` + `ok N - some.test.js`   a file whose tests were all filtered out
//   `ok N - scripts/test-escapes.js` a file that defines no tests at all
//                                    (no plan line — measured; do not rely on
//                                    `1..0` alone, node omits it here, and the
//                                    repo really does sweep such files in:
//                                    node's own `test-*.js` pattern matches
//                                    scripts/test-escapes.js)
// The yaml block is byte-identical for a container and a real test, so the name
// and the plan are the whole signal.
//
// Ruling: exiting non-zero on a filtered run that executed nothing is correct
// even when someone was deliberately narrowing a run. A green over a run that
// never happened is what this whole wrapper exists to prevent.
const FILTER_FLAGS = ['--test-name-pattern', '--test-skip-pattern', '--test-only'];
// Both spellings: node accepts `--flag=value` and `--flag value`, and produces
// the same invisible-miss from either, so matching only the `=` form would close
// half the door.
const filters = passthrough.filter(
  (a) => FILTER_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)),
);
// `fail === 0` is not a softening: a run with failures already exits non-zero,
// so it cannot be a false green, and blaming the filter there would misattribute
// a real failure to a mistyped pattern.
if (filters.length && fail === 0) {
  let executed = 0;
  let emptyPlan = false;
  for (const line of tap.split('\n')) {
    if (/^ *1\.\.0 *$/.test(line)) { emptyPlan = true; continue; }
    const point = /^ *(?:not )?ok \d+ - (.*)$/.exec(line);
    if (!point) continue;
    const name = point[1].replace(/ +# +(SKIP|TODO)\b.*$/i, '').trim();
    // A test whose NAME happens to collide with a real file counts as a
    // container and is not evidence. That direction costs a loud refusal on a
    // run that did execute something; the other direction is a silent green
    // over a run that did not.
    const ranNothing = emptyPlan || fs.existsSync(path.resolve(ROOT, name));
    emptyPlan = false;
    if (!ranNothing) executed++;
  }
  if (executed === 0) {
    die(`the run executed zero tests: ${filters.join(' ')} matched nothing.\n`
      + `  node reported ${pass} pass over ${tests} test(s), but those are FILES it opened and\n`
      + '  filtered away, counted as passes. Nothing was verified.');
  }
}

let escapes;
try {
  escapes = parseEscapes(tap);
} catch (e) {
  die(`escape analysis threw (${e.message}) — refusing to report on this run`);
}

console.log(`\nTOTALS: ${pass} pass, ${fail} fail, ${tests} tests`);
console.log(formatEscapes(escapes));

// Node already exits non-zero on an escape it could attribute to a file; it
// does NOT when the file had a real failure to report instead. Either way the
// escape is a failure, so it decides the exit code here too.
if (escapes.length) process.exit(run.status || 1);
process.exit(run.status === null ? 1 : run.status);
