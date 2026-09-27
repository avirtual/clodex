'use strict';

const { sizeFromPointer } = require('./lib/split');

function attachSplitter(handleEl, {
  edge, rect, clamp, apply, commit, reset, throttleMs = 0, dragClass,
  doc = document, win = window, now = () => Date.now(),
}) {
  let dragging = false;
  let pending = null;
  let rafId = 0;
  let timer = null;
  let lastApply = -Infinity;

  const applyPending = () => {
    timer = null;
    if (pending == null) return;
    lastApply = now();
    apply(pending);
  };
  const onFrame = () => {
    rafId = 0;
    if (timer) return;
    const wait = throttleMs - (now() - lastApply);
    if (wait <= 0) applyPending();
    else timer = win.setTimeout(applyPending, wait);
  };

  const onDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    pending = null;
    if (dragClass) doc.body.classList.add(dragClass);
    try { handleEl.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    pending = clamp(sizeFromPointer({ edge, rect: rect(), pointer: { x: e.clientX, y: e.clientY } }));
    if (!rafId) rafId = win.requestAnimationFrame(onFrame);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    if (dragClass) doc.body.classList.remove(dragClass);
    try { handleEl.releasePointerCapture(e.pointerId); } catch {}
    if (rafId) { win.cancelAnimationFrame(rafId); rafId = 0; }
    if (timer) { win.clearTimeout(timer); timer = null; }
    const final = pending;
    pending = null;
    if (final == null) return;
    apply(final);
    commit(final);
  };
  const onDbl = () => { if (typeof reset === 'function') reset(); };

  handleEl.addEventListener('pointerdown', onDown);
  handleEl.addEventListener('pointermove', onMove);
  handleEl.addEventListener('pointerup', onUp);
  handleEl.addEventListener('pointercancel', onUp);
  handleEl.addEventListener('dblclick', onDbl);

  return {
    dispose() {
      handleEl.removeEventListener('pointerdown', onDown);
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      handleEl.removeEventListener('dblclick', onDbl);
      if (rafId) { win.cancelAnimationFrame(rafId); rafId = 0; }
      if (timer) { win.clearTimeout(timer); timer = null; }
      if (dragging && dragClass) doc.body.classList.remove(dragClass);
      dragging = false;
    },
  };
}

module.exports = { attachSplitter };
