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

  const defer = () => { pending = true; paint(); };

  const schedule = () => {
    if (held()) { defer(); return; }
    if (timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      if (held()) { defer(); return; }
      pending = false;
      refresh();
    }, delayMs);
  };

  const refreshNow = () => { settle(); refresh(); };

  const releaseIfFree = () => {
    if (held() || !pending) return;
    settle();
    refresh();
  };

  return {
    schedule,
    refreshNow,
    settle,
    held,
    pending: () => pending,
    pointerEnter(pointerType) { if (pointerType !== 'touch') pointer = true; },
    pointerLeave() { pointer = false; releaseIfFree(); },
    hold(key) { keys.add(key); },
    unhold(key) { keys.delete(key); releaseIfFree(); },
    releaseAll() { pointer = false; keys.clear(); releaseIfFree(); },
  };
}

module.exports = { createSidebarHold };
