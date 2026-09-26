'use strict';

const { PASTE_OPEN, PASTE_CLOSE } = require('./composer-voice');

const IMAGE_CHIP_RE = /\[Image #\d+\] ?/gu;

function ptyComposerWrites(text) {
  return [`${PASTE_OPEN}${String(text)}${PASTE_CLOSE}`, '\r'];
}

function pasteKind(items) {
  const list = Array.from(items || []);
  if (list.some((it) => it && it.kind === 'string' && it.type === 'text/plain')) return 'text';
  if (list.some((it) => it && it.kind === 'file' && /^image\//u.test(String(it.type)))) return 'image';
  return 'none';
}

function imageChip(n) {
  return `[Image #${n}] `;
}

function stripImageChips(text) {
  return String(text).replace(IMAGE_CHIP_RE, '');
}

module.exports = { ptyComposerWrites, pasteKind, imageChip, stripImageChips };
