'use strict';

function fakeCell(ch, width, run) {
  const r = run || {};
  const kind = (v) => (v == null ? 'default' : typeof v === 'string' ? 'rgb' : 'palette');
  const value = (v) => (v == null ? 0 : typeof v === 'string' ? parseInt(v.slice(1), 16) : v);
  return {
    getChars: () => ch,
    getWidth: () => width,
    isFgDefault: () => kind(r.fg) === 'default',
    isBgDefault: () => kind(r.bg) === 'default',
    isFgRGB: () => kind(r.fg) === 'rgb',
    isBgRGB: () => kind(r.bg) === 'rgb',
    getFgColor: () => value(r.fg),
    getBgColor: () => value(r.bg),
    isBold: () => (r.bold ? 1 : 0),
    isDim: () => (r.dim ? 1 : 0),
    isInverse: () => (r.inverse ? 1 : 0),
  };
}

function fakeLine(text, runs = []) {
  const cells = [];
  let x = 0;
  for (const ch of Array.from(text)) {
    const run = runs.find((r) => x >= r.x && x < r.x + r.n);
    cells.push(fakeCell(ch, 1, run));
    x += ch.length;
  }
  return {
    translateToString: () => text,
    getCell: (col) => cells[col],
  };
}

module.exports = { fakeCell, fakeLine };
