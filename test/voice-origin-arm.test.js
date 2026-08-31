'use strict';

// voice-origin-arm.test.js — the voice-origin marker's armer (voice-origin-arm.js)
// and the discriminator it is driven by (renderer/lib/voice-submit.js).
//
// THE TWO HAZARDS THIS FEATURE WAS SPECIFIED AGAINST are what these pin:
//
//   1. THE REGISTER IS SHARED. hint-arm.js writes a fixed id and CLEARS it on a
//      pass that finds nothing, and the operator's typing drives that pass
//      continuously. A voice marker on the same id would be destroyed by the
//      next keystroke and would take his contextual hint with it. The proxy
//      registry is a dict keyed by id and armHints posts mode=merge, so distinct
//      ids coexist — verified against a live proxy, both ids in the read-back.
//      What is pinnable HERE is the half that decides it: the id this module
//      posts must not be the one hint-arm.js owns.
//   2. ARMING MAY NEVER AFFECT THE KEYSTROKE. Nothing is awaited and no failure
//      propagates: a dead wirescope costs the marker, never the Enter.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createVoiceOriginArm, VOICE_ID, VOICE_TTL_S, VOICE_TEXT,
} = require('../voice-origin-arm');
const { HINT_ID } = require('../hint-arm');
const { PEEK_ID } = require('../selection-hint');
const { isVoiceOriginated, recordingObserved } = require('../renderer/lib/voice-submit');

function recorder({ throws = false, rejects = false } = {}) {
  const calls = [];
  return {
    calls,
    armHints: (payload) => {
      calls.push(payload);
      if (throws) throw new Error('proxy is down');
      return rejects ? Promise.reject(new Error('proxy refused')) : Promise.resolve({ ok: true });
    },
  };
}

const CTX = { base: 'http://127.0.0.1:7800', route: 'clodex-seat-1' };

// ------------------------------------------------------------------ the id

test('the marker does NOT share an id with any other hint on the route', () => {
  // Hazard 1. Asserted against the OTHER modules' real exports rather than a
  // copied string, so renaming either one cannot leave this passing over a
  // collision that is now real.
  assert.notStrictEqual(VOICE_ID, HINT_ID);
  assert.notStrictEqual(VOICE_ID, PEEK_ID);
  // The proxy's id grammar: a lowercase token, safe in a URL.
  assert.match(VOICE_ID, /^[a-z0-9][a-z0-9-]{0,63}$/);
});

// ------------------------------------------------------------- what is posted

test('the armed hint is one-shot, turn-start-gated, and carries a TTL', () => {
  // The whole payload, not a field-by-field sample: an unwired key arrives as
  // `undefined`, and a partial assertion reads straight around it. `once`
  // without `ttl_s` is a 400 at the proxy, and `once` is what makes the marker
  // physically unable to persist onto a later TYPED message.
  const r = recorder();
  const arm = createVoiceOriginArm({ armHints: r.armHints });
  assert.strictEqual(arm.arm(CTX), true);
  assert.deepStrictEqual(r.calls, [{
    base: CTX.base,
    route: CTX.route,
    id: VOICE_ID,
    text: VOICE_TEXT,
    ttl_s: VOICE_TTL_S,
    turn_start_only: true,
    once: true,
  }]);
});

test('the text tells the reader what to DO, not merely that it was dictated', () => {
  // The instruction IS the payload: "this was dictated" alone invites the reader
  // to note the fact and carry on reading the literal, which is the behaviour
  // the feature exists to change.
  assert.match(VOICE_TEXT, /spoken/i);
  assert.match(VOICE_TEXT, /transcri/i);
  assert.match(VOICE_TEXT, /ask/i);
  // Well under the proxy's 2500-char per-hint ceiling.
  assert.ok(VOICE_TEXT.length < 2500, `hint is ${VOICE_TEXT.length} chars`);
});

// ------------------------------------------------- never in front of the keystroke

test('a proxy that THROWS is swallowed, and the arm reports the failure', () => {
  const r = recorder({ throws: true });
  const arm = createVoiceOriginArm({ armHints: r.armHints });
  assert.strictEqual(arm.arm(CTX), false, 'a throw must not escape into the submit path');
  assert.strictEqual(r.calls.length, 1, 'ENTER: it must have TRIED to arm');
});

test('a REJECTED arm is swallowed too, with no unhandled rejection', async () => {
  // The rejecting case is the one a `.catch()` omission would leak, and it
  // surfaces as a process-level crash rather than a failing assertion.
  const r = recorder({ rejects: true });
  const arm = createVoiceOriginArm({ armHints: r.armHints });
  assert.strictEqual(arm.arm(CTX), true);
  await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(r.calls.length, 1);
});

test('the arm returns synchronously — no promise reaches the caller', () => {
  // What keeps the proxy out from in front of the operator's Enter: there is no
  // value to await, so no caller can be written that waits on it.
  let settled = false;
  const arm = createVoiceOriginArm({
    armHints: () => new Promise((res) => setTimeout(() => { settled = true; res({}); }, 50)),
  });
  const out = arm.arm(CTX);
  assert.strictEqual(typeof out, 'boolean');
  assert.strictEqual(settled, false, 'the arm must not have waited for the proxy');
});

// ------------------------------------------------------------ the proxy-off case

test('no base is a proxy that is off, not an error: nothing is posted', () => {
  for (const ctx of [null, {}, { base: null, route: 'r' }, { base: 'b', route: null }]) {
    const r = recorder();
    const arm = createVoiceOriginArm({ armHints: r.armHints });
    assert.strictEqual(arm.arm(ctx), false, JSON.stringify(ctx));
    assert.deepStrictEqual(r.calls, [], JSON.stringify(ctx));
  }
});

// --------------------------------------------------------- the discriminator

test('voice origin requires POSITIVE evidence, and its default is NO', () => {
  // Each row carries its own expectation as a literal. The `now`/`evidenceAt`
  // pairs are chosen so no row can be satisfied by re-applying the code's own
  // subtraction rule — the absent and future rows are true for reasons the
  // window arithmetic alone does not produce.
  const W = 20_000;
  const rows = [
    { what: 'never seen', evidenceAt: null, now: 1_000_000, expect: false },
    { what: 'undefined', evidenceAt: undefined, now: 1_000_000, expect: false },
    { what: 'NaN', evidenceAt: NaN, now: 1_000_000, expect: false },
    { what: 'just now', evidenceAt: 1_000_000, now: 1_000_000, expect: true },
    { what: 'inside the window', evidenceAt: 990_000, now: 1_000_000, expect: true },
    { what: 'exactly at the edge', evidenceAt: 980_000, now: 1_000_000, expect: true },
    { what: 'one ms past the edge', evidenceAt: 979_999, now: 1_000_000, expect: false },
    { what: 'long stale', evidenceAt: 1, now: 1_000_000, expect: false },
    // A clock that went backwards is not evidence of a microphone.
    { what: 'in the future', evidenceAt: 1_000_001, now: 1_000_000, expect: false },
  ];
  for (const r of rows) {
    assert.strictEqual(
      isVoiceOriginated({ evidenceAt: r.evidenceAt, now: r.now, windowMs: W }),
      r.expect, r.what);
  }
  // Typing produces no evidence at all, which is the whole discrimination.
  assert.strictEqual(isVoiceOriginated({}), false);
});

test('the recording read reports what is there, and an unreadable screen is NOT evidence', () => {
  // The polarity is the OPPOSITE of recordingBlocksRearm's, deliberately: that
  // one guards a write into a live recording and so must assume the worst on an
  // unreadable screen. This one feeds an annotation, so the same input is
  // simply an absence of evidence.
  assert.strictEqual(recordingObserved([' agents ⏺REC · tap to send']), true);
  assert.strictEqual(recordingObserved(['⏺REC']), true);
  assert.strictEqual(recordingObserved(null), false, 'unreadable is not evidence');
  assert.strictEqual(recordingObserved([]), false);
  assert.strictEqual(recordingObserved(['⏺ Bash(ls)']), false, 'an ordinary tool bullet');
  assert.strictEqual(recordingObserved(['Read(RECOVERY.md)']), false, 'the word RECOVERY');
});
