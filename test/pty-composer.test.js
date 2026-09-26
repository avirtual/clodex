'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ptyComposerWrites, pasteKind, imageChip, stripImageChips } = require('../renderer/lib/pty-composer');
const { PASTE_OPEN, PASTE_CLOSE } = require('../renderer/lib/composer-voice');

test('a draft is written as a bracketed paste then a carriage return', () => {
  assert.deepStrictEqual(ptyComposerWrites('hello'), [`${PASTE_OPEN}hello${PASTE_CLOSE}`, '\r']);
});

test('carriage return is its own write', () => {
  const writes = ptyComposerWrites('hello');
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[1], '\r');
  assert.ok(!writes[0].includes('\r'));
});

test('newlines in a draft are carried literally inside the paste', () => {
  assert.strictEqual(ptyComposerWrites('a\nb')[0], `${PASTE_OPEN}a\nb${PASTE_CLOSE}`);
});

test('an empty draft still yields the two writes', () => {
  assert.deepStrictEqual(ptyComposerWrites(''), [`${PASTE_OPEN}${PASTE_CLOSE}`, '\r']);
});

const png = { kind: 'file', type: 'image/png' };
const plain = { kind: 'string', type: 'text/plain' };
const html = { kind: 'string', type: 'text/html' };

for (const [label, items, want] of [
  ['ENTER: an image alone is an image paste', [png], 'image'],
  ['an image with a text copy is a text paste', [html, plain, png], 'text'],
  ['plain text is a text paste', [plain], 'text'],
  ['a non-image file is nothing', [{ kind: 'file', type: 'application/pdf' }], 'none'],
  ['html without plain text is nothing', [html], 'none'],
  ['an empty clipboard is nothing', [], 'none'],
  ['a missing item list is nothing', undefined, 'none'],
]) {
  test(`pasteKind: ${label}`, () => {
    assert.strictEqual(pasteKind(items), want);
  });
}

test('pasteKind reads an array-like item list', () => {
  assert.strictEqual(pasteKind({ length: 1, 0: png }), 'image');
});

for (const [label, text, want] of [
  ['ENTER: text with no chip is untouched', 'describe this', 'describe this'],
  ['a leading chip is dropped with its space', `${imageChip(1)}describe this`, 'describe this'],
  ['chips after text are dropped', `look ${imageChip(1)}${imageChip(2)}`, 'look '],
  ['a draft of only chips becomes empty', `${imageChip(1)}${imageChip(2)}`, ''],
  ['newlines around a chip survive', `a\n${imageChip(3)}b`, 'a\nb'],
  ['a chip-shaped token without a number stays', '[Image #x] ok', '[Image #x] ok'],
]) {
  test(`stripImageChips: ${label}`, () => {
    assert.strictEqual(stripImageChips(text), want);
  });
}

test('the chip is what the CLI shows, numbered from one', () => {
  assert.strictEqual(imageChip(1), '[Image #1] ');
});

test('the pty composer registers a paste listener that routes an image paste through pasteKind', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const m = src.match(/composerEl\.addEventListener\('paste', \(e\) => \{([\s\S]*?)\n {4}\}\);/u);
  assert.ok(m, 'renderer.js registers a paste listener on composerEl');
  assert.match(m[1], /pasteKind\(/u);
  assert.match(m[1], /writePty\('\\x16'\)/u);
  assert.match(src, /ptyComposerWrites\(stripImageChips\(text\)\)/u);
});
