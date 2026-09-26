'use strict';

function colour(cell, fg) {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const c = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return '#' + c.toString(16).padStart(6, '0');
  return c;
}

function rowCells(line, cols) {
  const runs = [];
  if (!line) return runs;
  const text = line.translateToString(true);
  let cur = null;
  let x = 0;
  for (let col = 0; col < cols && x < text.length; col++) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue;
    const ch = cell.getChars() || ' ';
    const a = { fg: colour(cell, true), bg: colour(cell, false), bold: !!cell.isBold(), dim: !!cell.isDim(), inverse: !!cell.isInverse() };
    const same = cur && cur.fg === a.fg && cur.bg === a.bg && cur.bold === a.bold && cur.dim === a.dim && cur.inverse === a.inverse;
    if (same) { cur.n += ch.length; } else {
      cur = { x, n: ch.length, ...a };
      runs.push(cur);
    }
    x += ch.length;
  }
  return runs.map((r) => {
    const o = { x: r.x, n: r.n };
    if (r.fg !== null) o.fg = r.fg;
    if (r.bg !== null) o.bg = r.bg;
    if (r.bold) o.bold = true;
    if (r.dim) o.dim = true;
    if (r.inverse) o.inverse = true;
    return o;
  });
}

module.exports = { colour, rowCells };
