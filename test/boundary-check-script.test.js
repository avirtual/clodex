// Pins the CLI edge of scripts/boundary-check.js, the decommenting lint hands
// are pointed at by the hand prompt. Run with no file it used to reach
// readFileSync(undefined) and print a stack trace, which reads as "the tool is
// broken" rather than "you forgot the argument".
//
// The script is SPAWNED rather than required: the usage path lives under
// `require.main === module`, which a require() never enters, so a test that
// called check() directly could not see this behaviour at all.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'boundary-check.js');

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });

test('no argument prints usage on stderr and exits 2', () => {
  const r = run([]);
  assert.strictEqual(r.status, 2, 'a usage error must be its own exit code, distinct from 0 (clean) and 1 (crash)');
  assert.strictEqual(r.stderr.trim(), 'usage: node scripts/boundary-check.js <file> [uptoLine]');
  assert.doesNotMatch(r.stderr, /at Object|ENOENT|TypeError/,
    'the stack trace is the failure being closed — a usage line printed beside one fixes nothing');
});

test('a real file still gets checked', () => {
  const r = run([SCRIPT]);
  assert.strictEqual(r.status, 0,
    'ENTER: the argument path is untouched, so the exit 2 above is the missing-file case and not a script that never runs');
  assert.match(r.stdout, /clean|flag\(s\)/);
});
