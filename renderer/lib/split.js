'use strict';

function clampPx(px, { min, maxFraction, defaultFraction, containerPx }) {
  const max = Math.max(min, Math.floor(containerPx * maxFraction));
  const want = (typeof px === 'number' && Number.isFinite(px)) ? Math.round(px) : Math.round(containerPx * defaultFraction);
  return Math.min(max, Math.max(min, want));
}

function sizeFromPointer({ edge, rect, pointer }) {
  if (edge === 'left') return rect.right - pointer.x;
  if (edge === 'top') return rect.bottom - pointer.y;
  if (edge === 'bottom') return pointer.y - rect.top;
  return NaN;
}

function clampFraction(f, { min, max, fallback }) {
  if (typeof f !== 'number' || !Number.isFinite(f)) return fallback;
  return Math.min(max, Math.max(min, f));
}

module.exports = { clampPx, sizeFromPointer, clampFraction };
