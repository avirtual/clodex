// Run: node --test
// Covers remind-scheduler.js — the durable-schedule engine: single nearest-fire
// timer arming, one-shot vs recurring firing, missed-fire coalescing at start(),
// the ~24.8-day setTimeout clamp hop, fireCompactFor, and cancel/list. Driven by
// a fake clock + fake timers (no real setTimeout) over the REAL reminders store
// on a temp userData dir.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { initStores } = require('../stores');
const { createRemindScheduler, MAX_TIMER_MS } = require('../remind-scheduler');

// Fake clock + timer wheel. `now` is a mutable epoch; setTimer records a due
// time; advance() walks time forward firing due callbacks in order (a callback
// may arm new timers, which the loop then picks up — exercises re-arm/hop).
function fakeClock(startMs) {
  let cur = startMs;
  let seq = 0;
  const timers = new Map(); // handle -> { at, fn }
  return {
    now: () => cur,
    setTimer: (fn, delay) => { const h = ++seq; timers.set(h, { at: cur + delay, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
    // Advance to cur+ms, firing every timer whose due time is reached, in order.
    advance(ms) {
      const target = cur + ms;
      for (;;) {
        let next = null;
        for (const [h, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.t.at)) next = { h, t };
        }
        if (!next) break;
        timers.delete(next.h);
        cur = next.t.at;
        next.t.fn();
      }
      cur = target;
    },
    set(ms) { cur = ms; },
    pending: () => timers.size,
  };
}

// A scheduler over a fresh temp store + fake clock, plus a deliver spy.
function freshEngine(startMs) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'remsched-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remsched-reg-'));
  const stores = initStores(userData, { log: console, registryDir });
  const clock = fakeClock(startMs);
  const fires = []; // { agent, id, spec, body }
  const deliver = (agent, id, spec, body) => fires.push({ agent, id, spec, body });
  const scheduler = createRemindScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    store: stores.reminders, deliver,
  });
  return {
    scheduler, clock, fires, store: stores.reminders,
    cleanup() {
      scheduler.stop();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

const T0 = 1_700_000_000_000; // arbitrary fixed epoch
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('add: one-shot `in` fires once at its time, then is gone', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    const r = scheduler.add('t1', 'in 30m', 'ping');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store.list().length, 1);
    clock.advance(29 * MIN); // not yet
    assert.strictEqual(fires.length, 0);
    clock.advance(2 * MIN);  // crosses 30m
    assert.deepStrictEqual(fires, [{ agent: 't1', id: r.record.id, spec: 'in 30m', body: 'ping' }]);
    assert.strictEqual(store.list().length, 0); // one-shot removed
    clock.advance(HOUR);
    assert.strictEqual(fires.length, 1); // never fires again
  } finally { cleanup(); }
});

test('add: recurring `every` re-fires each interval and persists forward', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    const r = scheduler.add('t1', 'every 30m', 'tick');
    clock.advance(30 * MIN);
    clock.advance(30 * MIN);
    clock.advance(30 * MIN);
    assert.strictEqual(fires.length, 3);
    assert.strictEqual(store.list().length, 1); // still scheduled
    const rec = store.get(r.record.id);
    assert.strictEqual(rec.nextFireAt, T0 + 4 * 30 * MIN); // recomputed forward
    assert.strictEqual(rec.lastFiredAt, T0 + 3 * 30 * MIN);
  } finally { cleanup(); }
});

test('nearest-fire ordering: two schedules fire in time order off one timer', () => {
  const { scheduler, clock, fires, cleanup } = freshEngine(T0);
  try {
    scheduler.add('t1', 'in 2h', 'late');
    scheduler.add('t1', 'in 30m', 'soon');
    clock.advance(90 * MIN);
    assert.deepStrictEqual(fires.map((f) => f.body), ['soon']); // only the nearer one
    clock.advance(90 * MIN);
    assert.deepStrictEqual(fires.map((f) => f.body), ['soon', 'late']);
  } finally { cleanup(); }
});

test('missed fires coalesce to ONE late fire at start(), recurring recomputes forward', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    const r = scheduler.add('t1', 'every 30m', 'tick');
    // Simulate the app being DOWN for 5 hours: jump the clock past 10 intervals
    // WITHOUT advancing timers (no fires happened while down).
    clock.set(T0 + 5 * HOUR);
    scheduler.start();
    assert.strictEqual(fires.length, 1); // exactly one coalesced late fire, not 10
    const rec = store.get(r.record.id);
    assert.strictEqual(rec.nextFireAt, T0 + 5 * HOUR + 30 * MIN); // forward from now, no backlog
    // And it keeps ticking normally from there.
    clock.advance(30 * MIN);
    assert.strictEqual(fires.length, 2);
  } finally { cleanup(); }
});

test('missed one-shot fires once at start() and is removed', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    scheduler.add('t1', 'in 30m', 'once');
    clock.set(T0 + 3 * HOUR); // way past, app was down
    scheduler.start();
    assert.strictEqual(fires.length, 1);
    assert.strictEqual(store.list().length, 0);
  } finally { cleanup(); }
});

test('far-future schedule uses the 24.8-day clamp hop, not an immediate fire', () => {
  const { scheduler, clock, fires, cleanup } = freshEngine(T0);
  try {
    // 40 days out — beyond the ~24.85-day setTimeout clamp.
    const days40 = 40 * 24 * HOUR;
    scheduler.add('t1', `in ${40 * 24}h`, 'far');
    // Walk the max clamp once: must NOT fire (it's a bare re-arm hop).
    clock.advance(MAX_TIMER_MS);
    assert.strictEqual(fires.length, 0);
    // Advance the remainder to the real fire time.
    clock.advance(days40 - MAX_TIMER_MS + MIN);
    assert.deepStrictEqual(fires.map((f) => f.body), ['far']);
  } finally { cleanup(); }
});

test('add: past absolute `at` is rejected (never-fires guard)', () => {
  const { scheduler, cleanup } = freshEngine(T0);
  try {
    const past = new Date(T0 - HOUR).toISOString();
    const r = scheduler.add('t1', `at ${past}`, 'nope');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /past/);
  } finally { cleanup(); }
});

test('add: a bad spec bounces with the parser error (loud)', () => {
  const { scheduler, cleanup } = freshEngine(T0);
  try {
    assert.strictEqual(scheduler.add('t1', 'every 10s', 'x').ok, false); // under 60s floor
    assert.strictEqual(scheduler.add('t1', 'nonsense', 'x').ok, false);
    // management verbs aren't schedules
    assert.strictEqual(scheduler.add('t1', 'list', '').ok, false);
    assert.strictEqual(scheduler.add('t1', 'cancel ab12', '').ok, false);
  } finally { cleanup(); }
});

test('cancel: removes an own schedule (silent), bounces unknown / other-agent id', () => {
  const { scheduler, clock, fires, cleanup } = freshEngine(T0);
  try {
    const r = scheduler.add('t1', 'in 30m', 'x');
    assert.strictEqual(scheduler.cancel('t1', 'nope'), false); // unknown
    assert.strictEqual(scheduler.cancel('t2', r.record.id), false); // not t2's to cancel
    assert.strictEqual(scheduler.cancel('t1', r.record.id), true); // own -> silent success
    clock.advance(HOUR);
    assert.strictEqual(fires.length, 0); // cancelled before firing
  } finally { cleanup(); }
});

test('listForAgent: returns only the agent\'s schedules, verbatim spec', () => {
  const { scheduler, cleanup } = freshEngine(T0);
  try {
    scheduler.add('t1', 'every 30m', 'a');
    scheduler.add('t1', 'in 1h', 'b');
    scheduler.add('t2', 'in 2h', 'c');
    const mine = scheduler.listForAgent('t1');
    assert.deepStrictEqual(mine.map((r) => r.spec).sort(), ['every 30m', 'in 1h']);
    assert.deepStrictEqual(scheduler.listForAgent('t2').map((r) => r.spec), ['in 2h']);
  } finally { cleanup(); }
});

test('on compact: no timer fire; fireCompactFor delivers and persists (recurring event)', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    const r = scheduler.add('t1', 'on compact', 'reassess the plan');
    assert.strictEqual(store.get(r.record.id).nextFireAt, null); // no timer
    clock.advance(10 * HOUR);
    assert.strictEqual(fires.length, 0); // never timer-fires
    // Two compacts → two deliveries; the schedule persists (standing trigger).
    assert.strictEqual(scheduler.fireCompactFor('t1'), 1);
    assert.strictEqual(scheduler.fireCompactFor('t1'), 1);
    assert.strictEqual(fires.length, 2);
    assert.deepStrictEqual(fires[0], { agent: 't1', id: r.record.id, spec: 'on compact', body: 'reassess the plan' });
    assert.strictEqual(store.list().length, 1); // still there
    // Only the requesting agent's oncompact fires.
    assert.strictEqual(scheduler.fireCompactFor('t2'), 0);
    assert.strictEqual(fires.length, 2);
  } finally { cleanup(); }
});

test('start() coalesces missed + arms live, across a mix of schedule kinds', () => {
  const { scheduler, clock, fires, store, cleanup } = freshEngine(T0);
  try {
    scheduler.add('t1', 'every 1h', 'recur');   // will be missed
    scheduler.add('t1', 'in 90m', 'oneshot');   // will be missed
    scheduler.add('t1', 'on compact', 'evt');   // event, untouched by time
    scheduler.stop();
    clock.set(T0 + 10 * HOUR); // down for 10h
    scheduler.start();
    // recur fires once (coalesced), oneshot fires once; oncompact does not.
    assert.deepStrictEqual(fires.map((f) => f.body).sort(), ['oneshot', 'recur']);
    // oneshot gone, recur + oncompact remain.
    assert.strictEqual(store.list().length, 2);
    // recur keeps ticking forward from now.
    clock.advance(HOUR);
    assert.strictEqual(fires.filter((f) => f.body === 'recur').length, 2);
  } finally { cleanup(); }
});

test('renameAgent re-points one agent\'s schedules and leaves the timer alone', () => {
  const { scheduler, clock, store, cleanup } = freshEngine(1_000_000);
  try {
    scheduler.add('seat', 'in 1h', 'mine');
    scheduler.add('other', 'in 2h', 'not mine');
    scheduler.start();
    const armedBefore = clock.pending();

    assert.strictEqual(scheduler.renameAgent('seat', 'newseat'), 1, 'one schedule moved');
    assert.deepStrictEqual(scheduler.listForAgent('seat'), [], 'nothing answers to the old name');
    const moved = scheduler.listForAgent('newseat');
    assert.strictEqual(moved.length, 1, 'ENTER: the schedule is under the new name');
    assert.strictEqual(moved[0].body, 'mine');
    assert.strictEqual(moved[0].nextFireAt, 1_000_000 + 3600_000,
      'its fire time is untouched — only the agent changed');
    assert.deepStrictEqual(scheduler.listForAgent('other').map((r) => r.body), ['not mine']);
    assert.strictEqual(clock.pending(), armedBefore,
      'and no timer was re-armed: the nearest fire did not move');
    assert.deepStrictEqual(store.listForAgent('newseat').map((r) => r.body), ['mine'],
      'the DURABLE store carries it, not just the engine\'s view');
  } finally { cleanup(); }
});

test('renameAgent is a no-op for a missing agent, an empty name, or the same name', () => {
  const { scheduler, cleanup } = freshEngine(1_000_000);
  try {
    scheduler.add('seat', 'in 1h', 'mine');
    assert.strictEqual(scheduler.renameAgent('nobody', 'x'), 0);
    assert.strictEqual(scheduler.renameAgent('seat', 'seat'), 0, 'renaming to itself moves nothing');
    assert.strictEqual(scheduler.renameAgent('', 'x'), 0);
    assert.strictEqual(scheduler.renameAgent('seat', ''), 0);
    assert.deepStrictEqual(scheduler.listForAgent('seat').map((r) => r.body), ['mine'],
      'and the schedule is still where it was');
  } finally { cleanup(); }
});

test('MAX_TIMER_MS is the 32-bit signed setTimeout clamp', () => {
  assert.strictEqual(MAX_TIMER_MS, 2147483647);
});
