'use strict';
// load-smoke.test.js — every cli source must `require()` without throwing. A
// template-literal break (e.g. a stray backtick inside HELP) is a SyntaxError
// that crashes every verb at runtime but slips past unit tests that stub the
// broken module out. This guard requires each source in a child `node -c` and
// in-process, so such a break fails CI loudly.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const BIN = path.join(__dirname, '..', 'bin', 'clodexctl.js');

test('every src/*.js parses (node --check) and loads (require)', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC_DIR, f));
  files.push(BIN);
  for (const f of files) {
    // Syntax-check in a child so a template-literal break surfaces here.
    execFileSync(process.execPath, ['--check', f]);
  }
  // require() the modules in-process too (catches load-time throws --check misses).
  for (const f of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'))) {
    assert.doesNotThrow(() => require(path.join(SRC_DIR, f)), `require ${f}`);
  }
});

test('--help renders (contextual index is intact end-to-end)', async () => {
  const { run } = require('../src/main');
  let stdout = '';
  const code = await run(['--help'], { stdout: (s) => (stdout += s), stderr: () => {}, env: {} });
  assert.strictEqual(code, 0);
  assert.match(stdout, /clodexctl — a text client/);
  // The index is a grouped MAP of verbs now — per-verb flag detail moved into
  // `help <verb>` (covered by help.test.js). Pin the group headers + a verb line.
  assert.match(stdout, /PLUMBING/);
  assert.match(stdout, /\bexec\b/);
  assert.match(stdout, /clodexctl help <verb>/);
});
