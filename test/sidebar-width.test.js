'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  clampSidebarWidth,
  effectiveSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
} = require('../sidebar-width');

test('clampSidebarWidth: in-range numbers pass through (rounded)', () => {
  assert.equal(clampSidebarWidth(220), 220);
  assert.equal(clampSidebarWidth(160), 160);
  assert.equal(clampSidebarWidth(560), 560);
  assert.equal(clampSidebarWidth(300), 300);
  assert.equal(clampSidebarWidth(300.4), 300);
  assert.equal(clampSidebarWidth(300.6), 301);
});

test('clampSidebarWidth: out-of-range numbers clamp to the bounds', () => {
  assert.equal(clampSidebarWidth(159), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(0), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(-500), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(561), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(99999), SIDEBAR_WIDTH_MAX);
});

test('clampSidebarWidth: non-finite numbers fall back to the default', () => {
  assert.equal(clampSidebarWidth(NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(Infinity), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(-Infinity), SIDEBAR_WIDTH_DEFAULT);
});

test('clampSidebarWidth: non-number values fall back to the default', () => {
  assert.equal(clampSidebarWidth(undefined), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(null), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth('300'), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(''), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth({}), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth([220]), SIDEBAR_WIDTH_DEFAULT);
});

test('clampSidebarWidth: bounds are sane and default sits within them', () => {
  assert.ok(SIDEBAR_WIDTH_MIN < SIDEBAR_WIDTH_MAX);
  assert.ok(SIDEBAR_WIDTH_DEFAULT >= SIDEBAR_WIDTH_MIN);
  assert.ok(SIDEBAR_WIDTH_DEFAULT <= SIDEBAR_WIDTH_MAX);
});

test('effectiveSidebarWidth: folded is the rail, anything else is the clamped width', () => {
  const rows = [
    [{ folded: true, width: 300 }, 44],
    [{ folded: false, width: 300 }, 300],
    [{ folded: true, width: NaN }, 44],
    [{ folded: false, width: NaN }, 220],
    [{ folded: undefined, width: 600 }, 560],
  ];
  for (const [input, want] of rows) {
    assert.equal(effectiveSidebarWidth(input), want, JSON.stringify(input));
  }
});

test('sidebar-width exports exactly the clamp, the fold resolver and the bounds', () => {
  assert.deepStrictEqual(Object.keys(require('../sidebar-width')).sort(), [
    'SIDEBAR_RAIL_WIDTH',
    'SIDEBAR_WIDTH_DEFAULT',
    'SIDEBAR_WIDTH_MAX',
    'SIDEBAR_WIDTH_MIN',
    'clampSidebarWidth',
    'effectiveSidebarWidth',
  ]);
});
