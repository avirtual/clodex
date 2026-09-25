'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { composerReadlineEdit } = require('../renderer/lib/composer-keys');

const ROWS = [
  { name: 'u mid-line deletes before the cursor', key: 'u', value: 'hello world', start: 5, end: 5, want: { value: ' world', cursor: 0 } },
  { name: 'u on the second line clears only that line', key: 'u', value: 'a\nbc d', start: 6, end: 6, want: { value: 'a\n', cursor: 2 } },
  { name: 'u at line start is a no-op', key: 'u', value: 'a\nbc', start: 2, end: 2, want: { value: 'a\nbc', cursor: 2 } },
  { name: 'k deletes to the end of the line', key: 'k', value: 'hello', start: 2, end: 2, want: { value: 'he', cursor: 2 } },
  { name: 'k stops at the next newline', key: 'k', value: 'ab\ncd', start: 1, end: 1, want: { value: 'a\ncd', cursor: 1 } },
  { name: 'w deletes trailing whitespace and the previous word', key: 'w', value: 'foo bar  ', start: 9, end: 9, want: { value: 'foo ', cursor: 4 } },
  { name: 'w deletes the previous word', key: 'w', value: 'foo bar', start: 7, end: 7, want: { value: 'foo ', cursor: 4 } },
  { name: 'w does not cross a newline', key: 'w', value: 'foo\nbar', start: 7, end: 7, want: { value: 'foo\n', cursor: 4 } },
  { name: 'a jumps to the start of a middle line', key: 'a', value: 'one\ntwo\nthree', start: 6, end: 6, want: { value: 'one\ntwo\nthree', cursor: 4 } },
  { name: 'e jumps to the end of a middle line', key: 'e', value: 'one\ntwo\nthree', start: 5, end: 5, want: { value: 'one\ntwo\nthree', cursor: 7 } },
  { name: 'u with a selection deletes only the selection', key: 'u', value: 'hello world', start: 2, end: 5, want: { value: 'he world', cursor: 2 } },
  { name: 'w with a selection deletes only the selection', key: 'w', value: 'hello world', start: 6, end: 11, want: { value: 'hello ', cursor: 6 } },
  { name: 'uppercase U under ctrl is the same key', key: 'U', value: 'abc', start: 3, end: 3, want: { value: '', cursor: 0 } },
];

for (const r of ROWS) {
  test(`composerReadlineEdit: ${r.name}`, () => {
    const got = composerReadlineEdit({ key: r.key, ctrlKey: true, metaKey: false, altKey: false, value: r.value, selectionStart: r.start, selectionEnd: r.end });
    assert.deepStrictEqual(got, r.want);
  });
}

const NULL_ROWS = [
  { name: 'plain u without ctrl', key: 'u', ctrlKey: false, metaKey: false, altKey: false },
  { name: 'ctrl+meta+u', key: 'u', ctrlKey: true, metaKey: true, altKey: false },
  { name: 'ctrl+alt+u', key: 'u', ctrlKey: true, metaKey: false, altKey: true },
  { name: 'ctrl+b is not a readline key here', key: 'b', ctrlKey: true, metaKey: false, altKey: false },
  { name: 'ctrl+Enter', key: 'Enter', ctrlKey: true, metaKey: false, altKey: false },
];

for (const r of NULL_ROWS) {
  test(`composerReadlineEdit: ${r.name} returns null`, () => {
    const got = composerReadlineEdit({ key: r.key, ctrlKey: r.ctrlKey, metaKey: r.metaKey, altKey: r.altKey, value: 'hello', selectionStart: 5, selectionEnd: 5 });
    assert.strictEqual(got, null);
  });
}
