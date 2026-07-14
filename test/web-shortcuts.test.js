'use strict';
// web-shortcuts.test.js — the pure Alt-chord classifier for the browser frontend
// (web-frontend Phase 5, Chunk 2). It mirrors the desktop's Cmd shortcuts onto
// Alt because a browser tab reserves Cmd+T/W/1-9. The classifier keys off e.code
// (not e.key) so macOS Option-composition (Option+T → "†") can't defeat it; these
// tests pin that, plus the full chord set and the guard rails.

const test = require('node:test');
const assert = require('node:assert');
const { altChordAction } = require('../renderer/lib/web-shortcuts');

// A keydown-like event. code is the physical key; key defaults to a composed
// glyph so a mistaken e.key classifier would fail these.
const ev = (code, { shift = false, alt = true, meta = false, ctrl = false, key = '†' } = {}) =>
  ({ code, key, shiftKey: shift, altKey: alt, metaKey: meta, ctrlKey: ctrl });

test('the Alt chord set maps to the four actions', () => {
  assert.deepEqual(altChordAction(ev('KeyT')), { type: 'new' });
  assert.deepEqual(altChordAction(ev('KeyW')), { type: 'close' });
  assert.deepEqual(altChordAction(ev('BracketRight', { shift: true })), { type: 'cycle', dir: 'next' });
  assert.deepEqual(altChordAction(ev('BracketLeft', { shift: true })), { type: 'cycle', dir: 'prev' });
});

test('Alt+1..9 switch to a 0-based session index', () => {
  assert.deepEqual(altChordAction(ev('Digit1')), { type: 'switch', index: 0 });
  assert.deepEqual(altChordAction(ev('Digit9')), { type: 'switch', index: 8 });
  assert.equal(altChordAction(ev('Digit0')), null, 'Digit0 is not bound');
});

test('classification is by e.code, immune to Option-composed e.key', () => {
  // macOS: Option+T yields key "†" but code stays "KeyT" — must still classify.
  assert.deepEqual(altChordAction(ev('KeyT', { key: '†' })), { type: 'new' });
  assert.deepEqual(altChordAction(ev('Digit1', { key: '¡' })), { type: 'switch', index: 0 });
});

test('cycle chords require Shift; plain Alt+bracket is unbound', () => {
  assert.equal(altChordAction(ev('BracketRight')), null);
  assert.equal(altChordAction(ev('BracketLeft')), null);
});

test('missing Alt, or a competing modifier, classifies as nothing', () => {
  assert.equal(altChordAction(ev('KeyT', { alt: false })), null, 'no Alt → not ours');
  assert.equal(altChordAction(ev('KeyT', { meta: true })), null, 'Cmd+Alt is the desktop realm');
  assert.equal(altChordAction(ev('KeyT', { ctrl: true })), null, 'Ctrl+Alt is not a chord');
  assert.equal(altChordAction(ev('KeyF')), null, 'unbound letters classify as nothing');
  assert.equal(altChordAction(null), null, 'a null event is safe');
});
