'use strict';

// The README popover's own three properties, over the shipped source: the body
// is BUILT (renderMarkdown's nodes), the popover carries the plugin's name, and
// closing the Manage Plugins dialog closes it too.
//
// The functions are EXTRACTED from renderer.js and RUN, the idiom
// test/plugin-update-badge.test.js established: renderer.js cannot be required
// (DOM-bound, window.api at load), and a source-shape scan for `renderMarkdown`
// passes over a call whose result is never appended.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf-8');

// The REAL leaf, over the minimal document it builds against — a stubbed
// renderer would pin the stub, and the point here is that the popover feeds the
// shipped builder and appends what it returns.
function node(tag) {
  const n = { tagName: String(tag).toUpperCase(), children: [], attrs: {} };
  let text = '';
  n.appendChild = (c) => { n.children.push(c); return c; };
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
  Object.defineProperty(n, 'textContent', {
    get: () => (text || n.children.map((c) => c.textContent).join('')),
    set(v) { text = v == null ? '' : String(v); n.children = []; },
  });
  return n;
}

const prevDocument = global.document;
global.document = {
  createElement: node,
  createTextNode: (t) => { const n = node('#text'); n.textContent = t; return n; },
  createDocumentFragment: () => node('#fragment'),
};
process.on('exit', () => { global.document = prevDocument; });

const { renderMarkdown } = require('../renderer/lib/render-markdown');

function el(tag) {
  const e = {
    tagName: tag, className: '', hidden: false,
    children: [], handlers: {},
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(type, fn) { (e.handlers[type] = e.handlers[type] || []).push(fn); },
    classList: {
      add(c) { if (c === 'hidden') e.hidden = true; },
      remove(c) { if (c === 'hidden') e.hidden = false; },
      contains: (c) => (c === 'hidden' ? e.hidden : false),
    },
  };
  let html_ = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html_,
    set(v) { html_ = v == null ? '' : String(v); if (html_ === '') e.children = []; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', { get: () => text, set(v) { text = v == null ? '' : String(v); } });
  return e;
}

const FREE = ['pluginsOverlay', 'document', 'renderMarkdown', 'placeAboveAnchor'];

// From `function closePluginsDialog` to the line that opens the dialog — the
// whole popover block plus the dialog's close, so the wiring BETWEEN them is
// inside the slice rather than assumed.
function extractPopover() {
  const start = rendererSrc.indexOf('function closePluginsDialog() {');
  assert.ok(start >= 0, 'closePluginsDialog was not found in the shipped renderer');
  const end = rendererSrc.indexOf('async function openPluginsDialog() {', start);
  assert.ok(end > start, 'the end of the README popover block was not found');
  const body = rendererSrc.slice(start, end);
  assert.match(body, /plugin-readme-popover/, 'ENTER: the slice captured the popover block');
  // eslint-disable-next-line no-new-func
  return new Function(...FREE,
    `${body}; return { closePluginsDialog, openPluginReadmePopover, closePluginReadmePopover };`);
}

function mount() {
  const nodes = {
    'plugin-readme-popover': el('div'),
    'plugin-readme-popover-name': el('span'),
    'plugin-readme-popover-body': el('div'),
    'plugin-readme-popover-close': el('button'),
  };
  nodes['plugin-readme-popover'].hidden = true;
  const pluginsOverlay = el('div');
  const placed = [];
  const fns = extractPopover()(
    pluginsOverlay,
    { getElementById: (id) => nodes[id] || el('div') },
    renderMarkdown,
    (popover, anchor) => placed.push([popover, anchor]),
  );
  return { ...fns, nodes, pluginsOverlay, placed };
}

test('the README body is BUILT from the markdown, never assigned as HTML', () => {
  // A README is third-party text off disk. `innerHTML = markdown` would execute
  // whatever a plugin author put in it, inside the renderer's own origin — so
  // the assertion is on the NODES, which no innerHTML assignment produces.
  const m = mount();
  m.openPluginReadmePopover('Demo', '# Title\n\nA <img src=x onerror=alert(1)> line.\n', el('button'));
  const body = m.nodes['plugin-readme-popover-body'];
  assert.strictEqual(body.innerHTML, '', 'nothing was ever written as raw HTML');
  assert.strictEqual(body.children.length, 1, 'the rendered fragment really landed in the popover body');
  const tree = body.children[0];
  assert.match(tree.textContent, /Title/, 'and it carries the README text');
  assert.match(tree.textContent, /<img src=x onerror=alert\(1\)>/,
    'the markup in the README stayed TEXT — an innerHTML path would have consumed it as a tag');
  assert.deepStrictEqual(tree.children.map((c) => c.tagName), ['H1', 'P'],
    'the builder produced real elements, so the text above is not one flat string');
});

test('the popover opens named for its plugin, anchored to the button that asked', () => {
  const m = mount();
  const anchor = el('button');
  m.openPluginReadmePopover('Demo', '# hi', anchor);
  assert.strictEqual(m.nodes['plugin-readme-popover-name'].textContent, 'Demo');
  assert.strictEqual(m.nodes['plugin-readme-popover'].hidden, false);
  assert.deepStrictEqual(m.placed, [[m.nodes['plugin-readme-popover'], anchor]],
    'an unplaced popover paints at the top-left corner, away from the row');
});

test('a second open replaces the first README rather than stacking under it', () => {
  const m = mount();
  m.openPluginReadmePopover('One', '# One', el('button'));
  m.openPluginReadmePopover('Two', '# Two', el('button'));
  const body = m.nodes['plugin-readme-popover-body'];
  assert.strictEqual(m.nodes['plugin-readme-popover-name'].textContent, 'Two');
  assert.doesNotMatch(JSON.stringify(body.children), /One/,
    'the previous plugin\'s README must be cleared, not appended to');
});

test('the × in the title closes the popover', () => {
  const m = mount();
  m.openPluginReadmePopover('Demo', '# hi', el('button'));
  const close = m.nodes['plugin-readme-popover-close'].handlers.click;
  assert.ok(close && close.length, 'the close button must be wired, or the popover is a trap');
  close[0]();
  assert.strictEqual(m.nodes['plugin-readme-popover'].hidden, true);
});

test('closing Manage Plugins closes the README popover with it', () => {
  // The popover is a body-level sibling of the overlay, not a child: left open,
  // it survives the dialog it was opened from and floats over the app.
  const m = mount();
  m.openPluginReadmePopover('Demo', '# hi', el('button'));
  assert.strictEqual(m.nodes['plugin-readme-popover'].hidden, false,
    'ENTER: the popover is open, so the close below is a verdict');
  m.closePluginsDialog();
  assert.strictEqual(m.nodes['plugin-readme-popover'].hidden, true);
  assert.strictEqual(m.pluginsOverlay.hidden, true, 'and the dialog still closes');
});
