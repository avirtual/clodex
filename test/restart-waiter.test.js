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

// --- abandon watchers (t282) ------------------------------------------------
// [agent:reboot] arms this waiter instead of quitting under the requesting seat.
// That makes the give-up path reachable by a caller nobody is watching a desktop
// notification for: a seat told nothing sits blocked on a relaunch that will
// never come. These pin who gets told, and — just as load-bearing — who does not.

test('watcher: the 30m give-up tells every requester, including one that armed while armed', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(BUSY); // never settles
  assert.strictEqual(waiter.arm({ onAbandon: () => events.push('abandon:a') }), true);
  clock.advance(5 * 60_000);
  // A second seat reboots 5 minutes into the pending wait. The timer is a no-op
  // (the cap must not be pushed out), but this requester still has to hear.
  assert.strictEqual(waiter.arm({ onAbandon: () => events.push('abandon:b') }), false,
    'the pending wait already serves it — the window is not restarted');
  assert.strictEqual(clock.pending(), 1, 'ENTER: still one poll loop, so the cap below is the ORIGINAL horizon');
  clock.advance(24 * 60_000); // 29 min after the FIRST arm — before the cap
  assert.deepStrictEqual(events, [], 'nothing yet: still inside the original 30m horizon');
  clock.advance(2 * 60_000);
  assert.deepStrictEqual(events, ['notify', 'abandon:a', 'abandon:b'],
    'operator notified once, and BOTH requesters told the restart was dropped');
});

test('watcher: a restart that FIRES consumes its watchers rather than abandoning them', () => {
  // Two failures in one shape. Reporting "dropped" as the process dies would be
  // a lie the seat acts on; leaving the watcher REGISTERED instead is the quieter
  // bug — a later, unrelated wait gives up and replays a requester whose reboot
  // already happened. Silence alone cannot tell those apart from a watcher
  // mechanism that never worked, so the same waiter is driven to a give-up after.
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(IDLE);
  waiter.arm({ onAbandon: () => events.push('abandon') });
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart'], 'restart only — the request was fulfilled, not dropped');

  // Re-arm with nobody attached and let this one die at the cap.
  setSessions(BUSY);
  assert.strictEqual(waiter.arm(), true, 'ENTER: a genuinely fresh wait, so the cap below is reached');
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, ['restart', 'notify'],
    'the give-up notifies the operator only — the fulfilled watcher was consumed, not left armed');
});

test('watcher: cancelling a pending wait abandons it; consuming it silently does not', () => {
  // The two menu exits. "Cancel Pending Restart" owes the waiting agents the
  // news; "Restart Now" disarms only to take the restart itself, which fulfills
  // them.
  const cancelled = freshWaiter();
  cancelled.setSessions(BUSY);
  cancelled.waiter.arm({ onAbandon: () => cancelled.events.push('abandon') });
  cancelled.waiter.disarm({ abandoned: true });
  assert.deepStrictEqual(cancelled.events, ['abandon'], 'an operator cancel reaches the seat');

  const consumed = freshWaiter();
  consumed.setSessions(BUSY);
  consumed.waiter.arm({ onAbandon: () => consumed.events.push('abandon') });
  consumed.waiter.disarm(); // "Restart Now": disarm, then restart outside the waiter
  assert.deepStrictEqual(consumed.events, [], 'no false "dropped" ahead of a restart that IS happening');
});

test('watcher: watchers are one-shot — a later give-up does not re-notify a spent one', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(BUSY);
  waiter.arm({ onAbandon: () => events.push('abandon:first') });
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, ['notify', 'abandon:first'], 'ENTER: the first wait gave up and told its requester');
  // A fresh wait with nobody attached must not replay the old requester.
  waiter.arm();
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, ['notify', 'abandon:first', 'notify'],
    'second give-up notifies the operator only');
});

test('watcher: a throwing watcher does not stop the others or the give-up', () => {
  const { waiter, clock, events, setSessions } = freshWaiter();
  setSessions(BUSY);
  waiter.arm({ onAbandon: () => { throw new Error('seat is gone'); } });
  waiter.arm({ onAbandon: () => events.push('abandon:b') });
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, ['notify', 'abandon:b'], 'one bad watcher cannot silence the rest');
  assert.strictEqual(waiter.isArmed(), false, 'and the waiter still ended cleanly');
});
