'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { slashQuery, filterCommands, slashMenuKey } = require('../renderer/lib/composer-slash');

test('slashQuery opens on a line that starts with / while the cursor is inside the first token', () => {
  assert.deepStrictEqual(slashQuery('/', 1), { query: '', start: 0, end: 1 });
  assert.deepStrictEqual(slashQuery('/comp', 5), { query: 'comp', start: 0, end: 5 });
  assert.deepStrictEqual(slashQuery('/compact now', 3), { query: 'co', start: 0, end: 8 });
  assert.deepStrictEqual(slashQuery('hello\n/cl', 9), { query: 'cl', start: 6, end: 9 });
});

test('slashQuery stays closed off the first token, before the slash, or on a line without one', () => {
  assert.strictEqual(slashQuery('/compact now', 10), null);
  assert.strictEqual(slashQuery('/compact', 0), null);
  assert.strictEqual(slashQuery('hi /x', 5), null);
  assert.strictEqual(slashQuery('/x\nplain', 8), null);
  assert.strictEqual(slashQuery('', 0), null);
});

test('filterCommands puts prefix matches before substring matches, each in list order', () => {
  const list = ['/context', '/compact', '/recompact', '/clear', '/Compose'].map((name) => ({ name }));
  assert.deepStrictEqual(filterCommands(list, 'comp').map((c) => c.name), ['/compact', '/Compose', '/recompact']);
  assert.deepStrictEqual(filterCommands(list, '').map((c) => c.name), list.map((c) => c.name));
  assert.deepStrictEqual(filterCommands(list, 'zz'), []);
});

test('slashMenuKey moves, picks and closes only while the menu is open', () => {
  const k = (key, extra = {}) => slashMenuKey({ key, open: true, index: 0, count: 3, ...extra });
  assert.deepStrictEqual(k('ArrowDown'), { index: 1 });
  assert.deepStrictEqual(k('ArrowUp'), { index: 2 });
  assert.deepStrictEqual(k('ArrowDown', { index: 2 }), { index: 0 });
  assert.deepStrictEqual(k('Tab'), { pick: true });
  assert.deepStrictEqual(k('Enter'), { pick: true });
  assert.deepStrictEqual(k('Escape'), { close: true });
  assert.strictEqual(k('Enter', { shiftKey: true }), null);
  assert.strictEqual(k('a'), null);
  assert.strictEqual(k('Enter', { count: 0 }), null);
  assert.deepStrictEqual(k('Escape', { count: 0 }), { close: true });
  assert.strictEqual(slashMenuKey({ key: 'Enter', open: false, index: 0, count: 3 }), null);
});
