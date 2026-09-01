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
  const cleared = [];
  return {
    calls,
    cleared,
    armHints: (payload) => {
      calls.push(payload);
      if (throws) throw new Error('proxy is down');
      return rejects ? Promise.reject(new Error('proxy refused')) : Promise.resolve({ ok: true });
    },
    clearHints: (payload) => {
      cleared.push(payload);
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
  // The polarity is the OPPOSITE of recorderBlocksRearm's, deliberately: that
  // one guards a write into a live recording and so must assume the worst on an
  // unreadable screen. This one feeds an annotation, so the same input is
  // simply an absence of evidence.
  assert.strictEqual(recordingObserved([' agents ⏺ REC · tap to send']), true);
  assert.strictEqual(recordingObserved(['⏺ REC']), true);
  assert.strictEqual(recordingObserved(null), false, 'unreadable is not evidence');
  assert.strictEqual(recordingObserved([]), false);
  assert.strictEqual(recordingObserved(['⏺ Bash(ls)']), false, 'an ordinary tool bullet');
  assert.strictEqual(recordingObserved(['Read(RECOVERY.md)']), false, 'the word RECOVERY');

  // The indicator SHARES its row with the permission banner in the real footer,
  // so nothing may anchor on the bullet starting the row. Bytes below are the
  // captured row, U+23F5 twice included: a near neighbour of the bullet that a
  // widened U+23Fx class would swallow.
  assert.strictEqual(recordingObserved(
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle)          ⏺ REC · tap to send']), true,
    'the indicator sharing a row with the banner');

  // THE COLLISIONS the space cost us, and the reason the rule ends in (?!\w):
  // a bullet whose next word merely STARTS with REC is not a lit recorder, and a
  // phantom one arms a mic nobody asked for.
  assert.strictEqual(recordingObserved(['⏺ RECOVERY.md']), false, 'a bullet on a file named RECOVERY');
  assert.strictEqual(recordingObserved(['⏺ RECORD the thing']), false, 'the word RECORD after a bullet');
});

// ------------------------------------------------------- withdrawing the marker

// `once` bounds the marker to ONE delivery, not to the RIGHT one: the tap path
// arms at the match and submits seconds later, so a submit that stands down
// leaves the marker live for the rest of its TTL and the next turn takes it.
// Pointed at typed text the payload is actively harmful -- it instructs the
// reader to second-guess words the operator chose deliberately.

test('the disarm clears THIS marker by id, and nothing else on the route', () => {
  // The whole payload. The register is shared -- hint-arm.js and the selection
  // peek live on the same route -- so a disarm that omitted the id would clear
  // the operator's contextual hint along with this one, which is hazard 1 in
  // the withdraw direction.
  const r = recorder();
  const arm = createVoiceOriginArm({ armHints: r.armHints, clearHints: r.clearHints });
  assert.strictEqual(arm.disarm(CTX), true);
  assert.deepStrictEqual(r.cleared, [{ base: CTX.base, route: CTX.route, id: VOICE_ID }]);
  assert.deepStrictEqual(r.calls, [], 'a disarm must not arm anything');
});

test('the disarm never reaches the keystroke: throw, reject and no-base all swallowed', async () => {
  // Hazard 2, and it applies to the unwind exactly as the module header applies
  // it to the arm: the paths that abandon a submit are keystroke paths too, so a
  // dead wirescope must cost the withdrawal and never the key. The failure is
  // bounded rather than unbounded -- the TTL still expires the marker.
  const t = recorder({ throws: true });
  assert.strictEqual(
    createVoiceOriginArm({ armHints: t.armHints, clearHints: t.clearHints }).disarm(CTX), false,
    'a throw must not escape into the submit path');
  assert.strictEqual(t.cleared.length, 1, 'ENTER: it must have TRIED to clear');

  const j = recorder({ rejects: true });
  assert.strictEqual(
    createVoiceOriginArm({ armHints: j.armHints, clearHints: j.clearHints }).disarm(CTX), true);
  await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(j.cleared.length, 1, 'the rejection is caught, not left unhandled');

  for (const ctx of [null, {}, { base: null, route: 'r' }, { base: 'b', route: null }]) {
    const r = recorder();
    const arm = createVoiceOriginArm({ armHints: r.armHints, clearHints: r.clearHints });
    assert.strictEqual(arm.disarm(ctx), false, JSON.stringify(ctx));
    assert.deepStrictEqual(r.cleared, [], JSON.stringify(ctx));
  }
});

test('the disarm returns synchronously, like the arm', () => {
  // Same rule, same reason: no value to await means no caller can be written
  // that puts the proxy in front of the operator's key.
  let settled = false;
  const arm = createVoiceOriginArm({
    armHints: () => Promise.resolve({}),
    clearHints: () => new Promise((res) => setTimeout(() => { settled = true; res({}); }, 50)),
  });
  const out = arm.disarm(CTX);
  assert.strictEqual(typeof out, 'boolean');
  assert.strictEqual(settled, false, 'the disarm must not have waited for the proxy');
});

test('a host that wires no clearHints degrades to the TTL, it does not throw', () => {
  // The unwind is optional at the seam. Absent it, the marker expires on its own
  // -- today's behaviour, bounded by VOICE_TTL_S -- and no caller sees an error.
  const r = recorder();
  const arm = createVoiceOriginArm({ armHints: r.armHints });
  assert.strictEqual(arm.disarm(CTX), false);
  assert.deepStrictEqual(r.cleared, []);
});

// ------------------------------------------------------------------- the TTL

test('the TTL outlasts the tap path\'s own wait, which is what the marker must survive', () => {
  // THE FLOOR, and it is the counter-intuitive bound. The tap path stops the
  // recorder, then waits for transcription before writing `\r`: a first read one
  // STOP_SETTLE_MS after the key, then polling to SUBMIT_ABANDON_MS. A TTL under
  // that expires the marker before the submit it belongs to goes out, losing the
  // annotation on exactly the dictated messages the feature exists for.
  //
  // The watcher's constants are imported rather than restated: this bound is a
  // RELATION between two modules, and a copied number would keep this passing
  // after the watcher's own numbers moved.
  const {
    STOP_SETTLE_MS: STOP, SUBMIT_ABANDON_MS: ABANDON,
  } = require('../renderer/voice-submit-watcher');
  const worstCaseMs = STOP + ABANDON;
  assert.ok(VOICE_TTL_S * 1000 > worstCaseMs,
    `TTL ${VOICE_TTL_S}s must outlast the deferred submit's ${worstCaseMs}ms worst case`);
  // And it is not so far above it that an abandoned marker whose DISARM failed
  // sits on the register for minutes. The disarm is the primary bound; this is
  // the backstop when the proxy never receives it.
  assert.ok(VOICE_TTL_S <= 30, `TTL ${VOICE_TTL_S}s is the failed-disarm exposure window`);
});
