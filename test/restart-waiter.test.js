// Run: node --test
// Covers restart-waiter.js (T32): the busy/idle classifier and the sustained-idle
// waiter. Driven by a fake clock + fake timer wheel (no real setTimeout), same
// pattern as remind-scheduler.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyRestart, createIdleWaiter } = require('../restart-waiter');

// --- classifyRestart -------------------------------------------------------

test('classifyRestart: only mid-turn agent seats count busy; idle + bash + dead do not', () => {
  const sessions = [
    { name: 'a', agentType: 'claude', activityState: 'thinking' }, // busy
    { name: 'b', agentType: 'codex', activityState: 'thinking' },  // busy
    { name: 'c', agentType: 'claude', activityState: 'idle' },     // idle
    { name: 'd', agentType: null, activityState: 'idle' },         // bash → idle
    { name: 'e', agentType: 'claude', activityState: 'thinking', _dead: true }, // dead → ignored
    { name: 'f', agentType: null },                                // bash, no state → idle
  ];
  assert.deepStrictEqual(classifyRestart(sessions), { busy: 2, idle: 3 },
    'two mid-turn agents busy; two idle-ish agents + two bash minus the dead one = 3 idle');
});

test('classifyRestart: a bash pane is never busy even if it somehow carries a non-idle state', () => {
  // Defensive: agentType is the gate, not just the activityState seed.
  const sessions = [{ name: 'sh', agentType: null, activityState: 'thinking' }];
  assert.deepStrictEqual(classifyRestart(sessions), { busy: 0, idle: 1 });
});

test('classifyRestart: an unknown non-idle state on an agent counts busy (conservative read)', () => {
  const sessions = [{ name: 'a', agentType: 'claude', activityState: 'permission' }];
  assert.deepStrictEqual(classifyRestart(sessions), { busy: 1, idle: 0 },
    'anything not idle on an agent is treated as mid-turn');
});

test('classifyRestart: no sessions → zero/zero', () => {
  assert.deepStrictEqual(classifyRestart([]), { busy: 0, idle: 0 });
});

// --- fake clock + timer wheel (mirrors remind-scheduler.test.js) -----------

function fakeClock(startMs) {
  let cur = startMs;
  let seq = 0;
  const timers = new Map(); // handle -> { at, fn }
  return {
    now: () => cur,
    setTimer: (fn, delay) => { const h = ++seq; timers.set(h, { at: cur + delay, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
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
    pending: () => timers.size,
  };
}

// A waiter over a fake clock + a mutable session snapshot the test drives.
function freshWaiter(startMs = 1_000_000, opts = {}) {
  const clock = fakeClock(startMs);
  let snapshot = [];
  const events = []; // 'restart' | 'notify'
  const waiter = createIdleWaiter({
    getSessions: () => snapshot,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    restart: () => events.push('restart'),
    notify: () => events.push('notify'),
    ...opts,
  });
  return {
    waiter, clock, events,
    setSessions: (s) => { snapshot = s; },
  };
}

const BUSY = [{ name: 'a', agentType: 'claude', activityState: 'thinking' }];
const IDLE = [{ name: 'a', agentType: 'claude', activityState: 'idle' }];

// --- the sustained-idle waiter ---------------------------------------------

test('waiter: fires restart only after a SUSTAINED quiet window, not on an instant-idle snapshot', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE); // already idle at arm time
  assert.strictEqual(waiter.arm(), true, 'arm returns true on a fresh arm');
  // First tick (t+2s): all idle → streak begins, but 2s < 10s so no restart yet.
  clock.advance(2000);
  assert.deepStrictEqual(events, [], 'no restart on the first idle sample — a snapshot is not rest');
  assert.ok(waiter.isArmed(), 'still armed, still polling');
  // Advance past the 10s sustained window (needs ~5 more ticks).
  clock.advance(10_000);
  assert.deepStrictEqual(events, ['restart'], 'restart fires once the 10s quiet window is sustained');
  assert.strictEqual(waiter.isArmed(), false, 'the waiter is one-shot — disarmed after firing');
});

test('waiter: a busy sample mid-wait RESETS the 10s window', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE);
  waiter.arm();
  clock.advance(6000); // ~3 idle ticks — streak building (6s < 10s)
  assert.deepStrictEqual(events, [], 'not yet');
  setSessions(BUSY);   // work resumes
  clock.advance(4000); // ticks see busy → streak reset; 6+4=10s total but streak broke
  assert.deepStrictEqual(events, [], 'busy sample reset the window — no restart despite 10s elapsed');
  setSessions(IDLE);   // quiets again
  clock.advance(8000); // 8s of new streak — still short
  assert.deepStrictEqual(events, [], 'new streak not yet sustained');
  clock.advance(4000); // now the new streak clears 10s
  assert.deepStrictEqual(events, ['restart'], 'restart fires only after the NEW sustained window');
});

test('waiter: never-quiet gives up at the 30m cap with a notify, no forced restart', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(BUSY); // stays busy forever
  waiter.arm();
  clock.advance(29 * 60_000); // 29 min of busy polling
  assert.deepStrictEqual(events, [], 'still waiting before the cap');
  assert.ok(waiter.isArmed(), 'armed right up to the cap');
  clock.advance(2 * 60_000); // cross 30 min
  assert.deepStrictEqual(events, ['notify'], 'gives up with a notification — NOT a restart');
  assert.strictEqual(waiter.isArmed(), false, 'disarmed after giving up');
});

test('waiter: cap wins a same-tick collision with a completed streak (cap checked first)', () => {
  // The discriminating case: the sustained window COMPLETES on the very tick the
  // cap expires. Cap-first → notify; streak-first would restart. A test that stays
  // busy to the horizon can't tell the orderings apart (both notify).
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(BUSY);
  waiter.arm();
  clock.advance(29 * 60_000 + 48_000); // busy through the 29:48 tick — streak held at null
  assert.deepStrictEqual(events, [], 'still waiting, still busy');
  setSessions(IDLE); // quiets at 29:48; streak begins on the 29:50 tick
  clock.advance(12_000); // ticks 29:50 → 30:00 — at 30:00 streak hits 10s AND cap expires
  assert.deepStrictEqual(events, ['notify'], 'cap outranks the just-completed streak — notify, not restart');
});

test('waiter: double-arm is a no-op — one waiter, one window', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE);
  assert.strictEqual(waiter.arm(), true);
  assert.strictEqual(waiter.arm(), false, 'second arm while armed is a no-op');
  assert.strictEqual(clock.pending(), 1, 'still a single pending timer (no doubled poll loop)');
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart'], 'exactly one restart despite the double arm');
});

test('waiter: disarm cancels a pending wait; a later idle window does NOT fire', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE);
  waiter.arm();
  clock.advance(4000);
  waiter.disarm();
  assert.strictEqual(waiter.isArmed(), false, 'disarmed');
  assert.strictEqual(clock.pending(), 0, 'no lingering timer');
  clock.advance(60_000);
  assert.deepStrictEqual(events, [], 'a disarmed waiter never fires');
});

test('waiter: re-arm after firing works (not permanently spent)', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE);
  waiter.arm();
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart']);
  // Arm again — a fresh window.
  assert.strictEqual(waiter.arm(), true, 're-arm after a fire is allowed');
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart', 'restart'], 'second sustained window fires again');
});
