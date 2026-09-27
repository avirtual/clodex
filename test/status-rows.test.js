'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readStatusRows } = require('../renderer/lib/status-rows');
const { findAnchor, measureSplit } = require('../renderer/lib/live-split');

const STATUS_DIR = path.join(__dirname, 'fixtures', 'status-states');
const SPLIT_DIR = path.join(__dirname, 'fixtures', 'split-states');

const load = (dir, name) => fs.readFileSync(path.join(dir, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');

const BYPASS_LINE = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const MANUAL_LINE = '  ⏸ manual mode on · ← for agents';
const CODEX_DEFAULT_LINE = '  Context 0% used · GPT-6-Astra · cwd · master · 5h 46% left · ~/.clode…  ⚠ 3 warnings · f2 to view';
const MUSE_OVERRIDES_LINE = '  muse-spark-1.3-contributor · max · ~/.c/p/w/t/t/probe/cwd · Launch overrides';

const TABLE_1 = [
  { name: 'claude-manual-idle@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: MANUAL_LINE,
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-accept-edits@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
    expected: { mode: { key: 'accept-edits', label: 'accept edits', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-plan@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: '  ⏸ plan mode on (shift+tab to cycle) · ← for agents',
    expected: { mode: { key: 'plan', label: 'plan mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-auto@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    expected: { mode: { key: 'auto', label: 'auto mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-bypass-effort@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: BYPASS_LINE,
    expected: { mode: { key: 'bypass', label: 'bypass permissions', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-bypass@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: BYPASS_LINE,
    expected: { mode: { key: 'bypass', label: 'bypass permissions', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-headless@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 8, startsWith: '  ⏸ manual mode on · ← for agents   ',
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-ctrl-y@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: MANUAL_LINE,
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-draft@100', n: 40, platform: 'claude', cursorY: 6, cols: 100, at: 5, statusIdx: 9, statusRow: '  ⏸ manual mode on',
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-shell@100', n: 40, platform: 'claude', cursorY: 16, cols: 100, at: 15, statusIdx: 19, statusRow: '  ⏵⏵ bypass permissions on · 1 shell · ← for agents',
    expected: { mode: { key: 'bypass', label: 'bypass permissions', cycles: true }, tasks: '1 shell', warnings: null } },
  { name: 'claude-accept-edits@60', n: 30, platform: 'claude', cursorY: 6, cols: 60, at: 5, statusIdx: 9, statusRow: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
    expected: { mode: { key: 'accept-edits', label: 'accept edits', cycles: true }, tasks: null, warnings: null } },
  { name: 'claude-thinking@100', n: 40, platform: 'claude', cursorY: 13, cols: 100, at: 12, statusIdx: 16, statusRow: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    expected: { mode: { key: 'auto', label: 'auto mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'codex-default@100', n: 40, platform: 'codex', cursorY: 13, cols: 100, at: 13, statusIdx: 15, statusRow: CODEX_DEFAULT_LINE,
    expected: { mode: { key: 'default', label: 'Default', cycles: true }, tasks: null, warnings: 3 } },
  { name: 'codex-plan@100', n: 40, platform: 'codex', cursorY: 13, cols: 100, at: 13, statusIdx: 15, statusRow: '  Context 0% used · GPT-6-Astra · cwd · master · 5h 46% lef… Plan mode    ⚠ 3 warnings · f2 to view',
    expected: { mode: { key: 'plan', label: 'Plan', cycles: true }, tasks: null, warnings: 3 } },
  { name: 'codex-working@100', n: 40, platform: 'codex', cursorY: 21, cols: 100, at: 21, statusIdx: 23, statusRow: CODEX_DEFAULT_LINE,
    expected: { mode: { key: 'default', label: 'Default', cycles: true }, tasks: null, warnings: 3 } },
  { name: 'codex-default@200', n: 40, platform: 'codex', cursorY: 13, cols: 200, at: 13, statusIdx: 15,
    startsWith: '  Context 0% used · GPT-6-Astra · cwd · master · 5h 20% left · ~/',
    endsWith: '/probe/cwd                                      ⚠ 3 warnings · f2 to view',
    expected: { mode: { key: 'default', label: 'Default', cycles: true }, tasks: null, warnings: 3 } },
  { name: 'codex-plan@200', n: 40, platform: 'codex', cursorY: 13, cols: 200, at: 13, statusIdx: 15,
    endsWith: '/probe/cwd    Plan mode (shift+tab to cycle)    ⚠ 3 warnings · f2 to view',
    expected: { mode: { key: 'plan', label: 'Plan', cycles: true }, tasks: null, warnings: 3 } },
  { name: 'muse-auto-review@100', n: 40, platform: 'muse', cursorY: 7, cols: 100, at: 6, statusIdx: 9, statusRow: '  muse-spark-1.3-contributor · max · ~/.c/p/w/t/t/probe/cwd · Auto-review',
    expected: { mode: { key: 'posture', label: 'Auto-review', cycles: false }, tasks: null, warnings: null } },
  { name: 'muse-launch-overrides@100', n: 40, platform: 'muse', cursorY: 8, cols: 100, at: 7, statusIdx: 10, statusRow: MUSE_OVERRIDES_LINE,
    expected: { mode: { key: 'posture', label: 'Launch overrides', cycles: false }, tasks: null, warnings: null } },
  { name: 'muse-thinking@100', n: 40, platform: 'muse', cursorY: 12, cols: 100, at: 11, statusIdx: 14, statusRow: MUSE_OVERRIDES_LINE,
    expected: { mode: { key: 'posture', label: 'Launch overrides', cycles: false }, tasks: null, warnings: null } },
];

function enterStatusRow(rows, row) {
  const got = rows[row.statusIdx].trimEnd();
  if (row.statusRow !== undefined) assert.strictEqual(got, row.statusRow);
  if (row.startsWith !== undefined) assert.ok(got.startsWith(row.startsWith), got);
  if (row.endsWith !== undefined) assert.ok(got.endsWith(row.endsWith), got);
}

function enterAnchor(rows, at, platform) {
  if (platform === 'codex') assert.strictEqual(rows[at], '› Ask Codex to do anything');
  else assert.match(rows[at], /^─/u);
}

for (const row of TABLE_1) {
  test(`${row.name}: ${row.platform} status row ${row.statusIdx} reads as ${JSON.stringify(row.expected)}`, () => {
    const rows = load(STATUS_DIR, row.name);
    assert.strictEqual(rows.length, row.n);
    enterAnchor(rows, row.at, row.platform);
    enterStatusRow(rows, row);
    assert.strictEqual(measureSplit(rows, row.cursorY, row.cols, row.platform).at, row.at);
    assert.deepStrictEqual(readStatusRows(rows, row.at, row.platform), row.expected);
  });
}

test('ENTER: every fresh status-state fixture on disk is a Table 1 row', () => {
  const onDisk = fs.readdirSync(STATUS_DIR).filter((f) => f.endsWith('.screen.txt')).map((f) => f.replace('.screen.txt', '')).sort();
  const inTable = [...TABLE_1.map((r) => r.name), 'codex-warnings-overlay@100'].sort();
  assert.deepStrictEqual(onDisk, inTable);
});

const TABLE_2 = [
  { name: 'idle@200', n: 40, platform: 'claude', at: 5, statusIdx: 8,
    startsWith: '  ⏸ manual mode on · ? for shortcuts · ← for agents   ', endsWith: '◐ medium · /effort',
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'plan-idle@60', n: 40, platform: 'claude', at: 26, statusIdx: 30, statusRow: '  ⏸ plan mode on (shift+tab to cycle)',
    expected: { mode: { key: 'plan', label: 'plan mode', cycles: true }, tasks: null, warnings: null } },
  { name: 'codex-idle@100', n: 30, platform: 'codex', at: 26, statusIdx: 28, statusRow: '  Context 0% used · GPT-6-Astra · cap-codex-ba5Yyo · master · 5h 82% left',
    extra: { statusIdx: 29, startsWith: '  ? for shortcuts', endsWith: '⚠ 1 warning · f2 to view' },
    expected: { mode: { key: 'default', label: 'Default', cycles: true }, tasks: null, warnings: 1 } },
  { name: 'muse-slash-menu@100', n: 30, platform: 'muse', at: 6, statusIdx: 17, statusRow: '  muse-spark-1.3-contributor · max · /p/v/f/m/r/T/cap-muse-LStQjU · Auto-review',
    expected: { mode: { key: 'posture', label: 'Auto-review', cycles: false }, tasks: null, warnings: null } },
];

for (const row of TABLE_2) {
  test(`${row.name} (split-states): ${row.platform} status row ${row.statusIdx} reads as ${JSON.stringify(row.expected)}`, () => {
    const rows = load(SPLIT_DIR, row.name);
    assert.strictEqual(rows.length, row.n);
    enterAnchor(rows, row.at, row.platform);
    enterStatusRow(rows, row);
    if (row.extra) enterStatusRow(rows, row.extra);
    assert.deepStrictEqual(readStatusRows(rows, row.at, row.platform), row.expected);
  });
}

test('slash-menu@100 (split-states): the menu replaces the status rows, so nothing reads', () => {
  const rows = load(SPLIT_DIR, 'slash-menu@100');
  assert.strictEqual(rows.length, 40);
  assert.match(rows[5], /^─/u);
  assert.match(rows[7], /^─{100}$/u);
  assert.strictEqual(rows[8], '  /add-dir                Add a new working directory');
  assert.strictEqual(readStatusRows(rows, 5, 'claude'), null);
});

test('the 5.9 s effort flash in the right-hand column does not change the read', () => {
  const effortRows = load(STATUS_DIR, 'claude-bypass-effort@100');
  const plainRows = load(STATUS_DIR, 'claude-bypass@100');
  assert.strictEqual(effortRows.length, 40);
  assert.strictEqual(plainRows.length, 40);
  assert.match(effortRows[5], /^─/u);
  assert.match(plainRows[5], /^─/u);
  assert.strictEqual(effortRows[8].includes('● high · /effort'), true);
  assert.strictEqual(plainRows[8].includes('● high · /effort'), false);
  assert.strictEqual(effortRows[9], plainRows[9]);
  const bypass = { mode: { key: 'bypass', label: 'bypass permissions', cycles: true }, tasks: null, warnings: null };
  assert.deepStrictEqual(readStatusRows(effortRows, 5, 'claude'), readStatusRows(plainRows, 5, 'claude'));
  assert.deepStrictEqual(readStatusRows(effortRows, 5, 'claude'), bypass);
  assert.deepStrictEqual(readStatusRows(plainRows, 5, 'claude'), bypass);
});

test('the Codex warnings overlay has no anchor and reads as unreadable', () => {
  const rows = load(STATUS_DIR, 'codex-warnings-overlay@100');
  assert.strictEqual(rows.length, 40);
  assert.strictEqual(rows[12].trimEnd(), '  Warnings · 1 of 3 · Startup');
  assert.strictEqual(findAnchor(rows, 23, 100, 'codex'), -1);
  assert.deepStrictEqual(measureSplit(rows, 23, 100, 'codex'), { mode: 'full', top: -1, bottom: -1, busy: true });
  assert.strictEqual(readStatusRows(rows, -1, 'codex'), null);
});

const R = '─'.repeat(40);

test('synthetic: null rows, an unknown platform and a non-integer at are unreadable', () => {
  const idle = load(STATUS_DIR, 'claude-manual-idle@100');
  assert.strictEqual(readStatusRows(null, 5, 'claude'), null);
  assert.strictEqual(readStatusRows(idle, 5, 'gemini'), null);
  assert.strictEqual(readStatusRows(idle, 'x', 'claude'), null);
});

const SYNTHETIC = [
  { title: 'an unknown mode label keys as other', rows: [R, '❯ ', R, '  ⏵⏵ turbo mode on (shift+tab to cycle)'], platform: 'claude', enter: 3,
    expected: { mode: { key: 'other', label: 'turbo mode', cycles: true }, tasks: null, warnings: null } },
  { title: 'the bottom-most mode line wins over a lookalike above it', rows: [R, '❯ ', R, '  ⏵⏵ fake mode on', '  ⏸ plan mode on'], platform: 'claude', enter: 4,
    expected: { mode: { key: 'plan', label: 'plan mode', cycles: true }, tasks: null, warnings: null } },
  { title: 'a plural task segment reads', rows: [R, '❯ ', R, '  ⏵⏵ bypass permissions on · 2 shells · ← for agents'], platform: 'claude', enter: 3,
    expected: { mode: { key: 'bypass', label: 'bypass permissions', cycles: true }, tasks: '2 shells', warnings: null } },
  { title: 'negative: a non-task segment is no task', rows: [R, '❯ ', R, '  ⏸ manual mode on · 12% until auto-compact · ← for agents'], platform: 'claude', enter: 3,
    expected: { mode: { key: 'manual', label: 'manual mode', cycles: true }, tasks: null, warnings: null } },
  { title: 'negative: a codex cwd ending in "Plan mode" is not Plan', rows: ['› x', '', '  Context 0% used · GPT-6-Astra · ~/work/my Plan mode    ⚠ 3 warnings · f2 to view'], platform: 'codex', enter: 2,
    expected: { mode: { key: 'default', label: 'Default', cycles: true }, tasks: null, warnings: 3 } },
  { title: 'negative: a short muse row is unreadable', rows: [`── Voice ${R}`, '❯ ', R, '  muse-spark-1.3-contributor · max'], platform: 'muse', enter: 3, expected: null },
  { title: 'negative: a muse row whose last segment is a path is unreadable', rows: [`── Voice ${R}`, '❯ ', R, '  m · max · ~/x · ~/y'], platform: 'muse', enter: 3, expected: null },
];

const ENTER_LITERALS = [
  '  ⏵⏵ turbo mode on (shift+tab to cycle)',
  '  ⏸ plan mode on',
  '  ⏵⏵ bypass permissions on · 2 shells · ← for agents',
  '  ⏸ manual mode on · 12% until auto-compact · ← for agents',
  '  Context 0% used · GPT-6-Astra · ~/work/my Plan mode    ⚠ 3 warnings · f2 to view',
  '  muse-spark-1.3-contributor · max',
  '  m · max · ~/x · ~/y',
];

SYNTHETIC.forEach((c, i) => {
  test(`synthetic: ${c.title}`, () => {
    assert.strictEqual(c.rows[c.enter], ENTER_LITERALS[i]);
    assert.deepStrictEqual(readStatusRows(c.rows, 0, c.platform), c.expected);
  });
});
