'use strict';
// focus-policy.js — may a newly created session take the keyboard?
//
// Both call sites are DOM-bound and untestable (the New Session dialog's create
// ritual and the main→renderer `reattach` push handler), so the decision lives
// here whole — the draft query included, by injection — rather than as a pure
// predicate with the interesting half left in renderer.js. What a test can
// reach is what the app runs.
//
// `queryDraftOpen` must resolve the MAIN process's draft state
// (`session:draftOpen` → proxy-util's `isDraftOpen`), never a renderer-local
// notion of "is typing". The inject queue already gates deliveries on that
// state; a second approximation would disagree with it eventually, and the
// disagreement is exactly the focus theft this file prevents.

// `hasFocusedSession` false means the window is showing the empty state: no
// draft, no attention to steal, so even a background seat takes it rather than
// spawning behind an empty pane.
function shouldFocusNewSession({
  agentInitiated = false,
  focusedDraftOpen = false,
  hasFocusedSession = true,
} = {}) {
  if (!hasFocusedSession) return true;
  // Hard veto, ahead of provenance: a half-typed line belongs to the operator
  // whoever created the new seat.
  if (focusedDraftOpen) return false;
  return !agentInitiated;
}

// Resolves to the name to switch to, or null to leave focus where it is.
// A rejected/absent query answers "no draft", which restores the pre-t412
// behaviour for the manual path; the provenance rule still holds an agent
// spawn back, so a lost query cannot revive the theft this ticket is about.
async function decideNewSessionFocus({
  name, focused = null, agentInitiated = false, queryDraftOpen = null,
} = {}) {
  let focusedDraftOpen = false;
  // Not asked when the new session IS the focused one (nothing to steal from)
  // or when there is no focused session — a query whose answer cannot change
  // the outcome is a round trip for nothing.
  if (focused && focused !== name && typeof queryDraftOpen === 'function') {
    try {
      const r = await queryDraftOpen(focused);
      focusedDraftOpen = !!(r && r.open);
    } catch {}
  }
  const focus = shouldFocusNewSession({
    agentInitiated, focusedDraftOpen, hasFocusedSession: !!focused,
  });
  return focus ? name : null;
}

module.exports = { shouldFocusNewSession, decideNewSessionFocus };
