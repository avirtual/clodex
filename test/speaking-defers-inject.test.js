'use strict';
// Run: node --test
// The operator dictates from across the room. A background dm arrived
// while he was still speaking, the inject gate judged the seat idle, and the
// Ctrl-U that opens every injection ate his sentence mid-word.
//
// TYPING was already protected and SPEAKING was not, because the two arrive by
// different routes: typed bytes pass through SessionManager.write(), which
// stamps `lastUserInputTs` behind `isHumanPtyInput`, while dictated words are
// recorded by the CLI and painted into its own composer — nothing passes
// through write(), so the stamp never happens and the seat reads perfectly
// idle.
//
// EVERY ASSERTION HERE IS ON PTY BYTES, never on a predicate's return value.
// A predicate-only pin stays green when the call site is mutated away, and the
// call site is the entire content of this change: `shouldDeferInject` already
// returned sensible answers about an input nobody passed it.

const { test } = require('node:test');
const assert = require('node:assert');
const { InjectQueue } = require('../inject-queue');
const { createSessionManager } = require('../session-manager');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the gate, at the queue's own pty seam -----------------------------------

// A virtual clock, so "he is still speaking" is a state the test holds rather
// than a race it runs. `speaking` is read on every loop turn exactly as the
// live thunk is.
function vqueue({ speaking, maxWaitMs = 10_000, onTurn = null }) {
  const writes = [];
  const clock = { t: 1_000 };
  // The clock at the FIRST byte — i.e. how long the GATE held. Measured here
  // rather than after the drain because `settleMsFor` sleeps its own 1ms
  // between the text and the Enter: reading the clock at the end cannot tell a
  // gate that deferred from a settle that did, and the difference is the whole
  // subject of this file.
  let firstWriteAt = null;
  const q = new InjectQueue({
    write: (bytes) => { if (firstWriteAt === null) firstWriteAt = clock.t; writes.push(bytes); },
    settleMsFor: () => 1,
    quietMs: 50,
    maxWaitMs,
    ctrlUSettleMs: 0,
    // Long quiet: the TYPING gate is wide open throughout, so anything that
    // defers below is the speaking input and nothing else.
    lastHumanInputAt: () => 0,
    speaking: () => speaking(clock),
    isDead: () => false,
    now: () => clock.t,
    sleep: (ms) => { clock.t += ms; if (onTurn) onTurn(clock); return Promise.resolve(); },
  });
  return { q, writes, clock, firstWriteAt: () => firstWriteAt };
}

test('speaking defers the injection: not one byte reaches the pty while the recorder is lit', async () => {
  // Lit until t=5_000, then he stops. The message must land AFTER that instant
  // and not before — an assertion on the clock alone would pass for a queue
  // that wrote immediately and slept afterwards, so the first-byte instant is
  // what carries it.
  const h = vqueue({ speaking: (clock) => clock.t < 5_000 });

  await h.q.enqueue('a dm that must not splice his sentence');

  assert.deepStrictEqual(h.writes, ['\x15', 'a dm that must not splice his sentence', '\r'],
    'the message must still be delivered in full — deferred, never dropped');
  assert.ok(h.firstWriteAt() >= 5_000,
    `the Ctrl-U must not be written while he is speaking (first byte at t=${h.firstWriteAt()})`);
});

test('speaking defers even though the typing gate is wide open', async () => {
  // The regression shape itself: `lastHumanInputAt` is 0 and quietMs 50, so the
  // typing window has been open since the epoch. Before this change that was
  // the ONLY input, and the injection went straight through.
  const h = vqueue({ speaking: (clock) => clock.t < 3_000 });
  await h.q.enqueue('hi');
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r']);
  assert.ok(h.firstWriteAt() >= 3_000,
    'a seat that reads idle on the typing gate must still wait out the recorder');
});

// THE POLARITY CASE, and it is the OPPOSITE of `recorderBlocksRearm`'s in
// voice-submit.js, deliberately. There an unreadable screen BLOCKS the re-arm,
// because a missed indicator writes a key that cuts him off mid-sentence. Here
// an unreadable screen must NOT defer: nothing releases a deferral that no
// reader can clear, so a permanently-unreadable terminal would silently stop
// every delivery to the seat forever. Doubt blocks there; doubt delivers here.
test('an unreadable screen does NOT defer — doubt must never wedge delivery', async () => {
  // `false` is exactly what the renderer contributes when it cannot read the
  // screen: `recordingObserved(null) === false`, and a watcher that has gone
  // away contributes nothing at all. Both arrive here as a gate that is open.
  const h = vqueue({ speaking: () => false });
  await h.q.enqueue('hi');
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r']);
  assert.strictEqual(h.firstWriteAt(), 1_000,
    'ENTER: the gate must not have deferred at all, or this proves nothing about it');
});

test('a throwing speaking reader delivers rather than stranding the message', async () => {
  const writes = [];
  const q = new InjectQueue({
    write: (b) => writes.push(b),
    settleMsFor: () => 1,
    quietMs: 0,
    maxWaitMs: 10_000,
    ctrlUSettleMs: 0,
    lastHumanInputAt: () => 0,
    speaking: () => { throw new Error('renderer went away mid-read'); },
    isDead: () => false,
    now: () => 10_000,
    sleep: () => Promise.resolve(),
  });
  await q.enqueue('hi');
  assert.deepStrictEqual(writes, ['\x15', 'hi', '\r'],
    'every failure of this signal has to fall toward delivering');
});

// A STUCK-LIT INDICATOR IS REACHABLE — an observed, fixed bug, not a
// hypothetical — so the cap that bounds every other deferral bounds this one.
test('the max-wait cap still fires while speaking, and fires FIRST', async () => {
  // Never stops speaking. Without the cap this loops forever.
  const h = vqueue({ speaking: () => true, maxWaitMs: 500 });
  await h.q.enqueue('hi');
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r'],
    'a recorder that never goes out must not strand the delivery');
  assert.ok(h.firstWriteAt() - 1_000 >= 500, 'it must have waited the cap out first');
  assert.ok(h.firstWriteAt() - 1_000 < 1_500, 'and not much beyond it');
});

test('the cap is checked BEFORE speaking, so an already-expired wait injects at once', async () => {
  // maxWaitMs 0: the cap is satisfied on the very first evaluation. The write
  // must happen with no sleep at all, which is only true if the cap is tested
  // ahead of the speaking arm — swap the two and this deadlocks.
  const h = vqueue({ speaking: () => true, maxWaitMs: 0 });
  await h.q.enqueue('hi');
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r']);
  assert.strictEqual(h.firstWriteAt(), 1_000,
    'ENTER: the gate must not have deferred, or the ordering is not what is pinned');
});

// --- the same three cases through the REAL SessionManager wiring -------------
//
// The queue tests above pass a `speaking` thunk by hand, which proves the gate
// and NOT that anything supplies it. These drive the live wiring instead: the
// IPC handler's entry point (`noteVoiceRecording`), the session field it
// stamps, and the thunk `_injectQueueFor` builds — asserted at the seat's own
// pty write.

const STALE_MS = 120;

function boot({ quietMs = 10, maxWait = 10_000 } = {}) {
  const SessionManager = createSessionManager({
    InjectQueue,
    INJECT_QUIET_MS: quietMs,
    INJECT_QUIET_MAXWAIT: maxWait,
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_SPEAKING_STALE_MS: STALE_MS,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    hintArm: { holding: () => false },
  });
  const m = new SessionManager();
  m._broadcast = () => {};
  const writes = [];
  const s = {
    name: 'hand', agentType: 'claude', _dead: false, _bootReadySeen: true,
    // Typed a long time ago: the typing gate is open for the whole of every
    // test below, so a deferral can only come from the speaking input.
    lastUserInputTs: 0,
    pty: { write: (b) => writes.push(b) },
  };
  m.sessions = new Map([['hand', s]]);
  return { m, s, writes, q: m._injectQueueFor(s) };
}

test('wiring: a renderer reporting the recorder defers the seat’s pty writes', async () => {
  const h = boot();
  // What ipc-handlers calls on `voice:recording`, by its real name.
  h.m.noteVoiceRecording('hand');
  assert.ok(h.s.lastVoiceRecordingTs > 0,
    'ENTER: the stamp must actually have landed on the session, or nothing below is under test');

  const p = h.q.enqueue('a dm arriving mid-sentence');
  // He keeps speaking: the renderer resends on its poll, which is what holds
  // the deferral open. Level-triggered by design — main expires the stamp, so a
  // renderer that goes away releases the seat instead of wedging it.
  //
  // The interval is cleared in a FINALLY. A failing assertion jumps over a bare
  // clearInterval, and the surviving timer then keeps node alive until the
  // runner's timeout — which reports a HANG instead of naming the failed
  // assertion, and is exactly what this file's own mutation check hit.
  const poll = setInterval(() => h.m.noteVoiceRecording('hand'), 20);
  try {
    await settle(STALE_MS * 2);
    assert.deepStrictEqual(h.writes, [], 'not one byte may reach the pty while he is still speaking');
  } finally { clearInterval(poll); }

  await p;
  assert.deepStrictEqual(h.writes, ['\x15', 'a dm arriving mid-sentence', '\r'],
    'and the message lands in full once he has finished');
});

test('wiring: with no recorder ever reported, the injection is not delayed', async () => {
  const h = boot();
  assert.ok(!h.s.lastVoiceRecordingTs,
    'ENTER: this seat really has no recording stamp, or the absence proves nothing');
  await h.q.enqueue('hi');
  assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r']);
});

test('wiring: a stuck-lit recorder is bounded by the max-wait cap', async () => {
  const h = boot({ maxWait: STALE_MS });
  // Reported forever — the stuck-indicator shape, driven through the real entry
  // point rather than by setting the field once.
  const poll = setInterval(() => h.m.noteVoiceRecording('hand'), 10);
  try {
    await h.q.enqueue('hi');
    assert.deepStrictEqual(h.writes, ['\x15', 'hi', '\r'],
      'the cap must fire even though the recorder never goes out');
  } finally { clearInterval(poll); }
});

test('wiring: the recorder stamp is its own field, not an overload of lastUserInputTs', async () => {
  // The three readers of `lastUserInputTs` — the inject gate, the reboot-notice
  // draft staleness, and _maybeParkDelivery's typing test — would all silently
  // change meaning if the recorder stamped into it. This pins that it does not.
  const h = boot();
  h.s.lastUserInputTs = 0;
  h.m.noteVoiceRecording('hand');
  assert.strictEqual(h.s.lastUserInputTs, 0,
    'reporting a recorder must not make the seat look like it was TYPED into');
});

test('wiring: a dead seat takes no stamp', async () => {
  const h = boot();
  h.s._dead = true;
  h.m.noteVoiceRecording('hand');
  assert.ok(!h.s.lastVoiceRecordingTs);
  h.m.noteVoiceRecording('nobody');   // must not throw
});
