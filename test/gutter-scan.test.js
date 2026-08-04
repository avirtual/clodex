'use strict';
// The CLI's line-number gutter (renderer/lib/gutter-scan.js). Pure string in,
// offsets out — the buffer walking that feeds it is DOM-bound and lives in the
// link provider.
const { test } = require('node:test');
const assert = require('node:assert');

const { matchGutterRow, findGutterFile } = require('../renderer/lib/gutter-scan');

test('matches an added row and reports the number offsets', () => {
  assert.deepStrictEqual(matchGutterRow('   26 +  **The file peek** can be dragged'),
    { start: 3, end: 5, line: 26 });
});

test('matches a context row (no marker)', () => {
  assert.deepStrictEqual(matchGutterRow('   25    starts with one and still resolves'),
    { start: 3, end: 5, line: 25 });
});

// The number on a `-` row names a line in the file BEFORE the edit, so it can
// only land near the removed text. Matched deliberately — see the module header.
test('matches a removed row', () => {
  assert.deepStrictEqual(matchGutterRow('   29 -  **The File view shows line numbers**'),
    { start: 3, end: 5, line: 29 });
});

// The failure this guards: a context row whose CONTENT begins with a dash (a
// markdown bullet) is not a removal, and the number is the same either way.
test('a context row whose content starts with a dash still matches at the number', () => {
  assert.deepStrictEqual(matchGutterRow('   29    - **The File view shows line numbers**'),
    { start: 3, end: 5, line: 29 });
});

test('a number with no leading whitespace matches at offset 0', () => {
  assert.deepStrictEqual(matchGutterRow('7 +  x'), { start: 0, end: 1, line: 7 });
});

test('a number later in the line is prose, not a gutter', () => {
  assert.strictEqual(matchGutterRow('added 26 lines to the file'), null);
});

test('a bare number row with nothing after it still matches', () => {
  assert.deepStrictEqual(matchGutterRow('  42'), { start: 2, end: 4, line: 42 });
});

test('line 0 and non-numbers are refused', () => {
  assert.strictEqual(matchGutterRow('  0 +  x'), null);
  assert.strictEqual(matchGutterRow(''), null);
  assert.strictEqual(matchGutterRow('   +  x'), null);
  assert.strictEqual(matchGutterRow(null), null);
});

// ── the header search ──────────────────────────────────────────────────────

test('finds the header directly above a gutter block', () => {
  const above = [
    '   25    context line',
    '  ⎿  Added 3 lines',
    '● Update(CHANGELOG.md)',
  ];
  assert.deepStrictEqual(findGutterFile(above), { path: 'CHANGELOG.md', distance: 3 });
});

test('steps over glyph-only and summary rows', () => {
  const above = ['  ⎿', '   │', '  ⎿  Added 3 lines', '● Edit(renderer/lib/x.js)'];
  assert.deepStrictEqual(findGutterFile(above), { path: 'renderer/lib/x.js', distance: 4 });
});

test('the nearest header wins over an earlier one', () => {
  const above = [
    '   4 +  b',
    '● Update(second.js)',
    '   9 +  a',
    '● Update(first.js)',
  ];
  assert.deepStrictEqual(findGutterFile(above), { path: 'second.js', distance: 2 });
});

// THE false-positive case, and the reason contiguity exists rather than a line
// budget: both of these are real lines from this project's notes, and both match
// any number-then-marker pattern. Prose under a header must NOT link.
test('prose separated from a header by an unrelated row does not resolve', () => {
  const above = [
    'Post-suite orphan check was clean, so:',
    '● Update(journal.md)',
  ];
  assert.strictEqual(findGutterFile(above), null);
});

// Shipped broken: a gutter row whose CONTENT mentions `Update(file.js)` was read
// as a header, so every row below it linked to a file that was never edited —
// and the miss only appeared a few lines in, where the quotation happened to be.
// Any file discussing tool calls (this project's changelog) triggers it.
test('a tool call quoted INSIDE gutter content is not a header', () => {
  const above = [
    '     15 +  its gutter under `Update(file.js)`, clicking a number opens that',
    '     14 +  **The line numbers an edit prints are clickable too.**',
    '  ⎿  Added 5 lines',
    '● Update(CHANGELOG.md)',
  ];
  assert.deepStrictEqual(findGutterFile(above), { path: 'CHANGELOG.md', distance: 4 });
});

// The same hazard on a context row, which carries no +/- marker at all.
test('a tool call quoted in an unmarked context row is not a header', () => {
  const above = [
    '     15    see Update(other.js) for the pattern',
    '● Write(real.js)',
  ];
  assert.deepStrictEqual(findGutterFile(above), { path: 'real.js', distance: 2 });
});

test('a header far above an unbroken block is still found', () => {
  const above = [];
  for (let i = 0; i < 300; i += 1) above.push(`   ${i + 2} +  line ${i}`);
  above.push('● Write(big.js)');
  const r = findGutterFile(above);
  assert.deepStrictEqual(r, { path: 'big.js', distance: 301 });
});

test('no header anywhere above is not a link', () => {
  assert.strictEqual(findGutterFile(['   3 +  x', '   2 +  y']), null);
});

test('a non-tool paren expression is not a header', () => {
  assert.strictEqual(findGutterFile(['  ⎿  Added 1 line', 'Note(see below)']), null);
});

test('an empty header path is refused', () => {
  assert.strictEqual(findGutterFile(['● Update()']), null);
});

test('a shortened header path is returned as printed', () => {
  // Resolution (file-resolve.js) is what recovers a truncated path, not this.
  assert.deepStrictEqual(findGutterFile(['● Update(…/tasks/HANDOFF.md)']),
    { path: '…/tasks/HANDOFF.md', distance: 1 });
});

test('bad input is refused rather than thrown on', () => {
  assert.strictEqual(findGutterFile(null), null);
  assert.strictEqual(findGutterFile([]), null);
  assert.strictEqual(findGutterFile([42]), null);
});
