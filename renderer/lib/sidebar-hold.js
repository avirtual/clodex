'use strict';

function createSidebarHold({ refresh, paint = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, delayMs = 250 }) {
  let timer = null;
  let pending = false;
  let pointer = false;
  const keys = new Set();

  const held = () => pointer || keys.size > 0;

  const settle = () => {
    if (timer) { clearTimeoutFn(timer); timer = null; }
    pending = false;
  };

  const schedule = () => {
    if (held()) pending = true;
    if (timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      if (held()) { pending = true; paint(); return; }
      pending = false;
      refresh();
    }, delayMs);
  };

  const releaseIfFree = () => {
    if (held() || !pending) return;
    settle();
    refresh();
  };

  return {
    schedule,
    settle,
    held,
    pointerEnter(pointerType) { if (pointerType !== 'touch') pointer = true; },
    pointerLeave() { pointer = false; releaseIfFree(); },
    hold(key) { keys.add(key); },
    unhold(key) { keys.delete(key); releaseIfFree(); },
    releaseAll() { pointer = false; keys.clear(); releaseIfFree(); },
  };
}

function rowsToReveal(rows, { hidden, passes, collapsed }) {
  return rows.filter((row) => hidden(row) && passes(row) && !collapsed(row));
}

module.exports = { createSidebarHold, rowsToReveal };
