'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { clampPx, sizeFromPointer, clampFraction, DOCK_SPLIT_MIN, DOCK_SPLIT_MAX } = require('../renderer/lib/split');

const BOUNDS = { min: 320, maxFraction: 0.6, defaultFraction: 0.4, containerPx: 1000 };

const CLAMP_PX_ROWS = [
  { name: 'inside the bounds, kept', px: 450, bounds: BOUNDS, want: 450 },
  { name: 'rounded to an integer', px: 450.6, bounds: BOUNDS, want: 451 },
  { name: 'under the min, raised to it', px: 100, bounds: BOUNDS, want: 320 },
  { name: 'over the max fraction, lowered to it', px: 900, bounds: BOUNDS, want: 600 },
  { name: 'null → the default fraction', px: null, bounds: BOUNDS, want: 400 },
  { name: 'NaN → the default fraction', px: NaN, bounds: BOUNDS, want: 400 },
  { name: 'a string → the default fraction', px: '500', bounds: BOUNDS, want: 400 },
  { name: 'a container too small for the min, the min wins over the max', px: 400, bounds: { ...BOUNDS, containerPx: 400 }, want: 320 },
  { name: 'the default fraction still clamped to the min', px: null, bounds: { ...BOUNDS, containerPx: 700 }, want: 320 },
];

for (const row of CLAMP_PX_ROWS) {
  test(`clampPx: ${row.name}`, () => {
    assert.strictEqual(clampPx(row.px, row.bounds), row.want);
  });
}

const RECT = { top: 100, right: 900, bottom: 700, left: 200 };

const POINTER_ROWS = [
  { name: "edge 'left' measures from the rect's right", edge: 'left', pointer: { x: 600, y: 0 }, want: 300 },
  { name: "edge 'top' measures up from the rect's bottom", edge: 'top', pointer: { x: 0, y: 500 }, want: 200 },
  { name: "edge 'bottom' measures down from the rect's top", edge: 'bottom', pointer: { x: 0, y: 250 }, want: 150 },
  { name: "edge 'left' past the right edge goes negative", edge: 'left', pointer: { x: 950, y: 0 }, want: -50 },
];

for (const row of POINTER_ROWS) {
  test(`sizeFromPointer: ${row.name}`, () => {
    assert.strictEqual(sizeFromPointer({ edge: row.edge, rect: RECT, pointer: row.pointer }), row.want);
  });
}

test('sizeFromPointer: an unknown edge throws rather than returning NaN', () => {
  assert.throws(() => sizeFromPointer({ edge: 'right', rect: RECT, pointer: { x: 600, y: 250 } }), /unknown edge right/);
});

test('the dock split bounds are exported as [0.2, 0.8]', () => {
  assert.strictEqual(DOCK_SPLIT_MIN, 0.2);
  assert.strictEqual(DOCK_SPLIT_MAX, 0.8);
});

const RANGE = { min: 0.2, max: 0.8, fallback: 0.5 };

const FRACTION_ROWS = [
  { name: 'inside the range, kept', f: 0.35, want: 0.35 },
  { name: 'under the min, raised to it', f: 0.05, want: 0.2 },
  { name: 'over the max, lowered to it', f: 0.95, want: 0.8 },
  { name: 'null → the fallback', f: null, want: 0.5 },
  { name: 'NaN → the fallback', f: NaN, want: 0.5 },
  { name: 'Infinity → the fallback', f: Infinity, want: 0.5 },
  { name: 'a string → the fallback', f: '0.3', want: 0.5 },
];

for (const row of FRACTION_ROWS) {
  test(`clampFraction: ${row.name}`, () => {
    assert.strictEqual(clampFraction(row.f, RANGE), row.want);
  });
}
