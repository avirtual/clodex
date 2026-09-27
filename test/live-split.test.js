'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  SPLIT_SETTLE_MS, SPLIT_EXIT_MS, isRuleRow, findAnchor, measureSplit, sheetBand, initialSplitState, reduceSplit,
} = require('../renderer/lib/live-split');

const DIR = path.join(__dirname, 'fixtures', 'split-states');

const FIXTURES = [
  ['accept-edits-idle@100', 26, 'split', 25, 28, 'claude', 25],
  ['accept-edits-idle@200', 26, 'split', 25, 28, 'claude', 25],
  ['accept-edits-idle@60', 28, 'split', 26, 30, 'claude', 26],
  ['api-retry@100', 10, 'split', 9, 13, 'claude', 9],
  ['bypass-idle@100', 6, 'split', 5, 9, 'claude', 5],
  ['bypass-idle@200', 6, 'split', 5, 9, 'claude', 5],
  ['bypass-idle@60', 6, 'split', 5, 10, 'claude', 5],
  ['ctrl-o@100', 17, 'full', -1, -1],
  ['ctrl-o@200', 17, 'full', -1, -1],
  ['ctrl-o@60', 18, 'full', -1, -1],
  ['edit-diff@100', 28, 'full', -1, -1],
  ['edit-diff@200', 28, 'full', -1, -1],
  ['edit-diff@60', 29, 'full', -1, -1],
  ['help@100', 8, 'full', -1, -1],
  ['help@200', 8, 'full', -1, -1],
  ['help@60', 8, 'full', -1, -1],
  ['idle@100', 6, 'split', 5, 8, 'claude', 5],
  ['idle@200', 6, 'split', 5, 8, 'claude', 5],
  ['idle@60', 6, 'split', 5, 9, 'claude', 5],
  ['model@100', 15, 'full', -1, -1],
  ['model@200', 14, 'full', -1, -1],
  ['model@60', 16, 'full', -1, -1],
  ['permission@100', 24, 'full', -1, -1],
  ['permission@200', 24, 'full', -1, -1],
  ['permission@60', 26, 'full', -1, -1],
  ['plan-approve@100', 32, 'full', -1, -1],
  ['plan-approve@200', 33, 'full', -1, -1],
  ['plan-approve@60', 32, 'full', -1, -1],
  ['plan-idle@100', 26, 'split', 25, 28, 'claude', 25],
  ['plan-idle@200', 26, 'split', 25, 28, 'claude', 25],
  ['plan-idle@60', 28, 'split', 26, 30, 'claude', 26],
  ['slash-menu@100', 6, 'split', 5, 26, 'claude', 5],
  ['slash-menu@200', 6, 'split', 5, 27, 'claude', 5],
  ['slash-menu@60', 6, 'split', 5, 26, 'claude', 5],
  ['streaming@100', 16, 'split', 15, 18, 'claude', 15],
  ['streaming@200', 13, 'split', 12, 15, 'claude', 12],
  ['streaming@60', 21, 'split', 20, 24, 'claude', 20],
  ['thinking@100', 31, 'split', 30, 33, 'claude', 30],
  ['thinking@200', 31, 'split', 30, 33, 'claude', 30],
  ['thinking@60', 34, 'split', 33, 36, 'claude', 33],
  ['tool-running@100', 13, 'split', 12, 15, 'claude', 12],
  ['tool-running@200', 13, 'split', 12, 15, 'claude', 12],
  ['tool-running@60', 13, 'split', 12, 16, 'claude', 12],
  ['trust@100', 15, 'full', -1, -1],
  ['trust@200', 13, 'full', -1, -1],
  ['trust@60', 19, 'full', -1, -1],
  ['muse-idle@100', 7, 'split', 6, 9, 'muse', 6],
  ['muse-draft@100', 7, 'split', 6, 9, 'muse', 6],
  ['muse-slash-menu@100', 7, 'split', 6, 17, 'muse', 6],
  ['muse-typed-status@100', 7, 'split', 6, 10, 'muse', 6],
  ['muse-after-status@100', 27, 'split', 26, 29, 'muse', 26],
  ['muse-model-picker@100', 28, 'full', -1, -1, 'muse'],
  ['muse-after-picker-esc@100', 19, 'split', 18, 21, 'muse', 18],
  ['codex-idle@100', 26, 'split', 26, 29, 'codex', 26],
  ['codex-draft@100', 26, 'split', 26, 29, 'codex', 26],
  ['codex-slash-menu@100', 26, 'split', 17, 28, 'codex', 26],
  ['codex-typed-status@100', 26, 'split', 23, 28, 'codex', 26],
  ['codex-after-status@100', 26, 'split', 26, 29, 'codex', 26],
  ['codex-model-picker@100', 29, 'full', -1, -1, 'codex'],
  ['codex-after-picker-esc@100', 26, 'split', 26, 29, 'codex', 26],
  ['codex-upgrade-prompt@100', 9, 'full', -1, -1, 'codex'],
  ['codex-picker-with-history@100', 12, 'full', -1, -1, 'codex'],
  ['codex-idle-with-history@100', 36, 'split', 36, 39, 'codex', 36],
  ['codex-boot@100', 26, 'split', 26, 29, 'codex', 26],
  ['codex-wrapped-draft@100', 26, 'split', 24, 29, 'codex', 24],
];

const SCREEN_ROWS = { claude: 40, muse: 30, codex: 30 };
const screenRows = (name, platform) => (/-with-history@/u.test(name) ? 40 : SCREEN_ROWS[platform]);

function load(name, platform = 'claude') {
  const cols = Number(name.split('@')[1]);
  const rows = fs.readFileSync(path.join(DIR, `${name}.screen.txt`), 'utf8').split('\n').slice(0, screenRows(name, platform));
  return { cols, rows };
}

test('ENTER: every captured screen in the fixture dir is a table row, and every table row loads a full screen', () => {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.screen.txt')).map((f) => f.replace('.screen.txt', '')).sort();
  const inTable = FIXTURES.map((r) => r[0]).sort();
  assert.deepStrictEqual(onDisk, inTable);
  assert.strictEqual(FIXTURES.length, 65);
  for (const [name, , , , , platform = 'claude'] of FIXTURES) {
    const { rows, cols } = load(name, platform);
    assert.strictEqual(rows.length, screenRows(name, platform), name);
    assert.ok([60, 100, 200].includes(cols), name);
  }
});

for (const [name, cursorY, mode, top, bottom, platform, at] of FIXTURES) {
  test(`${name}: ${mode}${mode === 'split' ? ` rows ${top}..${bottom}` : ''}`, () => {
    const { rows, cols } = load(name, platform);
    const args = platform ? [rows, cursorY, cols, platform] : [rows, cursorY, cols];
    assert.deepStrictEqual(measureSplit(...args), mode === 'split' ? { mode, top, bottom, at } : { mode, top, bottom, busy: true });
  });
}

test('an unanchored screen is busy when any row carries text and not busy when every row is blank', () => {
  assert.deepStrictEqual(measureSplit(['', '  Select model', '', '❯ 1. Opus'], 3, 20), { mode: 'full', top: -1, bottom: -1, busy: true });
  assert.deepStrictEqual(measureSplit(['', '   ', '', ''], 0, 20), { mode: 'full', top: -1, bottom: -1, busy: false });
});

test('a Muse or Codex screen measured as Claude has no anchor, and an unknown platform never splits', () => {
  for (const [name, cursorY] of [['muse-idle@100', 7], ['codex-idle@100', 26]]) {
    const { rows, cols } = load(name, 'muse');
    assert.strictEqual(measureSplit(rows, cursorY, cols).mode, 'full', name);
  }
  const { rows } = load('idle@100');
  assert.strictEqual(measureSplit(rows, 6, 100, 'gemini').mode, 'full');
});

test('a Codex composer row with a menu block directly above it and no blank row still takes the block top', () => {
  const rows = ['', '  /model  pick', '› /m', '', '  Context 0% used'];
  assert.deepStrictEqual(measureSplit(rows, 2, 40, 'codex'), { mode: 'split', top: 1, bottom: 4, at: 2 });
  const twoBlanks = ['  /model  pick', '', '', '› /m', '  Context 0% used'];
  assert.deepStrictEqual(measureSplit(twoBlanks, 3, 40, 'codex'), { mode: 'split', top: 3, bottom: 4, at: 3 });
});

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
  assert.deepStrictEqual(measureSplit(rows, 1, 60), { mode: 'split', top: 0, bottom: 3, at: 0 });
  assert.deepStrictEqual(measureSplit(rows, 5, 60), { mode: 'split', top: 0, bottom: 5, at: 0 });
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

const MENU_DIR = path.join(__dirname, 'fixtures', 'menu-states');
const MENU_SPLITS = [
  ['claude-arrow-down-2@100', 6, 'split'],
  ['claude-arrow-down@100', 6, 'split'],
  ['claude-arrow-up@100', 6, 'split'],
  ['claude-backspace@100', 6, 'split'],
  ['claude-idle-slash@100', 6, 'split'],
  ['claude-one-char@100', 6, 'split'],
  ['claude-paste@100', 6, 'split'],
  ['claude-three-chars@100', 6, 'split'],
  ['codex-arrow-down-2@100', 36, 'split'],
  ['codex-arrow-down@100', 36, 'split'],
  ['codex-arrow-up@100', 36, 'split'],
  ['codex-backspace@100', 36, 'split'],
  ['codex-co@100', 36, 'split'],
  ['codex-idle-slash@100', 36, 'split'],
  ['codex-paste@100', 36, 'split'],
  ['muse-arrow-down-2@100', 7, 'split'],
  ['muse-arrow-down@100', 7, 'split'],
  ['muse-arrow-up@100', 7, 'split'],
  ['muse-backspace@100', 7, 'split'],
  ['muse-co@100', 7, 'split'],
  ['muse-idle-slash@100', 7, 'split'],
  ['muse-paste@100', 7, 'split'],
  ['muse-tab@100', 7, 'split'],
];

for (const [name, cursorY, mode] of MENU_SPLITS) {
  test(`measureSplit keeps the composer up over the open menu in ${name}`, () => {
    const rows = fs.readFileSync(path.join(MENU_DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
    assert.strictEqual(measureSplit(rows, cursorY, 100, name.split('-')[0]).mode, mode);
  });
}

test('every menu fixture readMenuRows reads as a menu is in the split table', () => {
  const { readMenuRows } = require('../renderer/lib/menu-rows');
  const menus = fs.readdirSync(MENU_DIR).filter((f) => f.endsWith('.screen.txt')).map((f) => f.replace('.screen.txt', '')).filter((name) => {
    const rows = fs.readFileSync(path.join(MENU_DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
    const cells = JSON.parse(fs.readFileSync(path.join(MENU_DIR, `${name}.cells.json`), 'utf8'));
    return readMenuRows(rows, cells, name.split('-')[0]) !== null;
  }).sort();
  assert.deepStrictEqual(MENU_SPLITS.map((r) => r[0]).sort(), menus);
});

const paint = (n, from, to) => Array.from({ length: n }, (_, i) => (i >= from && i <= to ? `row ${i}` : ''));

for (const [name, rows, cap, band] of [
  ['a top-anchored screen', paint(40, 0, 5), 20, { top: 0, bottom: 5 }],
  ['a bottom-anchored screen', paint(40, 30, 39), 20, { top: 30, bottom: 39 }],
  ['a band longer than the cap keeps its last rows', paint(40, 2, 37), 20, { top: 18, bottom: 37 }],
  ['a blank screen', paint(40, 1, 0), 20, null],
  ['a single painted row', paint(40, 12, 12), 20, { top: 12, bottom: 12 }],
]) {
  test(`sheetBand: ${name}`, () => {
    assert.deepStrictEqual(sheetBand(rows, cap), band);
  });
}

test('a Codex picker opened over a history prompt row is full and busy, and its sheet band is the picker', () => {
  const { rows, cols } = load('codex-picker-with-history@100', 'codex');
  assert.deepStrictEqual(measureSplit(rows, 12, cols, 'codex'), { mode: 'full', top: -1, bottom: -1, busy: true });
  assert.deepStrictEqual(sheetBand(rows, 20), { top: 20, bottom: 39 });
});

const MUSE_RULE = `── Voice input ${'─'.repeat(85)}`;
for (const [name, rows, want] of [
  ['a strip with only the status row below the bottom rule', ['text', MUSE_RULE, '❯ ', '─'.repeat(100), '  muse-spark · max'], 1],
  ['a strip with a picker below the bottom rule', [MUSE_RULE, '❯ ', '─'.repeat(100), '  Choose model', '', '⟩ muse-spark', '  muse-spark-1.2', '  ↑↓ move · enter confirm'], -1],
]) {
  test(`findAnchor on Muse: ${name}`, () => {
    assert.strictEqual(findAnchor(rows, rows.length - 1, 100, 'muse'), want);
  });
}

for (const [name, rows, want] of [
  ['a composer with its Context footer two rows down', ['› Ask Codex', '', '  Context 0% used · GPT', '  ? for shortcuts'], 0],
  ['a history prompt row followed by six rows of reply', ['› reply pong', '', '• pong', '', '  done', '', '  more', '  Context 0% used'], -1],
  ['a composer whose footer sits five rows down', ['› the quick', '  brown fox', '  jumps over', '  the dog', '', '  Context 0% used'], 0],
  ['a history prompt row whose window reaches the composer footer below', ['› reply pong', '• pong', '', '› Ask Codex', '', '  Context 0% used'], 3],
  ['a picker row with the footer beneath it', ['› 1. GPT-6-Astra (current)', '  Context 0% used'], -1],
]) {
  test(`findAnchor on Codex: ${name}`, () => {
    assert.strictEqual(findAnchor(rows, 0, 100, 'codex'), want);
  });
}

test('the Codex upgrade prompt paints at the top: full and busy, and its sheet band starts at row 0', () => {
  const { rows, cols } = load('codex-upgrade-prompt@100', 'codex');
  assert.deepStrictEqual(measureSplit(rows, 9, cols, 'codex'), { mode: 'full', top: -1, bottom: -1, busy: true });
  assert.deepStrictEqual(sheetBand(rows, Math.floor(rows.length / 2)), { top: 0, bottom: 13 });
});
