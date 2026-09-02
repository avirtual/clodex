'use strict';
// chord-overlay-guard.test.js — a window chord must never act on the session
// BEHIND an open modal.
//
// The live defect: the Cmd+W handler consulted #dialog-overlay alone, so Cmd+W
// with Preferences or Edit Session open archived the active session while the
// operator was looking at a dialog they believed the chord was scoped to.
//
// Two halves, and the SECOND is what keeps this file honest: "with an overlay
// open nothing is archived" is satisfied completely by a guard that always
// returns early, which would kill Cmd+W outright. The no-overlay case is the
// anti-degenerate half and is not optional.
//
// The behavioural subjects assert the ARCHIVE CALL through a spy rather than the
// predicate's answer: a predicate that answers correctly while the caller
// ignores it is the defect itself, so an assertion on the answer alone cannot
// see it. The source-shape subjects at the bottom cover what no fixture can —
// what renderer.js actually passes and calls.
//
// The first fix here derived the modal population from index.html and shipped a
// hole: that file holds the modals the markup DECLARES, not the ones script
// builds, and both runtime-created families were live archive paths while this
// file was green. Hence two completeness subjects over two different input sets.
// A guarded reducer over the wrong input set still measures nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  MODAL_OVERLAY_IDS, MODAL_OVERLAY_CLASSES, openOverlayIds, anyOverlayOpen, performCloseChord,
} = require('../renderer/lib/chord-guard');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The two probes the guard reads the document through. `open` names the ids and
// the classes that are showing; every other listed id exists and is hidden, and
// an id outside the list resolves to null the way a real lookup of an absent
// node does.
//
// The two families differ in HOW they close, and the fake models that difference
// because the guard has to survive both: an id overlay is toggled `hidden` and
// stays in the document, while `.prompt-modal-overlay` is `.remove()`d outright
// (renderer.js's promptText) — so for a class, ABSENT is the closed state and
// there is no hidden node left behind to find.
function fakeDom(open = [], { missing = [] } = {}) {
  const byId = (id) => {
    if (!MODAL_OVERLAY_IDS.includes(id) || missing.includes(id)) return null;
    const hidden = !open.includes(id);
    return { classList: { contains: (c) => c === 'hidden' && hidden } };
  };
  const byClass = (cls) => {
    if (!open.includes(cls)) return [];
    return [{ classList: { contains: () => false } }];
  };
  return { byId, byClass };
}

// A `.plugin-overlay` that is present but carries `hidden` — the plugin host
// toggles the class rather than removing the node, so a presence-only probe
// would read every mounted-but-closed plugin overlay as open and deaden the
// chords for good.
function fakeHiddenClassNode(cls) {
  return {
    byId: fakeDom([]).byId,
    byClass: (c) => (c === cls ? [{ classList: { contains: (x) => x === 'hidden' } }] : []),
  };
}

// Records what the chord actually DID. Nothing is stubbed to a no-op: a branch
// that fires the wrong action shows up as the wrong array being non-empty.
function spies() {
  const calls = { closed: [], archived: [], hidden: [] };
  return [calls, {
    closeNewSessionDialog: () => calls.closed.push(true),
    archiveSession: (name) => calls.archived.push(name),
    hidePeerRow: (peer) => calls.hidden.push(peer.name),
  }];
}

const localSession = { ...fakeDom([]), activeSession: 'clodex', peerOf: () => null };

// ── the defect: an overlay is open, the session behind it survives ──────────

test('with each overlay open in turn, Cmd+W archives NOTHING', () => {
  // Table-driven over the real population rather than a handful of spot checks:
  // the population is the thing that was wrong, so a test naming three ids by
  // hand would have passed at the base commit for the three it named.
  assert.ok(MODAL_OVERLAY_IDS.length >= 10,
    `ENTER: the overlay list must still hold every declared modal, got ${MODAL_OVERLAY_IDS.length}`);
  assert.ok(MODAL_OVERLAY_CLASSES.length >= 2,
    `ENTER: the runtime-created modal families must be in the population, got ${MODAL_OVERLAY_CLASSES.length}`);

  for (const id of [...MODAL_OVERLAY_IDS, ...MODAL_OVERLAY_CLASSES]) {
    const [calls, actions] = spies();
    performCloseChord({ ...localSession, ...fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, [],
      `Cmd+W with #${id} open archived the session behind it`);
    assert.deepStrictEqual(calls.hidden, [],
      `Cmd+W with #${id} open hid the peer row behind it`);
  }
});

test('the five overlays the pre-fix guard never consulted', () => {
  // Named as literals, not derived from the list above: the loop overhead is
  // MODAL_OVERLAY_IDS itself, so an edit that dropped an id from it would shrink
  // that loop silently while staying green. These five are the ones the defect
  // was verified on, and dropping any of them has to red HERE.
  for (const id of ['prefs-overlay', 'args-overlay', 'peers-overlay', 'plugins-overlay', 'sandbox-overlay']) {
    assert.ok(MODAL_OVERLAY_IDS.includes(id), `${id} must be consulted`);
    const [calls, actions] = spies();
    const result = performCloseChord({ ...localSession, ...fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, []);
    assert.strictEqual(result, 'overlay-open-nothing-closed');
  }
});

test('the four less obvious overlays are consulted too', () => {
  // discovery / peer-session / file-peek / report are modal by the same CSS and
  // were archive paths for the same reason, but none of them is a Settings-style
  // dialog anyone thinks of first. Same literal-not-derived reason as above.
  for (const id of ['discovery-overlay', 'peer-session-overlay', 'file-peek-overlay', 'report-overlay']) {
    assert.ok(MODAL_OVERLAY_IDS.includes(id), `${id} must be consulted`);
    const [calls, actions] = spies();
    performCloseChord({ ...localSession, ...fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, []);
  }
});

// ── modals that exist only at runtime (r1) ─────────────────────────────────
//
// The gap the first round shipped: the population was derived from index.html,
// which holds the STATICALLY DECLARED modals and not the ones built by script.
// A derivation is only as good as its input set, and that one was the wrong set.

test('a prompt-modal built at runtime blocks the archive', () => {
  // promptText() appends a fixed inset:0 backdrop with a focused input and
  // REMOVES it on dismiss, so it never appears in index.html. Reachable with no
  // declared overlay open: Export as a template, Create Team, role rename.
  const [calls, actions] = spies();
  const result = performCloseChord(
    { ...localSession, ...fakeDom(['prompt-modal-overlay']) }, actions);
  assert.deepStrictEqual(calls.archived, [],
    'Cmd+W meaning "cancel this prompt" archived the session behind it');
  assert.strictEqual(result, 'overlay-open-nothing-closed');
});

test('a prompt raised FROM the New Session dialog closes neither', () => {
  // The sub-case that makes this more than a missing list entry. With the prompt
  // counted, the open set is two, so the close branch is unreachable; with only
  // the id census it was ['dialog-overlay'] alone and Cmd+W hid the New Session
  // dialog UNDERNEATH the prompt the operator was typing into — an action
  // landing on a surface they cannot see, which is this ticket's whole subject.
  const [calls, actions] = spies();
  const result = performCloseChord(
    { ...localSession, ...fakeDom(['dialog-overlay', 'prompt-modal-overlay']) }, actions);
  assert.deepStrictEqual(calls.closed, [], 'the dialog under the prompt must stay put');
  assert.deepStrictEqual(calls.archived, []);
  assert.strictEqual(result, 'overlay-open-nothing-closed');
});

test('an open plugin overlay blocks the archive', () => {
  const [calls, actions] = spies();
  performCloseChord({ ...localSession, ...fakeDom(['plugin-overlay']) }, actions);
  assert.deepStrictEqual(calls.archived, []);
});

test('a plugin overlay that is present but HIDDEN does not block the chord', () => {
  // The two families close differently: the prompt family is removed from the
  // document, the plugin host keeps its node and toggles `hidden`. A probe that
  // treated presence alone as open would read every mounted-but-closed plugin
  // overlay as open and leave Cmd+W permanently dead — the failure that is
  // invisible from the guard's own subjects because it looks like caution.
  const probes = fakeHiddenClassNode('plugin-overlay');
  assert.strictEqual(anyOverlayOpen(probes), false);
  const [calls, actions] = spies();
  performCloseChord({ ...probes, activeSession: 'clodex', peerOf: () => null }, actions);
  assert.deepStrictEqual(calls.archived, ['clodex'], 'a closed plugin overlay must not block anything');
});

// ── the anti-degenerate half ────────────────────────────────────────────────

test('with NO overlay open, Cmd+W still archives the active session', () => {
  const [calls, actions] = spies();
  const result = performCloseChord(localSession, actions);
  assert.deepStrictEqual(calls.archived, ['clodex'], 'the chord must still do its job');
  assert.strictEqual(result, 'archived-active-session');
  assert.deepStrictEqual(calls.closed, [], 'nothing to close');
});

test('with NO overlay open, Cmd+W on a PEER row hides it instead of archiving', () => {
  const [calls, actions] = spies();
  const result = performCloseChord({
    ...fakeDom([]), activeSession: 'friend', peerOf: () => ({ id: 'p1', name: 'friend' }),
  }, actions);
  assert.deepStrictEqual(calls.hidden, ['friend']);
  assert.deepStrictEqual(calls.archived, [], 'a peer row has no local session to archive');
  assert.strictEqual(result, 'hid-peer-row');
});

test('with NO overlay and no active session, Cmd+W does nothing at all', () => {
  const [calls, actions] = spies();
  const result = performCloseChord({ ...fakeDom([]), activeSession: null, peerOf: () => null }, actions);
  assert.deepStrictEqual(calls, { closed: [], archived: [], hidden: [] });
  assert.strictEqual(result, 'no-active-session');
});

// ── the New Session dialog keeps its close-on-Cmd+W, and only alone ─────────

test('the New Session dialog ALONE is closed by Cmd+W, as it always was', () => {
  const [calls, actions] = spies();
  const result = performCloseChord({ ...localSession, ...fakeDom(['dialog-overlay']) }, actions);
  assert.deepStrictEqual(calls.closed, [true]);
  assert.deepStrictEqual(calls.archived, [], 'closing the dialog must not also archive');
  assert.strictEqual(result, 'closed-new-session-dialog');
});

test('the New Session dialog UNDER another overlay is NOT closed', () => {
  // These overlays are siblings with no stacking manager, so with two open the
  // DOM cannot say which is on top. Closing the one we can name would be the
  // same class of surprise as archiving the wrong session, so ambiguity does
  // nothing — and this is the case a plain `dialogOverlay` check gets wrong in
  // the OTHER direction.
  const [calls, actions] = spies();
  const result = performCloseChord(
    { ...localSession, ...fakeDom(['dialog-overlay', 'prefs-overlay']) }, actions);
  assert.deepStrictEqual(calls.closed, [], 'which one is topmost is not knowable');
  assert.deepStrictEqual(calls.archived, []);
  assert.strictEqual(result, 'overlay-open-nothing-closed');
});

// ── the predicate itself ────────────────────────────────────────────────────

test('anyOverlayOpen is false only when every overlay is hidden', () => {
  assert.strictEqual(anyOverlayOpen(fakeDom([])), false);
  for (const id of MODAL_OVERLAY_IDS) {
    assert.strictEqual(anyOverlayOpen(fakeDom([id])), true, `#${id} open must count as open`);
  }
});

test('an ABSENT node is not an open overlay', () => {
  // The web frontend ships a subset of these ids. Treating a missing node as
  // open would deaden every chord in the browser — silently, since the chords
  // would simply stop responding rather than erroring.
  const probes = fakeDom([], { missing: MODAL_OVERLAY_IDS });
  assert.strictEqual(anyOverlayOpen(probes), false);
  const [calls, actions] = spies();
  performCloseChord({ ...probes, activeSession: 'clodex', peerOf: () => null }, actions);
  assert.deepStrictEqual(calls.archived, ['clodex']);
});

test('openOverlayIds reports every open overlay, so a stack is visible as a stack', () => {
  assert.deepStrictEqual(openOverlayIds(fakeDom(['prefs-overlay', 'dialog-overlay'])),
    ['dialog-overlay', 'prefs-overlay'], 'list order, not open order');
});

// ── the list is complete against index.html ─────────────────────────────────

test('every STATICALLY DECLARED overlay in index.html is in MODAL_OVERLAY_IDS', () => {
  // The bug was a POPULATION bug, so the population is checked against the
  // markup rather than against a hand-kept second copy of the same list. This
  // half sees only what index.html declares; the script-built families are the
  // companion subject's job, and neither scan covers the other's input. Nesting
  // is read from indentation: a top-level modal sits at two spaces under <body>,
  // and #new-session-tool-overlay is deeper because it lives INSIDE the New
  // Session dialog — it cannot be visible while the dialog is not.
  const html = read('renderer/index.html').split('\n');
  const found = [];
  for (const line of html) {
    const m = /^(\s*)<div id="([a-z0-9-]*overlay)"/.exec(line);
    if (m && m[1].length <= 2) found.push(m[2]);
  }
  assert.ok(found.length >= 10,
    `ENTER: the markup scan must still find the overlays, got ${found.length}: ${found.join(',')}`);
  assert.ok(found.includes('prefs-overlay') && found.includes('report-overlay'),
    'ENTER: the scan reaches both ends of the file');

  const missing = found.filter((id) => !MODAL_OVERLAY_IDS.includes(id));
  assert.deepStrictEqual(missing, [],
    'a modal in the markup that no chord consults is a session archived behind it');
});

// A class token is EXCLUDED only with a reason, and a reason that would stop
// being true is the kind this map exists to make visible. A token here that is
// also guarded, or that no longer appears in the source, reds below.
const EXCLUDED_CLASSES = {
  'tool-overlay-tool': 'a row inside the new-session tool notice, not a backdrop',
  'tool-overlay-cmd': 'ditto — the install command line inside that notice',
  'team-create-overlay': 'a modifier ON a prompt-modal-overlay node, which is itself guarded',
};

function overlayClassTokens() {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'renderer'))
      .filter((f) => f.endsWith('.js')).map((f) => path.join('renderer', f)),
    ...fs.readdirSync(path.join(ROOT, 'renderer', 'popovers'))
      .filter((f) => f.endsWith('.js')).map((f) => path.join('renderer', 'popovers', f)),
  ];
  const found = new Map();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/className\s*=\s*['"`]([^'"`]*)['"`]/g)) {
      for (const tok of m[1].split(/\s+/)) {
        if (tok.includes('overlay') && !found.has(tok)) found.set(tok, f);
      }
    }
  }
  return { files, found };
}

test('every overlay class CREATED IN SCRIPT is guarded or excluded with a reason', () => {
  // The companion to the index.html scan, and the one the first round lacked.
  // index.html is not the population of modals — it is the population of
  // STATICALLY DECLARED ones, so a scan over it alone is structurally unable to
  // see a backdrop that document.createElement builds. Both dynamic families
  // were live archive paths while that scan sat green.
  const { files, found } = overlayClassTokens();
  assert.ok(files.length >= 20,
    `ENTER: the renderer file sweep must not collapse, got ${files.length}`);
  assert.ok(found.has('prompt-modal-overlay') && found.has('plugin-overlay'),
    `ENTER: both runtime-created modal families must be FOUND by this scan, got ${[...found.keys()].join(',')}`);

  const unaccounted = [...found.keys()]
    .filter((c) => !MODAL_OVERLAY_CLASSES.includes(c) && !(c in EXCLUDED_CLASSES));
  assert.deepStrictEqual(unaccounted, [],
    'an overlay class built in script that no chord consults is a session archived behind it');
});

test('no exclusion is stale, and none shadows a guarded class', () => {
  // A stale escape hatch is rot wearing the shape of a rule: an excluded token
  // that no longer exists stops documenting anything, and one that is ALSO
  // guarded reads as a decision not to guard it.
  const { found } = overlayClassTokens();
  for (const [cls, why] of Object.entries(EXCLUDED_CLASSES)) {
    assert.ok(found.has(cls), `${cls} is excluded but no longer appears in the source — drop the exclusion`);
    assert.ok(!MODAL_OVERLAY_CLASSES.includes(cls), `${cls} is both guarded and excluded`);
    assert.ok(why.length > 20, `${cls} needs a reason, not a placeholder`);
  }
});

test('the nested tool overlay is deliberately NOT in the list', () => {
  // If it were, "the New Session dialog is the sole open overlay" could never be
  // true while the tool notice is up, and Cmd+W would stop closing the dialog.
  assert.ok(!MODAL_OVERLAY_IDS.includes('new-session-tool-overlay'));
  assert.match(read('renderer/index.html'), /id="new-session-tool-overlay"/,
    'ENTER: the nested overlay still exists — if it were removed this exclusion is stale');
});

// ── the wiring: the predicate has to reach the handlers ─────────────────────

test('both chord handlers route Cmd+W/Alt+W through the shared guard', () => {
  // A leaf can only decide; these are the two call sites that act. The defect
  // lived in the handler, not in any predicate, so the handlers are pinned to
  // having no private overlay check of their own.
  const src = read('renderer/renderer.js');
  assert.match(src, /require\('\.\/lib\/chord-guard'\)/);

  const cmd = src.match(/if \(!e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\) return;[\s\S]*?\n\}, true\);/);
  assert.ok(cmd, 'ENTER: the Cmd chord handler is still a document-level capture listener');
  const web = src.match(/const action = altChordAction\(e\);[\s\S]*?\n\}, true\);/);
  assert.ok(web, 'ENTER: the web Alt chord handler is still there');

  for (const [name, body] of [['Cmd', cmd[0]], ['Alt', web[0]]]) {
    assert.match(body, /runCloseChord\(\)/, `${name}+W must go through the guard`);
    assert.match(body, /anyOverlayOpen\(/, `${name} handler must consult the predicate`);
    assert.doesNotMatch(body, /dialogOverlay\.classList/,
      `${name} handler still checks #dialog-overlay directly — that IS the defect`);
    assert.doesNotMatch(body, /archiveSessionRow\(/,
      `${name} handler archives outside the guard, so the guard can be bypassed`);
  }
});

test('renderer.js hands the guard BOTH probes, not just the id lookup', () => {
  // Found by mutation: dropping `byClass` from the probes object left all 21
  // subjects green, because every one of them builds its own probes and so
  // cannot see what the renderer actually passes. A guard that supports class
  // overlays while the caller supplies no way to find them is the round-1 defect
  // restored, and it would read as fixed from the leaf's tests alone.
  const src = read('renderer/renderer.js');
  assert.match(src, /getElementsByClassName/,
    'the renderer must be able to find a modal that has no id');
  const probes = src.match(/const overlayProbes = \{[^}]*\}/);
  assert.ok(probes, 'ENTER: the probes object is still assembled in one place');
  assert.match(probes[0], /byId:/);
  assert.match(probes[0], /byClass:/, 'without byClass the runtime-created modals are invisible again');
});

test('Cmd+T and the switch/search chords are guarded too, not just Cmd+W', () => {
  // Cmd+T behind a modal opened a SECOND dialog over the first; Cmd+1..9 and
  // Cmd+F moved the terminal out from under the dialog the operator was reading.
  // Same handler, same hole, and a fix for W alone leaves them.
  const src = read('renderer/renderer.js');
  const cmd = src.match(/if \(!e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\) return;[\s\S]*?\n\}, true\);/)[0];
  assert.match(cmd, /const overlaysOpen = anyOverlayOpen\(/);

  const tIdx = cmd.indexOf("e.key === 't'");
  const gateIdx = cmd.indexOf('if (overlaysOpen) return;');
  const digitIdx = cmd.indexOf("/^[1-9]$/");
  const searchIdx = cmd.indexOf("e.key === 'f'");
  assert.ok(tIdx > 0 && gateIdx > 0 && digitIdx > 0 && searchIdx > 0,
    'ENTER: all four chords are still in this handler');
  assert.ok(gateIdx < digitIdx && gateIdx < searchIdx,
    'the blanket gate must sit ABOVE the switch and search chords');
  assert.match(cmd.slice(tIdx, digitIdx), /if \(!overlaysOpen\) openDialog\(\)/,
    'Cmd+T must not open a second dialog over an open modal');
});
