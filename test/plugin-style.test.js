'use strict';

// Extends the project's `.hidden` gotcha guard ACROSS the plugin boundary.
//
// `test/css-hidden-invariant.test.js` reads renderer/index.html against
// renderer/styles.css. That pairing was total while every hidden id shipped in
// core markup. It is not any more: a plugin's markup is built by its renderer
// half at mount time, and its rules live in its own `style.css` (injected as
// one <style data-plugin-style=id> node, removed wholesale at disable —
// docs/plugin-plan.md §2.6). So a plugin id that ships class="hidden" with no
// `#id.hidden { display:none }` rule is the SAME always-visible bug, in a file
// the core test cannot see. Without this test, moving the workbench out of
// index.html (§4 W3) would have quietly dropped its ids out of the invariant.
//
// It also gates the W3 move itself: core's stylesheet must keep the HOST's
// container rule and must not keep any plugin interior selectors.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

// Every opening tag in a plugin's renderer source that carries BOTH an id and a
// class list containing `hidden`. The markup is inside template literals, so a
// tag scan over the raw source is the honest read: it sees exactly the strings
// that reach innerHTML, without executing anything.
function hiddenIdsInSource(src) {
  const ids = [];
  for (const tag of src.match(/<[a-zA-Z][^>]*>/g) || []) {
    const idM = tag.match(/\bid="([^"]+)"/);
    const clsM = tag.match(/\bclass="([^"]*)"/);
    if (!idM || !clsM) continue;
    if (clsM[1].split(/\s+/).includes('hidden')) ids.push(idM[1]);
  }
  return ids;
}

// Flat-CSS parse, same shape as the core test's: every `selectorList { body }`
// whose body sets display:none contributes its `#id.hidden` selectors. Comments
// are stripped first — a `#id.hidden` mentioned in prose must not count as
// coverage.
function idsWithHiddenRule(src) {
  const covered = new Set();
  for (const m of stripComments(src).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = m;
    if (!/display\s*:\s*none/.test(body)) continue;
    for (const sm of selectors.matchAll(/#([A-Za-z0-9_-]+)\.hidden\b/g)) covered.add(sm[1]);
  }
  return covered;
}

function plugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => fs.existsSync(path.join(PLUGINS_DIR, id, 'manifest.json')));
}

test('every class="hidden" id a plugin renders has a #id.hidden rule in ITS stylesheet', () => {
  const ids = plugins();
  assert.ok(ids.length >= 1, 'expected at least the workbench pilot under plugins/');

  for (const id of ids) {
    const dir = path.join(PLUGINS_DIR, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    const rendererPath = path.join(dir, (manifest.entry && manifest.entry.renderer) || 'renderer.js');
    if (!fs.existsSync(rendererPath)) continue;

    const hiddenIds = hiddenIdsInSource(fs.readFileSync(rendererPath, 'utf-8'));
    if (!hiddenIds.length) continue;

    const stylePath = path.join(dir, manifest.style || 'style.css');
    assert.ok(fs.existsSync(stylePath),
      `${id} renders hidden ids but declares no stylesheet — they would be always-visible`);

    const covered = idsWithHiddenRule(fs.readFileSync(stylePath, 'utf-8'));
    const missing = hiddenIds.filter((hid) => !covered.has(hid));
    assert.deepStrictEqual(missing, [],
      `${id}: hidden ids with no #id.hidden{display:none} rule in ${manifest.style} `
      + `(always-visible bug): ${missing.join(', ')}`);
  }
});

test('the workbench pilot is really the subject — its known hidden ids are covered', () => {
  // Sanity, so a regex that silently matches nothing cannot make the loop above
  // vacuously pass. These are the panel/editor ids the workbench toggles.
  const src = fs.readFileSync(path.join(PLUGINS_DIR, 'workbench/renderer.js'), 'utf-8');
  const hiddenIds = hiddenIdsInSource(src);
  for (const id of ['wb-scm-panel', 'wb-worktrees-panel', 'wb-textarea', 'wb-diff']) {
    assert.ok(hiddenIds.includes(id), `${id} should ship class="hidden" in the plugin's markup`);
  }
  const covered = idsWithHiddenRule(fs.readFileSync(path.join(PLUGINS_DIR, 'workbench/style.css'), 'utf-8'));
  assert.ok(covered.has('wb-scm-panel') && covered.has('wb-diff'),
    'the plugin stylesheet should carry the per-id hidden rules');
});

test('W3: core styles.css keeps the host container rule and no plugin interior', () => {
  const css = stripComments(fs.readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf-8'));

  // The host creates, toggles and removes `.plugin-overlay`; MUST-FIX 6 means a
  // plugin never owns its own container, so this rule belongs to core forever.
  assert.match(css, /\.plugin-overlay\s*\{/, '.plugin-overlay is host contract CSS');
  assert.match(css, /\.plugin-overlay\.hidden\s*\{\s*display:\s*none/,
    'the container hides per-class, never via a generic .hidden');

  // Everything the workbench draws inside it moved to plugins/workbench/style.css.
  const strays = [];
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const sel of m[1].split(',')) {
      const s = sel.trim();
      // `#btn-workbench` is core's sidebar button until W4 deletes it.
      if (/^#btn-workbench\b/.test(s)) continue;
      if (/(^|[.#\s])(wb-|workbench-|workbench\b)/.test(s)) strays.push(s);
    }
  }
  assert.deepStrictEqual(strays, [],
    `workbench selectors left in core styles.css after the W3 move: ${strays.join(' | ')}`);
});
