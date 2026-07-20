// Run: node --test
// Pure clamp math for the shared popover-drag helper (T29 Layer A Slice 4 C5). The
// mousedown/move DOM wiring is imperative + untested; clampTranslate is the piece
// worth pinning — it keeps a dragged popover inside the viewport margin.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { clampTranslate } = require('../renderer/lib/popover-drag');

// A 200x100 popover sitting at (100,100) in a 1000x800 viewport, margin 8.
const rect = { left: 100, top: 100, width: 200, height: 100 };

test('clampTranslate: a small move within bounds passes through unchanged', () => {
  assert.deepStrictEqual(clampTranslate(rect, 50, 40, 1000, 800, 8), { dx: 50, dy: 40 });
});

test('clampTranslate: dragging past the left/top margin is clamped to the margin', () => {
  // left would go to 100 + (-200) = -100; min allowed left is margin(8) → dx = 8-100 = -92.
  const r = clampTranslate(rect, -200, -200, 1000, 800, 8);
  assert.strictEqual(r.dx, -92, 'left pinned to margin');
  assert.strictEqual(r.dy, -92, 'top pinned to margin');
});

test('clampTranslate: dragging past the right/bottom margin is clamped', () => {
  // right edge max: vw - margin - width - left = 1000-8-200-100 = 692.
  // bottom edge max: vh - margin - height - top = 800-8-100-100 = 592.
  const r = clampTranslate(rect, 5000, 5000, 1000, 800, 8);
  assert.strictEqual(r.dx, 692, 'right pinned to margin');
  assert.strictEqual(r.dy, 592, 'bottom pinned to margin');
});

test('clampTranslate: a popover larger than the viewport pins to the start margin', () => {
  // 2000-wide popover in a 1000 viewport: maxDelta < minDelta → pin to minDelta.
  const big = { left: 100, top: 100, width: 2000, height: 100 };
  const r = clampTranslate(big, 500, 0, 1000, 800, 8);
  assert.strictEqual(r.dx, 8 - 100, 'pinned to left margin (minDelta), not drifting off-screen');
});
