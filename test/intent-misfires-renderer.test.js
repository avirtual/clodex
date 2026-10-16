'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fmtTime, fmtCtx, intentLabel, preview, countsLine } = require('../plugins/intent-misfires/renderer');

test('fmtTime: local wall-clock to the second in the given zone; blank without a time', () => {
  assert.strictEqual(fmtTime(Date.UTC(2026, 9, 16, 23, 41, 7), 'UTC'), '2026-10-16 23:41:07');
  assert.strictEqual(fmtTime(Date.UTC(2026, 9, 16, 23, 41, 7), 'America/New_York'), '2026-10-16 19:41:07');
  assert.strictEqual(fmtTime(null, 'UTC'), '');
});

test('fmtCtx: thousands as k, small counts verbatim, unknown blank', () => {
  assert.strictEqual(fmtCtx(123456), '123k');
  assert.strictEqual(fmtCtx(999), '999');
  assert.strictEqual(fmtCtx(null), '');
});

test('intentLabel: verb plus sub-verb or command when present', () => {
  assert.strictEqual(intentLabel({ intent: 'exec', sub: 'run-tests' }), 'exec run-tests');
  assert.strictEqual(intentLabel({ intent: 'dm', sub: null }), 'dm');
});

test('preview: 80 characters at most, whitespace flattened', () => {
  assert.strictEqual(preview('a\n  b'), 'a b');
  const p = preview('x'.repeat(120));
  assert.strictEqual(p.length, 80);
  assert.ok(p.endsWith('…'));
});

test('countsLine: seats and kinds sorted, one segment per seat', () => {
  assert.strictEqual(countsLine({ lead: { bounce: 2, 'unclosed-body': 1 }, hand: { schema: 1 } }),
    'hand: schema 1 · lead: bounce 2, unclosed-body 1');
  assert.strictEqual(countsLine({}), '');
});
