'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateSeatFiles, seatFileFileName, seatFileHead, safeFileStem, SEAT_FILE_FILE_PATTERN,
  SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES,
} = require('../seat-files');

const S = 1800000000000;
const FILE_RE = new RegExp(`^${SEAT_FILE_FILE_PATTERN}$`);

const NAMES = [
  ['a plain name is kept', 'report.pdf', 'file-1800000000000-1-report.pdf', 'File: report.pdf'],
  ['a posix traversal keeps only the basename', '../../etc/passwd', 'file-1800000000000-1-passwd', 'File: passwd'],
  ['a windows traversal keeps only the basename', '..\\..\\x.txt', 'file-1800000000000-1-x.txt', 'File: x.txt'],
  ['leading dots are stripped', '.env', 'file-1800000000000-1-env', 'File: env'],
  ['basename after / then space, colon and ? each map to _', 'a b/c:d?.txt', 'file-1800000000000-1-c_d_.txt', 'File: c_d_.txt'],
  ['a run of mapped chars collapses to one _', 'a  b??c.md', 'file-1800000000000-1-a_b_c.md', 'File: a_b_c.md'],
  ['a NUL maps to _', 'a\u0000b', 'file-1800000000000-1-a_b', 'File: a_b'],
  ['a dot-only name falls back to file', '..', 'file-1800000000000-1-file', 'File: file'],
  ['a 70-char stem is cut to 64', 'x'.repeat(70), `file-1800000000000-1-${'x'.repeat(64)}`, `File: ${'x'.repeat(64)}`],
  ['an empty name falls back to file', '', 'file-1800000000000-1-file', 'File: file'],
];

for (const [label, input, fileName, head] of NAMES) {
  test(`seatFileFileName: ${label}`, () => {
    const name = seatFileFileName(S, 1, input);
    assert.strictEqual(name, fileName);
    assert.ok(FILE_RE.test(name), `pattern matches ${name}`);
    assert.strictEqual(seatFileHead(name), head);
  });
}

test('safeFileStem never returns a path separator, a leading dot or more than 64 chars', () => {
  for (const n of ['/x/../y', '.ssh', 'x'.repeat(300), 'a/b\\c', '...hidden']) {
    const stem = safeFileStem(n);
    assert.match(stem, /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/, `${JSON.stringify(n)} → ${stem}`);
  }
});

test('seatFileHead is null for a non-file name', () => {
  for (const n of ['img-1-1.png', 'msg-1-1.txt', 'file-1-1-', 'file-1-1-../x', null, undefined]) assert.strictEqual(seatFileHead(n), null, String(n));
});

test('SEAT_FILE_FILE_PATTERN rejects an empty stem and a stem with a separator', () => {
  assert.ok(FILE_RE.test('file-1-1-report.pdf'), 'ENTER: the pattern matches a real name');
  assert.strictEqual(FILE_RE.test('file-1-1-'), false);
  assert.strictEqual(FILE_RE.test('file-1-1-../x'), false);
});

test('validateSeatFiles: absent is an empty list; a valid list keeps only { name, data }', () => {
  assert.deepStrictEqual(validateSeatFiles(undefined), { ok: true, files: [] });
  assert.deepStrictEqual(validateSeatFiles(null), { ok: true, files: [] });
  assert.deepStrictEqual(validateSeatFiles([{ name: 'a.bin', data: 'AAAA', mediaType: 'x/y', path: '/etc' }]),
    { ok: true, files: [{ name: 'a.bin', data: 'AAAA' }] });
});

test('validateSeatFiles accepts exactly SEAT_FILE_MAX_BYTES and any declared type', () => {
  assert.strictEqual(SEAT_FILE_MAX, 5);
  assert.strictEqual(SEAT_FILE_MAX_BYTES, 10 * 1024 * 1024);
  const exact = Buffer.alloc(SEAT_FILE_MAX_BYTES, 1).toString('base64');
  assert.strictEqual(validateSeatFiles([{ name: 'run.sh', data: exact }]).ok, true);
  const over = Buffer.alloc(SEAT_FILE_MAX_BYTES + 1, 1).toString('base64');
  assert.deepStrictEqual(validateSeatFiles([{ name: 'run.sh', data: over }]), { ok: false, error: 'file larger than 10 MB: run.sh' });
});

test('validateSeatFiles refusals', () => {
  const big = 'A'.repeat(Math.ceil((10 * 1024 * 1024 + 1) * 4 / 3) + 4);
  const one = { name: 'a.txt', data: 'aGk=' };
  for (const [files, error] of [
    ['x', 'files must be an array'],
    [{ name: 'a', data: 'AAAA' }, 'files must be an array'],
    [Array(6).fill(one), 'at most 5 files per message'],
    [[null], 'file must be { name, data }'],
    [[{ data: 'AAAA' }], 'file name must be a non-empty string of at most 255 characters'],
    [[{ name: '', data: 'AAAA' }], 'file name must be a non-empty string of at most 255 characters'],
    [[{ name: 'x'.repeat(256), data: 'AAAA' }], 'file name must be a non-empty string of at most 255 characters'],
    [[{ name: 'a.txt', data: 'not base64!' }], 'file data must be base64: a.txt'],
    [[{ name: 'a.txt' }], 'file data must be base64: a.txt'],
    [[{ name: 'a.txt', data: '' }], 'empty file: a.txt'],
    [[{ name: 'big.bin', data: big }], 'file larger than 10 MB: big.bin'],
  ]) assert.deepStrictEqual(validateSeatFiles(files), { ok: false, error });
  assert.strictEqual(validateSeatFiles(Array(5).fill(one)).ok, true, 'ENTER: five files pass');
});
