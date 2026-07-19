'use strict';
// diag-tools.test.js — Task 12 engine-side pieces: diagWarning's new missing-CLI /
// PATH-merge branches (piece 2) and the missing-CLI exit heuristic (piece 4).
// diagWarning takes a crafted `d` so no real PATH/arch is touched; a non-darwin
// platform skips the spawn-helper block to isolate the new branches.

const test = require('node:test');
const assert = require('node:assert');
const { diagWarning } = require('../engine');
const { missingToolOnExit } = require('../session-manager');

// A healthy-helper darwin base so the fatal-helper block passes and control reaches
// the new checks. (helperArch matches the running arch; both flags true.)
const healthyHelper = {
  platform: 'darwin', helperExists: true, helperExecutable: true,
  helperArch: process.arch === 'x64' ? 'x86_64' : process.arch, rosetta: false,
};

test('diagWarning: both agent CLIs present → no warning', () => {
  assert.strictEqual(diagWarning({ ...healthyHelper, claude: '/x/claude', codex: '/x/codex' }), null);
});

test('diagWarning: only one CLI missing → NOT a global warning (dialog gate owns it)', () => {
  assert.strictEqual(diagWarning({ ...healthyHelper, claude: null, codex: '/x/codex' }), null);
  assert.strictEqual(diagWarning({ ...healthyHelper, claude: '/x/claude', codex: null }), null);
});

test('diagWarning: BOTH agent CLIs missing → warns "no agent sessions can start"', () => {
  const w = diagWarning({ ...healthyHelper, claude: null, codex: null });
  assert.match(w, /Neither the claude nor codex CLI/);
  assert.match(w, /no agent sessions can start/);
  // Same remedy discipline as tool-doctor's claude spec: the native installer,
  // not npm — this audience (fresh account/machine) usually lacks npm too.
  assert.match(w, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(w, /npm i -g @anthropic-ai/);
});

test('diagWarning: a failed PATH merge is a first-class warning (root cause, over the symptom)', () => {
  const w = diagWarning({ ...healthyHelper, claude: null, codex: null, pathMergeFailed: true });
  assert.match(w, /PATH merge from your login shell failed/);
});

test('diagWarning: a fatal spawn-helper problem still takes PRIORITY over the CLI checks', () => {
  const w = diagWarning({
    platform: 'darwin', helperExists: false, helperExecutable: false,
    helperArch: 'arm64', rosetta: false, claude: null, codex: null, pathMergeFailed: true,
  });
  assert.match(w, /spawn-helper is missing/, 'helper problem wins — it sinks every session');
});

// ── missingToolOnExit (piece 4): the fast-fail missing-CLI heuristic ──────────
const whichPresent = (bin) => (bin === 'codex' ? '/usr/local/bin/codex' : null);

test('missingToolOnExit: fast code-1 exit + cmd not on PATH → names the cmd', () => {
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 500, cmd: 'claude', whichBin: whichPresent }),
    'claude',
  );
});

test('missingToolOnExit: cmd IS on PATH → null (a real crash, not a missing binary)', () => {
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 500, cmd: 'codex', whichBin: whichPresent }),
    null,
  );
});

test('missingToolOnExit: past the fast-fail window → null (the CLI clearly launched)', () => {
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 9000, cmd: 'claude', whichBin: whichPresent }),
    null,
  );
});

test('missingToolOnExit: expected exit / a signal / a non-1 code are never flagged', () => {
  const base = { exitCode: 1, signal: null, elapsedMs: 100, cmd: 'claude', whichBin: whichPresent };
  assert.strictEqual(missingToolOnExit({ ...base, expected: true }), null);
  assert.strictEqual(missingToolOnExit({ ...base, expected: false, signal: 'SIGKILL' }), null);
  assert.strictEqual(missingToolOnExit({ ...base, expected: false, exitCode: 127 }), null);
});

test('missingToolOnExit: an absolute-path cmd is never flagged (assumed explicit, like the spawn-error path)', () => {
  // An absolute cmd short-circuits on '/' WITHOUT consulting whichBin, mirroring
  // the spawn-error diagnostic (session-manager:958). So a code-1 bash exit never
  // masquerades as a missing CLI, regardless of whichBin.
  const neverCalled = () => { throw new Error('whichBin must not be consulted for an absolute cmd'); };
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 100, cmd: '/bin/zsh', whichBin: neverCalled }),
    null,
  );
});
