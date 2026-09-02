'use strict';

const MARGIN = 8;
const GAP = 6;

function isDetachedRect(rect) {
  return !rect
    || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0);
}

function barPlacement(rect, size, viewport, margin = MARGIN) {
  const maxBottom = Math.max(margin, viewport.height - size.height - margin);
  if (isDetachedRect(rect)) return { left: margin, bottom: margin, detached: true };
  const left = Math.max(margin, Math.min(rect.left, viewport.width - size.width - margin));
  const wantBottom = Math.max(margin, viewport.height - rect.top + GAP);
  return { left, bottom: Math.min(wantBottom, maxBottom), detached: false };
}

function liveAnchor(captured, selector) {
  if (captured && captured.isConnected) return captured;
  const live = selector ? document.querySelector(selector) : null;
  return live || captured || null;
}

function placeAboveAnchor(popover, anchor, selector) {
  const el = liveAnchor(anchor, selector);
  const p = barPlacement(
    el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null,
    { width: popover.offsetWidth, height: popover.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  popover.style.left = `${p.left}px`;
  popover.style.bottom = `${p.bottom}px`;
  return p;
}

module.exports = { isDetachedRect, barPlacement, liveAnchor, placeAboveAnchor, MARGIN, GAP };
