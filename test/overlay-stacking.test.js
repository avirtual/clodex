'use strict';
// overlay-stacking.test.js — full-screen overlays must not be nested inside #main.
//
// #main is `position: fixed`, which makes it its own STACKING CONTEXT. An
// overlay nested inside it is flattened to #main's z-index (11) no matter how
// high its own value, so the root-level drawers (z-index 15) paint over it.
//
// This shipped: the inbox drawer's clickable file paths (t275) opened the file
// peek UNDERNEATH the drawer that launched it. The peek's own z-index is 70 —
// reading the CSS suggests it wins, and it loses anyway, which is exactly why
// this is pinned structurally rather than by comparing the two numbers.
//
// The trap is invisible to the obvious test. Asserting `z-index: 70 > 15`
// passes against the broken DOM, because the defect is not in either value.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// Overlays that cover the viewport and must sit above every drawer.
const ROOT_OVERLAYS = ['file-peek-overlay', 'report-overlay'];

// Walk the tag stack with a regex scanner: no DOM dependency, and it only has
// to answer "which element ids enclose this id", not build a real tree.
function ancestorsOf(html, id) {
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'area']);
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  const stack = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, close, tag, attrs] = m;
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const idm = /\bid="([^"]+)"/.exec(attrs);
    if (idm && idm[1] === id) return stack.map((s) => s.id).filter(Boolean);
    if (!VOID.has(tag.toLowerCase()) && !attrs.trim().endsWith('/')) stack.push({ tag, id: idm && idm[1] });
  }
  return null;
}

test('full-screen overlays are not nested inside #main', () => {
  // ENTER: the scanner must actually find the elements, or every assertion
  // below is vacuously true of an overlay that was renamed or deleted.
  for (const id of ROOT_OVERLAYS) {
    assert.notStrictEqual(ancestorsOf(HTML, id), null, `${id} not found in index.html`);
  }
  // And it must be able to see nesting at all — #main's own children prove the
  // walker reports enclosing ids rather than always returning an empty list.
  const known = ancestorsOf(HTML, 'terminal-container');
  assert.ok(known && known.includes('main'),
    `scanner cannot see nesting: #terminal-container reported ancestors ${JSON.stringify(known)}`);

  for (const id of ROOT_OVERLAYS) {
    const anc = ancestorsOf(HTML, id);
    assert.ok(!anc.includes('main'),
      `#${id} is inside #main, whose position:fixed stacking context flattens it to z-index 11 — `
      + `the drawers (z-index 15) will paint over it. Move it to a direct child of <body>.`);
  }
});

test('root overlays are parsed BEFORE the script that wires them', () => {
  // renderer.js is a classic synchronous <script>, so it runs DURING parse.
  // Anything below that tag does not exist yet when init code calls
  // getElementById — it gets null, and `null.addEventListener` throws an
  // uncaught TypeError that aborts the rest of renderer startup. That is not a
  // cosmetic failure: it shipped in v5.5.0 as "no agents load", because the
  // throw killed the sidebar before it ever rendered.
  //
  // Moving these overlays to document root (the test above) is what put them at
  // risk — at the bottom of <body> is the natural place to paste a root-level
  // element, and it is exactly the wrong side of the script tag.
  const script = HTML.indexOf('<script src="renderer.js">');
  assert.ok(script > 0, 'renderer.js script tag not found');

  for (const id of ROOT_OVERLAYS) {
    const at = HTML.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} not found in index.html`);
    assert.ok(at < script,
      `#${id} is declared AFTER <script src="renderer.js">, which runs during parse — `
      + `getElementById('${id}') returns null at init and the wiring throws. Move it above the script tag.`);
  }
});

test('the init sites this ordering protects still query at module scope', () => {
  // ENTER: the ordering test above is only load-bearing while something
  // actually resolves these ids during parse. If both lookups moved behind a
  // DOMContentLoaded or a lazy init, the ordering would stop mattering and the
  // test above would be guarding nothing while still passing.
  const sites = [
    ['popovers/report-panel.js', 'report-overlay'],
    ['popovers/files-popover.js', 'file-peek-overlay'],
  ];
  for (const [rel, id] of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', rel), 'utf8');
    assert.match(src, new RegExp(`getElementById\\(['"]${id}['"]\\)`),
      `${rel} no longer resolves #${id} — re-check whether the ordering test still guards a real failure`);
  }
});

test('#main still creates the stacking context this test guards against', () => {
  // If #main ever stops being position:fixed the trap disappears and this whole
  // file is obsolete. Pinning it means the test fails loudly when the premise
  // changes, instead of silently guarding nothing.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const rule = /#main\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '#main rule not found in styles.css');
  assert.match(rule[1], /position:\s*fixed/,
    '#main is no longer position:fixed — re-check whether overlay-stacking still needs pinning');
});
