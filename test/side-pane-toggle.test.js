'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const views = [];
const fileTabPath = require.resolve(path.join(__dirname, '..', 'renderer', 'file-tab.js'));
require.cache[fileTabPath] = {
  id: fileTabPath,
  filename: fileTabPath,
  loaded: true,
  exports: {
    createFileTab({ doc, filePath, on }) {
      const v = {
        filePath,
        on,
        el: doc.createElement('div'),
        setDataCalls: [],
        render() {},
        setData(peek, diff, opts) { v.setDataCalls.push(opts); },
        defaultView: (want) => want || 'file',
        anchorLine: () => null,
        showBanner() {},
        canEdit: () => true,
      };
      views.push(v);
      return v;
    },
  },
};
const { createSidePane, bindFilesToggle } = require('../renderer/side-pane');

function el(tag = 'div', id = null) {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const node = {
    tag, id, hidden: false, textContent: '', title: '', className: '', dataset: {}, children: [], parent: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type, e = {}) => { for (const fn of listeners[type] || []) fn(e); },
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    replaceChildren(...kids) { node.children = kids; },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); node.parent = null; },
    querySelector: (sel) => node.children.find((c) => sel === `.${c.className}`) || null,
  };
  return node;
}

function setup() {
  views.length = 0;
  const ids = {};
  for (const id of ['side-pane', 'side-pane-tabs', 'side-pane-seat', 'side-pane-close', 'side-pane-body']) ids[id] = el('div', id);
  const doc = { getElementById: (id) => ids[id] || null, createElement: (tag) => el(tag) };
  const dock = { shown: {}, reveals: 0, addPane() {}, setShown(name, on) { dock.shown[name] = on; }, onScreen: () => true, reveal() { dock.reveals += 1; } };
  const api = { remote: false, mtime: 7, diff: async () => ({ ok: true }), peek: async () => api.peekRes || ({ ok: true, mtime: api.mtime }) };
  let active = 'A';
  const sp = createSidePane({
    dock, popoverApi: () => api, showToast() {}, getActiveSession: () => active, getFiles: () => [],
    focusTerminal() {}, doc, win: { confirm: () => true, api: {} },
  });
  const button = el('button', 'files-toggle');
  for (const cls of ['footer-glyph', 'footer-label', 'footer-badge']) { const s = el('span'); s.className = cls; button.appendChild(s); }
  const toggle = bindFilesToggle({ button, sidePane: sp, getActiveSession: () => active });
  const setActive = (seat) => { active = seat; };
  const switchTo = (seat) => { active = seat; sp.showSeat(seat); };
  const state = () => ({
    hidden: button.hidden,
    pressed: button.getAttribute('aria-pressed'),
    on: button.classList.contains('footer-on'),
    badge: button.querySelector('.footer-badge').textContent,
    pane: !!dock.shown.files,
  });
  return { sp, dock, button, ids, api, toggle, setActive, switchTo, state };
}

const flush = () => new Promise((r) => setImmediate(r));
const ON = { hidden: false, pressed: 'true', on: true, badge: '✓', pane: true };
const OFF = { hidden: false, pressed: 'false', on: false, badge: '', pane: false };
const NONE = { hidden: true, pressed: 'false', on: false, badge: '', pane: false };

test('files toggle: hidden on a seat with no tabs, and a click there does nothing', () => {
  const t = setup();
  t.switchTo('A');
  assert.deepStrictEqual(t.state(), NONE);
  t.button.fire('click');
  assert.deepStrictEqual(t.state(), NONE);
  assert.strictEqual(t.dock.reveals, 0);
});

test('files toggle: a file click ticks it, and the pane × unticks it with the tab kept', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  t.ids['side-pane-close'].fire('click');
  assert.deepStrictEqual(t.state(), OFF);
  assert.strictEqual(t.ids['side-pane-tabs'].children.length, 1);
});

test('files toggle: unticking closes the pane, ticking reopens the kept active tab and reveals the dock', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  t.sp.open('A', { kind: 'file', path: '/w/b.js' });
  await flush();
  const reveals = t.dock.reveals;
  t.button.fire('click');
  assert.deepStrictEqual(t.state(), OFF);
  t.button.fire('click');
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  assert.strictEqual(t.dock.reveals, reveals + 1);
  const strip = t.ids['side-pane-tabs'].children;
  assert.deepStrictEqual(strip.map((c) => c.className), ['side-tab', 'side-tab active']);
});

test('files toggle: a seat switch repaints it for the seat now active', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  t.switchTo('B');
  assert.deepStrictEqual(t.state(), NONE);
  t.switchTo('A');
  assert.deepStrictEqual(t.state(), ON);
  t.ids['side-pane-close'].fire('click');
  t.switchTo('B');
  t.switchTo('A');
  assert.deepStrictEqual(t.state(), OFF);
});

test('files toggle: unticking keeps a dirty edit tab and its buffer', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  const v = views[0];
  v.on.dirty(true);
  v.setDataCalls.length = 0;
  t.button.fire('click');
  assert.deepStrictEqual(t.state(), OFF);
  t.button.fire('click');
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  assert.strictEqual(views.length, 1);
  assert.ok(t.ids['side-pane-body'].children.includes(v.el), 'the edit view is still mounted');
  const tabEl = t.ids['side-pane-tabs'].children[0];
  assert.ok(tabEl.children.some((c) => c.className === 'file-peek-dirty'), 'the tab still shows unsaved changes');
  assert.strictEqual(v.setDataCalls.length, 0, 'the reopen did not push data over the dirty buffer');
});

test('files toggle: a dirty tab whose file changed on disk shows the banner and pushes no data', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  const v = views[0];
  v.on.dirty(true);
  v.setDataCalls.length = 0;
  let banners = 0;
  v.showBanner = () => { banners += 1; };
  t.api.mtime = 8;
  t.button.fire('click');
  t.button.fire('click');
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  assert.strictEqual(banners, 1);
  assert.strictEqual(v.setDataCalls.length, 0);
});

test('files toggle: a dirty tab whose file was deleted re-renders with keepBuffer', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  const v = views[0];
  v.on.dirty(true);
  v.setDataCalls.length = 0;
  t.api.peekRes = { ok: false, code: 'not-found' };
  t.button.fire('click');
  t.button.fire('click');
  await flush();
  assert.deepStrictEqual(v.setDataCalls, [{ keepBuffer: true }]);
});

test('files toggle: lit when another seat\'s file is on screen, and a click closes it', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('B', { kind: 'file', path: '/w/b.js' });
  await flush();
  assert.strictEqual(t.button.hidden, false);
  assert.strictEqual(t.button.getAttribute('aria-pressed'), 'true');
  t.button.fire('click');
  assert.strictEqual(t.sp.paneOpen(), false);
  assert.deepStrictEqual(t.state(), NONE);
});

test('files toggle: a click with another seat on screen closes it instead of opening the active seat', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  t.sp.open('B', { kind: 'file', path: '/w/b.js' });
  await flush();
  assert.deepStrictEqual(t.state(), ON);
  const reveals = t.dock.reveals;
  t.button.fire('click');
  await flush();
  assert.strictEqual(t.sp.paneOpen(), false);
  assert.strictEqual(t.sp.isOpen('A'), false);
  assert.strictEqual(t.dock.reveals, reveals);
  assert.deepStrictEqual(t.state(), OFF);
});

test('files toggle: hidden once the last seat closes, even with a dirty tab kept', async () => {
  const t = setup();
  t.switchTo('A');
  t.sp.open('A', { kind: 'file', path: '/w/a.js' });
  await flush();
  views[0].on.dirty(true);
  t.sp.forgetSeat('A');
  assert.strictEqual(t.button.hidden, false);
  t.setActive(null);
  t.toggle.refresh();
  assert.deepStrictEqual(t.state(), NONE);
});

test('files toggle: the renderer refreshes it on the no-seat-left branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('      activeSession = null;');
  assert.ok(at > 0);
  const branch = src.slice(at, src.indexOf('\n    }\n', at));
  assert.ok(branch.includes('filesToggle.refresh();'));
});
