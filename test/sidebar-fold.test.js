'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const { classifySender } = require('../renderer/lib/sender-class');
const { clampSidebarWidth, effectiveSidebarWidth, SIDEBAR_WIDTH_DEFAULT } = require('../sidebar-width');

function sliceFn(name) {
  const start = rendererSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `ENTER: ${name} was not found in the shipped renderer`);
  const end = rendererSrc.indexOf('\n}\n', start);
  assert.ok(end > start, `ENTER: the end of ${name} was not found`);
  return rendererSrc.slice(start, end + 2);
}

function fakeNode() {
  return {
    className: '', dataset: {}, innerHTML: '',
    addEventListener() {},
    querySelector() { return { addEventListener() {} }; },
  };
}

function loadRowBuilder(name, free, extra = {}) {
  const body = sliceFn(name);
  let made = null;
  const env = {
    document: { createElement: () => { made = fakeNode(); return made; } },
    window: { api: {} },
    esc: (s) => String(s),
    baseName: (p) => String(p || '').split('/').filter(Boolean).pop() || '',
    typeGlyph: () => 'A',
    ACCOUNT_DEFAULT: 'default',
    insertLocalSessionRow() {},
    sidebarMeta: new Map(),
    scheduleSidebarRelayout() {},
    applyFixChip() {},
    classifySender,
    ...extra,
  };
  const names = Object.keys(env).concat(free);
  const fn = new Function(...names, `${body}; return ${name};`)(...names.map((n) => env[n]));
  return (...args) => { made = null; fn(...args); return made; };
}

test('addSessionToSidebar stamps the rail monogram classifySender gives the session name', () => {
  const build = loadRowBuilder('addSessionToSidebar',
    ['switchSession', 'openSessionInfoPopover', 'archiveSessionRow', 'startRename']);
  const rows = [
    ['clodex-hand-1141', 'H'],
    ['Codex', 'C'],
    ['wirescope', '∿'],
  ];
  for (const [name, want] of rows) {
    assert.equal(build(name, 'claude', '/proj/app', null).dataset.monogram, want, name);
  }
});

test('the failed and archived row builders stamp the same monogram', () => {
  const failed = loadRowBuilder('addFailedSessionToSidebar',
    ['alert', 'createTerminal', 'addSessionToSidebar', 'switchSession', 'confirm']);
  assert.equal(failed({ name: 'clodex-hand-1141', type: 'claude', cwd: '/p' }).dataset.monogram, 'H');
  const archived = loadRowBuilder('addArchivedSessionToSidebar',
    ['createTerminal', 'addSessionToSidebar', 'switchSession', 'confirm', 'alert', 'refreshSidebarView'],
    { CSS: { escape: String }, sessionList: { querySelector: () => null } });
  assert.equal(archived({ name: 'Codex', type: 'codex', cwd: '/p' }).dataset.monogram, 'C');
});

function loadFoldIife({ stored = {}, settings = {} } = {}) {
  const start = rendererSrc.indexOf('(function initSidebarResize()');
  assert.ok(start >= 0, 'ENTER: initSidebarResize was not found');
  const end = rendererSrc.indexOf('\n})();\n', start);
  assert.ok(end > start, 'ENTER: the end of initSidebarResize was not found');
  const src = rendererSrc.slice(start, end + 6);

  const listeners = {};
  const el = (id) => ({
    id, dataset: {}, textContent: '', style: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[id] ||= {})[type] = fn; },
    setPointerCapture() {}, releasePointerCapture() {},
  });
  const els = { 'sidebar-resizer': el('sidebar-resizer'), sidebar: el('sidebar'), 'sidebar-fold': el('sidebar-fold') };
  const vars = {};
  const ls = { ...stored };
  const saved = [];
  let resolveSettings;
  const settingsP = new Promise((r) => { resolveSettings = r; });
  const env = {
    document: {
      getElementById: (id) => els[id] || null,
      documentElement: { style: { setProperty: (k, v) => { vars[k] = v; } } },
      body: { style: {} },
    },
    window: { api: { getSettings: () => settingsP, setSettings: (p) => { saved.push(p); } } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    clampSidebarWidth, effectiveSidebarWidth, SIDEBAR_WIDTH_DEFAULT,
  };
  const names = Object.keys(env);
  const toggle = new Function(...names, `return ${src}`)(...names.map((n) => env[n]));
  return { toggle, els, vars, ls, saved, listeners, settle: async () => { resolveSettings(settings); await settingsP; await null; } };
}

test('toggleSidebarFold folds to the rail, persists both mirrors, and unfolding restores the remembered width', async () => {
  const h = loadFoldIife({ stored: { 'clodex-sidebar-width': '300' }, settings: { sidebarWidth: 300, sidebarFolded: false } });
  await h.settle();
  assert.deepStrictEqual([h.els.sidebar.dataset.folded, h.vars['--sidebar-width']], ['0', '300px']);
  h.toggle();
  assert.deepStrictEqual([h.els.sidebar.dataset.folded, h.vars['--sidebar-width']], ['1', '44px']);
  assert.equal(h.els['sidebar-fold'].dataset.tip, 'Unfold sidebar (Cmd+B)');
  assert.equal(h.els['sidebar-fold'].textContent, '›');
  assert.equal(h.ls['clodex-sidebar-folded'], '1');
  assert.deepStrictEqual(h.saved.at(-1), { sidebarFolded: true });
  h.toggle();
  assert.deepStrictEqual([h.els.sidebar.dataset.folded, h.vars['--sidebar-width']], ['0', '300px']);
  assert.equal(h.els['sidebar-fold'].dataset.tip, 'Fold sidebar (Cmd+B)');
  assert.equal(h.els['sidebar-fold'].textContent, '‹');
  assert.equal(h.ls['clodex-sidebar-folded'], '0');
  assert.deepStrictEqual(h.saved.at(-1), { sidebarFolded: false });
});

test('a stored fold is applied on load, and the chevron button drives the same toggle', async () => {
  const h = loadFoldIife({ stored: { 'clodex-sidebar-folded': '1' }, settings: { sidebarWidth: 280, sidebarFolded: true } });
  assert.equal(h.vars['--sidebar-width'], '44px');
  await h.settle();
  assert.deepStrictEqual([h.els.sidebar.dataset.folded, h.vars['--sidebar-width']], ['1', '44px']);
  h.listeners['sidebar-fold'].click();
  assert.deepStrictEqual([h.els.sidebar.dataset.folded, h.vars['--sidebar-width']], ['0', '280px']);
});

test('while folded the resizer drag is inert', async () => {
  const h = loadFoldIife({ settings: { sidebarWidth: 300, sidebarFolded: true } });
  await h.settle();
  const r = h.listeners['sidebar-resizer'];
  let prevented = false;
  r.pointerdown({ button: 0, pointerId: 1, preventDefault() { prevented = true; } });
  r.pointerup({ pointerId: 1, clientX: 500 });
  r.dblclick();
  assert.equal(prevented, false);
  assert.equal(h.vars['--sidebar-width'], '44px');
  assert.deepStrictEqual(h.saved, []);
});

test('Cmd+B in the capture keydown toggles the fold ahead of the overlay gate', () => {
  const start = rendererSrc.indexOf("document.addEventListener('keydown', (e) => {\n  if (!e.metaKey");
  assert.ok(start >= 0, 'ENTER: the capture keydown handler was not found');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n});\n', start));
  const at = body.indexOf("e.key === 'b'");
  assert.ok(at >= 0, 'the handler binds Cmd+B');
  assert.ok(at < body.indexOf('anyOverlayOpen('), 'Cmd+B is not gated on an open overlay');
  assert.ok(at > body.indexOf('drawerHost.hasFocus()'), 'Cmd+B sits after the drawer guard');
  assert.match(body.slice(at, at + 160), /e\.preventDefault\(\);[\s\S]*toggleSidebarFold\(\);[\s\S]*return;/);
});

test('index.html pre-paints the fold and carries the chevron inside the toolbar', () => {
  const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
  assert.match(script, /localStorage\.getItem\('clodex-sidebar-folded'\) === '1'/);
  const toolbar = html.slice(html.indexOf('<div id="sidebar-toolbar">'), html.indexOf('</div>', html.indexOf('<div id="sidebar-toolbar">')));
  assert.match(toolbar, /<button id="sidebar-fold" data-tip="Fold sidebar \(Cmd\+B\)">&#8249;<\/button>/);
});

test('styles.css makes the resizer inert while folded', () => {
  assert.match(css, /#sidebar\[data-folded="1"\] #sidebar-resizer \{ pointer-events: none; \}/);
  assert.match(css, /#sidebar\[data-folded="1"\] \.session-item::before \{\s*content: attr\(data-monogram\);/);
});
