'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toYaml } = require('../src/yaml');

test('a nested object/array/scalar mix renders kubectl-style, 2-space indent', () => {
  const doc = {
    ok: true,
    count: 3,
    sessions: [
      { name: 'bob', type: 'claude', cwd: '/w/one' },
      { name: 'sh', activity: '' },
    ],
    tags: ['a', 'b'],
    meta: { nested: { deep: null }, list: [] },
  };
  assert.strictEqual(toYaml(doc),
    'ok: true\n'
    + 'count: 3\n'
    + 'sessions:\n'
    + '  - name: bob\n'
    + '    type: claude\n'
    + '    cwd: /w/one\n'
    + '  - name: sh\n'
    + '    activity: ""\n'
    + 'tags:\n'
    + '  - a\n'
    + '  - b\n'
    + 'meta:\n'
    + '  nested:\n'
    + '    deep: null\n'
    + '  list: []\n');
});

test('an array under a key inside a dashed object indents under its own key', () => {
  assert.strictEqual(toYaml({ items: [{ name: 'a', tags: ['x', 'y'] }] }),
    'items:\n'
    + '  - name: a\n'
    + '    tags:\n'
    + '      - x\n'
    + '      - y\n');
});

test('an array of arrays puts the inner dash on the outer dash line', () => {
  assert.strictEqual(toYaml([[1, 2], [3]]),
    '- - 1\n'
    + '  - 2\n'
    + '- - 3\n');
});

const QUOTING = [
  ['', 'v: ""\n'],
  ['true', 'v: "true"\n'],
  ['False', 'v: "False"\n'],
  ['null', 'v: "null"\n'],
  ['yes', 'v: "yes"\n'],
  ['NO', 'v: "NO"\n'],
  ['on', 'v: "on"\n'],
  ['off', 'v: "off"\n'],
  ['~', 'v: "~"\n'],
  ['42', 'v: "42"\n'],
  ['-7', 'v: "-7"\n'],
  ['1e3', 'v: "1e3"\n'],
  ['0x1f', 'v: "0x1f"\n'],
  ['.5', 'v: ".5"\n'],
  ['+3', 'v: "+3"\n'],
  ['1_000', 'v: "1_000"\n'],
  ['-alpha', 'v: "-alpha"\n'],
  ['? q', 'v: "? q"\n'],
  [': colon', 'v: ": colon"\n'],
  [',comma', 'v: ",comma"\n'],
  ['[brackets]', 'v: "[brackets]"\n'],
  ['{braces}', 'v: "{braces}"\n'],
  ['#hash', 'v: "#hash"\n'],
  ['&anchor', 'v: "&anchor"\n'],
  ['*alias', 'v: "*alias"\n'],
  ['!tag', 'v: "!tag"\n'],
  ['|pipe', 'v: "|pipe"\n'],
  ['>fold', 'v: ">fold"\n'],
  ["'quote", 'v: "\'quote"\n'],
  ['"dquote', 'v: "\\"dquote"\n'],
  ['%directive', 'v: "%directive"\n'],
  ['@at', 'v: "@at"\n'],
  ['`tick', 'v: "`tick"\n'],
  [' leading', 'v: " leading"\n'],
  ['trailing ', 'v: "trailing "\n'],
  ['endcolon:', 'v: "endcolon:"\n'],
  ['a: b', 'v: "a: b"\n'],
  ['a #c', 'v: "a #c"\n'],
  ['tab\there', 'v: "tab\\there"\n'],
  ['bell\x07', 'v: "bell\\u0007"\n'],
  ['a\n\n', 'v: "a\\n\\n"\n'],
  ['plain text', 'v: plain text\n'],
  ['ok-1', 'v: ok-1\n'],
  ['1.2.3', 'v: 1.2.3\n'],
  ['/w/one', 'v: /w/one\n'],
  ['a#b', 'v: a#b\n'],
  ['x:y', 'v: x:y\n'],
];

test('every quoting trigger renders as its literal row, and the safe ones stay bare', () => {
  const seen = [];
  for (const [input, expected] of QUOTING) {
    assert.strictEqual(toYaml({ v: input }), expected, `row ${JSON.stringify(input)}`);
    seen.push(input);
  }
  assert.strictEqual(seen.length, QUOTING.length, `ENTER: every row ran (${seen.length})`);
  for (const marker of ['', 'yes', 'off', '1e3', ' leading', 'a: b', 'plain text']) {
    assert.ok(seen.includes(marker), `ENTER: the table still carries the ${JSON.stringify(marker)} row`);
  }
  const bare = seen.filter((s) => !toYaml({ v: s }).startsWith('v: "'));
  assert.deepStrictEqual(bare, ['plain text', 'ok-1', '1.2.3', '/w/one', 'a#b', 'x:y'],
    'ENTER: the table mixes quoted and bare rows, so it can express an exception');
});

test('a quoted scalar is a JSON string of the original', () => {
  for (const s of ['a: b', 'tab\there', '"dquote', 'a\n\n', '']) {
    const body = toYaml({ v: s }).slice('v: '.length, -1);
    assert.strictEqual(JSON.parse(body), s, `round-trip of ${JSON.stringify(s)}`);
  }
});

test('a multi-line string ending in a newline is a | block scalar', () => {
  assert.strictEqual(toYaml({ v: 'line one\nline two\n' }),
    'v: |\n'
    + '  line one\n'
    + '  line two\n');
});

test('a multi-line string with no trailing newline is a |- block scalar', () => {
  assert.strictEqual(toYaml({ v: 'line one\nline two' }),
    'v: |-\n'
    + '  line one\n'
    + '  line two\n');
});

test('a block scalar nests under its own indent, and keeps blank interior lines', () => {
  assert.strictEqual(toYaml({ outer: { v: 'one\n\ntwo' } }),
    'outer:\n'
    + '  v: |-\n'
    + '    one\n'
    + '\n'
    + '    two\n');
});

test('empty object and empty array render inline', () => {
  assert.strictEqual(toYaml({}), '{}\n');
  assert.strictEqual(toYaml([]), '[]\n');
  assert.strictEqual(toYaml({ a: {}, b: [] }), 'a: {}\nb: []\n');
  assert.strictEqual(toYaml([{}, { a: 1 }]), '- {}\n- a: 1\n');
});

test('undefined is omitted from an object and rendered null in an array', () => {
  assert.strictEqual(toYaml({ a: 1, b: undefined, c: 2 }), 'a: 1\nc: 2\n');
  assert.strictEqual(toYaml({ list: [1, undefined, 2] }),
    'list:\n'
    + '  - 1\n'
    + '  - null\n'
    + '  - 2\n');
  assert.strictEqual(toYaml({ only: undefined }), '{}\n');
});

test('a key that is not a bare YAML name is double-quoted', () => {
  assert.strictEqual(toYaml({ 'has space': 1, 'ok_key-2': 2, '9lives': 3, '': 4, 'a:b': 5 }),
    '"has space": 1\n'
    + 'ok_key-2: 2\n'
    + '"9lives": 3\n'
    + '"": 4\n'
    + '"a:b": 5\n');
});

test('scalars at the top level, and the JSON parity cases', () => {
  assert.strictEqual(toYaml(null), 'null\n');
  assert.strictEqual(toYaml(true), 'true\n');
  assert.strictEqual(toYaml(5), '5\n');
  assert.strictEqual(toYaml(-0.25), '-0.25\n');
  assert.strictEqual(toYaml('bob'), 'bob\n');
  assert.strictEqual(toYaml(NaN), 'null\n');
  assert.strictEqual(toYaml(Infinity), 'null\n');
  assert.strictEqual(toYaml({ n: NaN, i: -Infinity }), 'n: null\ni: null\n');
});

test('a Date renders as its quoted ISO string', () => {
  assert.strictEqual(toYaml({ at: new Date(Date.UTC(2026, 8, 16, 12, 0, 0)) }),
    'at: "2026-09-16T12:00:00.000Z"\n');
});
