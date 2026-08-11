// Run: node --test
// Pure clamp math for the shared popover-drag helper (T29 Layer A Slice 4 C5). The
// mousedown/move DOM wiring is imperative + untested; clampTranslate is the piece
// worth pinning — it keeps a dragged popover inside the viewport margin.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { anchorRect, clampTranslate } = require('../renderer/lib/popover-drag');

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

// anchorRect — the anchor-less open. A popover opened from a NATIVE MENU item
// (the Teams menu, t288) has no anchor element, and the throw that a naive
// dereference produces surfaces only when a human clicks a team in the menu, so
// no other test in this suite would reach it.

test('anchorRect: a real anchor element passes its own rect through', () => {
  const box = { left: 40, bottom: 90, top: 60, width: 120, height: 30 };
  const el = { getBoundingClientRect: () => box };
  assert.strictEqual(anchorRect(el), box, 'the element rect wins — no fallback when there is a box');
});

test('anchorRect: no anchor at all yields the viewport-origin fallback', () => {
  // null is the menu-driven open; the others are the ways a caller can arrive
  // holding something that merely LOOKS like an element.
  for (const nothing of [null, undefined, false, {}, { getBoundingClientRect: null }]) {
    assert.deepStrictEqual(anchorRect(nothing), { left: 24, bottom: 24 },
      `${JSON.stringify(nothing)} must not throw`);
  }
});
