'use strict';
// Run: node --test test/headless-reboot.test.js
// t910 — [agent:reboot] on the headless host killed the box and never brought it
// back. Two faults, one mechanism (the agent restart path off Electron):
// headless supplied no `restartHostWhenIdle`, so engine.js's `|| restartHost`
// fallback exited mid-turn inside the requesting seat's own intent scan; and
// exit 64 is a contract a SUPERVISOR holds, which nothing told the agent about.
// Rationale for the declared (never detected) capability:
// docs/notes/headless-restart.md.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');
const {
  SUPERVISED_ENV, UNSUPERVISED_REASON, supervisorDeclared, createHeadlessRestart,
} = require('../headless-restart');

const ROOT = path.join(__dirname, '..');

// The fake clock + timer wheel restart-waiter.test.js drives the waiter with.
function fakeClock(startMs) {
  let cur = startMs;
  let seq = 0;
  const timers = new Map();
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
  };
}

const quietLog = { info() {}, warn() {}, error() {} };

// A headless-shaped host: the real createHeadlessRestart on a real engine
// through the same three seams headless-main.js supplies, with `restart`
// standing in for the process.exit(64) at the end of that chain.
function mkHeadlessHost({ env = {}, startMs = 1_000_000 } = {}) {
  const clock = fakeClock(startMs);
  const exits = [];
  const sessions = [];
  const tmp = mkTmpRoot('clx-t910-');
  const headlessRestart = createHeadlessRestart({
    env,
    log: quietLog,
    getSessions: () => sessions,
    restart: () => exits.push(64),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const eng = createEngine({
    userDataPath: tmp,
    log: quietLog,
    // registryDir or the engine seeds the operator's live ~/.clodex (t359).
    seams: {
      registryDir: path.join(tmp, 'clodex-home'),
      restartHost: () => exits.push(64),
      restartHostWhenIdle: headlessRestart.restartHostWhenIdle,
      restartUnavailable: headlessRestart.restartUnavailable,
    },
  });
  const injects = [];
  eng.manager._injectText = (session, text) => { injects.push({ to: session && session.name, text }); };
  const addSeat = (name, activityState) => {
    const s = {
      name, createdAt: startMs, type: 'claude', agentType: 'claude',
      activityState, cwd: '/tmp', workspaceId: 'default', pty: { pid: -1, write() {} },
    };
    sessions.push(s);
    eng.manager.sessions.set(name, s);
    return s;
  };
  return { eng, clock, exits, injects, addSeat, headlessRestart, sessions };
}

test('supervised headless: [agent:reboot] does NOT exit synchronously — it arms the wait', () => {
  const host = mkHeadlessHost({ env: { [SUPERVISED_ENV]: '1' } });
  const asker = host.addSeat('worker', 'thinking');

  host.eng.manager._handleRebootIntent(asker, 'ship it');

  // ENTER: the request must have been ACCEPTED, or "did not exit" is true for the
  // refusal's reason and this test says nothing about the wait at all.
  assert.match(host.injects.map((i) => i.text).join('\n'), /reboot queued/,
    'ENTER: the request was accepted and queued, not refused');
  assert.deepStrictEqual(host.exits, [],
    'the host did not exit inside the intent scan of the seat that asked — that is the mid-turn kill');
  assert.ok(host.headlessRestart.isArmed(), 'a wait is armed instead');
});

test('supervised headless: the exit comes only after a SUSTAINED all-idle window', () => {
  const host = mkHeadlessHost({ env: { [SUPERVISED_ENV]: 'yes' } });
  const asker = host.addSeat('worker', 'thinking');
  host.eng.manager._handleRebootIntent(asker, 'ship it');
  assert.ok(host.headlessRestart.isArmed(), 'ENTER: the wait is armed');

  // The requester is still mid-turn: polling must not fire the restart.
  host.clock.advance(60_000);
  assert.deepStrictEqual(host.exits, [],
    'a busy requester holds the restart off — the whole point of deferring it');

  asker.activityState = 'idle';
  host.clock.advance(2_000);
  assert.deepStrictEqual(host.exits, [],
    'one idle sample is not rest — a single quiet tick must not be enough');

  host.clock.advance(12_000);
  assert.deepStrictEqual(host.exits, [64],
    'once every seat has been idle for the sustained window, the host exits 64 for the supervisor');
});

test('supervised headless: a wait that gives up tells the requesting seat', () => {
  // onAbandon is the ONLY way a seat learns its relaunch is never coming. A
  // headless host has no operator reading a notification, so if this callback is
  // dropped the seat waits forever with nobody to tell it.
  const host = mkHeadlessHost({ env: { [SUPERVISED_ENV]: '1' } });
  const asker = host.addSeat('worker', 'thinking');
  host.eng.manager._handleRebootIntent(asker, 'ship it');
  assert.ok(host.headlessRestart.isArmed(), 'ENTER: the wait is armed');
  host.injects.length = 0;

  host.clock.advance(31 * 60_000); // past the 30-minute cap, never quiet

  assert.deepStrictEqual(host.exits, [], 'the cap never forces a restart');
  assert.strictEqual(host.injects.length, 1, 'the requester is told, exactly once');
  assert.strictEqual(host.injects[0].to, 'worker');
  assert.match(host.injects[0].text, /reboot DROPPED/,
    'and told it was dropped, not left blocked on a relaunch that is not coming');
});

test('unsupervised headless: [agent:reboot] is refused — no exit, and the reply names what is missing', () => {
  const host = mkHeadlessHost({ env: {} });
  const asker = host.addSeat('worker', 'thinking');

  host.eng.manager._handleRebootIntent(asker, 'ship it');

  assert.deepStrictEqual(host.exits, [],
    'a host nothing will relaunch must not honour the intent by exiting — that is a kill with extra steps');
  assert.strictEqual(host.headlessRestart.isArmed(), false, 'and no wait was armed either');
  assert.strictEqual(host.injects.length, 1, 'the seat gets exactly one reply');
  assert.match(host.injects[0].text, /refused/i, 'which refuses');
  assert.match(host.injects[0].text, new RegExp(SUPERVISED_ENV),
    `and NAMES the missing capability by the env var that grants it — "refused" alone leaves the operator nothing to do`);
});

test('unsupervised headless: the refusal does not burn the rate limit', () => {
  // lastRebootAt is stamped at QUEUE time, before the restart seam is reached, so
  // a capability check placed after it would leave a 5-minute cooldown behind a
  // request that did nothing. Asserting only on the reply text passes even when
  // the stamp landed anyway, which is why the settings read is the assertion.
  const host = mkHeadlessHost({ env: { [SUPERVISED_ENV]: 'false' } });
  const asker = host.addSeat('worker', 'thinking');
  const before = host.eng.stores.uiSettings.get();
  assert.ok(!before.lastRebootAt, 'ENTER: no stamp before the request');

  host.eng.manager._handleRebootIntent(asker, 'ship it');

  const settings = host.eng.stores.uiSettings.get();
  assert.ok(!settings.lastRebootAt,
    'no lastRebootAt: a refused request must leave no 5-minute cooldown behind it');
  assert.ok(!settings.pendingRebootNotice,
    'and no pending notice, or the next launch announces a restart that never happened');
});

test('unsupervised headless: the refusal is repeatable, not once every five minutes', () => {
  // The observable consequence of the stamp above. Without the ordering, the
  // SECOND identical request comes back rate-limited — telling the operator to
  // wait for a cooldown on a host that was never going to restart.
  const host = mkHeadlessHost({ env: {} });
  const asker = host.addSeat('worker', 'thinking');

  host.eng.manager._handleRebootIntent(asker, 'first');
  host.eng.manager._handleRebootIntent(asker, 'second');

  assert.strictEqual(host.injects.length, 2, 'ENTER: both requests replied');
  for (const i of host.injects) {
    assert.doesNotMatch(i.text, /rate-limited/,
      'a refusal never leaves a cooldown, so the next attempt hears the real reason again');
    assert.match(i.text, new RegExp(SUPERVISED_ENV), 'and hears it in full both times');
  }
});

test('the capability gate does not reach the human restart control', () => {
  // restartHost is the phone/web restart button: a person pressing a control,
  // already looking at the box, and it has always exited immediately. Routing it
  // through the refusal would make an operator's tap silently do nothing on every
  // unsupervised box — so headless wires it STRAIGHT to the exit, ungated.
  const src = seamNames('headless-main.js');
  assert.match(src, /restartHost:\s*restartNow\b/,
    'the human control still exits immediately — unconditionally, with no capability check between');
  assert.doesNotMatch(src, /restartHost:\s*[^,\n]*[Uu]navailable/,
    'and the gate is not folded into it');
});

test('supervisorDeclared: only an explicit, non-negative value declares a supervisor', () => {
  assert.strictEqual(supervisorDeclared({}), false, 'absent = unsupervised, the safe default');
  assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: '' }), false, 'empty is absent');
  assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: '   ' }), false, 'blank is absent');
  assert.strictEqual(supervisorDeclared(undefined), false, 'and a missing env does not throw');
  for (const off of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
    assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: off }), false,
      `${JSON.stringify(off)} reads as a decline — a drop-in that switches it off must not switch it ON`);
  }
  for (const on of ['1', 'true', 'yes', 'systemd']) {
    assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: on }), true,
      `${JSON.stringify(on)} declares one`);
  }
});

test('the refusal reason names the variable and says what to do with it', () => {
  assert.match(UNSUPERVISED_REASON, new RegExp(SUPERVISED_ENV),
    'the seat cannot relay a fix it is never told the name of');
  assert.match(UNSUPERVISED_REASON, /supervisor/i, 'and says what has to exist');
});

// Host parity on the seam, the shape test/host-log-parity.test.js uses: a seam
// present on one host and absent on the other is this exact bug class one file
// over, and engine.js's `|| restartHost` makes the absence SILENT.
function seamNames(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

for (const file of ['main.js', 'headless-main.js']) {
  test(`${file} supplies a deferred restart seam for the agent path`, () => {
    const src = seamNames(file);
    assert.match(src, /restartHostWhenIdle\s*:/,
      `${file} must declare restartHostWhenIdle — omitting it silently falls back to the immediate `
      + 'exit/quit, which is the mid-turn kill this ticket fixed');
    assert.match(src, /createIdleWaiter|headlessRestart\./,
      `${file}'s deferred seam must reach the shared sustained-idle waiter, not a private timer`);
  });
}

test('both hosts defer the agent restart; only headless gates it on a declared supervisor', () => {
  const desktop = seamNames('main.js');
  const headless = seamNames('headless-main.js');

  // The desktop is the reference implementation and is unchanged: it arms the
  // waiter it has always armed, and declares no capability gate — an Electron app
  // relaunches itself, so there is nothing to be missing.
  assert.match(desktop, /restartHostWhenIdle:\s*\(opts\)\s*=>\s*\{/, 'the desktop seam keeps its shape');
  assert.match(desktop, /idleWaiter\.arm\(/, 'and still arms the same waiter');
  assert.doesNotMatch(desktop, /restartUnavailable/,
    'and takes NO capability gate — Electron relaunches itself, so a gate there could only refuse a restart that works');

  assert.match(headless, /restartUnavailable:/,
    'headless declares the gate, because exit-64 is a contract only a supervisor holds');
});

// createEngine starts background timers with no host to stop them.
after(() => { setImmediate(() => process.exit(0)); });
