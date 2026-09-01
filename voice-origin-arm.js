// voice-origin-arm.js — tell the receiving agent that the message it is about
// to read came out of a microphone.
//
// Speech-to-text does not always produce what the operator said (measured: a
// spoken "over and out" arrived as "call where not"). An agent reading the
// literal has no way to know, so it treats a garbled word as deliberate. Told
// the text is transcribed, it can read for intent and ASK instead of guessing.
//
// THE CHANNEL IS THE ONE-SHOT WIRESCOPE HINT, not the UserPromptSubmit drain.
// The proxy pops it on the first request of a turn and never persists it
// (one-shot payloads are excluded from the agent table), so it costs no
// transcript bytes and cannot accrete turn over turn.
//
// `once` bounds the marker to ONE delivery, NOT to the right one: a marker
// armed for a submit that never reaches the model would be taken by the next
// turn inside its TTL. What puts it on the intended turn is the ORDERING at the
// call site (armed before the Enter that submits the text it describes), and
// what keeps it OFF an unintended one is `disarm`, which the caller owes on
// every path that abandons the submit it armed for. The TTL is only the
// backstop for a disarm the proxy never received.
//
// ITS OWN ID, NEVER hint-arm.js's. That register is a fixed-id REGISTER whose
// empty pass CLEARS it, and the operator's typing rewrites it continuously; a
// voice marker sharing the id would be overwritten by the next keystroke and
// would delete his contextual hint on the way out. The proxy registry is a
// dict keyed by id and `armHints` posts mode=merge, so two ids coexist on one
// route — verified against a live proxy, both ids present in the read-back.
//
// ARMING MAY NEVER AFFECT THE KEYSTROKE. Nothing here is awaited by the submit
// path and no failure propagates: a dead wirescope must cost the operator the
// marker, never the Enter.

'use strict';

// One-shot, so the proxy requires a TTL. It is bounded from BOTH sides and the
// lower bound is the surprising one.
//
// FLOOR: the tap path does not submit beside the arm. It stops the recorder,
// then waits for the CLI's transcription to finish before writing `\r` — a
// first read one repaint after the key, then a poll to its own abandon
// deadline. That is the gap the marker has to survive, and it is seconds, not
// the sub-second erase+Enter this once covered. A TTL under it expires the
// marker before the submit it belongs to goes out, which loses the annotation
// on exactly the dictated messages the feature is for. The watcher owns those
// two numbers; do not re-derive this one from them, and do not shorten this
// toward what the immediate path needs.
//
// CEILING: the TTL is the mislabel exposure window. `disarm` unwinds a marker
// whose submit stood down, so the window is normally closed at the abandon
// rather than waited out — but the disarm is a POST that a dead proxy never
// receives, and this is what bounds the leak when it fails.
const VOICE_TTL_S = 20;

// Distinct from hint-arm.js's HINT_ID and selection-hint.js's PEEK_ID; the
// proxy id grammar is lowercase token.
const VOICE_ID = 'voice-origin';

// States what the channel was and what to DO about it. The instruction is the
// payload: "this was dictated" alone invites the reader to note the fact and
// carry on reading the literal, which is the behaviour this exists to change.
const VOICE_TEXT = 'The message that follows was SPOKEN by the operator and '
  + 'machine-transcribed, not typed. Transcription errors are expected and '
  + 'measured: a word that does not fit the context is more likely a '
  + 'near-homophone mis-transcription than a deliberate choice. Read for '
  + 'intent, and ASK rather than guess when a word does not fit.';

// NO `enabled` GETTER, DELIBERATELY — do not add one. Every other armer here
// gates on its own pref because it forwards CONTENT (memories, the operator's
// screen selection) and so needs its own consent decision. This forwards no
// content: it is a fixed sentence about the CHANNEL the operator already chose
// by dictating. Its off switch is the hands-free submit setting itself, and a
// second pref would be one more thing to leave off by accident.
//
// deps:
//   armHints   ({base, route, id, text, ttl_s, turn_start_only, once}) -> Promise
//   clearHints ({base, route, id}) -> Promise   (optional; absent = no disarm)
//   log        optional
function createVoiceOriginArm({ armHints, clearHints = null, log = null, ttlS = VOICE_TTL_S }) {
  const debug = (msg) => { try { if (log && log.debug) log.debug('voice-hint', msg); } catch {} };

  // Fire and forget by construction: the promise is consumed HERE rather than
  // returned, so no caller can be written that awaits it and puts the proxy in
  // front of the operator's Enter.
  function arm(ctx) {
    const { base, route } = ctx || {};
    // No base is the proxy being off or the session unrouted, not an error —
    // hands-free submit works without wirescope, it just carries no marker.
    if (!base || !route) return false;
    try {
      Promise.resolve(armHints({
        base,
        route,
        id: VOICE_ID,
        text: VOICE_TEXT,
        ttl_s: ttlS,
        // Rides the FIRST request of the turn: the operator's message, not a
        // tool-result continuation later in the same turn.
        turn_start_only: true,
        once: true,
      })).catch((e) => debug(`arm failed for ${route}: ${e.message}`));
    } catch (e) {
      debug(`arm threw for ${route}: ${e.message}`);
      return false;
    }
    return true;
  }

  // Unwinds a marker whose submit stood down. `once` bounds the marker to one
  // delivery but not to the RIGHT one, so an armed-and-abandoned marker is
  // taken by the next turn — which may be typed, and which the payload then
  // tells the reader to second-guess.
  //
  // Idempotent at the proxy (clearing an absent hint is a 200), so this never
  // reads before it writes and a disarm racing the marker's own expiry is not
  // an error. Fire-and-forget on the same rule as `arm`: this runs on paths the
  // operator's keystroke also runs on, and a dead wirescope must cost the
  // unwind, never the key. A failure leaves today's behaviour, bounded by the
  // TTL.
  function disarm(ctx) {
    const { base, route } = ctx || {};
    if (!base || !route || !clearHints) return false;
    try {
      Promise.resolve(clearHints({ base, route, id: VOICE_ID }))
        .catch((e) => debug(`disarm failed for ${route}: ${e.message}`));
    } catch (e) {
      debug(`disarm threw for ${route}: ${e.message}`);
      return false;
    }
    return true;
  }

  return { arm, disarm };
}

module.exports = { createVoiceOriginArm, VOICE_ID, VOICE_TTL_S, VOICE_TEXT };
