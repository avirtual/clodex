// Run: node --test
// Covers restart-waiter.js (T32): the busy/idle classifier and the sustained-idle
// waiter. Driven by a fake clock + fake timer wheel (no real setTimeout), same
// pattern as remind-scheduler.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyRestart, createIdleWaiter, giveUpBody, restartDetail, pendingDetail, createQuitGuard, quitGiveUpBody } = require('../restart-waiter');

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
  const deps = {
    getSessions: () => snapshot,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    restart: () => events.push('restart'),
    notify: () => events.push('notify'),
    lastInputAt: () => 0,
    ...opts,
  };
  const waiter = createIdleWaiter(deps);
  return {
    waiter, clock, events, deps,
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

test('waiter: the fixture hands createIdleWaiter every dep it reads', () => {
  const { deps } = freshWaiter();
  assert.deepStrictEqual(Object.keys(deps).map((k) => [k, typeof deps[k]]), [
    ['getSessions', 'function'], ['now', 'function'], ['setTimer', 'function'],
    ['clearTimer', 'function'], ['restart', 'function'], ['notify', 'function'],
    ['lastInputAt', 'function'],
  ]);
});

test('waiter: an operator typing every tick holds the restart even with every seat idle', () => {
  let typedAt = 0;
  const { waiter, clock, events, setSessions } = freshWaiter(1_000_000, {
    lastInputAt: () => typedAt,
  });
  setSessions(IDLE);
  waiter.arm();
  for (let t = 1_002_000; t <= 1_030_000; t += 2000) {
    typedAt = t - 3000;
    clock.advance(2000);
  }
  assert.strictEqual(clock.now(), 1_030_000);
  assert.deepStrictEqual(events, [], 'a keystroke 3s ago is not a quiet operator');
  assert.ok(waiter.isArmed());
});

test('waiter: fires exactly operatorQuietMs after the last keystroke once typing stops', () => {
  let typedAt = 0;
  const { waiter, clock, events, setSessions } = freshWaiter(1_000_000, {
    lastInputAt: () => typedAt, operatorQuietMs: 10_000, sustainMs: 0,
  });
  setSessions(IDLE);
  waiter.arm();
  for (let t = 1_002_000; t <= 1_008_000; t += 2000) {
    typedAt = t;
    clock.advance(2000);
  }
  assert.strictEqual(typedAt, 1_008_000);
  clock.advance(1_016_000 - 1_008_000);
  assert.deepStrictEqual(events, [], 'at 1_016_000, 8s after the last keystroke');
  assert.ok(waiter.isArmed());
  clock.advance(2000);
  assert.strictEqual(clock.now(), 1_018_000);
  assert.deepStrictEqual(events, ['restart'], 'fires at 1_018_000, 10s after the last keystroke');
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

test('watcher: a give-up and an operator cancel are told APART, not merely told', () => {
  // Both end the wait without restarting, but the advice they imply is opposite:
  // one means "ask again when work settles", the other means a human said no. A
  // watcher handed no reason has to guess, and guessing wrong turns a cancel into
  // a re-arm loop the operator has to keep cancelling.
  const gaveUp = freshWaiter();
  gaveUp.setSessions(BUSY);
  gaveUp.waiter.arm({ onAbandon: (why) => gaveUp.events.push(`abandon:${why}`) });
  gaveUp.clock.advance(31 * 60_000);
  assert.deepStrictEqual(gaveUp.events, ['notify', 'abandon:gave-up'], 'the cap reports itself as a give-up');

  const cancelled = freshWaiter();
  cancelled.setSessions(BUSY);
  cancelled.waiter.arm({ onAbandon: (why) => cancelled.events.push(`abandon:${why}`) });
  cancelled.waiter.disarm({ abandoned: true });
  assert.deepStrictEqual(cancelled.events, ['abandon:cancelled'],
    'an operator cancel reports itself as a cancel — a different word, not the same one twice');
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

// --- the give-up notification's copy (t282 follow-up) -----------------------
// These CALL the builder rather than reading main.js. The distinction is the
// whole point: a source pin can show the copy interpolates something, and a
// version whose attribution was wired to a permanently-empty value passed every
// such assertion. Only calling it proves a name reaches the string.

test('copy: no requesters — the sentence stands alone, with no duration and no dangling label', () => {
  const s = giveUpBody([]);
  assert.match(s, /Sessions stayed busy/, 'it still says why the restart was dropped');
  assert.match(s, /dropped/, 'ENTER: this is the give-up copy');
  assert.doesNotMatch(s, /Requested by/, 'nothing to attribute — no empty label');
  assert.doesNotMatch(s, /30 minutes/,
    'no duration: a seat that joined a wait in progress did not wait the cap');
});

test('copy: a requester is APPENDED, never folded into the sentence', () => {
  // The mixed-arm case is what forces this shape: the operator arms from the menu
  // at t=0, an agent joins at t=25m, the cap fires. "the pending restart requested
  // by hand-282 was dropped" tells the operator their OWN restart was someone
  // else's. Appending is true for menu-only, agent-only and mixed alike — so the
  // sentence must come through byte-identical to the unattributed one.
  const alone = giveUpBody([]);
  const one = giveUpBody(['hand-282']);
  assert.ok(one.startsWith(alone),
    'the unattributed sentence survives verbatim; attribution only follows it');
  assert.strictEqual(one.slice(alone.length), ' Requested by: hand-282.',
    'and the name really reaches the string — the assertion a source pin could not make');
});

test('copy: every requester is named, comma-separated', () => {
  assert.strictEqual(giveUpBody(['hand-282', 'hand-281']).slice(giveUpBody([]).length),
    ' Requested by: hand-282, hand-281.', 'a wait several seats joined names all of them');
});

test('copy: junk in the name list cannot produce a half-formed attribution', () => {
  // notify() is called by the waiter, but the list is assembled from whatever the
  // hosts passed as `requester`; an empty string must not render "Requested by: ."
  const alone = giveUpBody([]);
  assert.strictEqual(giveUpBody(['', null, undefined]), alone, 'all-empty is the same as none');
  assert.strictEqual(giveUpBody(undefined), alone, 'and a missing list does not throw');
  assert.strictEqual(giveUpBody(['', 'hand-282']).slice(alone.length), ' Requested by: hand-282.',
    'a real name beside the junk still lands, without a leading empty entry');
});

// --- who the OPERATOR is told about (t282 follow-up) ------------------------
// The give-up notification is the operator's only view of a wait that died. Since
// an agent can arm one, an unattributed notice reads as the operator's own
// restart failing — so the requesting seats ride along to `notify`.

// A waiter whose notify records its argument. Kept local: the shared fake asserts
// on the bare string 'notify' and every existing test reads that.
function attributedWaiter() {
  const seen = [];
  const w = freshWaiter(1_000_000, { notify: (asked) => seen.push(asked) });
  return { ...w, seen };
}

test('attribution: the give-up names the seats that asked, and stays anonymous from the menu', () => {
  const menu = attributedWaiter();
  menu.setSessions(BUSY);
  menu.waiter.arm(); // the dialog's "Restart When Idle" — no requester
  menu.clock.advance(31 * 60_000);
  assert.deepStrictEqual(menu.seen, [[]],
    'ENTER: the menu wait reached the cap, and named nobody — the operator knows they asked');

  const agents = attributedWaiter();
  agents.setSessions(BUSY);
  agents.waiter.arm({ requester: 'hand-282' });
  agents.waiter.arm({ requester: 'hand-281' });
  agents.waiter.arm({ requester: 'hand-282' }); // same seat again — one name, not two
  agents.clock.advance(31 * 60_000);
  assert.deepStrictEqual(agents.seen, [['hand-282', 'hand-281']],
    'every requesting seat, deduped, in arm order');
});

test('attribution: a fulfilled restart does not leak its requester into the NEXT wait', () => {
  // The quiet failure mode: a restart consumes the request, so a later menu-armed
  // wait that gives up must not tell the operator an innocent seat asked for it.
  const { waiter, clock, seen, setSessions } = attributedWaiter();
  setSessions(IDLE);
  waiter.arm({ requester: 'hand-282' });
  clock.advance(12_000);
  assert.deepStrictEqual(seen, [], 'ENTER: that wait ended in a restart, not a give-up');

  setSessions(BUSY);
  assert.strictEqual(waiter.arm(), true, 'ENTER: a genuinely fresh wait, so the cap below is reached');
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(seen, [[]], 'the new give-up names nobody — the old requester was consumed');
});

test('attribution: an operator cancel clears the names too', () => {
  const { waiter, clock, seen, setSessions } = attributedWaiter();
  setSessions(BUSY);
  waiter.arm({ requester: 'hand-282' });
  waiter.disarm({ abandoned: true });
  waiter.arm();
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(seen, [[]], 'the cancelled request is gone, not carried into the next wait');
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

function runGatedWaiter() {
  let runs = [];
  const logs = { info: [], warn: [] };
  const log = { info: (_t, m) => logs.info.push(m), warn: (_t, m) => logs.warn.push(m) };
  const w = freshWaiter(1_000_000, { inFlightRuns: () => runs, log });
  w.setSessions(IDLE);
  return { ...w, logs, setRuns: (r) => { runs = r; } };
}

test('waiter: an in-flight exec run holds an otherwise idle restart, and it fires once the run ends', () => {
  const { waiter, clock, events, logs, setRuns } = runGatedWaiter();
  setRuns(['hand-1 run #3 (clodex-run-tests)']);
  waiter.arm();
  clock.advance(5 * 60_000);
  assert.deepStrictEqual(events, [], 'idle seat, quiet keyboard, but a run in flight — no restart');
  assert.deepStrictEqual(logs.info, ['restart waiting on in-flight exec runs: hand-1 run #3 (clodex-run-tests)']);
  setRuns([]);
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart'], 'the run ended — the usual 10s window then fires');
  assert.deepStrictEqual(logs.warn, [], 'nothing was abandoned');
});

test('waiter: a run still in flight 10 minutes after arming no longer holds the restart, and the warn names it', () => {
  const { waiter, clock, events, logs, setRuns } = runGatedWaiter();
  setRuns(['hand-1 run #3 (clodex-run-tests)']);
  waiter.arm();
  clock.advance(10 * 60_000 - 2000);
  assert.deepStrictEqual(events, []);
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart']);
  assert.strictEqual(logs.warn.length, 1);
  assert.match(logs.warn[0], /abandoning: hand-1 run #3 \(clodex-run-tests\)/);
});

function suiteGatedWaiter() {
  let jobs = [];
  const seen = [];
  const fences = [];
  const w = freshWaiter(1_000_000, {
    suiteJobs: () => jobs,
    fence: (on) => fences.push(on),
    notify: (asked, why) => seen.push([asked, why, giveUpBody(asked, why)]),
  });
  w.setSessions(IDLE);
  return { ...w, seen, fences, setJobs: (j) => { jobs = j; } };
}

test('t2400: a live suite-runner job holds an otherwise idle restart, and it fires once the job ends', () => {
  const { waiter, clock, events, fences, setJobs } = suiteGatedWaiter();
  setJobs([{ id: 'j1', team: 'alpha' }]);
  waiter.arm();
  clock.advance(25 * 60_000);
  assert.deepStrictEqual(events, [], 'idle seats, quiet keyboard, one runner job live — no restart, even past the 10m exec-run ceiling');
  setJobs([]);
  clock.advance(12_000);
  assert.deepStrictEqual(events, ['restart']);
  assert.deepStrictEqual(fences, [true], 'a restart that fires keeps admission closed until the app goes');
});

test('t2400: at the 30m cap with a live runner job the restart is dropped, not forced, and the notice names the runner job', () => {
  const { waiter, clock, events, seen, fences, setJobs } = suiteGatedWaiter();
  setJobs([{ id: 'j1', team: 'alpha' }]);
  waiter.arm({ requester: 'hand-7' });
  clock.advance(31 * 60_000);
  assert.deepStrictEqual(events, []);
  assert.deepStrictEqual(seen, [[['hand-7'], { suiteJobs: [{ id: 'j1', team: 'alpha' }], sessionsBusy: false },
    '1 suite job this machine is running for other teams did not finish — the pending restart was dropped. Try again when work settles. Requested by: hand-7.']]);
  assert.deepStrictEqual(fences, [true, false]);
  assert.strictEqual(waiter.isArmed(), false);
});

test('t2400: busy seats and runner jobs at the cap are both named', () => {
  assert.strictEqual(giveUpBody([], { suiteJobs: 2, sessionsBusy: true }),
    'Sessions stayed busy and 2 suite jobs this machine is running for other teams did not finish — the pending restart was dropped. Try again when work settles.');
  assert.strictEqual(giveUpBody([], { suiteJobs: 0, sessionsBusy: true }),
    'Sessions stayed busy — the pending restart was dropped. Try again when work settles.');
});

test('t2400: arming closes the fence before the first hold check; cancelling reopens it', () => {
  const order = [];
  const { waiter, clock } = freshWaiter(1_000_000, {
    suiteJobs: () => { order.push('hold'); return []; },
    fence: (on) => order.push(`fence:${on}`),
  });
  waiter.arm();
  clock.advance(2000);
  waiter.disarm({ abandoned: true });
  assert.deepStrictEqual(order, ['fence:true', 'hold', 'fence:false']);
});

test('t2400: restart dialog text for one runner job', () => {
  assert.strictEqual(restartDetail({ busy: 0, idle: 2, jobs: [{ id: 'j1', team: 'alpha' }] }),
    '2 idle sessions will be restored cleanly.\n'
    + '1 suite job this machine is running for other teams is in flight (alpha).\n'
    + 'Restart When Idle waits until work settles and the suite jobs finish; Restart Now interrupts and cuts the suite jobs.');
  assert.strictEqual(pendingDetail([{ id: 'j1', team: 'alpha' }]),
    'Clodex will restart once every session and the keyboard are idle and 1 suite job this machine is running for other teams finishes. Restart now anyway, cancel the pending restart, or keep waiting?');
  assert.strictEqual(pendingDetail([]),
    'Clodex will restart once every session and the keyboard are idle. Restart now anyway, cancel the pending restart, or keep waiting?');
});

test('t2400: restart dialog text for three runner jobs from two teams, one name with markup', () => {
  const jobs = [{ id: 'j1', team: '<b>red</b>\nteam' }, { id: 'j2', team: 'blue' }, { id: 'j3', team: '<b>red</b>\nteam' }];
  assert.strictEqual(restartDetail({ busy: 1, idle: 0, jobs }),
    '1 session is mid-turn.\n'
    + '3 suite jobs this machine is running for other teams are in flight (<b>red</b> team, blue).\n'
    + 'Restart When Idle waits until work settles and the suite jobs finish; Restart Now interrupts and cuts the suite jobs.');
});

test('t2400: a 200-character team name is cut to a bounded label', () => {
  const line = restartDetail({ busy: 0, idle: 0, jobs: [{ id: 'j1', team: 'x'.repeat(200) }, { id: 'j2', team: 'blue' }] }).split('\n')[0];
  assert.strictEqual(line, `2 suite jobs this machine is running for other teams are in flight (${'x'.repeat(31)}…, blue).`);
});

test('t2400: with no runner jobs the busy dialog text is unchanged', () => {
  assert.strictEqual(restartDetail({ busy: 2, idle: 1, jobs: [] }),
    '2 sessions are mid-turn; 1 idle session will be restored cleanly. Restart When Idle waits until work settles; Restart Now interrupts.');
});

function quitHarness({ jobs = [], answers = [] } = {}) {
  const clock = fakeClock(1_000_000);
  const st = { jobs, fence: [], quits: 0, asked: [], notices: [], answers: [...answers] };
  const guard = createQuitGuard({
    suiteJobs: () => st.jobs,
    fence: (on) => st.fence.push(on),
    quit: () => { st.quits += 1; },
    ask: (m) => { st.asked.push(m); return Promise.resolve({ response: st.answers.shift() }); },
    notify: (n) => st.notices.push(quitGiveUpBody(n)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const request = () => {
    let prevented = false;
    const ok = guard.beforeQuit({ preventDefault: () => { prevented = true; } });
    return { ok, prevented };
  };
  return { clock, st, guard, request };
}

const flush = () => new Promise((r) => setImmediate(r));
const ONE_JOB = [{ id: 'j1', team: 'alpha' }];

test('t2401: a quit with no live runner job passes through with no dialog', async () => {
  const { st, request } = quitHarness();
  assert.deepStrictEqual(request(), { ok: true, prevented: false });
  await flush();
  assert.deepStrictEqual({ asked: st.asked, fence: st.fence, quits: st.quits }, { asked: [], fence: [], quits: 0 });
});

test('t2401: a quit with a live runner job is stopped and asks with three buttons in order', async () => {
  const { st, request } = quitHarness({ jobs: ONE_JOB });
  assert.deepStrictEqual(request(), { ok: false, prevented: true });
  await flush();
  assert.deepStrictEqual(st.asked, [{
    kind: 'quit',
    type: 'warning',
    message: 'Clodex is running tests for another team',
    detail: '1 suite job this machine is running for other teams is in flight (alpha).\nQuit When Finished waits for them (up to 30 minutes) and accepts no new suite meanwhile; Quit Now cuts them.',
    buttons: ['Quit When Finished', 'Quit Now', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  }]);
});

test('t2401: Quit When Finished fences, holds the quit while the job is live and quits when it ends; the fence stays up', async () => {
  const { st, clock, guard, request } = quitHarness({ jobs: ONE_JOB, answers: [0] });
  request();
  await flush();
  assert.deepStrictEqual(st.fence, [true]);
  clock.advance(10 * 60_000);
  assert.strictEqual(st.quits, 0);
  st.jobs = [];
  clock.advance(2000);
  assert.strictEqual(st.quits, 1);
  assert.deepStrictEqual(request(), { ok: true, prevented: false });
  guard.restartFence(false);
  assert.deepStrictEqual(st.fence, [true]);
});

test('t2401: a second quit request while waiting asks Quit Now / Keep Waiting / Cancel Quit', async () => {
  const { st, request } = quitHarness({ jobs: ONE_JOB, answers: [0, 1] });
  request();
  await flush();
  assert.deepStrictEqual(request(), { ok: false, prevented: true });
  await flush();
  assert.deepStrictEqual(st.asked[1], {
    kind: 'waiting',
    type: 'warning',
    message: 'Clodex will quit when the tests finish',
    detail: '1 suite job this machine is running for other teams is in flight (alpha).\nQuit Now cuts them; Cancel Quit keeps Clodex running and accepts new suites again.',
    buttons: ['Quit Now', 'Keep Waiting', 'Cancel Quit'],
    defaultId: 1,
    cancelId: 1,
  });
  assert.deepStrictEqual({ fence: st.fence, quits: st.quits }, { fence: [true], quits: 0 });
});

test('t2401: at the 30-minute cap the quit is dropped, the fence lifted and a notice posted', async () => {
  const { st, clock, guard } = quitHarness({ jobs: ONE_JOB, answers: [0] });
  guard.beforeQuit({ preventDefault() {} });
  await flush();
  clock.advance(30 * 60_000 - 2000);
  assert.deepStrictEqual(st.fence, [true]);
  clock.advance(2000);
  assert.deepStrictEqual({ fence: st.fence, quits: st.quits, notices: st.notices, waiting: guard.isWaiting() }, {
    fence: [true, false],
    quits: 0,
    notices: ['1 suite job this machine is running for other teams did not finish within 30 minutes — the quit was dropped. Quit again to choose.'],
    waiting: false,
  });
});

test('t2401: Cancel leaves the app running, and Cancel Quit lifts the fence', async () => {
  const first = quitHarness({ jobs: ONE_JOB, answers: [2] });
  first.request();
  await flush();
  assert.deepStrictEqual({ fence: first.st.fence, quits: first.st.quits }, { fence: [], quits: 0 });

  const second = quitHarness({ jobs: ONE_JOB, answers: [0, 2] });
  second.request();
  await flush();
  second.request();
  await flush();
  second.st.jobs = [];
  second.clock.advance(60_000);
  assert.deepStrictEqual({ fence: second.st.fence, quits: second.st.quits }, { fence: [true, false], quits: 0 });
});

test('t2401: after Quit Now the next quit request passes through with the job still live', async () => {
  const { st, request } = quitHarness({ jobs: ONE_JOB, answers: [1] });
  request();
  await flush();
  assert.strictEqual(st.quits, 1);
  assert.deepStrictEqual(request(), { ok: true, prevented: false });
  assert.strictEqual(st.asked.length, 1);
});

test('t2401: a fired restart passes through with a live job and keeps the restart fence up', async () => {
  const { st, guard, request } = quitHarness({ jobs: ONE_JOB });
  guard.restartFence(true);
  guard.passThrough();
  assert.deepStrictEqual(request(), { ok: true, prevented: false });
  guard.restartFence(false);
  await flush();
  assert.deepStrictEqual({ asked: st.asked, fence: st.fence }, { asked: [], fence: [true] });
});

function remotePlan(opts, { jobs = [], fenced = false } = {}) {
  const calls = [];
  const logs = [];
  const { planRemoteRestart } = require('../restart-waiter');
  const plan = planRemoteRestart(opts, {
    fence: (on) => calls.push(`fence:${on}`),
    fenced: () => fenced,
    jobs: () => { calls.push('count'); return jobs; },
    restart: () => calls.push('restart'),
    restartWhenIdle: (o) => calls.push(`whenIdle:${JSON.stringify(o)}`),
    log: (line) => logs.push(line),
  });
  return { plan, calls, logs };
}

const TWO = [{ id: 'j1', team: 'other' }, { id: 'j2', team: 'third' }];
const BUSY_TWO = 'Not restarted: 2 suite jobs this machine is running for other teams would be cut — send wait (clodexctl restart node --wait) to restart once they finish, or cutJobs (--cut-jobs) to cut them now.';

test('t2407: /api/restart with no flags on a busy node answers 409 runner-busy with the count, never restarts, and lifts the fence it raised', () => {
  const { plan, calls, logs } = remotePlan({}, { jobs: TWO });
  assert.deepStrictEqual(plan, { status: 409, body: { ok: false, code: 'runner-busy', jobs: 2, error: BUSY_TWO } });
  assert.deepStrictEqual(calls, ['fence:true', 'count', 'fence:false']);
  assert.deepStrictEqual(logs, [`restart requested remotely — refused: ${BUSY_TWO}`]);
});

test('t2407: a busy refusal leaves a fence someone else raised in place', () => {
  const { plan, calls } = remotePlan({}, { jobs: TWO, fenced: true });
  assert.strictEqual(plan.status, 409);
  assert.deepStrictEqual(calls, ['fence:true', 'count']);
});

test('t2407: /api/restart on an idle node restarts after the reply, fence left up', () => {
  const { plan, calls, logs } = remotePlan({}, { jobs: [] });
  assert.deepStrictEqual({ status: plan.status, body: plan.body }, { status: 200, body: { ok: true } });
  assert.deepStrictEqual(calls, ['fence:true', 'count']);
  plan.go();
  assert.deepStrictEqual(calls, ['fence:true', 'count', 'restart']);
  assert.deepStrictEqual(logs, ['restart requested remotely']);
});

test('t2407: wait reaches the idle waiter, not the immediate restart, and answers 202 with the job count', () => {
  const { plan, calls, logs } = remotePlan({ wait: true }, { jobs: TWO });
  assert.deepStrictEqual({ status: plan.status, body: plan.body }, { status: 202, body: { ok: true, waiting: true, jobs: 2 } });
  plan.go();
  assert.deepStrictEqual(calls, ['count', 'whenIdle:{}']);
  assert.deepStrictEqual(logs, ['restart requested remotely — waiting for 2 suite jobs this machine is running for other teams']);
});

test('t2407: cutJobs restarts a busy node and logs the cut count', () => {
  const { plan, calls, logs } = remotePlan({ cutJobs: true }, { jobs: TWO });
  assert.deepStrictEqual({ status: plan.status, body: plan.body }, { status: 200, body: { ok: true } });
  plan.go();
  assert.deepStrictEqual(calls, ['fence:true', 'count', 'restart']);
  assert.deepStrictEqual(logs, ['restart requested remotely; cutting 2 suite jobs this machine is running for other teams']);
});

const { waitedClause, restartWaitLine } = require('../restart-waiter');

function blockerWaiter(extra = {}) {
  let jobs = [];
  const seen = [];
  const w = freshWaiter(1_000_000, {
    suiteJobs: () => jobs,
    teamOf: (s) => s.team,
    notify: (asked, why, wait) => seen.push(giveUpBody(asked, why, wait)),
    ...extra,
  });
  return { ...w, seen, setJobs: (j) => { jobs = j; } };
}

const TWO_TEAMS_BUSY = [
  { name: 'avh-ride-hand-265', team: 'avh-ride', agentType: 'claude', activityState: 'thinking' },
  { name: 'clodex-hand-12', team: 'clodex', agentType: 'claude', activityState: 'thinking' },
];

test('t2492: at the 30m cap the drop notice names two busy seats of different teams and a running test job, with ages', () => {
  const abandons = [];
  const { waiter, clock, seen, setSessions, setJobs, events } = blockerWaiter();
  setSessions(TWO_TEAMS_BUSY);
  waiter.arm({ requester: 'avh-ride-lead', onAbandon: (why, wait) => abandons.push([why, waitedClause(wait)]) });
  clock.advance(24 * 60_000);
  setJobs([{ id: 'j9', team: 'clodex', ticket: 't2147', kind: 'verify' }]);
  clock.advance(7 * 60_000);
  assert.deepStrictEqual(events, [], 'the cap never forces a restart');
  assert.deepStrictEqual(seen, [
    'Sessions stayed busy and 1 suite job this machine is running for other teams did not finish — the pending restart was dropped after 30m. Still busy: avh-ride-hand-265 (team avh-ride, busy 29m), clodex-hand-12 (team clodex, busy 29m), test job t2147 verify (5m). Try again when work settles. Requested by: avh-ride-lead.',
  ]);
  assert.deepStrictEqual(abandons, [
    ['gave-up', ' for 30m: avh-ride-hand-265 (team avh-ride, busy 29m), clodex-hand-12 (team clodex, busy 29m), test job t2147 verify (5m)'],
  ]);
});

test('t2492: the blocker list is capped at 10 entries, then "+N more"', () => {
  const { waiter, clock, seen, setSessions } = blockerWaiter();
  setSessions(Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, agentType: 'claude', activityState: 'thinking' })));
  waiter.arm();
  clock.advance(31 * 60_000);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0], /Still busy: s0 \(busy 29m\), .*s9 \(busy 29m\), \+2 more\. Try again/);
  assert.doesNotMatch(seen[0], /s10/);
});

test('t2492: the 10-minute progress line goes to the requester once per wait', () => {
  const progress = [];
  const { waiter, clock, setSessions } = blockerWaiter();
  setSessions(TWO_TEAMS_BUSY);
  waiter.arm({ requester: 'avh-ride-lead', onProgress: (p) => progress.push(p) });
  clock.advance(10 * 60_000 - 2000);
  assert.deepStrictEqual(progress, [], 'nothing before 10 minutes');
  clock.advance(2000);
  assert.strictEqual(progress.length, 1, 'ENTER: one line at 10 minutes');
  assert.deepStrictEqual({ ran: progress[0].at - progress[0].armedAt, leftMs: progress[0].leftMs, names: progress[0].blockers.map((b) => b.name) },
    { ran: 600_000, leftMs: 1_200_000, names: ['avh-ride-hand-265', 'clodex-hand-12'] });
  clock.advance(15 * 60_000);
  assert.strictEqual(progress.length, 1, 'at most one per wait');
});

test('t2492: wait events — armed, blocker changes rate-limited to one per 30s, fired; state clears on fire', () => {
  const evs = [];
  const { waiter, clock, setSessions, events } = blockerWaiter({ onEvent: (ev) => evs.push([ev.phase, ev.blockers.map((b) => b.name), ev.requesters]) });
  const a = { name: 'a', agentType: 'claude', activityState: 'thinking' };
  const b = { name: 'b', agentType: 'claude', activityState: 'idle' };
  setSessions([a, b]);
  waiter.arm({ requester: 'lead-1' });
  assert.strictEqual(waiter.state().armedAt, 1_000_000);
  clock.advance(32_000);
  b.activityState = 'thinking';
  clock.advance(38_000);
  a.activityState = 'idle';
  b.activityState = 'idle';
  clock.advance(20_000);
  assert.deepStrictEqual(events, ['restart']);
  assert.deepStrictEqual(evs, [
    ['armed', [], ['lead-1']],
    ['waiting', ['a'], ['lead-1']],
    ['waiting', ['a', 'b'], ['lead-1']],
    ['fired', [], ['lead-1']],
  ]);
  assert.strictEqual(waiter.state(), null, 'a wait that fired leaves no waiting line behind');
});

test('t2492: a cancelled wait and a dropped wait each broadcast their end', () => {
  const cancelled = [];
  const c = blockerWaiter({ onEvent: (ev) => cancelled.push(ev.phase) });
  c.setSessions(BUSY);
  c.waiter.arm();
  c.waiter.disarm({ abandoned: true });
  assert.deepStrictEqual(cancelled, ['armed', 'cancelled']);
  assert.strictEqual(c.waiter.state(), null);
  const dropped = [];
  const d = blockerWaiter({ onEvent: (ev) => dropped.push(ev.phase) });
  d.setSessions(BUSY);
  d.waiter.arm();
  d.clock.advance(31 * 60_000);
  assert.deepStrictEqual(dropped, ['armed', 'waiting', 'dropped']);
  assert.strictEqual(d.waiter.state(), null);
});

test('t2492: restartWaitLine splits by audience — the requester sees every blocker, another team its own plus a count', () => {
  const armedAt = Date.UTC(2026, 10, 28, 14, 20);
  const st = {
    armedAt, at: armedAt + 5 * 60_000, requesters: ['avh-ride-lead'],
    blockers: [
      { type: 'seat', name: 'avh-ride-hand-265', team: 'avh-ride', since: armedAt },
      { type: 'seat', name: 'avh-ride-hand-266', team: 'avh-ride', since: armedAt },
      { type: 'seat', name: 'clodex-hand-12', team: 'clodex', since: armedAt + 60_000 },
    ],
  };
  assert.strictEqual(restartWaitLine(st, { viewer: 'avh-ride-lead', team: 'avh-ride' }),
    'restart waiting since 14:20Z, asked by avh-ride-lead; waiting on: avh-ride-hand-265 (team avh-ride, busy 5m), avh-ride-hand-266 (team avh-ride, busy 5m), clodex-hand-12 (team clodex, busy 4m)');
  assert.strictEqual(restartWaitLine(st, { viewer: 'clodex-hand-3', team: 'clodex' }),
    'restart waiting since 14:20Z, asked by avh-ride-lead; waiting on: clodex-hand-12 (team clodex, busy 4m) and 2 seats on other teams');
  assert.strictEqual(restartWaitLine(st, { viewer: 'solo', team: null }),
    'restart waiting since 14:20Z, asked by avh-ride-lead; waiting on: 3 seats on other teams');
});

test('t2492: the pending-restart dialog leads with the waiting line', () => {
  const armedAt = Date.UTC(2026, 10, 28, 14, 20);
  assert.strictEqual(pendingDetail([], { armedAt, at: armedAt, requesters: [], blockers: [{ type: 'test job', name: 't9 verify', team: null, since: armedAt }] }),
    `Restart waiting since 14:20Z, asked by the operator; waiting on: test job t9 verify (0s).\n${pendingDetail([])}`);
});
