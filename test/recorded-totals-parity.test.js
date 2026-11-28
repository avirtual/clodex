'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { recordedTotals: clientTotals } = require('../suite-client');
const { recordedTotals: scriptTotals } = require('../scripts/clodex-run-tests.js');

const ROWS = [
  ['green', { outcome: 'pass', pass: 12, fail: 0, tests: 12 }, { outcome: 'pass', pass: 12, fail: 0, tests: 12 }],
  ['red', { outcome: 'fail', pass: 10, fail: 2, tests: 12 }, { outcome: 'fail', pass: 10, fail: 2, tests: 12 }],
  ['pass with failing tests', { outcome: 'pass', pass: 3, fail: 1, tests: 4 }, { outcome: 'pass', pass: 3, fail: 1, tests: 4 }],
  ['missing counts', { outcome: 'pass' }, null],
  ['missing tests count', { outcome: 'fail', pass: 1, fail: 1 }, null],
  ['non-integer count', { outcome: 'pass', pass: 1.5, fail: 0, tests: 2 }, null],
  ['string count', { outcome: 'pass', pass: '2', fail: 0, tests: 2 }, null],
  ['negative count', { outcome: 'fail', pass: -1, fail: 2, tests: 1 }, null],
  ['pass plus fail over tests', { outcome: 'fail', pass: 2, fail: 2, tests: 3 }, null],
  ['unknown outcome', { outcome: 'error', pass: 1, fail: 0, tests: 1 }, null],
  ['extra fields dropped', { outcome: 'pass', pass: 1, fail: 0, tests: 1, at: 5 }, { outcome: 'pass', pass: 1, fail: 0, tests: 1 }],
  ['null', null, null],
  ['undefined', undefined, null],
  ['a string', 'pass', null],
];

test('recordedTotals: the client and the digest script read every record the same way', () => {
  assert.ok(ROWS.some(([, , want]) => want !== null), 'ENTER: the table holds rows that yield totals');
  for (const [name, rec, want] of ROWS) {
    assert.deepStrictEqual(clientTotals(rec), want, `client: ${name}`);
    assert.deepStrictEqual(scriptTotals(rec), want, `script: ${name}`);
  }
});
