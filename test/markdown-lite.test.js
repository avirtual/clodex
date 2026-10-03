'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseBlocks, parseInline } = require('../renderer/lib/markdown-lite');

test('a pipe table parses header, alignment, rows; an escaped pipe stays in its cell and cells parse inline', () => {
  const text = [
    'intro',
    '| Name | Kind | Note |',
    '|:-----|:----:|-----:|',
    '| a \\| b | **bold** | see [docs](https://example.com/d) |',
    'x | y | z',
    'after',
  ].join('\n');
  const blocks = parseBlocks(text);
  assert.deepStrictEqual(blocks.map((b) => b.kind), ['text', 'table', 'text']);
  const table = blocks[1];
  assert.deepStrictEqual(table.header, ['Name', 'Kind', 'Note']);
  assert.deepStrictEqual(table.align, ['left', 'center', 'right']);
  assert.deepStrictEqual(table.rows, [['a | b', '**bold**', 'see [docs](https://example.com/d)'], ['x', 'y', 'z']]);
  assert.deepStrictEqual(parseInline(table.rows[0][1]), [{ kind: 'bold', text: 'bold' }]);
  assert.deepStrictEqual(parseInline(table.rows[0][2]), [{ kind: 'text', text: 'see ' }, { kind: 'link', text: 'docs', href: 'https://example.com/d' }]);
  assert.strictEqual(blocks[2].text, 'after');
});

test('a header row whose separator has the wrong cell count stays literal text', () => {
  assert.deepStrictEqual(parseBlocks('| a | b |\n|---|'), [{ kind: 'text', text: '| a | b |\n|---|' }]);
});

test('a fence keeps a table-shaped line verbatim; an unclosed fence stays literal', () => {
  assert.deepStrictEqual(parseBlocks('```sh\n| not | a table |\n|---|---|\n```'), [{ kind: 'fence', lang: 'sh', text: '| not | a table |\n|---|---|' }]);
  assert.deepStrictEqual(parseBlocks('```\n**x**'), [{ kind: 'text', text: '```\n**x**' }]);
});

test('# to ### are headings; #### stays text', () => {
  assert.deepStrictEqual(parseBlocks('# One\n### Three\n#### Four'), [
    { kind: 'heading', level: 1, text: 'One' },
    { kind: 'heading', level: 3, text: 'Three' },
    { kind: 'text', text: '#### Four' },
  ]);
});

test('inline: bold, word-bounded italic, code, http links', () => {
  assert.deepStrictEqual(parseInline('a **b** *c* _d_ `e` [f](http://g.h)'), [
    { kind: 'text', text: 'a ' }, { kind: 'bold', text: 'b' }, { kind: 'text', text: ' ' },
    { kind: 'italic', text: 'c' }, { kind: 'text', text: ' ' }, { kind: 'italic', text: 'd' },
    { kind: 'text', text: ' ' }, { kind: 'code', text: 'e' }, { kind: 'text', text: ' ' },
    { kind: 'link', text: 'f', href: 'http://g.h' },
  ]);
});

test('a lone star, snake_case, 2*3*4, **unclosed and a javascript: link all stay literal', () => {
  for (const s of ['a * b', '* item', 'snake_case_name', '2*3*4', '**unclosed', '[x](javascript:alert(1))', '[x](javascript:void)', '`open']) {
    assert.deepStrictEqual(parseInline(s), [{ kind: 'text', text: s }], s);
  }
});

test('no line is swallowed: plain prose round-trips', () => {
  const text = 'line one\n\n- list item\n  indented | pipe';
  assert.deepStrictEqual(parseBlocks(text), [{ kind: 'text', text }]);
});
