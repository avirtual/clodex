'use strict';
// diag-tools.test.js — Task 12 engine-side pieces: diagWarning's new missing-CLI /
// PATH-merge branches (piece 2) and the missing-CLI exit heuristic (piece 4).
// diagWarning takes a crafted `d` so no real PATH/arch is touched; a non-darwin
// platform skips the spawn-helper block to isolate the new branches.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { diagWarning, diagLines } = require('../engine');
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

test('diagWarning: every agent CLI missing → warns "no agent sessions can start"', () => {
  const w = diagWarning({ ...healthyHelper, claude: null, codex: null, muse: null });
  assert.match(w, /No agent CLI \(claude, codex or muse\)/);
  assert.match(w, /no agent sessions can start/);
  // Same remedy discipline as tool-doctor's claude spec: the native installer,
  // not npm — this audience (fresh account/machine) usually lacks npm too.
  assert.match(w, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(w, /npm i -g @anthropic-ai/);
});

test('diagWarning: any one AGENT_TOOLS CLI present is enough, and the collector probes every one of them', () => {
  const { AGENT_TOOLS } = require('../renderer/lib/tool-gate');
  const none = Object.fromEntries(AGENT_TOOLS.map((t) => [t, null]));
  assert.match(diagWarning({ ...healthyHelper, ...none }), /no agent sessions can start/, 'ENTER: none present warns');
  for (const t of AGENT_TOOLS) {
    assert.strictEqual(diagWarning({ ...healthyHelper, ...none, [t]: `/x/${t}` }), null, t);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const start = src.indexOf('function collectSystemDiagnostics() {');
  assert.ok(start > 0, 'ENTER: collectSystemDiagnostics is found by this anchor');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  for (const t of AGENT_TOOLS) assert.ok(body.includes(`${t}: whichBin('${t}')`), `collectSystemDiagnostics probes ${t}`);
  const lines = diagLines({ ...healthyHelper, ...none });
  for (const t of AGENT_TOOLS) assert.ok(lines.some((l) => l.startsWith(`${t}:`)), `diagLines prints ${t}`);
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

test('missingToolOnExit: an absolute-path cmd the probe accepts is never flagged', () => {
  const whichExplicit = (bin) => (bin === '/bin/zsh' ? '/bin/zsh' : null);
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 100, cmd: '/bin/zsh', whichBin: whichExplicit }),
    null,
  );
});

test('missingToolOnExit: an explicit path the probe rejects → names the cmd', () => {
  const rejectDir = (bin) => (bin === '/opt/dir/claude' ? null : '/usr/bin/' + bin);
  assert.strictEqual(
    missingToolOnExit({ expected: false, exitCode: 1, signal: null, elapsedMs: 100, cmd: '/opt/dir/claude', whichBin: rejectDir }),
    '/opt/dir/claude',
  );
});

test('a directory named claude on PATH is not an installed CLI', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createEngine } = require('../engine');
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const tmp = mkTmpRoot('clx-diag-dir-');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(binDir, 'claude'), { recursive: true });
  const origPath = process.env.PATH;
  try {
    process.env.PATH = binDir;
    assert.ok(fs.statSync(path.join(binDir, 'claude')).isDirectory());
    assert.strictEqual(eng.collectSystemDiagnostics().claude, null);
  } finally {
    process.env.PATH = origPath;
  }
});

test('whichBin: an explicit path to a directory is not a binary', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createEngine } = require('../engine');
  const { mkTmpRoot } = require('./lib/tmp-roots');
  const tmp = mkTmpRoot('clx-diag-dir-');
  const { whichBin } = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, 'claude');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(whichBin(binDir), null);
  assert.strictEqual(whichBin(exe), path.join(tmp, 'bin', 'claude'));
});

test.after(() => { setImmediate(() => process.exit(0)); });
