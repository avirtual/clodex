'use strict';

// The terminal mark that says "this intent fired". A mark is BELIEVED, so the
// assertions that matter are the NEGATIVE ones: a row marked `fire` that the
// real scan drops, or an escaped example marked at all, is a worse outcome
// than no marking — it sends the reader looking for a turn that never came.
//
// Every case here is stated against intent-scanner's own grammar, which is the
// point of the module: these tests fail if the classification and the scan
// ever disagree.

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const { classifyRows, classifyText, logicalLines, SCAN_ROWS } = require('../renderer/lib/intent-marks');

const rows = (...texts) => texts.map((t) => (typeof t === 'string' ? { text: t, isWrapped: false } : t));
const wrapped = (text) => ({ text, isWrapped: true });

// --- classifyText: the three states -----------------------------------------

test('a bare intent will fire', () => {
  assert.strictEqual(classifyText('[agent:who]'), 'fire');
});

test('an intent with a body head will fire', () => {
  assert.strictEqual(classifyText('[agent:dm someone] hello there'), 'fire');
});

test('prose before the bracket is inert, not fire', () => {
  // The half that earns the feature: this does NOT fire today and nothing says so.
  assert.strictEqual(classifyText('as I said [agent:who]'), 'inert');
});

test('an unknown verb is inert', () => {
  assert.strictEqual(classifyText('[agent:notaverb]'), 'inert');
});

test('a malformed arg list is inert', () => {
  assert.strictEqual(classifyText('[agent:dm]'), 'inert');
});

test('an escaped intent is left unmarked', () => {
  // Deliberate quoting. Marking it defeats finding the one that fired among
  // the ones merely written about.
  assert.strictEqual(classifyText('\\[agent:who]'), null);
});

test('a line with no intent at all is left unmarked', () => {
  assert.strictEqual(classifyText('just some ordinary prose'), null);
  assert.strictEqual(classifyText(''), null);
});

test('an indented intent fires, because the scanner strips indentation', () => {
  assert.strictEqual(classifyText('    [agent:who]'), 'fire');
});

test('a bullet-decorated intent fires, because the scanner strips decorators', () => {
  assert.strictEqual(classifyText('• [agent:who]'), 'fire');
});

test('ANSI colour around the intent does not hide it', () => {
  assert.strictEqual(classifyText('\x1b[32m[agent:who]\x1b[39m'), 'fire');
});

test('an intent mid-prose after a real word is inert even with a valid verb', () => {
  assert.strictEqual(classifyText('see [agent:dm bob] for the syntax'), 'inert');
});

// --- logicalLines: wrapped rows ---------------------------------------------

test('a head absorbs its continuation rows into one logical line', () => {
  const out = logicalLines(rows('[agent:dm bob] start', wrapped(' of a long body'), 'next line'));
  assert.deepStrictEqual(out, [
    { start: 0, end: 1, text: '[agent:dm bob] start of a long body' },
    { start: 2, end: 2, text: 'next line' },
  ]);
});

test('an unwrapped row stands alone', () => {
  assert.deepStrictEqual(logicalLines(rows('alpha', 'beta')), [
    { start: 0, end: 0, text: 'alpha' },
    { start: 1, end: 1, text: 'beta' },
  ]);
});

test('a space at the wrap boundary survives the join', () => {
  // The caller must NOT right-trim a row that continues: a soft-wrapped row is
  // full to `cols`, so a space in its last cell is real content. Trimmed, the
  // join fuses the words and a FIRED intent reads as inert — the false "did
  // not fire" that invites a double emission.
  const out = logicalLines([{ text: '[agent:dm ', isWrapped: false }, wrapped('bob] hi')]);
  assert.deepStrictEqual(out, [{ start: 0, end: 1, text: '[agent:dm bob] hi' }]);
  assert.strictEqual(classifyText(out[0].text), 'fire');
});

test('an intent split across the wrap boundary is still fire, not inert', () => {
  const marks = classifyRows([{ text: '[agent:dm ', isWrapped: false }, wrapped('bob] a body')]);
  assert.deepStrictEqual(marks, [{ start: 0, end: 1, kind: 'fire' }]);
});

// --- classifyRows: anchoring, fences, reduction ------------------------------

test('a wrapped intent is marked once, anchored to its HEAD row', () => {
  const marks = classifyRows(rows('[agent:dm bob] a body that', wrapped(' spills over'), 'plain'));
  // ENTER: the wrapped intent is present at all, and as ONE mark on row 0 —
  // a per-row scan would mark row 1 too, or mark neither.
  assert.deepStrictEqual(marks, [{ start: 0, end: 1, kind: 'fire' }]);
});

test('an intent inside a fenced block is left unmarked', () => {
  const marks = classifyRows(rows('```', '[agent:who]', '```'));
  assert.deepStrictEqual(marks, []);
});

test('a real intent BELOW a closed fence is still marked', () => {
  // ENTER: guards the fence-state reduction — if the fence never closed, this
  // row would vanish and the empty-set assertion above would still pass.
  const marks = classifyRows(rows('```', '[agent:who]', '```', '[agent:name]'));
  assert.deepStrictEqual(marks, [{ start: 3, end: 3, kind: 'fire' }]);
});

test('a tilde fence quotes an intent too', () => {
  assert.deepStrictEqual(classifyRows(rows('~~~', '[agent:who]', '~~~')), []);
});

test('a DECORATED fence row still quotes what is inside it', () => {
  // The CLI prepends decorator glyphs to rendered rows, and fencedLines only
  // tolerates leading whitespace — so the fence must be cleaned before it is
  // detected. Undetected, this fence would leave the quoted intent marked as
  // firing, which is the believed-but-false mark the module exists to avoid.
  assert.deepStrictEqual(classifyRows(rows('• ```', '[agent:who]', '• ```')), []);
});

test('fire and inert are distinguished in one pass', () => {
  const marks = classifyRows(rows(
    '[agent:who]',
    'prose then [agent:who]',
    'nothing here',
    '[agent:bogusverb]',
  ));
  assert.deepStrictEqual(marks, [
    { start: 0, end: 0, kind: 'fire' },
    { start: 1, end: 1, kind: 'inert' },
    { start: 3, end: 3, kind: 'inert' },
  ]);
});

test('an empty buffer yields no marks', () => {
  assert.deepStrictEqual(classifyRows([]), []);
});

test('SCAN_ROWS still exceeds the terminal scrollback it is sized against', () => {
  // The bounded window truncates fence state at its top, which is harmless
  // only while the window covers the whole buffer. renderer.js builds its
  // Terminal without a `scrollback` option, so xterm's default 1000 applies.
  // A future bump past SCAN_ROWS silently creates the mid-fence-window case,
  // and this fails when it does instead of leaving a stale comment behind.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const configured = src.match(/scrollback:\s*(\d+)/);
  const scrollback = configured ? Number(configured[1]) : 1000;
  assert.ok(
    SCAN_ROWS > scrollback,
    `SCAN_ROWS (${SCAN_ROWS}) must exceed the terminal scrollback (${scrollback}); ` +
    'below it the scan window can open inside a fence and read it as closed.',
  );
});

test('escaped and fenced rows survive as unmarked among marked ones', () => {
  // ENTER: the fire row is present, so the two absences below it are absences
  // in a set that was actually scanned, not in one the reduction emptied.
  const marks = classifyRows(rows('\\[agent:who]', '[agent:who]', '```', '[agent:name]', '```'));
  assert.deepStrictEqual(marks, [{ start: 1, end: 1, kind: 'fire' }]);
});
