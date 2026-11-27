'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { ledgerFiles, ledgerPicks, LEDGER_FILES_MAX, LEDGER_PATH_MAX } = require('../suite-client');

const LONG = `${'d'.repeat(50)}/`.repeat(6) + 'x.test.js';
const LONG_CUT = `${'d'.repeat(50)}/`.repeat(5) + 'd'.repeat(45);

test('t2459: the ledger bounds are the clodex-run-tests named limits', () => {
  assert.deepStrictEqual([LEDGER_FILES_MAX, LEDGER_PATH_MAX], [20, 300]);
});

test('t2459: a named list within the limits is kept as given, in order, with no flag', () => {
  assert.deepStrictEqual(ledgerFiles(['test/b.test.js', 'test/a.test.js']), { files: ['test/b.test.js', 'test/a.test.js'] });
});

test('t2459: a path over 300 bytes is cut to 300 and the row says filesCut', () => {
  assert.strictEqual(LONG.length, 309, 'ENTER: the path is over the limit');
  assert.deepStrictEqual(ledgerFiles(['test/a.test.js', LONG]), { files: ['test/a.test.js', LONG_CUT], filesCut: true });
});

test('t2459: a list over 20 keeps the first 20 and says filesCut', () => {
  const list = Array.from({ length: 22 }, (_, i) => `test/f${i}.test.js`);
  const got = ledgerFiles(list);
  assert.deepStrictEqual(got, { files: list.slice(0, 20), filesCut: true });
  assert.strictEqual(got.files[19], 'test/f19.test.js');
});

test('t2459: a path cut by its JSON bytes counts escapes, so quotes and control characters cannot grow the row', () => {
  const got = ledgerFiles(['\u0001'.repeat(60)]);
  assert.deepStrictEqual(got, { files: ['\u0001'.repeat(50)], filesCut: true });
});

test('t2459: the worst-case growth of a start row is 6086 bytes', () => {
  const grow = (list) => Buffer.byteLength(JSON.stringify({ a: 1, ...ledgerFiles(list) })) - Buffer.byteLength(JSON.stringify({ a: 1 }));
  assert.strictEqual(grow(Array.from({ length: 25 }, () => 'p'.repeat(400))), 6086);
  for (const ch of ['"', '\\', '\u0001', 'é', '\u{1F600}']) {
    const g = grow(Array.from({ length: 25 }, () => ch.repeat(400)));
    assert.ok(g <= 6086, `${JSON.stringify(ch)}: ${g}`);
  }
});

test('t2459: ledgerPicks carries a named start row\'s files onto the job, its later end row included, and a run without files has none', () => {
  const file = path.join(mkTmpRoot('clodex-ledger-files-'), 'suite-runs.jsonl');
  const P = { chosen: 'a', considered: [{ member: 'a', state: 'chosen' }] };
  fs.writeFileSync(file, [
    { id: 'n1', phase: 'start', where: 'a', team: 't', kind: 'hand', queuedAt: 'q', startedAt: 's', named: 2, files: ['test/b.test.js', 'test/a.test.js'] },
    { id: 'n2', phase: 'start', where: 'a', team: 't', kind: 'hand', queuedAt: 'q2', startedAt: 's2', named: 21, files: [LONG_CUT], filesCut: true, pick: P },
    { id: 'f1', phase: 'start', where: 'a', team: 't', kind: 'hand', queuedAt: 'q3', startedAt: 's3' },
    { id: 'n1', phase: 'end', where: 'a', team: 't', kind: 'hand', queuedAt: 'q', endedAt: 'e', outcome: 'pass', named: 2 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepStrictEqual(ledgerPicks(file), [
    { id: 'n2', phase: 'start', team: 't', ticket: undefined, seat: undefined, kind: 'hand', where: 'a', queuedAt: 'q2', startedAt: 's2', pick: P, files: [LONG_CUT], filesCut: true },
    { id: 'n1', phase: 'end', team: 't', ticket: undefined, seat: undefined, kind: 'hand', where: 'a', queuedAt: 'q', endedAt: 'e', outcome: 'pass', files: ['test/b.test.js', 'test/a.test.js'] },
  ]);
});
