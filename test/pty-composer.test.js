'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PTY_NEWLINE, ptyComposerBytes } = require('../renderer/lib/pty-composer');

test('a one-line draft is written as the text then a carriage return', () => {
  assert.strictEqual(ptyComposerBytes('hello'), 'hello\r');
});

test('each newline in a draft becomes the ESC CR chord and only the last byte submits', () => {
  assert.strictEqual(PTY_NEWLINE, '\x1b\r');
  assert.strictEqual(ptyComposerBytes('a\nb\r\nc'), 'a\x1b\rb\x1b\rc\r');
  assert.strictEqual(ptyComposerBytes('a\nb').split('\r').length, 3);
});
