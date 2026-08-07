'use strict';

// The sidebar notice that says a peer has a shell open on this machine.
//
// This is not a second opinion about the per-seat row mark — for some served
// seats it is the only surface there is. `rowPasses` display:none's a row that
// fails the sidebar search text or sits in a collapsed group, and the session is
// alive, so nothing prunes the stream: the mark is set, on a node nobody can
// see. An inverted `hidden` or a wrong string here is a peer in a shell with
// nothing on screen to say so, which is the failure the whole feature exists to
// prevent.

const test = require('node:test');
const assert = require('node:assert');

const { servedBannerView } = require('../renderer/lib/served-banner');

test('nobody watching hides the notice', () => {
  assert.deepStrictEqual(servedBannerView([]), { hidden: true, text: '', tip: '' });
});

// The wire is the caller's input and it has not been validated. A non-array must
// read as "nobody", not throw — a renderer fault here would take out the peer
// listener that carries every other peer signal.
test('a malformed payload reads as nobody watching', () => {
  for (const bad of [undefined, null, 'alice', 42, {}]) {
    assert.deepStrictEqual(servedBannerView(bad), { hidden: true, text: '', tip: '' },
      `${JSON.stringify(bad) || String(bad)} is not a seat list`);
  }
});

// NAMED, not counted. The operator's next move on seeing this is to go look at
// the session, and the row they would look for may be filtered out of the list —
// so the name has to be in the notice itself.
test('one watched seat names it', () => {
  const v = servedBannerView(['alice']);
  assert.strictEqual(v.hidden, false, 'ENTER: the notice is shown');
  assert.strictEqual(v.text, 'A peer has a shell open on alice');
  assert.match(v.tip, /alice/, 'and the tip names it too');
});

test('several watched seats are counted, and the tip lists them', () => {
  const v = servedBannerView(['alice', 'bob', 'carol']);
  assert.strictEqual(v.hidden, false, 'ENTER: the notice is shown');
  assert.strictEqual(v.text, 'Peers have shells open on 3 sessions');
  assert.strictEqual(v.tip, 'Peers are watching these terminals on this machine: alice, bob, carol');
});

// The wire reports the whole set every heartbeat and a Map iteration can repeat
// nothing — but the caller passes a spread Set today and a future one might not.
// A count that double-counts is a number the operator cannot reconcile with what
// they can see.
test('a repeated seat is counted once', () => {
  assert.deepStrictEqual(servedBannerView(['alice', 'alice']), servedBannerView(['alice']),
    'a duplicate reads exactly as the single seat does');
});

// Non-string seats arrive from JSON that this side does not control. They must
// be rendered, not dropped — a seat missing from the notice is the silent state.
test('seats are stringified rather than dropped', () => {
  const v = servedBannerView([7]);
  assert.strictEqual(v.hidden, false, 'ENTER: still shown');
  assert.match(v.text, /7/, 'the seat appears in the text');
});

// The caller assigns these with textContent and a session name is
// operator-supplied. If this leaf ever composed markup, that assignment would
// become unsafe at a distance — the contract is strings only.
test('the view is plain strings, never markup', () => {
  const v = servedBannerView(['<img src=x onerror=alert(1)>']);
  assert.strictEqual(v.text, 'A peer has a shell open on <img src=x onerror=alert(1)>',
    'passed through verbatim — escaping would be this leaf guessing at the caller\'s sink');
  assert.strictEqual(typeof v.tip, 'string');
  assert.deepStrictEqual(Object.keys(v).sort(), ['hidden', 'text', 'tip'],
    'and the shape is exactly these three — a fourth key would be a sink the caller does not know how to assign');
});

// The browser frontend runs out of the committed bundle, and `npm run build:web`
// is a manual step — so a renderer-only edit leaves web users with NEITHER
// surface: no banner node, no row attribute, and `wterm:*` IPC is unregistered
// on web so there is no local tab either. The peer's shell is then completely
// unannounced on the host shape where an unattended shell is likeliest. Silent,
// because the desktop app looks right; this is how it got here once already.
//
// Each half asserts the renderer source FIRST, and that guard is not decoration:
// with it removed, deleting the banner from the renderer and leaving the bundle
// STALE passes — the bundle still carries the string the renderer no longer
// produces, so a bundle-only pin reports a feature that exists nowhere in the
// source. (Measured, not reasoned: the mutant is green at 10/10.) A rebuild
// after such a deletion fails loudly instead, so it is precisely the
// deleted-and-not-rebuilt combination the guard covers.
const readBoth = (rel) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  return [
    fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8'),
  ];
};
const STALE = 'web-dist/index.html is stale — run `npm run build:web` and commit it';

test('the banner markup is in the committed web bundle, not just the renderer', () => {
  const [rsrc, wsrc] = readBoth('renderer/index.html');
  const NODE = 'id="served-terminal-banner"';
  assert.ok(rsrc.includes(NODE), 'ENTER: the renderer page still has a banner node at all');
  assert.ok(wsrc.includes(NODE),
    `${STALE}, or a peer's shell on this box is unannounced in the browser frontend`);
});

test('the served-terminal CSS is in the committed web bundle, not just the renderer', () => {
  const [rsrc, wsrc] = readBoth('renderer/styles.css');
  // Both rules matter and they fail differently. Without the `.hidden` rule the
  // banner is stuck visible and claims a shell that is not open; without the row
  // attribute's rule the per-seat glyph never renders at all.
  for (const rule of ['#served-terminal-banner.hidden', '.session-item[data-served-terminal]']) {
    assert.ok(rsrc.includes(rule), `ENTER: styles.css still carries \`${rule}\``);
    assert.ok(wsrc.includes(rule), `${STALE} — the bundle is missing \`${rule}\``);
  }
});

test('the banner text is in the committed web bundle, not just the renderer', () => {
  const [rsrc, wsrc] = readBoth('renderer/lib/served-banner.js');
  // The template literal's static prefix. esbuild does not minify here, so it
  // survives verbatim; if a later build ever mangles it, pin the bundle's own
  // shape rather than deleting this — the markup being present says nothing
  // about whether the code that fills it came along.
  const TEXT = 'A peer has a shell open on ';
  assert.ok(rsrc.includes(TEXT), 'ENTER: the leaf still produces this text at all');
  assert.ok(wsrc.includes(TEXT),
    `${STALE} — the bundle has the banner node but not the code that fills it, so it stays empty`);
});
