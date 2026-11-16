'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSidebarHold } = require('../renderer/lib/sidebar-hold');

function mk() {
  const state = { refreshes: 0, paints: 0, now: 0, timers: new Map(), seq: 0 };
  const hold = createSidebarHold({
    refresh: () => { state.refreshes++; },
    paint: () => { state.paints++; },
    setTimeoutFn: (fn, ms) => { const id = ++state.seq; state.timers.set(id, { fn, at: state.now + ms }); return id; },
    clearTimeoutFn: (id) => { state.timers.delete(id); },
    delayMs: 250,
  });
  const advance = (ms) => {
    state.now += ms;
    for (const [id, t] of [...state.timers]) {
      if (t.at <= state.now) { state.timers.delete(id); t.fn(); }
    }
  };
  return { hold, state, advance };
}

test('with nothing held, a background relayout refreshes once after the debounce', () => {
  const { hold, state, advance } = mk();
  hold.schedule();
  hold.schedule();
  advance(249);
  assert.strictEqual(state.refreshes, 0);
  advance(1);
  assert.strictEqual(state.refreshes, 1);
});

test('a background relayout while the pointer is inside does not refresh; one refresh runs on leave', () => {
  const { hold, state, advance } = mk();
  hold.pointerEnter('mouse');
  hold.schedule();
  advance(1000);
  assert.strictEqual(state.refreshes, 0);
  assert.strictEqual(state.paints, 1);
  hold.pointerLeave();
  assert.strictEqual(state.refreshes, 1);
  advance(1000);
  assert.strictEqual(state.refreshes, 1);
});

test('several held relayouts produce exactly one refresh', () => {
  const { hold, state, advance } = mk();
  hold.schedule();
  hold.pointerEnter('mouse');
  advance(250);
  hold.schedule();
  hold.schedule();
  advance(1000);
  assert.strictEqual(state.refreshes, 0);
  hold.pointerLeave();
  advance(1000);
  assert.strictEqual(state.refreshes, 1);
});

test('a relayout scheduled before the pointer entered and still pending on leave refreshes once', () => {
  const { hold, state, advance } = mk();
  hold.schedule();
  hold.pointerEnter('mouse');
  hold.schedule();
  hold.pointerLeave();
  assert.strictEqual(state.refreshes, 1);
  advance(1000);
  assert.strictEqual(state.refreshes, 1);
});

test('an operator refresh while inside runs at once and clears the pending one', () => {
  const { hold, state, advance } = mk();
  hold.pointerEnter('mouse');
  hold.schedule();
  hold.refreshNow();
  assert.strictEqual(state.refreshes, 1);
  hold.pointerLeave();
  advance(1000);
  assert.strictEqual(state.refreshes, 1);
});

test('an outside settle (the refresh itself) drops a pending debounce', () => {
  const { hold, state, advance } = mk();
  hold.schedule();
  hold.settle();
  advance(1000);
  assert.strictEqual(state.refreshes, 0);
});

test('blur releases the pointer and every key hold, applying what is pending', () => {
  const { hold, state } = mk();
  hold.pointerEnter('mouse');
  hold.hold('rename');
  hold.hold('menu');
  hold.schedule();
  hold.releaseAll();
  assert.strictEqual(state.refreshes, 1);
  assert.strictEqual(hold.held(), false);
});

test('a hold with nothing pending causes no refresh on leave', () => {
  const { hold, state, advance } = mk();
  hold.pointerEnter('mouse');
  hold.pointerLeave();
  hold.hold('rename');
  hold.unhold('rename');
  hold.releaseAll();
  advance(1000);
  assert.strictEqual(state.refreshes, 0);
});

test('rename-open holds without the pointer, and its end applies the pending refresh', () => {
  const { hold, state, advance } = mk();
  hold.hold('rename');
  hold.schedule();
  advance(1000);
  assert.strictEqual(state.refreshes, 0);
  hold.unhold('rename');
  assert.strictEqual(state.refreshes, 1);
});

test('the pointer leaving while a rename is open does not release it', () => {
  const { hold, state } = mk();
  hold.hold('rename');
  hold.pointerEnter('mouse');
  hold.schedule();
  hold.pointerLeave();
  assert.strictEqual(state.refreshes, 0);
  hold.unhold('rename');
  assert.strictEqual(state.refreshes, 1);
});

test('a touch pointer never engages the hold, so a tap cannot leave it stuck', () => {
  const { hold, state, advance } = mk();
  hold.pointerEnter('touch');
  assert.strictEqual(hold.held(), false);
  hold.schedule();
  advance(250);
  assert.strictEqual(state.refreshes, 1);
});
