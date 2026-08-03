'use strict';
// prefs-gate.js — which Preferences controls are inert given the current state
// of the dialog. Pure leaf: renderer.js plumbs the result into `disabled` and a
// reason line.
//
// The three wirescope-dependent toggles are not merely "less useful" with it off
// — they are DEAD. Hints are armed through ProxyClient, and `_armCtx` resolves a
// null base whenever wirescope is not routing this session; hint-arm returns
// immediately on a falsy base. So the checkbox persists, survives a reload, and
// does nothing.
//
// NEW leaf (not a renderer.js extraction), so — following the tool-gate.js and
// sandbox-view.js precedent — deliberately NOT added to
// test/free-identifier-leaks.test.js RENDERER_SCANNED_MODULES.

// Each dependent control names the pref it needs and why, so the reason shown
// in the UI cannot drift from the dependency being enforced.
const PROXY_DEPENDENT = [
  ['compactOnResume', 'Needs wirescope — it is what bakes the transcript.'],
  ['contextHints', 'Needs wirescope — it is what attaches the hint.'],
  ['semanticHints', 'Needs wirescope — it is what attaches the hint.'],
];

// state: the live checkbox values, NOT saved settings — the gate must respond to
// unticking the master before Save, or the dialog would claim a control is live
// while the change that kills it is already on screen.
// Returns { [key]: { disabled, reason } } for every dependent control.
function prefsGate(state) {
  const out = {};
  const proxyOn = !!(state && state.proxyEnabled);
  for (const [key, reason] of PROXY_DEPENDENT) {
    out[key] = proxyOn ? { disabled: false, reason: '' } : { disabled: true, reason };
  }
  // Semantic ranking only reorders what the hint path retrieved, so it is dead
  // whenever hints are — one level deeper than the proxy dependency above.
  if (proxyOn && !(state && state.contextHints)) {
    out.semanticHints = { disabled: true, reason: 'Needs contextual memory hints — it ranks what they retrieve.' };
  }
  return out;
}

module.exports = { prefsGate, PROXY_DEPENDENT };
