'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { colour, rowCells } = require('../renderer/lib/menu-cells');
const { fakeCell, fakeLine } = require('./lib/fake-cells');

const DIR = path.join(__dirname, 'fixtures', 'menu-states');

function load(name) {
  const rows = fs.readFileSync(path.join(DIR, `${name}.screen.txt`), 'utf8').replace(/\n$/, '').split('\n');
  const cells = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.cells.json`), 'utf8'));
  return { rows, cells };
}

test('colour reads an RGB cell as #rrggbb, a palette cell as its index and a default cell as null', () => {
  assert.strictEqual(colour(fakeCell('a', 1, { fg: '#05769f' }), true), '#05769f');
  assert.strictEqual(colour(fakeCell('a', 1, { bg: 6 }), false), 6);
  assert.strictEqual(colour(fakeCell('a', 1, {}), true), null);
  assert.strictEqual(colour(fakeCell('a', 1, { fg: 6 }), false), null);
});

test('rowCells merges equal neighbours into one run and drops default attributes', () => {
  const line = fakeLine('ab cd', [{ x: 0, n: 2, fg: '#5769f7', bold: true }, { x: 2, n: 1 }, { x: 3, n: 2, inverse: true, dim: true, bg: 4 }]);
  assert.deepStrictEqual(rowCells(line, 100), [
    { x: 0, n: 2, fg: '#5769f7', bold: true },
    { x: 2, n: 1 },
    { x: 3, n: 2, bg: 4, dim: true, inverse: true },
  ]);
});

test('rowCells stops at the trimmed text, at cols, and on a missing line', () => {
  const padded = { translateToString: () => 'ab', getCell: (c) => fakeCell('ab   '[c] || '', 1, { fg: 2 }) };
  assert.deepStrictEqual(rowCells(padded, 100), [{ x: 0, n: 2, fg: 2 }]);
  assert.deepStrictEqual(rowCells(fakeLine('abcd', []), 2), [{ x: 0, n: 2 }]);
  assert.deepStrictEqual(rowCells(null, 100), []);
});

test('rowCells skips the zero-width tail of a wide cell', () => {
  const line = { translateToString: () => '漢a', getCell: (c) => [fakeCell('漢', 2, { bold: true }), fakeCell('', 0), fakeCell('a', 1)][c] };
  assert.deepStrictEqual(rowCells(line, 100), [{ x: 0, n: 1, bold: true }, { x: 1, n: 1 }]);
});

for (const name of ['claude-one-char@100', 'codex-arrow-down@100', 'muse-arrow-down-2@100']) {
  test(`rowCells rebuilds ${name}.cells.json from cells carrying its attributes`, () => {
    const { rows, cells } = load(name);
    assert.deepStrictEqual(rows.map((r, i) => rowCells(fakeLine(r, cells[i]), 100)), cells);
  });
}

function headless() {
  try { return require('@xterm/headless'); } catch { return null; }
}

function sgr(run) {
  const codes = ['0'];
  const col = (v, base) => (typeof v === 'string' ? `${base};2;${parseInt(v.slice(1, 3), 16)};${parseInt(v.slice(3, 5), 16)};${parseInt(v.slice(5, 7), 16)}` : `${base};5;${v}`);
  if (run.fg != null) codes.push(col(run.fg, 38));
  if (run.bg != null) codes.push(col(run.bg, 48));
  if (run.bold) codes.push('1');
  if (run.dim) codes.push('2');
  if (run.inverse) codes.push('7');
  return `\x1b[${codes.join(';')}m`;
}

function paint(rows, cells) {
  return rows.map((row, i) => `\x1b[${i + 1};1H` + cells[i].map((r) => sgr(r) + row.slice(r.x, r.x + r.n)).join('') + '\x1b[0m').join('');
}

test('rowCells over @xterm/headless rebuilds claude-one-char@100.cells.json from its painted screen', async (t) => {
  const mod = headless();
  if (!mod) {
    t.skip('@xterm/headless does not resolve (not in package.json)');
    return;
  }
  const { rows, cells } = load('claude-one-char@100');
  const term = new mod.Terminal({ cols: 100, rows: rows.length, allowProposedApi: true });
  await new Promise((r) => term.write(paint(rows, cells), r));
  const buf = term.buffer.active;
  assert.deepStrictEqual(rows.map((_, i) => rowCells(buf.getLine(buf.baseY + i), 100)), cells);
  term.dispose();
});
