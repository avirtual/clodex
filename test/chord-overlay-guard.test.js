'use strict';
// chord-overlay-guard.test.js — a window chord must never act on the session
// BEHIND an open modal.
//
// The live defect (t634): the Cmd+W handler consulted #dialog-overlay alone, so
// Cmd+W with Preferences or Edit Session open archived the active session while
// the operator was looking at a dialog they believed the chord was scoped to.
// Five of the app's ten top-level overlays were unconsulted.
//
// Two halves, and the SECOND is what keeps this file honest: "with an overlay
// open nothing is archived" is satisfied completely by a guard that always
// returns early, which would kill Cmd+W outright. The no-overlay case is the
// anti-degenerate half and is not optional.
//
// Every assertion here is about the ARCHIVE CALL, recorded by a spy, not about
// what the predicate returned — a predicate that answers correctly while the
// handler ignores it is exactly the shipped bug.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  MODAL_OVERLAY_IDS, openOverlayIds, anyOverlayOpen, performCloseChord,
} = require('../renderer/lib/chord-guard');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A byId standing in for document.getElementById over the overlay ids only.
// `openIds` are the ones without the `hidden` class; every other listed id
// exists and is hidden, and an id outside the list resolves to null the way a
// real lookup of an absent node does.
function fakeDom(openIds = [], { missing = [] } = {}) {
  return (id) => {
    if (!MODAL_OVERLAY_IDS.includes(id) || missing.includes(id)) return null;
    const hidden = !openIds.includes(id);
    return { classList: { contains: (c) => c === 'hidden' && hidden } };
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

const localSession = { byId: fakeDom([]), activeSession: 'clodex', peerOf: () => null };

// ── the defect: an overlay is open, the session behind it survives ──────────

test('with each overlay open in turn, Cmd+W archives NOTHING', () => {
  // Table-driven over the real id list rather than a handful of spot checks:
  // the population is the thing that was wrong, so a test naming three ids by
  // hand would have passed at the base commit for the three it named.
  assert.ok(MODAL_OVERLAY_IDS.length >= 10,
    `ENTER: the overlay list must still hold every top-level modal, got ${MODAL_OVERLAY_IDS.length}`);

  for (const id of MODAL_OVERLAY_IDS) {
    const [calls, actions] = spies();
    performCloseChord({ ...localSession, byId: fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, [],
      `Cmd+W with #${id} open archived the session behind it`);
    assert.deepStrictEqual(calls.hidden, [],
      `Cmd+W with #${id} open hid the peer row behind it`);
  }
});

test('the five overlays the shipped guard never consulted', () => {
  // Named as literals, not derived from the list above: these are the ids the
  // t634 report verified as live archive paths, and a future edit that drops
  // one from MODAL_OVERLAY_IDS must red HERE, not silently shrink the loop.
  for (const id of ['prefs-overlay', 'args-overlay', 'peers-overlay', 'plugins-overlay', 'sandbox-overlay']) {
    assert.ok(MODAL_OVERLAY_IDS.includes(id), `${id} must be consulted`);
    const [calls, actions] = spies();
    const result = performCloseChord({ ...localSession, byId: fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, []);
    assert.strictEqual(result, 'overlay-open-nothing-closed');
  }
});

test('the four overlays the ticket itself did not list are consulted too', () => {
  // discovery / peer-session / file-peek / report are modal by the same CSS and
  // were archive paths for the same reason. Found by reading index.html, not
  // from the ticket's list.
  for (const id of ['discovery-overlay', 'peer-session-overlay', 'file-peek-overlay', 'report-overlay']) {
    assert.ok(MODAL_OVERLAY_IDS.includes(id), `${id} must be consulted`);
    const [calls, actions] = spies();
    performCloseChord({ ...localSession, byId: fakeDom([id]) }, actions);
    assert.deepStrictEqual(calls.archived, []);
  }
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
    byId: fakeDom([]), activeSession: 'friend', peerOf: () => ({ id: 'p1', name: 'friend' }),
  }, actions);
  assert.deepStrictEqual(calls.hidden, ['friend']);
  assert.deepStrictEqual(calls.archived, [], 'a peer row has no local session to archive');
  assert.strictEqual(result, 'hid-peer-row');
});

test('with NO overlay and no active session, Cmd+W does nothing at all', () => {
  const [calls, actions] = spies();
  const result = performCloseChord({ byId: fakeDom([]), activeSession: null, peerOf: () => null }, actions);
  assert.deepStrictEqual(calls, { closed: [], archived: [], hidden: [] });
  assert.strictEqual(result, 'no-active-session');
});

// ── the New Session dialog keeps its close-on-Cmd+W, and only alone ─────────

test('the New Session dialog ALONE is closed by Cmd+W, as it always was', () => {
  const [calls, actions] = spies();
  const result = performCloseChord({ ...localSession, byId: fakeDom(['dialog-overlay']) }, actions);
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
    { ...localSession, byId: fakeDom(['dialog-overlay', 'prefs-overlay']) }, actions);
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
  const byId = fakeDom([], { missing: MODAL_OVERLAY_IDS });
  assert.strictEqual(anyOverlayOpen(byId), false);
  const [calls, actions] = spies();
  performCloseChord({ byId, activeSession: 'clodex', peerOf: () => null }, actions);
  assert.deepStrictEqual(calls.archived, ['clodex']);
});

test('openOverlayIds reports every open overlay, so a stack is visible as a stack', () => {
  assert.deepStrictEqual(openOverlayIds(fakeDom(['prefs-overlay', 'dialog-overlay'])),
    ['dialog-overlay', 'prefs-overlay'], 'list order, not open order');
});

// ── the list is complete against index.html ─────────────────────────────────

test('every top-level overlay in index.html is in MODAL_OVERLAY_IDS', () => {
  // The bug was a POPULATION bug, so the population is checked against the
  // markup rather than against a hand-kept second copy of the same list. Nesting
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
