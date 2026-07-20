// lib/popover-drag.js — make a position:fixed popover draggable by its title bar
// (T29 Layer A Slice 4 C5). A base-level, shared helper: any popover with a
// `.popover-title` opts in via makeDraggable(popover); openers call resetDrag()
// so a fresh open re-anchors instead of inheriting the last drag offset.
//
// Drag is applied as a CSS `transform: translate(dx,dy)` — an OFFSET on top of
// whatever left/top/bottom the opener set, so it composes with both top-anchored
// (team-roles) and bottom-anchored (checklist) popovers without knowing which.
// resetDrag() clears the transform; openers call it before positioning, which
// also covers the re-open-while-open case (opening a second team's popover while
// one is already visible — no hidden-class toggle, so a MutationObserver wouldn't
// fire; an explicit reset call is deterministic).
//
// The offset math (clampTranslate) is pure + unit-tested; the mousedown wiring is
// DOM-bound. Host globals only (window/document) — no requires.
'use strict';

// The applied drag offset per popover element, so makeDraggable and resetDrag
// share state without stamping it onto the DOM.
const offsets = new WeakMap();

// Clamp a desired translate so the popover stays within the viewport margin. Given
// the popover's UNTRANSFORMED rect (start/size per axis) and the raw desired
// delta, return the delta that keeps [start+delta, start+delta+size] inside
// [margin, viewport-margin]. When the popover is larger than the usable viewport,
// pin it to the start margin (minDelta) rather than letting it drift off-screen.
function clampAxis(start, size, delta, viewport, margin) {
  const minDelta = margin - start;
  const maxDelta = viewport - margin - size - start;
  if (maxDelta < minDelta) return minDelta;
  return Math.max(minDelta, Math.min(maxDelta, delta));
}

function clampTranslate(rect, dx, dy, vw, vh, margin = 8) {
  return {
    dx: clampAxis(rect.left, rect.width, dx, vw, margin),
    dy: clampAxis(rect.top, rect.height, dy, vh, margin),
  };
}

function applyOffset(popover, dx, dy) {
  offsets.set(popover, { dx, dy });
  popover.style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
}

// Zero a popover's drag offset + clear the transform. Openers call this before
// (re)positioning so the anchor logic wins on every open.
function resetDrag(popover) {
  if (popover) applyOffset(popover, 0, 0);
}

// Wire drag-by-title on a popover. Ignores mousedowns on buttons in the title (the
// close/help controls keep working) and only the primary button drags. Uses
// document-level move/up listeners so the drag survives the pointer leaving the
// title. Text selection of the title is suppressed (preventDefault); inputs live
// in the body, so their selection is untouched. The drag starts INSIDE the
// popover, so the existing mousedown-outside dismiss handlers skip it.
function makeDraggable(popover) {
  if (!popover) return;
  const title = popover.querySelector('.popover-title');
  if (!title) return;
  title.classList.add('draggable-title');
  title.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // close/help buttons handle themselves
    const cur = offsets.get(popover) || { dx: 0, dy: 0 };
    const startX = e.clientX;
    const startY = e.clientY;
    // Untransformed rect = the current on-screen rect minus the applied offset.
    const r = popover.getBoundingClientRect();
    const base = { left: r.left - cur.dx, top: r.top - cur.dy, width: r.width, height: r.height };
    e.preventDefault();
    title.classList.add('dragging');
    const onMove = (ev) => {
      const want = clampTranslate(
        base,
        cur.dx + (ev.clientX - startX),
        cur.dy + (ev.clientY - startY),
        window.innerWidth, window.innerHeight, 8,
      );
      applyOffset(popover, want.dx, want.dy);
    };
    const onUp = () => {
      title.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

module.exports = { clampTranslate, makeDraggable, resetDrag };
