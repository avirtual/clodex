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
// This wrapper never converts a bad run into a good one: a spawn failure, a
// missing or empty tap file, a run that produced no summary, or a throw inside
// the escape analysis all exit non-zero with the reason on stderr.

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

// ── the suite mutex, shared with scripts/test-digest.sh ────────────────────
// SAME lock dir and SAME protocol as the digest path, because parts of this
// suite bind real ports (cli/test/attach.test.js) and two concurrent runs
// deadlock at 0% CPU — neither finishes, and the wedge is indistinguishable
// from a slow suite. The digest took this lock from the start; `npm test` did
// not, so the obvious command walked straight past the guard. Measured: four
// concurrent runs, two permanently wedged on attach.test.js, the older one for
// 13h47m. Any new entry point to the suite must take this lock too.
//
// REFUSES rather than waits. The digest's 120s wait is for a run that is about
// to finish; a human or agent at a prompt wants the reason NOW, and waiting
// only converts a wedge into a timeout somewhere further up (the exec's own cap
// killed the digest before it could report exactly this).
const LOCK = path.join(ROOT, '.test-digest.lock');

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
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
      die(`another suite run is already going (pid ${holder}).\n`
        + '  Parts of this suite bind real ports, so a second run deadlocks both.\n'
        + '  Wait for it, or if it is wedged: kill '
        + `${holder} && rm -rf ${path.relative(ROOT, LOCK)}`);
    }
    try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
  }
  die('could not take the suite lock after reclaiming a stale one');
}

let lockHeld = false;
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
}
acquireLock();
lockHeld = true;
// Covers the normal exit and the signals a Ctrl-C or a kill delivers; without
// this an interrupted run leaves a lock whose pid is briefly still alive, and
// the next run refuses against a ghost.
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-test-'));
const tapFile = path.join(tmpDir, 'run.tap');

const run = spawnSync(process.execPath, [
  '--test',
  `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${tapFile}`,
  ...passthrough,
], { cwd: ROOT, stdio: 'inherit' });

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
