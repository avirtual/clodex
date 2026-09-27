'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createDock } = require('../renderer/dock');

function fakeEl(id) {
  const classes = new Set();
  const listeners = {};
  const el = {
    id,
    parent: null,
    children: [],
    style: {},
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type, e = {}) => { for (const fn of listeners[type] || []) fn(e); },
    appendChild(child) {
      return el.insertBefore(child, null);
    },
    insertBefore(child, ref) {
      if (child.parent) child.remove();
      child.parent = el;
      child.inserts = (child.inserts || 0) + 1;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(child);
      else el.children.splice(i, 0, child);
      return child;
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    getBoundingClientRect: () => ({ right: 1000 }),
  };
  return el;
}

function rig({ innerWidth = 1000, web = false, settings = {}, view } = {}) {
  const dockEl = fakeEl('dock');
  const handle = fakeEl('dock-handle');
  dockEl.classList.add('dock-closed');
  handle.classList.add('dock-closed');
  const byId = { dock: dockEl, 'dock-handle': handle };
  const doc = { getElementById: (id) => byId[id] || null, body: fakeEl('body') };
  const win = fakeEl('window');
  win.innerWidth = innerWidth;
  if (web) win.__CLODEX_WEB__ = true;
  const toasts = [];
  const saved = [];
  const views = [];
  const dock = createDock({
    doc, win,
    showToast: (text, opts) => toasts.push({ text, opts }),
    getSettings: () => settings,
    setSettings: (patch) => saved.push(patch),
    loadView: view === undefined ? undefined : () => view,
    saveView: (patch) => views.push(patch),
  });
  return { dock, dockEl, handle, doc, win, toasts, saved, views };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ROWS = [
  {
    name: 'files shown → dock on screen and width from settings applied',
    opts: { innerWidth: 1000, settings: { sidePaneWidth: 480 } },
    async run(r) {
      const files = fakeEl('side-pane');
      r.dock.addPane('files', files, 0);
      await flush();
      assert.strictEqual(r.dock.onScreen(), false, 'ENTER: nothing shown yet');
      assert.ok(r.dockEl.classList.contains('dock-closed'), 'ENTER: the dock starts closed');
      r.dock.setShown('files', true);
      r.dock.reveal();
      assert.strictEqual(r.dock.onScreen(), true);
      assert.strictEqual(r.dock.isShown('files'), true);
      assert.strictEqual(r.dockEl.classList.contains('dock-closed'), false);
      assert.strictEqual(r.handle.classList.contains('dock-closed'), false);
      assert.strictEqual(files.classList.contains('dock-pane-hidden'), false);
      assert.strictEqual(r.dockEl.style.width, '480px');
      assert.deepStrictEqual(r.toasts, []);
    },
  },
  {
    name: 'files hidden → .dock-closed',
    opts: { innerWidth: 1000 },
    async run(r) {
      const files = fakeEl('side-pane');
      r.dock.addPane('files', files, 0);
      r.dock.setShown('files', true);
      assert.strictEqual(r.dock.onScreen(), true, 'ENTER: files shown');
      assert.strictEqual(r.dockEl.classList.contains('dock-closed'), false, 'ENTER: the dock is open');
      r.dock.setShown('files', false);
      assert.strictEqual(r.dock.onScreen(), false);
      assert.strictEqual(r.dock.isShown('files'), false);
      assert.ok(r.dockEl.classList.contains('dock-closed'));
      assert.ok(r.handle.classList.contains('dock-closed'));
      assert.ok(files.classList.contains('dock-pane-hidden'));
    },
  },
  {
    name: 'window under 700px with a pane shown → hidden, toast, onScreen() false',
    opts: { innerWidth: 699 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      assert.deepStrictEqual(r.toasts, [], 'ENTER: no toast before a pane is shown');
      r.dock.setShown('files', true);
      assert.strictEqual(r.dock.isShown('files'), true);
      assert.strictEqual(r.dock.onScreen(), false);
      assert.ok(r.dockEl.classList.contains('dock-closed'));
      assert.ok(r.handle.classList.contains('dock-closed'));
      assert.deepStrictEqual(r.toasts, [], 'ENTER: setShown alone does not toast');
      r.dock.reveal();
      assert.deepStrictEqual(r.toasts, [
        { text: 'Widen the window to see the side pane', opts: { kind: 'warn', duration: 4000 } },
      ]);
      r.dock.setShown('files', true);
      assert.strictEqual(r.toasts.length, 1, 'a re-render without reveal does not toast again');
      r.win.innerWidth = 1000;
      r.win.fire('resize');
      assert.strictEqual(r.dock.onScreen(), true, 'widening the window brings the dock back');
      assert.strictEqual(r.dockEl.classList.contains('dock-closed'), false);
    },
  },
  {
    name: 'web under 700px with a pane shown → the dock is a sheet, no toast',
    opts: { innerWidth: 500, web: true },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.dock.reveal();
      assert.strictEqual(r.dock.onScreen(), true);
      assert.ok(r.dockEl.classList.contains('dock-sheet'));
      assert.strictEqual(r.dockEl.classList.contains('dock-closed'), false);
      assert.ok(r.handle.classList.contains('dock-closed'));
      assert.deepStrictEqual(r.toasts, []);
    },
  },
  {
    name: 'a drag end → setSettings called with the clamped width',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('mousedown', { button: 0, preventDefault() {} });
      assert.ok(r.doc.body.classList.contains('dock-dragging'), 'ENTER: the drag started');
      r.win.fire('mousemove', { clientX: 100 });
      r.win.fire('mouseup');
      assert.strictEqual(r.doc.body.classList.contains('dock-dragging'), false);
      assert.deepStrictEqual(r.saved, [{ sidePaneWidth: 600 }]);
      assert.strictEqual(r.dockEl.style.width, '600px');
    },
  },
  {
    name: 'a mouseup with no drag started persists nothing',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.win.fire('mousemove', { clientX: 100 });
      r.win.fire('mouseup');
      assert.deepStrictEqual(r.saved, []);
    },
  },
  {
    name: 'addPane order and front()',
    opts: { innerWidth: 1000 },
    async run(r) {
      const tickets = fakeEl('tickets');
      const files = fakeEl('side-pane');
      r.dock.addPane('tickets', tickets, 1);
      r.dock.addPane('files', files, 0);
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['side-pane', 'tickets']);
      assert.strictEqual(files.dataset.pane, 'files');
      assert.ok(files.classList.contains('dock-pane'));
      assert.strictEqual(r.dock.front(), null, 'ENTER: nothing shown, no front');
      r.dock.setShown('files', true);
      r.dock.setShown('tickets', true);
      assert.strictEqual(r.dock.front(), 'tickets');
      r.dock.setShown('files', true);
      assert.strictEqual(r.dock.front(), 'tickets', 'an already-shown pane does not come to the front again');
      r.dock.setShown('tickets', false);
      assert.strictEqual(r.dock.front(), 'files');
      r.dock.removePane('files');
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['tickets']);
      assert.strictEqual(r.dock.front(), null);
      assert.strictEqual(r.dock.onScreen(), false);
    },
  },
  {
    name: 'adding a second pane inserts only the new element; the first keeps its identity and slot',
    opts: { innerWidth: 1000 },
    async run(r) {
      const files = fakeEl('side-pane');
      r.dock.addPane('files', files, 0);
      assert.strictEqual(files.inserts, 1, 'ENTER: files was inserted once');
      const tickets = fakeEl('tickets');
      r.dock.addPane('tickets', tickets, 1);
      assert.strictEqual(files.inserts, 1, 'files was not re-inserted');
      assert.strictEqual(r.dockEl.children[0], files);
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['side-pane', 'tickets']);
      const early = fakeEl('early');
      r.dock.addPane('early', early, -1);
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['early', 'side-pane', 'tickets']);
      assert.strictEqual(files.inserts, 1);
      assert.strictEqual(tickets.inserts, 1);
    },
  },
  {
    name: 'a drag sets the width, the window shrinks, reveal() re-clamps it',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('mousedown', { button: 0, preventDefault() {} });
      r.win.fire('mousemove', { clientX: 100 });
      r.win.fire('mouseup');
      assert.strictEqual(r.dockEl.style.width, '600px', 'ENTER: the drag stored 600');
      r.win.innerWidth = 800;
      r.dockEl.style.width = 'stale';
      r.dock.reveal();
      assert.strictEqual(r.dockEl.style.width, '480px');
    },
  },
  {
    name: 'intent: loaded from the view, written whole, and a tick before the load survives it',
    opts: { innerWidth: 1000, view: { panes: { 'p:a': true, 'p:b': true, 'p:c': 'yes' } } },
    async run(r) {
      let loaded = 0;
      r.dock.onViewLoaded(() => { loaded += 1; });
      r.dock.setIntent('p:b', false);
      assert.strictEqual(loaded, 0, 'ENTER: the view has not loaded yet');
      await Promise.resolve();
      assert.deepStrictEqual(r.views, [], 'nothing is written before the view has loaded');
      await flush();
      assert.deepStrictEqual(r.views, [{ panes: { 'p:a': true, 'p:b': false } }], 'the first write carries the merged map');
      assert.strictEqual(loaded, 1);
      assert.strictEqual(r.dock.intent('p:a'), true);
      assert.strictEqual(r.dock.intent('p:b'), false, 'the earlier untick wins over the loaded tick');
      assert.strictEqual(r.dock.intent('p:c'), false, 'only a literal true is a tick');
      r.dock.onViewLoaded(() => { loaded += 1; });
      assert.strictEqual(loaded, 2, 'a waiter after the load runs at once');
      r.dock.setIntent('p:d', true);
      await flush();
      assert.deepStrictEqual(r.views[r.views.length - 1], { panes: { 'p:a': true, 'p:b': false, 'p:d': true } });
    },
  },
  {
    name: 'web sheet shows only the front pane; the others stay shown underneath',
    opts: { innerWidth: 500, web: true },
    async run(r) {
      const files = fakeEl('side-pane');
      const tickets = fakeEl('tickets');
      r.dock.addPane('files', files, 0);
      r.dock.addPane('tickets', tickets, 1);
      r.dock.setShown('files', true);
      r.dock.setShown('tickets', true);
      assert.ok(r.dockEl.classList.contains('dock-sheet'), 'ENTER: the dock is a sheet');
      assert.ok(files.classList.contains('dock-pane-hidden'));
      assert.strictEqual(tickets.classList.contains('dock-pane-hidden'), false);
      assert.strictEqual(r.dock.isShown('files'), true);
      r.dock.setShown('tickets', false);
      assert.strictEqual(files.classList.contains('dock-pane-hidden'), false);
      assert.ok(tickets.classList.contains('dock-pane-hidden'));
      r.win.innerWidth = 1000;
      r.dock.setShown('tickets', true);
      r.win.fire('resize');
      assert.strictEqual(files.classList.contains('dock-pane-hidden'), false, 'at full width both show');
      assert.strictEqual(tickets.classList.contains('dock-pane-hidden'), false);
    },
  },
];

for (const row of ROWS) {
  test(`dock: ${row.name}`, async () => {
    await row.run(rig(row.opts));
  });
}
