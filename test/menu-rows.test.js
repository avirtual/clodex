'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { CELL_RUN_KEYS, isCellRun, readMenuRows } = require('../renderer/lib/menu-rows');

const DIR = path.join(__dirname, 'fixtures', 'menu-states');

function load(name) {
  const rows = fs.readFileSync(path.join(DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
  const cells = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.cells.json`), 'utf8'));
  return { rows, cells };
}

const platformOf = (name) => name.split('-')[0].replace(/\d+$/u, '');

const FIXTURES = [
  ['claude-arrow-down-2@100', 6, 1, ['/remote-env', '/web-setup', '/teleport'], [{field: 'description', start: 35, end: 38}]],
  ['claude-arrow-down@100', 6, 0, ['/remote-env', '/web-setup', '/teleport'], [{field: 'description', start: 35, end: 38}]],
  ['claude-arrow-up@100', 6, 0, ['/remote-env', '/web-setup', '/teleport'], [{field: 'description', start: 35, end: 38}]],
  ['claude-backspace@100', 6, 0, ['/clear', '/doctor', '/copy', '/teleport', '/plugin-authoring', '/init', '/memory', '/design-login', '/docs', '/docx', '/google-workspace', '/import-memory'], [{field: 'name', start: 1, end: 3}]],
  ['claude-co@100', 6, 0, ['/copy', '/color', '/config', '/compact', '/context', '/usage (cost)', '/resume (continue)', '/autocompact', '/doctor', '/docs', '/docx', '/google-workspace', '/pptx', '/xlsx'], [{field: 'name', start: 1, end: 3}, {field: 'description', start: 0, end: 2}]],
  ['claude-escape@100', null],
  ['claude-idle-slash@100', 6, 0, ['/add-dir', '/advisor', '/artifacts', '/auto-mode-setup', '/autocompact', '/autofix-pr', '/background', '/branch', '/btw', '/bug', '/cd', '/chrome', '/clear', '/color', '/compact', '/config', '/context', '/copy'], []],
  ['claude-one-char@100', 6, 0, ['/cd', '/copy', '/clear', '/color', '/chrome', '/config', '/compact', '/context', '/usage (cost)', '/doctor (checkup)', '/resume (continue)', '/rewind (checkpoint)', '/usage-credits', '/skill-creator', '/mcp', '/privacy-settings'], [{field: 'name', start: 1, end: 2}, {field: 'description', start: 39, end: 40}]],
  ['claude-paste@100', 6, -1, ['/remote-env', '/web-setup', '/teleport'], [{field: 'description', start: 35, end: 38}]],
  ['claude-tab@100', null],
  ['claude-three-chars@100', 6, -1, ['/remote-env', '/web-setup', '/teleport'], [{field: 'description', start: 35, end: 38}]],
  ['claude283-one-char@100', 6, 0, ['/cd', '/copy', '/clear', '/color', '/chrome', '/config', '/context', '/compact', '/computer-use', '/chrome-browser', '/usage (cost)', '/doctor (checkup)', '/resume (continue)', '/rewind (checkpoint)'], [{field: 'name', start: 1, end: 2}, {field: 'description', start: 39, end: 40}]],
  ['codex-arrow-down-2@100', 36, 0, ['/compact', '/copy'], []],
  ['codex-arrow-down@100', 36, 1, ['/compact', '/copy'], [{field: 'name', start: 1, end: 3}]],
  ['codex-arrow-up@100', 36, 1, ['/compact', '/copy'], [{field: 'name', start: 1, end: 3}]],
  ['codex-backspace@100', 36, 0, ['/compact', '/copy', '/cd', '/clear'], []],
  ['codex-co@100', 36, 0, ['/compact', '/copy'], []],
  ['codex-escape@100', null],
  ['codex-idle-slash@100', 36, 0, ['/model', '/fast', '/ide', '/permissions', '/keymap', '/vim', '/experimental', '/approve'], []],
  ['codex-paste@100', 36, 0, ['/compact', '/copy'], []],
  ['codex-tab@100', null],
  ['codex-three-chars@100', null],
  ['muse-arrow-down-2@100', 7, 2, ['/compact', '/copy', '/settings (/config)', '/usage (/cost)'], []],
  ['muse-arrow-down@100', 7, 1, ['/compact', '/copy', '/settings (/config)', '/usage (/cost)'], []],
  ['muse-arrow-up@100', 7, 1, ['/compact', '/copy', '/settings (/config)', '/usage (/cost)'], []],
  ['muse-backspace@100', 7, 1, ['/clear', '/compact', '/copy', '/settings (/config)', '/usage (/cost)', '/create-plugin · bui… skill', '/create-skill · buil… skill'], []],
  ['muse-co@100', 7, 0, ['/compact', '/copy', '/settings (/config)', '/usage (/cost)'], []],
  ['muse-escape@100', null],
  ['muse-idle-slash@100', 7, 0, ['/bug', '/clear', '/compact', '/copy', '/deep-research', '/effort', '/export'], []],
  ['muse-paste@100', 7, 0, ['/compact', '/copy', '/settings (/config)', '/usage (/cost)'], []],
  ['muse-tab@100', 7, 0, ['/compact'], []],
  ['muse-three-chars@100', null],
];

for (const [name, anchor, selected, names, firstSpans] of FIXTURES) {
  test(`readMenuRows ${name}`, () => {
    const { rows, cells } = load(name);
    const got = readMenuRows(rows, cells, platformOf(name));
    if (anchor === null) {
      assert.strictEqual(got, null);
      return;
    }
    assert.strictEqual(got.anchor, anchor);
    assert.deepStrictEqual(got.rows.map((r) => r.name), names);
    assert.strictEqual(got.rows.findIndex((r) => r.selected), selected);
    assert.strictEqual(got.rows.filter((r) => r.selected).length, selected < 0 ? 0 : 1);
    assert.deepStrictEqual(got.rows[0].matchSpans, firstSpans);
  });
}

test('every fixture on disk is in the table', () => {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.screen.txt')).map((f) => f.replace('.screen.txt', '')).sort();
  assert.deepStrictEqual(FIXTURES.map((f) => f[0]).sort(), onDisk);
});

test('cells fixtures are one run array per screen row, covering the trimmed row text', () => {
  for (const [name] of FIXTURES) {
    const { rows, cells } = load(name);
    assert.strictEqual(cells.length, rows.length, name);
    cells.forEach((runs, i) => {
      assert.ok(runs.every(isCellRun), `${name} row ${i}`);
      let x = 0;
      for (const r of runs) { assert.strictEqual(r.x, x, `${name} row ${i}`); x += r.n; }
      assert.strictEqual(x, rows[i].length, `${name} row ${i}`);
    });
  }
});

test('isCellRun accepts only the pinned keys with a non-negative x and positive n', () => {
  assert.deepStrictEqual(CELL_RUN_KEYS, ['x', 'n', 'fg', 'bg', 'bold', 'dim', 'inverse']);
  assert.ok(isCellRun({ x: 0, n: 2, fg: '#5769f7', bold: true }));
  assert.ok(isCellRun({ x: 3, n: 1, fg: 6, inverse: true, dim: true, bg: 4 }));
  assert.ok(!isCellRun({ x: 0, n: 0 }));
  assert.ok(!isCellRun({ x: -1, n: 1 }));
  assert.ok(!isCellRun({ x: 0, n: 1, italic: true }));
  assert.ok(!isCellRun(null));
});

test('claude /clo matches descriptions: every bold span reads clo', () => {
  const { rows, cells } = load('claude-three-chars@100');
  const got = readMenuRows(rows, cells, 'claude');
  assert.strictEqual(got.rows[0].description, 'Choose the default environment for cloud agents');
  const read = got.rows.flatMap((r) => r.matchSpans.map((s) => r[s.field].slice(s.start, s.end).toLowerCase()));
  assert.strictEqual(read.length, 3);
  assert.ok(read.every((t) => t === 'clo'), read.join(','));
});

test('claude 2.1.283 one-char bold marks the name and description characters', () => {
  const { rows, cells } = load('claude283-one-char@100');
  const got = readMenuRows(rows, cells, 'claude');
  assert.deepStrictEqual(got.rows[0], {
    name: '/cd',
    description: 'Move this session to a new working directory',
    selected: true,
    matchSpans: [{ field: 'name', start: 1, end: 2 }, { field: 'description', start: 39, end: 40 }],
  });
});

test('claude 2.1.304 /co reads past the marker column: /copy selected with name-relative spans', () => {
  const { rows, cells } = load('claude-co@100');
  assert.ok(rows[8].startsWith('  ❯ /copy '));
  assert.ok(rows[9].startsWith('    /color '));
  const got = readMenuRows(rows, cells, 'claude');
  assert.deepStrictEqual(got.rows.slice(0, 2), [
    { name: '/copy', description: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", selected: true, matchSpans: [{ field: 'name', start: 1, end: 3 }, { field: 'description', start: 0, end: 2 }] },
    { name: '/color', description: 'Set the prompt bar color for this session', selected: false, matchSpans: [{ field: 'name', start: 1, end: 3 }, { field: 'description', start: 19, end: 21 }] },
  ]);
});

test('claude 2.1.304 marker and selection colour agree on every recorded row', () => {
  const marked = [];
  for (const [name, anchor] of FIXTURES) {
    if (!name.startsWith('claude-') || anchor === null) continue;
    const { rows, cells } = load(name);
    rows.forEach((row, i) => {
      if (!/^\s{2}(?:❯ |\s{2})\//u.test(row)) return;
      const coloured = cells[i].some((r) => r.fg === '#5769f7' && r.x <= 4 && r.x + r.n > 4);
      assert.strictEqual(row.startsWith('  ❯ '), coloured, `${name} row ${i}`);
      if (coloured) marked.push(name);
    });
  }
  assert.ok(marked.includes('claude-co@100'), marked.join(','));
});

test('claude marker wins over a row whose name carries no selection colour', () => {
  const rule = '─'.repeat(20);
  const rows = [rule, '❯ /co', rule, '  ❯ /copy   Copy it', '    /color  Set colour', ''];
  const got = readMenuRows(rows, rows.map(() => []), 'claude');
  assert.deepStrictEqual(got.rows.map((r) => [r.name, r.description, r.selected]), [['/copy', 'Copy it', true], ['/color', 'Set colour', false]]);
});

test('codex marks matches bold only on unselected rows', () => {
  const { rows, cells } = load('codex-arrow-down@100');
  const got = readMenuRows(rows, cells, 'codex');
  assert.deepStrictEqual(got.rows.map((r) => [r.name, r.description, r.selected, r.matchSpans]), [
    ['/compact', 'summarize conversation to prevent hitting the context limit', false, [{ field: 'name', start: 1, end: 3 }]],
    ['/copy', 'copy the last response or part of it', true, []],
  ]);
});

test('codex reads no menu from a past `› /…` prompt in the history when the composer below holds plain text', () => {
  const rows = ['  /model  choose model', '', '› /tmp/notes explain this', '', '', '', '› hello', '', '  Context 0% used · GPT', '  ? for shortcuts'];
  assert.strictEqual(readMenuRows(rows, [], 'codex'), null);
});

test('muse selection is the bold coloured name and carries no match spans', () => {
  const { rows, cells } = load('muse-arrow-down-2@100');
  const got = readMenuRows(rows, cells, 'muse');
  assert.deepStrictEqual(got.rows[2], { name: '/settings (/config)', description: 'Open local settings', selected: true, matchSpans: [] });
});

test('a claude prompt echoed into history without its rules is not a composer', () => {
  const rows = ['❯ /clear', '  /cd                Move', '', '─'.repeat(20), '❯ hello', '─'.repeat(20)];
  assert.strictEqual(readMenuRows(rows, rows.map(() => []), 'claude'), null);
});

test('muse skips its scroll counter and its no-match hint', () => {
  const { rows, cells } = load('muse-idle-slash@100');
  assert.ok(rows.some((r) => /↓ \d+ more/u.test(r)));
  assert.ok(readMenuRows(rows, cells, 'muse').rows.every((r) => r.name.startsWith('/')));
  const miss = load('muse-three-chars@100');
  assert.ok(miss.rows.some((r) => r.includes('No slash command named /clo')));
});

test('unknown platform and non-array rows read as no menu', () => {
  const { rows, cells } = load('claude-idle-slash@100');
  assert.strictEqual(readMenuRows(rows, cells, 'gemini'), null);
  assert.strictEqual(readMenuRows(null, cells, 'claude'), null);
  const bare = readMenuRows(rows, null, 'claude').rows;
  assert.ok(bare.every((r) => r.matchSpans.length === 0));
  assert.deepStrictEqual(bare.map((r) => r.selected).indexOf(true), 0);
  const old = load('claude283-one-char@100');
  assert.ok(readMenuRows(old.rows, null, 'claude').rows.every((r) => !r.selected && r.matchSpans.length === 0));
});
