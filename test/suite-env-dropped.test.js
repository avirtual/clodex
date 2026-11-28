'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const client = require('../suite-client');
const script = require('../scripts/run-tests.js');

const { localPhaseDropped, envDroppedLine, envDroppedRow } = client;

const CLODEX_21 = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`CLODEX_K${i}`, 'x']));
const CLODEX_20_NAMES = Array.from({ length: 20 }, (_, i) => ({ name: `CLODEX_K${i}`, why: 'reserved' }));

const DROPPED_ROWS = [
  ['nothing refused', { env: { A: '1' }, handEnv: { B: '2' } }, 'hand', null],
  ['no runner', null, 'hand', null],
  ['reserved, bad value and bad name, in phaseEnv order', { env: { PATH: '/x', A: '1', lower: 'v' }, handEnv: { N: 5, CLODEX_SUITE_KIND: 'k' } }, 'hand',
    { dropped: [{ name: 'PATH', why: 'reserved' }, { name: 'lower', why: 'bad name' }, { name: 'N', why: 'bad value' }, { name: 'CLODEX_SUITE_KIND', why: 'reserved' }] }],
  ['another phase map is not read', { env: { A: '1' }, verifyEnv: { HOME: '/h' } }, 'hand', null],
  ['the verify map is read for verify', { env: { A: '1' }, verifyEnv: { HOME: '/h' } }, 'verify', { dropped: [{ name: 'HOME', why: 'reserved' }] }],
  ['21 names keep the first 20 and say cut', { env: CLODEX_21 }, 'hand', { dropped: CLODEX_20_NAMES, cut: true }],
  ['a 70-byte name is cut to 64 bytes', { env: { [`CLODEX_${'A'.repeat(63)}`]: 'x' } }, 'hand', { dropped: [{ name: `CLODEX_${'A'.repeat(57)}`, why: 'reserved' }], cut: true }],
  ['a 64-byte name is kept whole', { env: { [`CLODEX_${'A'.repeat(57)}`]: 'x' } }, 'hand', { dropped: [{ name: `CLODEX_${'A'.repeat(57)}`, why: 'reserved' }] }],
];

for (const [name, tr, kind, want] of DROPPED_ROWS) {
  test(`t2462: localPhaseDropped: ${name}`, () => {
    assert.deepStrictEqual(localPhaseDropped(tr, kind), want);
  });
}

test('t2462: the dropped line and row, and nothing for nothing dropped', () => {
  const d = { dropped: [{ name: 'PATH', why: 'reserved' }, { name: 'LD_PRELOAD', why: 'bad value' }] };
  assert.strictEqual(envDroppedLine(d), 'team env not applied here: PATH (reserved), LD_PRELOAD (bad value)');
  assert.strictEqual(envDroppedLine({ ...d, cut: true }), 'team env not applied here: PATH (reserved), LD_PRELOAD (bad value), …');
  assert.deepStrictEqual(envDroppedRow({ ...d, cut: true }), { envDropped: d.dropped, envDroppedCut: true });
  assert.deepStrictEqual(envDroppedRow(d), { envDropped: d.dropped });
  assert.strictEqual(envDroppedLine(null), null);
  assert.deepStrictEqual(envDroppedRow(null), {});
});

test('t2462: the runner script reads back the row the client builds, and refuses a malformed one', () => {
  const row = { envDropped: [{ name: 'PATH', why: 'reserved' }], envDroppedCut: true };
  assert.deepStrictEqual(script.ledgerEnvDropped(JSON.stringify(row)), row);
  assert.deepStrictEqual(script.ledgerEnvDropped(undefined), {});
  assert.deepStrictEqual(script.ledgerEnvDropped('not json'), {});
  assert.deepStrictEqual(script.ledgerEnvDropped('{"envDropped":[]}'), {});
  assert.deepStrictEqual(script.ledgerEnvDropped(JSON.stringify({ envDropped: [{ name: 'A'.repeat(65), why: 'reserved' }] })), {});
  assert.deepStrictEqual(script.ledgerEnvDropped(JSON.stringify({ envDropped: CLODEX_20_NAMES.concat([{ name: 'X', why: 'reserved' }]) })), {});
  assert.deepStrictEqual(script.ledgerEnvDropped(JSON.stringify({ envDropped: [{ name: 'A', why: 'reserved', value: 'secret' }] })), { envDropped: [{ name: 'A', why: 'reserved' }] });
});

const TWENTY = Array.from({ length: 20 }, (_, i) => `test/f${i}.test.js`);

const PARITY = [
  ['under both bounds', ['test/b.test.js', 'test/a.test.js'], { files: ['test/b.test.js', 'test/a.test.js'] }],
  ['exactly 20 paths', TWENTY, { files: TWENTY }],
  ['21 paths', [...TWENTY, 'test/extra.test.js'], { files: TWENTY, filesCut: true }],
  ['a path of exactly 300 bytes', ['a'.repeat(300)], { files: ['a'.repeat(300)] }],
  ['a path of 301 bytes', ['a'.repeat(301)], { files: ['a'.repeat(300)], filesCut: true }],
  ['a two-byte character straddling 300', [`${'a'.repeat(299)}é`], { files: ['a'.repeat(299)], filesCut: true }],
  ['a quote measured escaped, landing on 300', [`${'a'.repeat(298)}"`], { files: [`${'a'.repeat(298)}"`] }],
  ['a backslash measured escaped, one over', [`${'a'.repeat(299)}\\`], { files: ['a'.repeat(299)], filesCut: true }],
];

for (const [name, list, want] of PARITY) {
  test(`t2462: ledgerFiles parity, suite-client and run-tests.js: ${name}`, () => {
    const a = client.ledgerFiles(list);
    const b = script.ledgerFiles(list);
    assert.deepStrictEqual(a, want);
    assert.deepStrictEqual(b, want);
    assert.deepStrictEqual(a, b);
  });
}

test('t2462: both ledgerFiles copies share their bounds', () => {
  assert.deepStrictEqual([client.LEDGER_FILES_MAX, client.LEDGER_PATH_MAX], [20, 300]);
  assert.deepStrictEqual([script.LEDGER_FILES_MAX, script.LEDGER_PATH_MAX], [20, 300]);
});
