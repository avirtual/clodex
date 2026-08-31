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
// armed for a submit that never reaches the model is still live until its TTL,
// and the next turn inside that window takes it. What puts it on the intended
// turn is the ORDERING at the call site (armed before the Enter that submits
// the text it describes); the TTL only bounds how long a mis-armed one can
// linger, which is why it is short.
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

// One-shot, so the proxy requires a TTL — and THE TTL IS THE MISLABEL EXPOSURE
// WINDOW, which is what sets it. An armed marker whose submit never reached the
// model stays live until it expires, and the next turn inside that window is
// labelled as spoken whether or not it was.
//
// The only gap it legitimately has to cover is erase + Enter + the CLI's
// dispatch, which is sub-second. So this is already two orders of magnitude of
// headroom over what the feature needs, and every second beyond that buys
// nothing while widening the window in which a typed message can be mislabelled.
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
//   armHints ({base, route, id, text, ttl_s, turn_start_only, once}) -> Promise
//   log      optional
function createVoiceOriginArm({ armHints, log = null, ttlS = VOICE_TTL_S }) {
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

  return { arm };
}

module.exports = { createVoiceOriginArm, VOICE_ID, VOICE_TTL_S, VOICE_TEXT };
