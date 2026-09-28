'use strict';

const { SYSTEM_SENDER_GLYPHS: SYSTEM_GLYPHS } = require('../../system-senders');

const SEAT_SHAPE = /^([A-Za-z0-9]+)-([A-Za-z]+)((?:-\d+)?(?:-r\d+)?)$/;

function systemGlyph(name) {
  if (Object.prototype.hasOwnProperty.call(SYSTEM_GLYPHS, name)) return SYSTEM_GLYPHS[name];
  if (name.endsWith('-loop')) return SYSTEM_GLYPHS['ticket-loop'];
  if (name.endsWith('-watchdog')) return SYSTEM_GLYPHS['ticket-watchdog'];
  return null;
}

function initial(text) {
  const first = Array.from(String(text || ''))[0];
  return first ? first.toUpperCase() : '?';
}

function classifySender(from) {
  const name = String(from == null ? '' : from);
  const system = systemGlyph(name);
  if (system) return { cls: 'system', label: name, glyph: system };
  if (name === 'user') return { cls: 'operator', label: 'you', glyph: '●' };
  if (name.includes('@')) return { cls: 'peer', label: name, glyph: '⇢' };
  const shape = SEAT_SHAPE.exec(name);
  if (shape) {
    return { cls: 'seat', label: `${shape[2]}${shape[3]}`, glyph: initial(shape[2]) };
  }
  return { cls: 'seat', label: name, glyph: initial(name) };
}

module.exports = { classifySender, initial, SYSTEM_GLYPHS };
