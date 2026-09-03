'use strict';

// dialog-escape-parity.test.js — New Session, Preferences and Edit Session close
// on Escape and on an outside press, the way every other dismissable surface in
// the renderer does.
//
// The reported symptom was "the app is stuck": three of the seven dialogs had no
// way out but Cancel or the X. At the commit this was written, NO dialog closed
// on Escape — the four that were believed to (peers, plugins, sandbox,
// discovery) each had an outside-press handler only, so there was no existing
// Escape implementation to copy and no regression to guard.
//
// Escape is bound on `document`, so the listener sees every keystroke in the
// window and must decide for itself whether it is the one that should act. It
// asks chord-guard's openOverlayIds and closes only when this dialog is the SOLE
// open overlay — the same shape performCloseChord uses for Cmd+W, and the same
// refusal files-popover makes when the peek is open above it. What that buys is
// the stacked case below; what it costs is nothing, because the guard's list
// deliberately omits the nested new-session tool notice.
//
// Five subjects per dialog. The last two are what keep the first three honest:
//   Escape         — reds if the keydown binding is dropped.
//   closed dialog  — nothing open: reds if the listener acts unconditionally,
//                    firing teardown (closePrefs stops a poll timer and the
//                    voice control) against a surface nobody opened.
//   other keys     — reds if the key test goes.
//   STACKED modal  — this dialog open AND a modal above it. Reds if the gate
//                    weakens to "am I open" — which is what one press
//                    dismissing two surfaces looks like from here.
//   INSIDE press   — the anti-degenerate half for the press half. "close on any
//                    mousedown" satisfies the backdrop subject completely; only
//                    this one separates them.
//
// The handlers are executed out of renderer.js rather than re-typed here, and
// against the REAL guard rather than a stub of it: a fake that answered the
// open-set question itself would pin this file's idea of stacking rather than
// the one the chords already act on, and the two could then drift apart
// silently. A re-typed copy asserts only that the test agrees with itself.
// Every extraction below is floored with an ENTER assertion naming what it must
// have captured.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { MODAL_OVERLAY_IDS, openOverlayIds } = require('../renderer/lib/chord-guard');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

// The three dialogs, by the overlay variable renderer.js binds on and the close
// function it is expected to call. The close names are LITERAL per row: deriving
// them (e.g. from the overlay name) would make the table structurally unable to
// express that Edit Session's closer is `closeArgsDialog` and not `closeArgs`.
const DIALOGS = [
  { label: 'New Session', overlay: 'dialogOverlay', id: 'dialog-overlay', close: 'closeDialog' },
  { label: 'Preferences', overlay: 'prefsOverlay', id: 'prefs-overlay', close: 'closePrefs' },
  { label: 'Edit Session', overlay: 'argsOverlay', id: 'args-overlay', close: 'closeArgsDialog' },
];

// A second modal raised OVER one of the three, one per route that reaches it.
// Both are already in MODAL_OVERLAY_CLASSES, so the guard sees them without any
// new enumeration: prompt-modal-overlay is promptText (btnSaveTemplate lives
// inside the New Session form), clx-modal-bg is the web frontend's showDialog
// (btn-browse raises it over the same form).
const STACKED = ['prompt-modal-overlay', 'clx-modal-bg'];

// --- the smallest DOM these handlers touch -----------------------------------
// The probes the guard reads the document through, modelling exactly what is
// OPEN. Mirrors chord-overlay-guard.test.js's fakeDom, and for the same reason:
// an id overlay stays in the document carrying `hidden`, while a class backdrop
// is appended and removed outright, so ABSENT is its closed state.
function fakeProbes(open) {
  return {
    byId: (id) => (MODAL_OVERLAY_IDS.includes(id)
      ? { classList: { contains: (c) => c === 'hidden' && !open.includes(id) } }
      : null),
    byClass: (cls) => (open.includes(cls) ? [{ classList: { contains: () => false } }] : []),
  };
}

function makeFixture(varName, closeName, overlayId, { open = [], which = 'both' } = {}) {
  const overlayListeners = new Map();
  const docListeners = new Map();
  function push(map, type, fn) {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  }
  const overlay = { addEventListener: (type, fn) => push(overlayListeners, type, fn) };
  const document = { addEventListener: (type, fn) => push(docListeners, type, fn) };

  const closed = [];
  // The REAL guard, not a stub of it: a fake that answered the open-set question
  // itself would pin this test's idea of stacking rather than the one the chords
  // already act on, and the two could then disagree silently.
  const stubs = {
    [varName]: overlay,
    [closeName]: () => closed.push(closeName),
    document,
    openOverlayIds,
    overlayProbes: fakeProbes(open),
  };

  const block = extractBlock(varName, overlayId, which);
  const names = Object.keys(stubs);
  new Function(...names, block)(...names.map((n) => stubs[n]));

  const fire = (map, type, e) => { for (const fn of map.get(type) || []) fn(e); };
  return {
    overlay,
    closed,
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

// Anchored on the overlay ID the block closes on, at line starts, so it selects
// this dialog's listener positively rather than by being the first `keydown`
// block that happens not to contain a brace. The chord handlers are also
// document-level keydown listeners a loose pattern can wander into.
function extractEscape(varName, overlayId) {
  const re = new RegExp(
    `^document\\.addEventListener\\('keydown', \\(e\\) => \\{\\n`
    + `(?:[ \\t].*\\n)*?[ \\t].*'${overlayId}'.*\\n`
    + `\\}\\);$`, 'm');
  const m = rendererSrc.match(re);
  assert.ok(m, `ENTER: no Escape binding found for ${varName} in renderer.js`);
  assert.match(m[0], /e\.key !== 'Escape'/,
    `ENTER: ${varName}'s captured keydown block must be the Escape one`);
  assert.match(m[0], /openOverlayIds\(overlayProbes\)/,
    `ENTER: ${varName}'s Escape block must consult the shared open-overlay guard`);
  assert.doesNotMatch(m[0], /metaKey|altChordAction/,
    `ENTER: the regex wandered into a chord handler for ${varName}`);
  return m[0];
}

// Only the block under test is run, so a fixture built for one mechanism cannot
// be satisfied by the other.
function extractBlock(varName, overlayId, which) {
  if (which === 'press') return extractPress(varName);
  if (which === 'escape') return extractEscape(varName, overlayId);
  return `${extractPress(varName)}\n${extractEscape(varName, overlayId)}`;
}

for (const { label, overlay: varName, id: overlayId, close: closeName } of DIALOGS) {
  test(`${label}: Escape closes it`, () => {
    const f = makeFixture(varName, closeName, overlayId, { which: 'escape', open: [overlayId] });
    assert.deepStrictEqual(f.boundDocTypes(), ['keydown'],
      'ENTER: the Escape binding must be on document, not on the overlay');
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [closeName], `Escape must call ${closeName}`);
  });

  test(`${label}: Escape while the dialog is CLOSED closes nothing`, () => {
    // A document-level listener sees every keystroke in the window. Without the
    // open-set gate this fires teardown against a dialog nobody opened —
    // closePrefs stops a poll timer and the voice control.
    const f = makeFixture(varName, closeName, overlayId, { which: 'escape', open: [] });
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [], `${closeName} ran against a closed dialog`);
  });

  test(`${label}: a key that is not Escape closes nothing`, () => {
    const f = makeFixture(varName, closeName, overlayId, { which: 'escape', open: [overlayId] });
    for (const k of ['Enter', 'a', 'Tab', 'ArrowDown']) f.key(k);
    assert.deepStrictEqual(f.closed, [], 'only Escape may close the dialog');
  });

  test(`${label}: Escape with a modal stacked ABOVE it closes nothing`, () => {
    // The rework defect. Both stacked modals dismiss themselves on Escape
    // WITHOUT stopping propagation for this listener — api-shim's showDialog
    // registers in the capture phase and does not stop it at all, and
    // promptText's stopPropagation is bound to its input, so it shields only
    // once that input has taken focus (a 50ms setTimeout later) and not after a
    // click on Cancel. So the same press reaches here with the dialog still
    // un-hidden, and an ungated listener dismisses two surfaces at once —
    // stranding the prompt over a dead parent with its promise unresolved.
    for (const above of STACKED) {
      const f = makeFixture(varName, closeName, overlayId, { which: 'escape', open: [overlayId, above] });
      f.key('Escape');
      assert.deepStrictEqual(f.closed, [],
        `${label} closed underneath a stacked ${above}`);
    }
  });

  test(`${label}: a press on the backdrop closes it`, () => {
    const f = makeFixture(varName, closeName, overlayId, { which: 'press' });
    assert.deepStrictEqual(f.boundOverlayTypes(), ['mousedown'],
      'ENTER: the outside-press binding must be a mousedown on the overlay');
    f.press(f.overlay);
    assert.deepStrictEqual(f.closed, [closeName], `a backdrop press must call ${closeName}`);
  });

  test(`${label}: a press INSIDE the dialog does not close it`, () => {
    // The anti-degenerate half. A handler that closes on any mousedown passes
    // the backdrop subject above and makes the dialog unusable — every click on
    // a field or a button would dismiss it.
    const f = makeFixture(varName, closeName, overlayId, { which: 'press' });
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
  const pairs = DIALOGS.map(({ overlay, id, close }) => {
    const block = extractBlock(overlay, id);
    const calls = [...block.matchAll(/(close[A-Za-z]*)\(\)/g)].map((m) => m[1]);
    return [overlay, [...new Set(calls)]];
  });
  assert.deepStrictEqual(pairs, [
    ['dialogOverlay', ['closeDialog']],
    ['prefsOverlay', ['closePrefs']],
    ['argsOverlay', ['closeArgsDialog']],
  ]);
});
