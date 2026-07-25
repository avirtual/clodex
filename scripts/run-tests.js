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
