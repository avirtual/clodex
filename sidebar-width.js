'use strict';
// sidebar-width.js — the clamp/reset decision for the resizable sidebar
// (Task 17, GH#7). Pure leaf, shared by BOTH hosts: stores.js clamps
// uiSettings.sidebarWidth on read AND write through it, and the renderer clamps
// every drag frame + the pre-paint localStorage mirror through the same fn, so
// a persisted or dragged width can never escape the range the CSS layout was
// built for.
//
// clampSidebarWidth(px): a finite number is rounded and clamped to
// [MIN, MAX]; anything else (non-number, NaN, Infinity — a missing key, a
// corrupt settings file, a bad drag value) falls back to DEFAULT. The floor
// keeps the toolbar/filter chrome from collapsing; the ceiling keeps the
// terminal usable.
//
// NEW leaf (not a coordinator extraction) → per the external-link.js /
// sandbox-view.js / tool-doctor.js precedent, deliberately NOT added to the
// free-identifier-leaks SCANNED lists.
const SIDEBAR_WIDTH_MIN = 160;
const SIDEBAR_WIDTH_MAX = 560;
const SIDEBAR_WIDTH_DEFAULT = 220;

function clampSidebarWidth(px) {
  if (typeof px !== 'number' || !Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  const r = Math.round(px);
  if (r < SIDEBAR_WIDTH_MIN) return SIDEBAR_WIDTH_MIN;
  if (r > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_MAX;
  return r;
}

module.exports = {
  clampSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
};
