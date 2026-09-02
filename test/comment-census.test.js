'use strict';
// Fixtures for countCommentLines. Every row carries a hardcoded expected count:
// re-deriving the expectation by the tokenizer's own rule would assert only that
// the code agrees with itself, and would leave the table unable to express the
// rows that matter here — the ones where a `//` is NOT a comment.
//
// Naive `//` counting is wrong for this repo and these rows are why: cli-hooks.js
// reads 175 naively and 104 tokenized, the difference being shell text inside the
// template literals that generate the hook scripts.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { countCommentLines } = require('../comment-census.js');

const REPO = path.join(__dirname, '..');

const ROWS = [
  {
    name: 'a bare line comment counts',
    expected: 1,
    src: [
      '// a comment',
      'const a = 1;',
    ].join('\n'),
  },
  {
    name: 'a trailing comment counts its line once',
    expected: 1,
    src: 'const a = 1; // trailing',
  },
  {
    name: '// inside a single-quoted string is not a comment',
    expected: 0,
    src: [
      "const url = 'https://example.com/a//b';",
      "const other = 'no // comment here';",
    ].join('\n'),
  },
  {
    name: '// inside a double-quoted string is not a comment',
    expected: 0,
    src: 'const s = "protocol // slashes";',
  },
  {
    name: '// inside a template literal body is not a comment',
    expected: 0,
    src: [
      'const t = `',
      '  https://example.com',
      '  // not a comment, just text',
      '`;',
    ].join('\n'),
  },
  {
    name: '// inside a regex literal is not a comment',
    expected: 0,
    src: [
      'const re = /https:\\/\\/[a-z]+/;',
      'const cls = /[/]{2}rest/;',
    ].join('\n'),
  },
  {
    name: 'a shell # comment inside a template literal is not a JS comment',
    expected: 0,
    src: [
      'const script = `#!/bin/sh',
      '# this is shell, not JS',
      'echo hi  # trailing shell comment',
      '`;',
    ].join('\n'),
  },
  {
    name: 'a /* */ block counts every line it spans',
    expected: 3,
    src: [
      '/* opens here',
      '   continues',
      '   and closes */',
      'const a = 1;',
    ].join('\n'),
  },
  {
    name: 'a /* */ opening and closing on one line counts that line once',
    expected: 1,
    src: 'const a = /* inline */ 1;',
  },
  {
    name: 'a nested ${} containing a // IS code, so the // counts',
    expected: 1,
    src: [
      'const t = `body ${',
      '  value // a real comment, inside the expression',
      '} tail`;',
    ].join('\n'),
  },
  {
    name: 'a ${} nested inside a ${} keeps template and code frames straight',
    expected: 1,
    src: [
      'const t = `a ${ inner(`b ${',
      '  deep // a real comment two frames down',
      '} c`) } d`;',
      'const after = `// still just template text`;',
    ].join('\n'),
  },
  {
    name: 'an object literal inside ${} does not pop the template frame early',
    expected: 0,
    src: [
      'const t = `x ${ fn({ a: 1, b: { c: 2 } }) } y`;',
      'const t2 = `// template text, not a comment`;',
    ].join('\n'),
  },
  {
    name: 'eslint, @ts and prettier directive lines are exempt',
    expected: 0,
    src: [
      '// eslint-disable-next-line no-unused-vars',
      '// @ts-ignore',
      '// prettier-ignore',
      'const a = 1;',
    ].join('\n'),
  },
  {
    name: 'an exempt-looking directive with code before it still counts',
    expected: 1,
    src: 'const a = 1; // eslint-disable-line',
  },
  {
    name: 'a division is not mistaken for a regex opening',
    expected: 1,
    src: [
      'const half = total / 2;',
      'const ratio = arr[0] / size;',
      '// a real comment after the divisions',
    ].join('\n'),
  },
  {
    name: 'an escaped backtick does not close the template early',
    expected: 0,
    src: [
      'const t = `a \\` b // still template`;',
    ].join('\n'),
  },
  {
    name: 'a blank source counts nothing',
    expected: 0,
    src: '',
  },
];

for (const row of ROWS) {
  test(`countCommentLines: ${row.name}`, () => {
    assert.strictEqual(countCommentLines(row.src), row.expected);
  });
}

// The tokenizer's reason for existing, measured on a real file in this tree:
// cli-hooks.js generates test-pinned shell scripts inside template literals, so
// its naive `//` line count is far above its tokenized one. A tokenizer that
// silently degraded to naive counting would pass every synthetic row above and
// fail only here.
test('countCommentLines is well below the naive count on cli-hooks.js', () => {
  const src = fs.readFileSync(path.join(REPO, 'cli-hooks.js'), 'utf8');
  const naive = src.split('\n').filter((l) => l.includes('//')).length;
  const tokenized = countCommentLines(src);

  // ENTER: the file must actually be the shell-in-template file this row is
  // about. Reading some other cli-hooks.js, or an empty one, would make the
  // inequality below trivially true.
  assert.ok(src.includes('#!/bin/bash'), 'cli-hooks.js should contain a generated shell script');
  assert.ok(naive > 150, `naive count should be large, got ${naive}`);

  assert.ok(
    tokenized < naive - 50,
    `tokenized (${tokenized}) should be far below naive (${naive})`,
  );
});

test('countCommentLines finds no comment in comment-census.js itself', () => {
  const src = fs.readFileSync(path.join(REPO, 'comment-census.js'), 'utf8');

  // ENTER: an empty or missing read would satisfy the zero below for the wrong
  // reason.
  assert.ok(src.includes('function countCommentLines'), 'should be reading the census module');

  assert.strictEqual(countCommentLines(src), 0);
});
