// Run: node --test
// Covers renderer/lib/prefs-gate.js — which Preferences toggles are inert.
//
// The defect this pins: three checkboxes persisted and did nothing with the
// proxy off. `_armCtx` passes `base: s.proxyBase || null` and hint-arm returns
// on a falsy base, so the setting was saved, survived reload, and never acted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { prefsGate, PROXY_DEPENDENT } = require('../renderer/lib/prefs-gate');

test('proxy off: every dependent toggle is disabled with a reason', () => {
  const g = prefsGate({ proxyEnabled: false, contextHints: true });
  for (const [key] of PROXY_DEPENDENT) {
    assert.strictEqual(g[key].disabled, true, `${key} must be disabled`);
    assert.ok(g[key].reason, `${key} must say why`);
  }
});

test('proxy on: nothing is gated on the proxy', () => {
  const g = prefsGate({ proxyEnabled: true, contextHints: true });
  for (const [key] of PROXY_DEPENDENT) {
    assert.strictEqual(g[key].disabled, false, `${key} must be live`);
    assert.strictEqual(g[key].reason, '');
  }
});

// Semantic ranking only REORDERS what the hint path retrieved, so it is dead
// one level deeper than the proxy dependency.
test('proxy on but hints off: semantic ranking is still dead, and says so', () => {
  const g = prefsGate({ proxyEnabled: true, contextHints: false });
  assert.strictEqual(g.semanticHints.disabled, true);
  assert.match(g.semanticHints.reason, /contextual memory hints/i);
  assert.strictEqual(g.contextHints.disabled, false, 'hints itself stays togglable');
  assert.strictEqual(g.compactOnResume.disabled, false, 'the bake does not depend on hints');
});

// The proxy reason must win over the hints reason: telling someone to enable
// hints is useless advice when the proxy they both need is off.
test('both off: the reason names the proxy, not the hints', () => {
  const g = prefsGate({ proxyEnabled: false, contextHints: false });
  assert.match(g.semanticHints.reason, /traffic optimization/i);
});

test('a missing/empty state gates rather than assuming enabled', () => {
  for (const s of [undefined, null, {}]) {
    assert.strictEqual(prefsGate(s).contextHints.disabled, true);
  }
});

// The gate is only honest if the DOM it drives actually exists. These pin the
// contract between the leaf and the markup, which no unit test of a pure
// function can see.
test('every gated control has a checkbox and a reason element in the markup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const ids = {
    compactOnResume: 'prefs-compact-on-resume',
    contextHints: 'prefs-context-hints',
    semanticHints: 'prefs-semantic-hints',
  };
  for (const [key] of PROXY_DEPENDENT) {
    const id = ids[key];
    assert.ok(id, `no markup id known for ${key}`);
    assert.ok(html.includes(`id="${id}"`), `${id} checkbox missing from index.html`);
    assert.ok(html.includes(`id="${id}-why"`), `${id}-why reason element missing from index.html`);
  }
});

test('renderer re-runs the gate when either master toggle changes', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  // Reading live checkbox state is what makes the gate correct before Save; if
  // it only ran on open, unticking the proxy would leave dependants looking live.
  assert.match(js, /prefsProxyEnabled\.addEventListener\('change', applyPrefsGate\)/);
  assert.match(js, /prefsContextHints\.addEventListener\('change', applyPrefsGate\)/);
  assert.match(js, /applyPrefsGate\(\);/, 'openPrefs must apply the gate on open');
});

// A disabled checkbox still reports .checked, and save reads it. That is
// deliberate: greying a control must not silently discard a preference the user
// set earlier, or re-enabling the proxy would come back with hints off.
test('gating is presentational — it exposes no value to write back', () => {
  const g = prefsGate({ proxyEnabled: false, contextHints: true });
  for (const v of Object.values(g)) {
    assert.deepStrictEqual(Object.keys(v).sort(), ['disabled', 'reason']);
  }
});
