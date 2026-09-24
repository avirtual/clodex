'use strict';

const { replyGlyphFor } = require('../../intent-glyphs');

const INBOUND_RE = /^\[agent:from ([^\]\s]+)\][ \t]*/;
const RUNTIME_RE = /^\[agent:([a-z-]+)\][ \t]*/;
const ROW_CAP = 160;

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  return line.length > ROW_CAP ? `${line.slice(0, ROW_CAP - 1)}…` : line;
}

function outboxRowOf(item) {
  const text = String((item && item.text) || '');
  const images = (item && Number(item.images)) || 0;
  if (!item || item.origin !== 'system') return { origin: 'operator', badge: null, text: firstLine(text), images };
  const from = INBOUND_RE.exec(text);
  if (from) return { origin: 'system', badge: { glyph: null, label: from[1] }, text: firstLine(text.slice(from[0].length)), images };
  const runtime = RUNTIME_RE.exec(text);
  if (runtime) {
    const { glyph, label } = replyGlyphFor(runtime[1]);
    return { origin: 'system', badge: { glyph, label }, text: firstLine(text.slice(runtime[0].length)), images };
  }
  return { origin: 'system', badge: { glyph: null, label: 'system' }, text: firstLine(text), images };
}

module.exports = { outboxRowOf };
