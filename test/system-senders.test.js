'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SYSTEM_SENDERS, SYSTEM_SENDER_GLYPHS } = require('../system-senders');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['session-manager.js', 'team-tickets.js', 'engine.js', 'scripts/clodex-monitor.js', 'wirescope-supervisor.js', 'ipc-handlers.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('SYSTEM_SENDERS is the glyph names plus exactly clodex and user', () => {
  const glyphNames = Object.keys(SYSTEM_SENDER_GLYPHS);
  for (const n of glyphNames) assert.ok(SYSTEM_SENDERS.has(n), `${n} missing from SYSTEM_SENDERS`);
  const extra = [...SYSTEM_SENDERS].filter((n) => !glyphNames.includes(n)).sort();
  assert.deepStrictEqual(extra, ['clodex', 'user']);
  assert.strictEqual(SYSTEM_SENDERS.size, 14);
});

test('every glyph-carrying system sender appears as a quoted literal in a delivery source', () => {
  const expectedMisses = [];
  const misses = [...SYSTEM_SENDERS]
    .filter((n) => n !== 'clodex' && n !== 'user')
    .filter((n) => !SOURCES.some((src) => src.includes(`'${n}'`)));
  assert.deepStrictEqual(misses, expectedMisses);
});
