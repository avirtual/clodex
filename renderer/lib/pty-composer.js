'use strict';

const PTY_NEWLINE = '\x1b\r';

function ptyComposerBytes(text) {
  return `${String(text).replace(/\r\n|\r|\n/g, PTY_NEWLINE)}\r`;
}

module.exports = { PTY_NEWLINE, ptyComposerBytes };
