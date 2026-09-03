'use strict';

// dialog-escape-parity.test.js — all seven full-screen dialogs close on Escape
// and on an outside press, the way every other dismissable surface in the
// renderer does.
//
// The reported symptom was "the app is stuck": at the commit this file was first
// written NO dialog closed on Escape, and the four believed to (peers, plugins,
// sandbox, discovery) each had an outside-press handler only. Three got Escape
// in the first round; the remaining four are what this revision adds. The
// discovery case is what surfaced them — with Discover Sessions raised over New
// Session, Escape did nothing at all.
//
// Escape is bound ONCE on `document`, as a table of overlay id → closer, rather
// than as seven copies of one block. The listener sees every keystroke in the
// window and must decide for itself whether it is the one that should act: it
// asks chord-guard's openOverlayIds and acts only when exactly ONE overlay is
// open — the same shape performCloseChord uses for Cmd+W. That gate is what buys
// the stacked subject below, and these overlays are siblings with no stacking
// manager, so without it Escape would dismiss the wrong one of two.
//
// Six subjects per dialog. The last three are what keep the first three honest:
//   Escape         — reds if the row is dropped from the table.
//   closed dialog  — nothing open: reds if the listener acts unconditionally,
//                    firing teardown (closePrefs stops a poll timer and the
//                    voice control; closeSandboxDialog stops sbPollTimer)
//                    against a surface nobody opened.
//   other keys     — reds if the key test goes.
//   STACKED modal  — this dialog open AND a modal above it. Reds if the gate
//                    weakens to "am I open" — which is what one press
//                    dismissing two surfaces looks like from here.
//   backdrop press — reds if the outside-press binding is dropped, and pins the
//                    event as mousedown: discovery was the lone `click` of the
//                    seven, where a drag begun inside the panel and released on
//                    the backdrop dismissed it.
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

// The seven dialogs, by the overlay variable renderer.js binds the outside press
// on and the close function Escape is expected to reach. The close names are
// LITERAL per row: deriving them (e.g. from the overlay name) would make the
// table structurally unable to express that Edit Session's closer is
// `closeArgsDialog` and not `closeArgs`, or that Discover's is `closeDiscovery`
// with no `Dialog` suffix at all.
const DIALOGS = [
  { label: 'New Session', overlay: 'dialogOverlay', id: 'dialog-overlay', close: 'closeDialog' },
  { label: 'Discover Sessions', overlay: 'discoveryOverlay', id: 'discovery-overlay', close: 'closeDiscovery' },
  { label: 'Peers', overlay: 'peersOverlay', id: 'peers-overlay', close: 'closePeersDialog' },
  { label: 'Plugins', overlay: 'pluginsOverlay', id: 'plugins-overlay', close: 'closePluginsDialog' },
  { label: 'Sandbox', overlay: 'sandboxOverlay', id: 'sandbox-overlay', close: 'closeSandboxDialog' },
  { label: 'Preferences', overlay: 'prefsOverlay', id: 'prefs-overlay', close: 'closePrefs' },
  { label: 'Edit Session', overlay: 'argsOverlay', id: 'args-overlay', close: 'closeArgsDialog' },
];

// A second modal raised OVER one of the dialogs, one per route that reaches it.
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

// Anchored on `const ESCAPE_CLOSES` through the listener that reads it, so the
// table and its one consumer are captured together — a table left behind by a
// deleted listener would otherwise satisfy the pairing subject while closing
// nothing. The chord handlers are also document-level keydown listeners, so the
// capture is floored below against wandering into one.
function extractEscape() {
  const m = rendererSrc.match(
    /^const ESCAPE_CLOSES = \[\n[\s\S]*?^\}\);$/m);
  assert.ok(m, 'ENTER: no ESCAPE_CLOSES table + keydown listener found in renderer.js');
  assert.match(m[0], /e\.key !== 'Escape'/,
    'ENTER: the captured keydown block must be the Escape one');
  assert.match(m[0], /openOverlayIds\(overlayProbes\)/,
    'ENTER: the Escape block must consult the shared open-overlay guard');
  assert.doesNotMatch(m[0], /metaKey|altChordAction/,
    'ENTER: the regex wandered into a chord handler');
  return m[0];
}

// The two bindings are extracted SEPARATELY, and that separation is load-bearing.
// Captured as one adjacent block, dropping either binding fails the block's own
// ENTER floor and reds all six subjects for both mechanisms at once — so the
// suite could no longer say WHICH mechanism broke, and the press subjects would
// be reding for a reason that has nothing to do with a press.
function extractPress(varName) {
  const m = rendererSrc.match(new RegExp(`${varName}\\.addEventListener\\('mousedown'.*\\n`));
  assert.ok(m, `ENTER: no outside-press mousedown binding found for ${varName} in renderer.js`);
  return m[0];
}

function makeFixture(varName, closeNames, { open = [], which = 'escape' } = {}) {
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
    document,
    openOverlayIds,
    overlayProbes: fakeProbes(open),
  };
  if (varName) stubs[varName] = overlay;
  for (const n of closeNames) stubs[n] = () => closed.push(n);

  const block = which === 'press' ? extractPress(varName) : extractEscape();
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

// Every closer is stubbed for every Escape subject, so a row wired to the WRONG
// closer mis-closes visibly instead of throwing on an undefined name.
const ALL_CLOSERS = DIALOGS.map((d) => d.close);

for (const { label, overlay: varName, id: overlayId, close: closeName } of DIALOGS) {
  test(`${label}: Escape closes it`, () => {
    const f = makeFixture(null, ALL_CLOSERS, { open: [overlayId] });
    assert.deepStrictEqual(f.boundDocTypes(), ['keydown'],
      'ENTER: the Escape binding must be on document, not on the overlay');
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [closeName], `Escape must call ${closeName}, and only it`);
  });

  test(`${label}: Escape while the dialog is CLOSED closes nothing`, () => {
    // A document-level listener sees every keystroke in the window. Without the
    // open-set gate this fires teardown against a dialog nobody opened —
    // closePrefs stops a poll timer and the voice control, closeSandboxDialog
    // stops the sandbox status poll.
    const f = makeFixture(null, ALL_CLOSERS, { open: [] });
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [], `${closeName} ran against a closed dialog`);
  });

  test(`${label}: a key that is not Escape closes nothing`, () => {
    const f = makeFixture(null, ALL_CLOSERS, { open: [overlayId] });
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
      const f = makeFixture(null, ALL_CLOSERS, { open: [overlayId, above] });
      f.key('Escape');
      assert.deepStrictEqual(f.closed, [], `${label} closed underneath a stacked ${above}`);
    }
  });

  test(`${label}: Escape with ANOTHER dialog also open closes nothing`, () => {
    // The stacked subject above raises a class-keyed modal; this one raises a
    // sibling DIALOG, which is the case discovery actually hits (Discover over
    // New Session). A gate that consulted only MODAL_OVERLAY_CLASSES for the
    // stacking question would pass the subject above and close the wrong dialog
    // here.
    const other = DIALOGS.find((d) => d.id !== overlayId).id;
    const f = makeFixture(null, ALL_CLOSERS, { open: [overlayId, other] });
    f.key('Escape');
    assert.deepStrictEqual(f.closed, [], `${label} acted with ${other} also open`);
  });

  test(`${label}: a press on the backdrop closes it`, () => {
    const f = makeFixture(varName, [closeName], { which: 'press' });
    assert.deepStrictEqual(f.boundOverlayTypes(), ['mousedown'],
      'ENTER: the outside-press binding must be a mousedown on the overlay');
    f.press(f.overlay);
    assert.deepStrictEqual(f.closed, [closeName], `a backdrop press must call ${closeName}`);
  });

  test(`${label}: a press INSIDE the dialog does not close it`, () => {
    // The anti-degenerate half. A handler that closes on any mousedown passes
    // the backdrop subject above and makes the dialog unusable — every click on
    // a field or a button would dismiss it.
    const f = makeFixture(varName, [closeName], { which: 'press' });
    const inner = { classList: { contains: () => false } };
    f.press(inner);
    assert.deepStrictEqual(f.closed, [], 'a press on the dialog body must not close it');
  });
}

test('the table names all seven dialogs, each paired with its OWN closer', () => {
  // The per-dialog subjects run one row at a time, so a table carrying an EIGHTH
  // row, or two rows sharing a closer, is invisible to them. This reads the
  // pairs straight out of the source and states them whole.
  const block = extractEscape();
  const rows = [...block.matchAll(/\['([a-z-]+)', \(\) => (close[A-Za-z]*)\(\)\]/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(rows, DIALOGS.map((d) => [d.id, d.close]));
  assert.strictEqual(new Set(rows.map((r) => r[1])).size, rows.length,
    'two overlays point at one close function — a copy-paste in the table');
});

test('every id in the table is one the guard can actually report open', () => {
  // openOverlayIds only ever returns ids from MODAL_OVERLAY_IDS, so a row keyed
  // on an id missing from that list is dead code: its dialog would never close
  // on Escape and every subject above would still pass, because the fixture's
  // byId is built from the same list. This is the one direction the fixture
  // cannot see.
  for (const { id, label } of DIALOGS) {
    assert.ok(MODAL_OVERLAY_IDS.includes(id),
      `${label}'s ${id} is not in MODAL_OVERLAY_IDS — the guard can never report it open`);
  }
});

test('no per-dialog Escape listener survives beside the shared table', () => {
  // The three dialogs that had Escape first were each wired with their own
  // `open[0] === '<id>'` block. Left in place beside the table they would double
  // the close call, and would drift from it — the second mechanism doing the
  // same job is exactly what the table replaced.
  assert.doesNotMatch(rendererSrc, /open\[0\] === '[a-z-]+-overlay'/,
    'a per-dialog Escape block is still wired alongside ESCAPE_CLOSES');
  assert.strictEqual((rendererSrc.match(/if \(e\.key !== 'Escape'\) return;/g) || []).length, 1,
    'more than one Escape gate — the mechanism was duplicated, not shared');
});
