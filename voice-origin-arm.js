// voice-origin-arm.js — tell the receiving agent that the message it is about
// to read came out of a microphone.
//
// Speech-to-text does not always produce what the operator said (measured: a
// spoken "over and out" arrived as "call where not"). An agent reading the
// literal has no way to know, so it treats a garbled word as deliberate. Told
// the text is transcribed, it can read for intent and ASK instead of guessing.
//
// THE CHANNEL IS THE ONE-SHOT WIRESCOPE HINT, not the UserPromptSubmit drain.
// `once` + a required TTL is what makes the marker physically unable to persist
// onto a later TYPED message: the proxy pops it on the first request of the
// turn and never persists it (one-shot payloads are excluded from the agent
// table), so the failure mode of a hint armed for a message that never gets
// sent is expiry, not a mislabelled message. It also costs no transcript bytes.
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

// One-shot, so the proxy requires a TTL. It bounds how long an armed marker can
// sit if the submit it was armed for never reaches the model — short, because
// the only thing that legitimately sits between the arm and the request is one
// erase-plus-Enter, and long enough to survive a CLI that is slow to dispatch.
const VOICE_TTL_S = 60;

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
