'use strict';
// prefs-gate.js — which Preferences controls are inert given the current state
// of the dialog. Pure leaf: renderer.js plumbs the result into `disabled` and a
// reason line.
//
// The three proxy-dependent toggles are not merely "less useful" with the proxy
// off — they are DEAD. Hints are armed through ProxyClient, and `_armCtx` passes
// `base: s.proxyBase || null`, which is null when the session was spawned
// unrouted; hint-arm returns immediately on a falsy base. So the checkbox
// persists, survives a reload, and does nothing.
//
// NEW leaf (not a renderer.js extraction), so — following the tool-gate.js and
// sandbox-view.js precedent — deliberately NOT added to
// test/free-identifier-leaks.test.js RENDERER_SCANNED_MODULES.

// Each dependent control names the pref it needs and why, so the reason shown
// in the UI cannot drift from the dependency being enforced.
const PROXY_DEPENDENT = [
  ['compactOnResume', 'Needs traffic optimization — the bake mirrors what the proxy strips.'],
  ['contextHints', 'Needs traffic optimization — hints are attached by the proxy.'],
  ['semanticHints', 'Needs traffic optimization — hints are attached by the proxy.'],
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
