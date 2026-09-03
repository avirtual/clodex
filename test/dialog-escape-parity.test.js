'use strict';

// dialog-escape-parity.test.js — New Session, Preferences and Edit Session close
// on Escape and on an outside press, the way every other dismissable surface in
// the renderer does.
//
// The reported symptom was "the app is stuck": three of the seven dialogs had no
// way out but Cancel or the X. At the commit this was written, NO dialog closed
// on Escape — the four that were believed to (peers, plugins, sandbox,
// discovery) each had an outside-press handler only, so there was no existing
// Escape implementation to copy and no regression to guard. These three follow
// the ~15-site popover idiom instead (`document` keydown, gated on `hidden`).
//
// Each dialog gets three subjects, and the third is what keeps the other two
// honest:
//   Escape         — reds if the keydown binding is dropped.
//   outside press  — reds if the mousedown binding is dropped.
//   INSIDE press   — the anti-degenerate half. "close on any mousedown" and
//                    `e.target !== overlay` both satisfy the outside subject
//                    completely; only this one separates them.
//
// The Escape subjects fire the handler while the overlay is HIDDEN as well,
// because a `document`-level listener sees every keystroke in the window: a
// binding that skips the `hidden` check closes a dialog that was never open,
// and calls its teardown (closePrefs stops a poll timer and the voice control)
// against a surface nobody opened. Reds if the gate goes.
//
// The handlers are executed out of renderer.js rather than re-typed here. A
// re-typed copy asserts that the test agrees with itself, which is what a source
// regex alone would also do — so every extraction below is floored with an
// ENTER assertion naming the binding it must have captured.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

// The three dialogs, by the overlay variable renderer.js binds on and the close
// function it is expected to call. The close names are LITERAL per row: deriving
// them (e.g. from the overlay name) would make the table structurally unable to
// express that Edit Session's closer is `closeArgsDialog` and not `closeArgs`.
const DIALOGS = [
  { label: 'New Session', overlay: 'dialogOverlay', close: 'closeDialog' },
  { label: 'Preferences', overlay: 'prefsOverlay', close: 'closePrefs' },
  { label: 'Edit Session', overlay: 'argsOverlay', close: 'closeArgsDialog' },
];

// --- the smallest DOM these handlers touch -----------------------------------
// They read `e.target`, `e.key` and `classList.contains('hidden')`, and nothing
// else. `hidden` is the open/closed state for all three (none is removed from
// the document), so a boolean models it exactly.

function makeFixture(varName, closeName, { hidden = false, which = 'both' } = {}) {
  const state = { hidden };
  const overlay = {
    classList: { contains: (c) => c === 'hidden' && state.hidden },
    addEventListener: (type, fn) => push(overlayListeners, type, fn),
  };
  const overlayListeners = new Map();
  const docListeners = new Map();
  function push(map, type, fn) {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  }
  const document = { addEventListener: (type, fn) => push(docListeners, type, fn) };

  const closed = [];
  const stubs = {
    [varName]: overlay,
    [closeName]: () => closed.push(closeName),
    document,
  };

  const block = extractBlock(varName, which);
  const names = Object.keys(stubs);
  new Function(...names, block)(...names.map((n) => stubs[n]));

  const fire = (map, type, e) => { for (const fn of map.get(type) || []) fn(e); };
  return {
    overlay,
    closed,
    state,
    boundOverlayTypes: () => [...overlayListeners.keys()].sort(),
    boundDocTypes: () => [...docListeners.keys()].sort(),
    press: (target) => fire(overlayListeners, 'mousedown', { target }),
    key: (key) => fire(docListeners, 'keydown', { key }),
  };
}

// The two bindings are extracted SEPARATELY, and that separation is load-bearing.
// Captured as one adjacent block, dropping either binding fails the block's own
// ENTER floor and reds all six subjects for both mechanisms at once — so the
// suite could no longer say WHICH mechanism broke, and the press subjects would
// be reding for a reason that has nothing to do with a press.
function extractPress(varName) {
  const m = rendererSrc.match(new RegExp(`${varName}\\.addEventListener\\('mousedown'.*\\n`));
  assert.ok(m, `ENTER: no outside-press binding found for ${varName} in renderer.js`);
  return m[0];
}

function extractEscape(varName) {
  const re = new RegExp(
    `document\\.addEventListener\\('keydown', \\(e\\) => \\{\\n[^}]*?${varName}[\\s\\S]*?\\n\\}\\);`);
  const m = rendererSrc.match(re);
  assert.ok(m, `ENTER: no Escape binding found for ${varName} in renderer.js`);
  assert.match(m[0], /e\.key === 'Escape'/,
    `ENTER: ${varName}'s captured keydown block must be the Escape one`);
  return m[0];
}

// Only the block under test is run, so a fixture built for one mechanism cannot
// be satisfied by the other.
function extractBlock(varName, which) {
  if (which === 'press') return extractPress(varName);
  if (which === 'escape') return extractEscape(varName);
  return `${extractPress(varName)}\n${extractEscape(varName)}`;
}

for (const { label, overlay: varName, close: closeName } of DIALOGS) {
  test(`${label}: Escape closes it`, () => {
    const f = makeFixture(varName, closeName, { which: 'escape' });
    assert.deepStrictEqual(f.boundDocTypes(), ['keydown'],
      'ENTER: the Escape binding must be on document, not on the overlay');
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [closeName], `Escape must call ${closeName}`);
  });

  test(`${label}: Escape while the dialog is HIDDEN closes nothing`, () => {
    // A document-level listener sees every keystroke in the window. Without the
    // hidden gate this fires teardown against a dialog nobody opened.
    const f = makeFixture(varName, closeName, { hidden: true, which: 'escape' });
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [], `${closeName} ran against a closed dialog`);
  });

  test(`${label}: a key that is not Escape closes nothing`, () => {
    const f = makeFixture(varName, closeName, { which: 'escape' });
    for (const k of ['Enter', 'a', 'Tab', 'ArrowDown']) f.key(k);
    assert.deepStrictEqual(f.closed, [], 'only Escape may close the dialog');
  });

  test(`${label}: a press on the backdrop closes it`, () => {
    const f = makeFixture(varName, closeName, { which: 'press' });
    assert.deepStrictEqual(f.boundOverlayTypes(), ['mousedown'],
      'ENTER: the outside-press binding must be a mousedown on the overlay');
    f.press(f.overlay);
    assert.deepStrictEqual(f.closed, [closeName], `a backdrop press must call ${closeName}`);
  });

  test(`${label}: a press INSIDE the dialog does not close it`, () => {
    // The anti-degenerate half. A handler that closes on any mousedown passes
    // the backdrop subject above and makes the dialog unusable — every click on
    // a field or a button would dismiss it.
    const f = makeFixture(varName, closeName, { which: 'press' });
    const inner = { classList: { contains: () => false } };
    f.press(inner);
    assert.deepStrictEqual(f.closed, [], 'a press on the dialog body must not close it');
  });
}

test('all three dialogs are wired, and each to its OWN closer', () => {
  // A block extracted for one overlay that closes another would satisfy every
  // subject above (the fixture stubs exactly one closer, so a wrong name would
  // throw rather than mis-close) — this states the pairing directly, and reds if
  // a copy-paste points two overlays at one close function.
  const pairs = DIALOGS.map(({ overlay, close }) => {
    const block = extractBlock(overlay);
    const calls = [...block.matchAll(/(close[A-Za-z]*)\(\)/g)].map((m) => m[1]);
    return [overlay, [...new Set(calls)]];
  });
  assert.deepStrictEqual(pairs, [
    ['dialogOverlay', ['closeDialog']],
    ['prefsOverlay', ['closePrefs']],
    ['argsOverlay', ['closeArgsDialog']],
  ]);
});
