'use strict';
// errors.test.js — the exit-code contract mapping.
const { test } = require('node:test');
const assert = require('node:assert');
const { EXIT, exitForStatus, CliError } = require('../src/errors');

test('status → exit code mapping', () => {
  assert.strictEqual(exitForStatus(401), EXIT.AUTH);
  assert.strictEqual(exitForStatus(403), EXIT.AUTH);
  assert.strictEqual(exitForStatus(404), EXIT.NOTFOUND);
  assert.strictEqual(exitForStatus(400), EXIT.USAGE);
  assert.strictEqual(exitForStatus(413), EXIT.USAGE);
  assert.strictEqual(exitForStatus(500), EXIT.SERVER);
  assert.strictEqual(exitForStatus(502), EXIT.SERVER);
});

test('CliError carries its exit code', () => {
  const e = new CliError(EXIT.CONNECT, 'nope');
  assert.strictEqual(e.exitCode, EXIT.CONNECT);
  assert.strictEqual(e.message, 'nope');
  assert.ok(e instanceof Error);
});

test('the code set is stable and distinct', () => {
  const vals = Object.values(EXIT);
  assert.deepStrictEqual(vals, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(new Set(vals).size, vals.length);
});
