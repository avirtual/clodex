'use strict';

const LINE_WINDOW_MS = 10000;
const SUSPEND_MS = 60000;

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function createLoopStall({
  log,
  now = monotonicMs,
  wallNow = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  intervalMs = 500,
  warnMs = 1000,
} = {}) {
  let timer = null;
  let last = 0;
  let stalls = 0;
  let longestMs = 0;
  let lastAt = null;
  let lastLineAt = null;
  let held = 0;
  let heldLongest = 0;

  function tick() {
    if (timer === null) return;
    const t = now();
    const late = Math.round(t - last - intervalMs);
    last = t;
    if (late < warnMs) return;
    const endedAt = wallNow();
    stalls++;
    if (late > longestMs) longestMs = late;
    lastAt = endedAt;
    if (lastLineAt !== null && t - lastLineAt < LINE_WINDOW_MS) {
      held++;
      if (late > heldLongest) heldLongest = late;
      return;
    }
    lastLineAt = t;
    const what = late > SUSPEND_MS ? 'blocked or suspended' : 'blocked';
    const more = held > 0 ? ` +${held} more, longest ${heldLongest} ms` : '';
    held = 0;
    heldLongest = 0;
    try {
      log.warn('loop', `main process ${what} for ${late} ms (ended ${new Date(endedAt).toISOString()})${more}`);
    } catch {}
  }

  function start() {
    if (timer !== null) return;
    last = now();
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer === null) return;
    const t = timer;
    timer = null;
    clearTimer(t);
  }

  function stats() {
    return { stalls, longestMs, lastAt };
  }

  return { start, stop, stats };
}

module.exports = { createLoopStall };
