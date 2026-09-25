'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  SPLIT_SETTLE_MS, SPLIT_EXIT_MS, isRuleRow, findAnchor, measureSplit, initialSplitState, reduceSplit,
} = require('../renderer/lib/live-split');

const DIR = path.join(__dirname, 'fixtures', 'split-states');

const FIXTURES = [
  ['accept-edits-idle@100', 26, 'split', 25, 28],
  ['accept-edits-idle@200', 26, 'split', 25, 28],
  ['accept-edits-idle@60', 28, 'split', 26, 30],
  ['api-retry@100', 10, 'split', 9, 13],
  ['bypass-idle@100', 6, 'split', 5, 9],
  ['bypass-idle@200', 6, 'split', 5, 9],
  ['bypass-idle@60', 6, 'split', 5, 10],
  ['ctrl-o@100', 17, 'full', -1, -1],
  ['ctrl-o@200', 17, 'full', -1, -1],
  ['ctrl-o@60', 18, 'full', -1, -1],
  ['edit-diff@100', 28, 'full', -1, -1],
  ['edit-diff@200', 28, 'full', -1, -1],
  ['edit-diff@60', 29, 'full', -1, -1],
  ['help@100', 8, 'full', -1, -1],
  ['help@200', 8, 'full', -1, -1],
  ['help@60', 8, 'full', -1, -1],
  ['idle@100', 6, 'split', 5, 8],
  ['idle@200', 6, 'split', 5, 8],
  ['idle@60', 6, 'split', 5, 9],
  ['model@100', 15, 'full', -1, -1],
  ['model@200', 14, 'full', -1, -1],
  ['model@60', 16, 'full', -1, -1],
  ['permission@100', 24, 'full', -1, -1],
  ['permission@200', 24, 'full', -1, -1],
  ['permission@60', 26, 'full', -1, -1],
  ['plan-approve@100', 32, 'full', -1, -1],
  ['plan-approve@200', 33, 'full', -1, -1],
  ['plan-approve@60', 32, 'full', -1, -1],
  ['plan-idle@100', 26, 'split', 25, 28],
  ['plan-idle@200', 26, 'split', 25, 28],
  ['plan-idle@60', 28, 'split', 26, 30],
  ['slash-menu@100', 6, 'split', 5, 26],
  ['slash-menu@200', 6, 'split', 5, 27],
  ['slash-menu@60', 6, 'split', 5, 26],
  ['streaming@100', 16, 'split', 15, 18],
  ['streaming@200', 13, 'split', 12, 15],
  ['streaming@60', 21, 'split', 20, 24],
  ['thinking@100', 31, 'split', 30, 33],
  ['thinking@200', 31, 'split', 30, 33],
  ['thinking@60', 34, 'split', 33, 36],
  ['tool-running@100', 13, 'split', 12, 15],
  ['tool-running@200', 13, 'split', 12, 15],
  ['tool-running@60', 13, 'split', 12, 16],
  ['trust@100', 15, 'full', -1, -1],
  ['trust@200', 13, 'full', -1, -1],
  ['trust@60', 19, 'full', -1, -1],
];

function load(name) {
  const cols = Number(name.split('@')[1]);
  const rows = fs.readFileSync(path.join(DIR, `${name}.screen.txt`), 'utf8').split('\n').slice(0, 40);
  return { cols, rows };
}

test('ENTER: every captured screen in the fixture dir is a table row, and every table row loads a 40-row screen', () => {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.screen.txt')).map((f) => f.replace('.screen.txt', '')).sort();
  const inTable = FIXTURES.map((r) => r[0]).sort();
  assert.deepStrictEqual(onDisk, inTable);
  assert.strictEqual(FIXTURES.length, 46);
  for (const [name] of FIXTURES) {
    const { rows, cols } = load(name);
    assert.strictEqual(rows.length, 40, name);
    assert.ok([60, 100, 200].includes(cols), name);
  }
});

for (const [name, cursorY, mode, top, bottom] of FIXTURES) {
  test(`${name}: ${mode}${mode === 'split' ? ` rows ${top}..${bottom}` : ''}`, () => {
    const { rows, cols } = load(name);
    assert.deepStrictEqual(measureSplit(rows, cursorY, cols), { mode, top, bottom });
  });
}

test('a permission dialog and an Edit diff are FULL at every width', () => {
  const dialogs = FIXTURES.filter(([n]) => /^(permission|edit-diff)@/.test(n));
  assert.strictEqual(dialogs.length, 6);
  for (const [name, cursorY] of dialogs) {
    const { rows, cols } = load(name);
    assert.strictEqual(measureSplit(rows, cursorY, cols).mode, 'full', name);
  }
});

test('a rule one cell short of the width still anchors; two short does not', () => {
  assert.strictEqual(isRuleRow('─'.repeat(99), 100), true);
  assert.strictEqual(isRuleRow('─'.repeat(98), 100), false);
  assert.strictEqual(isRuleRow(`${'─'.repeat(50)} x`, 60), false);
});

test('the composer must sit directly under the rule: a blank row between them is no anchor', () => {
  const rule = '─'.repeat(60);
  assert.strictEqual(findAnchor([rule, '❯ '], 1, 60), 0);
  assert.strictEqual(findAnchor([rule, '', '❯ '], 2, 60), -1);
  assert.strictEqual(findAnchor([rule, ' Bash command', '', ' ❯ 1. Yes'], 3, 60), -1);
});

test('the scan prefers the anchor at or above the cursor, then looks below it', () => {
  const rule = '─'.repeat(60);
  const rows = [rule, '❯ old', 'x', rule, '❯ ', rule];
  assert.strictEqual(findAnchor(rows, 4, 60), 3);
  assert.strictEqual(findAnchor(rows, 2, 60), 0);
  assert.strictEqual(findAnchor(['text', 'x', rule, '❯ '], 0, 60), 2);
});

test('bottom is the last non-blank row but never above the cursor row', () => {
  const rule = '─'.repeat(60);
  const rows = [rule, '❯ ', rule, '  footer', '', '', ''];
  assert.deepStrictEqual(measureSplit(rows, 1, 60), { mode: 'split', top: 0, bottom: 3 });
  assert.deepStrictEqual(measureSplit(rows, 5, 60), { mode: 'split', top: 0, bottom: 5 });
});

const S = (top, bottom) => ({ mode: 'split', top, bottom });
const FULL = { mode: 'full', top: -1, bottom: -1 };

test('FULL -> split waits for the anchor to hold for the settle window, and reports when to look again', () => {
  assert.strictEqual(SPLIT_SETTLE_MS, 250);
  let st = reduceSplit(initialSplitState(), S(5, 9), 1000);
  assert.strictEqual(st.mode, 'full');
  assert.strictEqual(st.wakeAt, 1250);
  st = reduceSplit(st, S(5, 9), 1249);
  assert.strictEqual(st.mode, 'full');
  st = reduceSplit(st, S(5, 9), 1250);
  assert.deepStrictEqual([st.mode, st.top, st.bottom, st.wakeAt], ['split', 5, 9, null]);
});

test('an anchor lost mid-hold restarts the hold', () => {
  let st = reduceSplit(initialSplitState(), S(5, 9), 1000);
  st = reduceSplit(st, FULL, 1100);
  st = reduceSplit(st, S(5, 9), 1200);
  st = reduceSplit(st, S(5, 9), 1300);
  assert.strictEqual(st.mode, 'full');
  st = reduceSplit(st, S(5, 9), 1450);
  assert.strictEqual(st.mode, 'split');
});

test('split -> anchorless keeps the geometry and pends an exit that wakes 50 ms later', () => {
  assert.strictEqual(SPLIT_EXIT_MS, 50);
  const on = { mode: 'split', top: 5, bottom: 9, pending: null, wakeAt: null };
  const st = reduceSplit(on, FULL, 1000);
  assert.deepStrictEqual(st, { mode: 'split', top: 5, bottom: 9, pending: { kind: 'exit', since: 1000 }, wakeAt: 1050 });
  assert.deepStrictEqual(reduceSplit(on, null, 1000).pending, { kind: 'exit', since: 1000 });
});

test('split -> FULL once the frame has stayed anchorless for 50 ms', () => {
  const on = { mode: 'split', top: 5, bottom: 9, pending: null, wakeAt: null };
  let st = reduceSplit(on, FULL, 1000);
  st = reduceSplit(st, FULL, 1049);
  assert.deepStrictEqual([st.mode, st.top, st.bottom, st.wakeAt], ['split', 5, 9, 1050]);
  st = reduceSplit(st, FULL, 1050);
  assert.deepStrictEqual(st, initialSplitState());
});

test('a split measure during an exit pending cancels the exit and takes the new geometry', () => {
  const on = { mode: 'split', top: 5, bottom: 9, pending: null, wakeAt: null };
  let st = reduceSplit(on, FULL, 1000);
  st = reduceSplit(st, S(6, 11), 1020);
  assert.deepStrictEqual(st, { mode: 'split', top: 6, bottom: 11, pending: null, wakeAt: null });
});

test('full state plus an anchorless measure is the initial state with no pending', () => {
  assert.deepStrictEqual(reduceSplit(initialSplitState(), FULL, 1000), initialSplitState());
  const entering = reduceSplit(initialSplitState(), S(5, 9), 1000);
  assert.deepStrictEqual(reduceSplit(entering, FULL, 1100), initialSplitState());
});

test('grow applies at once; shrink holds the old height until the smaller one has held for the window', () => {
  const on = { mode: 'split', top: 5, bottom: 9, pending: null, wakeAt: null };
  const grown = reduceSplit(on, S(5, 26), 0);
  assert.deepStrictEqual([grown.top, grown.bottom], [5, 26]);
  let st = reduceSplit(grown, S(5, 9), 100);
  assert.deepStrictEqual([st.mode, st.top, st.bottom, st.wakeAt], ['split', 5, 26, 350]);
  st = reduceSplit(st, S(6, 10), 200);
  assert.deepStrictEqual([st.top, st.bottom], [6, 27]);
  st = reduceSplit(st, S(6, 10), 350);
  assert.deepStrictEqual([st.top, st.bottom, st.pending], [6, 10, null]);
});

test('a shrink to a different height restarts the shrink hold', () => {
  const on = { mode: 'split', top: 5, bottom: 26, pending: null, wakeAt: null };
  let st = reduceSplit(on, S(5, 9), 0);
  st = reduceSplit(st, S(5, 12), 200);
  st = reduceSplit(st, S(5, 12), 300);
  assert.strictEqual(st.bottom, 26);
  st = reduceSplit(st, S(5, 12), 450);
  assert.strictEqual(st.bottom, 12);
});
