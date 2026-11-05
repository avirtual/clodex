'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
const m = src.match(/function typeGlyph\(type, backend\) \{[\s\S]*?\n\}/);
assert.ok(m, 'typeGlyph must stay a plain function in renderer.js');
const typeGlyph = new Function(`${m[0]}; return typeGlyph;`)();

test('typeGlyph: every session type has its own letter; backends win', () => {
  const rows = [
    ['claude', null, 'A'], ['codex', null, 'C'], ['clodent', null, 'D'], ['muse', null, 'M'],
    ['bash', null, '›_'], ['remote', null, '@'],
    ['claude', 'bedrock', 'B'], ['claude', 'vertex', 'V'],
  ];
  for (const [type, backend, want] of rows) assert.strictEqual(typeGlyph(type, backend), want, type);
  const letters = rows.filter(([, b]) => !b).map(([, , g]) => g);
  assert.strictEqual(new Set(letters).size, letters.length, 'ENTER: no two types share a glyph (clodent must not fall back to C)');
});
