'use strict';

function readCursorRow(terminal) {
  const buf = terminal.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  if (!line) return null;
  return line.translateToString(false, 0, buf.cursorX);
}

function readRowsToCursor(terminal) {
  try {
    const buf = terminal.buffer.active;
    const out = [];
    for (let y = buf.cursorY; y >= 0 && out.length < terminal.rows; y--) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) break;
      out.unshift(line.translateToString(true));
    }
    return out.length ? out : null;
  } catch { return null; }
}

module.exports = { readCursorRow, readRowsToCursor };
