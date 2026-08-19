'use strict';
// The cleared cwd must LOOK inert, and the rule that makes it so must not be
// keyed on a class the Clear handler removes.
//
// The state: a role dispatching `standing` renders its stored cwd stale —
// visible, disabled, with a note. Clear blanks the input and drops `.stale`
// (with its note's warn colour), but deliberately LEAVES THE INPUT DISABLED,
// because the role is still standing and a re-enabled box would invite a value
// Save persists invisibly. So there is a live state — empty, uneditable — that
// `.team-role-field.stale input` no longer covers. Without a rule keyed on
// `disabled` it renders at full opacity: indistinguishable from an ordinary
// empty field the operator can type into.
//
// Only a comment held this before. `manual/team-popover-stale-fields.js` checks
// the computed opacity, but it needs a running Electron and nobody runs it in
// the loop — deleting the CSS rule was GREEN in the suite.
//
// This is deliberately NOT a value pin. The number is a styling choice and an
// ordinary restyle must not fail here; what may not regress is that SOME visual
// distinction survives the class the Clear removes. The cross-file half is what
// makes it more than a literal: the popover is the authority on which classes
// the cleared state keeps, and the CSS is checked against that.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf-8');
const POPOVER = fs.readFileSync(
  path.join(ROOT, 'renderer/popovers/team-roles-popover.js'), 'utf-8');

// Properties that make a disabled box read as inert. Any ONE of them is enough
// — the point is that the state is distinguished, not how.
const DISTINGUISHING = /(^|[;{\s])(opacity|filter|color|background|background-color|border-color|text-decoration)\s*:/;

// Flat-CSS parse (same shape as css-hidden-invariant.test.js): selector lists
// that target a disabled input inside a team-role-field WITHOUT depending on
// `.stale`, and whose body distinguishes it visually.
function inertRulesIndependentOfStale(src) {
  const found = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = m;
    if (!DISTINGUISHING.test(body)) continue;
    for (const sel of selectors.split(',')) {
      const s = sel.trim();
      if (!/\.team-role-field\b/.test(s)) continue;
      if (!/input[^,]*:disabled|:disabled[^,]*input/.test(s)) continue;
      // The whole point: a rule that also requires `.stale` is gone the moment
      // Clear removes that class, which is the state this exists to cover.
      if (/\.stale\b/.test(s)) continue;
      found.push(s);
    }
  }
  return found;
}

test('the popover really does leave the cleared field disabled and un-staled', () => {
  // ENTER: everything below is only meaningful while the JS keeps producing the
  // state the CSS has to cover. If the Clear handler stopped removing `.stale`,
  // or stopped leaving the input disabled, the CSS requirement would be a
  // different requirement and this file would be pinning a rule nothing needs.
  const handler = /clear\.addEventListener\('click', \(\) => \{[\s\S]*?\n {10}\}\);/.exec(POPOVER);
  assert.ok(handler, 'ENTER: found the Clear handler — a rename would vacuum out this premise');
  assert.match(handler[0], /field\.classList\.remove\('stale'\)/,
    'ENTER: the Clear still drops `.stale`, which is what takes the field out of the stale rule');
  assert.ok(!/\binput\.disabled\b/.test(handler[0]),
    'ENTER: the Clear still leaves the input disabled — that is the state needing its own rule');

  const stale = /if \(state === 'stale'\) \{[\s\S]*?clear\.addEventListener/.exec(POPOVER);
  assert.ok(stale, 'ENTER: found the stale branch that renders the field');
  assert.match(stale[0], /input\.disabled = true;/,
    'ENTER: the field is disabled when rendered, so it is still disabled after a Clear');
});

test('a disabled team-role input is visually distinguished without `.stale`', () => {
  const rules = inertRulesIndependentOfStale(CSS);
  assert.notDeepStrictEqual(rules, [],
    'renderer/styles.css has no rule dimming `.team-role-field input:disabled` independently '
    + 'of `.stale`. Clearing a stale cwd removes that class but leaves the input disabled, so '
    + 'that state now renders at FULL OPACITY — uneditable, unexplained and indistinguishable '
    + 'from an ordinary empty field. Restore a rule keyed on `:disabled` (the value is free; '
    + 'the visual distinction is not).');
});

test('the detector separates a covered state from an uncovered one', () => {
  // Guards the guard. The test above passes on the real file, which cannot tell
  // us it would still FAIL for the reason it exists — and a selector parse that
  // silently matched nothing would be green forever.
  const covered = '.team-role-field input:disabled { opacity: 0.55; }';
  const staleOnly = '.team-role-field.stale input { opacity: 0.55; }';
  const restyled = '.team-role-field input:disabled { opacity: 0.4; color: var(--text-dim); }';
  const layoutOnly = '.team-role-field input:disabled { margin: 0; }';

  assert.deepStrictEqual(inertRulesIndependentOfStale(covered),
    ['.team-role-field input:disabled'], 'the detector no longer sees the rule it guards');
  assert.deepStrictEqual(inertRulesIndependentOfStale(staleOnly), [],
    'a rule keyed on `.stale` must NOT satisfy this — it is exactly the gap the Clear opens');
  assert.notDeepStrictEqual(inertRulesIndependentOfStale(restyled), [],
    'the pin is on the property, not the value: an ordinary restyle must stay green');
  assert.deepStrictEqual(inertRulesIndependentOfStale(layoutOnly), [],
    'a rule that changes no visual property does not make the state distinguishable');
});
