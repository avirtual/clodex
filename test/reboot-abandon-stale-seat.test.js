'use strict';
// Run: node --test test/reboot-abandon-stale-seat.test.js
// t283 — a deferred reboot's abandon must not land on a seat that merely SHARES
// THE NAME of the requester.
//
// `_rebootAbandoned` runs up to 30 minutes after the request and carries only
// the name across, re-resolving with `this.sessions.get(who)`. Rate-limiting is
// 5 minutes, so a kill + same-name recreate — or the original seat re-requesting
// — is comfortably inside that window. Two things then go to the wrong seat:
//
//   the INJECT   the abandon reply is `parkable`, so a seat that never asked for
//                a restart finds "[agent:reboot] reboot DROPPED" in its next
//                prompt, about a request it has no memory of making.
//   the NOTICE   pendingRebootNotice is keyed by name too, so the stale abandon
//                clears the LATER request's notice — deleting the announcement
//                for a restart that is still armed.
//
// The guards are the request-time stamps threaded into the callback: `born`
// (`_bornFor`, the same generation stamp parked deliveries carry) for the seat,
// and `at` (the request's own timestamp, already inside the notice record) for
// the notice. Re-reading either inside the callback would read the LATER
// request's values and guard nothing.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');

// Fixed points, never relative offsets: a re-mint lands on the real Date.now()
// and must not be able to collide with either of these by accident.
const BORN_A = 1700000000000; // the requester
const BORN_B = 1700000111000; // the impostor — same name, different birth

// REBOOT_MIN_INTERVAL is 5 minutes and is not exported; 6 clears it. Stubbing
// Date.now rather than zeroing lastRebootAt keeps the rate limit REAL, and it is
// also what makes the two requests' `at` distinct — under the real clock both
// calls can land in the same millisecond, which would make the notice guard
// untestable for a reason that cannot occur in production.
const T1 = 1800000000000;
const T2 = T1 + 6 * 60 * 1000;

function mkEngine(seams) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t283-'));
  // registryDir or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home'), ...seams },
    log: { info() {}, warn() {}, error() {} },
  });
}

// A live session as the reboot paths see it: they read `name`, `createdAt`,
// `workspaceId`, and hand the object to _injectText.
function seat(eng, name, createdAt) {
  const s = { name, createdAt, type: 'claude', agentType: 'claude', cwd: '/tmp', workspaceId: 'default', pty: { pid: -1, write() {} } };
  eng.manager.sessions.set(name, s);
  return s;
}

// The probe sits ON the inject, because "does this seat get injected at all" IS
// the decision under test — not what the inject then does with the text.
function watchInjects(eng) {
  const seen = [];
  eng.manager._injectText = (session, text, opts) => { seen.push({ to: session && session.name, born: session && session.createdAt, text, opts }); };
  return seen;
}

// Capture the onAbandon the host was handed. The seam is the only place the
// callback is observable — it is a closure created inside _handleRebootIntent.
function armEngine() {
  const armed = [];
  const eng = mkEngine({ restartHostWhenIdle: (opts) => { armed.push(opts); } });
  return { eng, armed };
}

function withNow(t, fn) {
  const orig = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = orig; }
}

test('a same-name seat created after the request receives NOTHING from the abandon', () => {
  const { eng, armed } = armEngine();
  const requester = seat(eng, 'worker', BORN_A);
  const injects = watchInjects(eng);

  withNow(T1, () => eng.manager._handleRebootIntent(requester, 'ship it'));

  // ENTER: without an armed wait there is no onAbandon and the rest of this test
  // asserts nothing. Every later assertion is downstream of this one.
  assert.strictEqual(armed.length, 1, 'ENTER: the deferred restart was armed, so an onAbandon exists to fire');
  assert.strictEqual(typeof armed[0].onAbandon, 'function', 'ENTER: and it is a callback');
  const notice = eng.stores.uiSettings.get().pendingRebootNotice;
  assert.strictEqual(notice && notice.name, 'worker', 'ENTER: the request persisted a notice for this seat');
  assert.strictEqual(notice.at, T1, 'ENTER: stamped with the request time the guard compares against');
  assert.strictEqual(injects.length, 1, 'ENTER: the request itself replied to the requester (the "reboot queued" ack)');

  // The seat dies and something takes its name. This is the whole scenario.
  eng.manager.sessions.delete('worker');
  const impostor = seat(eng, 'worker', BORN_B);
  assert.notStrictEqual(impostor.createdAt, requester.createdAt,
    'ENTER: the two seats have different birth stamps — with equal stamps the guard cannot discriminate and the test is vacuous');
  injects.length = 0;

  armed[0].onAbandon('timeout');

  assert.deepStrictEqual(injects, [],
    'the new seat is told nothing about a restart it never requested — the abandon reply is parkable, so any inject here lands in its next prompt');
});

test('the abandon still reaches the requester itself — the guard is not a blanket mute', () => {
  // Without this the previous test passes with `_rebootAbandoned` returning
  // early unconditionally, which would silently strand every real requester.
  const { eng, armed } = armEngine();
  const requester = seat(eng, 'worker', BORN_A);
  const injects = watchInjects(eng);

  withNow(T1, () => eng.manager._handleRebootIntent(requester, 'ship it'));
  assert.strictEqual(armed.length, 1, 'ENTER: the deferred restart was armed');
  injects.length = 0;

  armed[0].onAbandon('timeout');

  assert.strictEqual(injects.length, 1, 'the requester is told its restart was dropped');
  assert.strictEqual(injects[0].to, 'worker');
  assert.strictEqual(injects[0].born, BORN_A, 'and it went to the seat that asked, not merely to the name');
  assert.match(injects[0].text, /reboot DROPPED/);
  assert.strictEqual(injects[0].opts && injects[0].opts.parkable, true,
    'still parkable — a seat mid-turn must not lose the reply, which is why the wrong-seat case matters at all');
});

test("an operator cancel reaches the requester with the cancel wording, not the timeout one", () => {
  const { eng, armed } = armEngine();
  const requester = seat(eng, 'worker', BORN_A);
  const injects = watchInjects(eng);
  withNow(T1, () => eng.manager._handleRebootIntent(requester, 'ship it'));
  assert.strictEqual(armed.length, 1, 'ENTER: the deferred restart was armed');
  injects.length = 0;

  armed[0].onAbandon('cancelled');

  assert.strictEqual(injects.length, 1, 'the requester hears about the cancel');
  assert.match(injects[0].text, /reboot CANCELLED/, 'the two reasons give opposite advice and must not be collapsed by the new guard');
});

test('a stale abandon does not clear the LATER request\'s pending notice', () => {
  // The notice-clear hole, which the name check alone does not close: the later
  // requester may wear the same name. Clearing here deletes the announcement for
  // a restart that is still armed, so the next launch says nothing.
  //
  // This interleaving is driven DIRECTLY, and the shipped host cannot produce
  // it: there is one idleWaiter (main.js), arm() refuses to duplicate it, and
  // drainAbandoned fires every pending onAbandon in one synchronous loop — so
  // both requesters are always abandoned back-to-back and either order ends at
  // null. The guard is defence for a host that could split them, not a fix for
  // an observed defect; do not infer from this test that the waiter can.
  const { eng, armed } = armEngine();
  const first = seat(eng, 'worker', BORN_A);
  watchInjects(eng);

  withNow(T1, () => eng.manager._handleRebootIntent(first, 'first'));
  assert.strictEqual(armed.length, 1, 'ENTER: the first request armed a wait');

  eng.manager.sessions.delete('worker');
  const second = seat(eng, 'worker', BORN_B);
  withNow(T2, () => eng.manager._handleRebootIntent(second, 'second'));

  // ENTER: the second request must have gotten PAST the 5-minute rate limit — a
  // refused second request never overwrites the notice, and then "the notice
  // survives" is true for the wrong reason and true with the fix reverted.
  assert.strictEqual(armed.length, 2, 'ENTER: the second request was not rate-limited; it armed its own wait');
  const before = eng.stores.uiSettings.get().pendingRebootNotice;
  assert.strictEqual(before && before.at, T2, 'ENTER: the notice now belongs to the SECOND request');

  armed[0].onAbandon('timeout');

  const after_ = eng.stores.uiSettings.get().pendingRebootNotice;
  assert.ok(after_, 'the second request\'s notice survives the first request\'s abandon');
  assert.strictEqual(after_.at, T2, 'and it is still the second request\'s, untouched');
  assert.strictEqual(after_.reason, 'second');
});

test('the requester\'s own abandon DOES clear its own notice', () => {
  // The counterweight: if the guard over-fires, a dropped restart leaves a
  // notice that announces it on some later launch — the bug the clear exists to
  // prevent, reintroduced from the other side.
  const { eng, armed } = armEngine();
  const requester = seat(eng, 'worker', BORN_A);
  watchInjects(eng);

  withNow(T1, () => eng.manager._handleRebootIntent(requester, 'ship it'));
  assert.strictEqual(armed.length, 1, 'ENTER: the deferred restart was armed');
  assert.ok(eng.stores.uiSettings.get().pendingRebootNotice, 'ENTER: a notice exists to be cleared');

  armed[0].onAbandon('timeout');

  assert.strictEqual(eng.stores.uiSettings.get().pendingRebootNotice, null,
    'nothing was restarted, so nothing may announce a restart later');
});

test('a name-reused seat also does not clear the notice out from under a live request', () => {
  // Same-name recreate WITHOUT a second request: the notice is still the
  // requester's, so it must be cleared. Pins that the notice guard keys on the
  // REQUEST (`at`), not on the seat — a born-based notice guard would wrongly
  // retain here and re-announce a restart that never happened.
  const { eng, armed } = armEngine();
  const requester = seat(eng, 'worker', BORN_A);
  watchInjects(eng);

  withNow(T1, () => eng.manager._handleRebootIntent(requester, 'ship it'));
  assert.strictEqual(armed.length, 1, 'ENTER: the deferred restart was armed');
  eng.manager.sessions.delete('worker');
  seat(eng, 'worker', BORN_B);
  assert.strictEqual(eng.stores.uiSettings.get().pendingRebootNotice.at, T1,
    'ENTER: the notice is still the first request\'s — nothing overwrote it');

  armed[0].onAbandon('timeout');

  assert.strictEqual(eng.stores.uiSettings.get().pendingRebootNotice, null,
    'the notice belonged to this request, so it goes — the seat swap is irrelevant to it');
});

// createEngine starts background timers with no host to stop them.
after(() => { setImmediate(() => process.exit(0)); });
