'use strict';

const { PASTE_OPEN, PASTE_CLOSE } = require('./composer-voice');

function ptyComposerWrites(text) {
  return [`${PASTE_OPEN}${String(text)}${PASTE_CLOSE}`, '\r'];
}

module.exports = { ptyComposerWrites };
