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
      const at = ref ? el.children.indexOf(ref) : -1;
      if (at < 0) el.children.push(child);
      else el.children.splice(at, 0, child);
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

function rig({ innerWidth = 1000, web = false, settings = {} } = {}) {
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
  const dock = createDock({
    doc, win,
    showToast: (text, opts) => toasts.push({ text, opts }),
    getSettings: () => settings,
    setSettings: (patch) => saved.push(patch),
  });
  return { dock, dockEl, handle, doc, win, toasts, saved };
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
    name: 'reveal re-clamps the dragged width against the current window',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('mousedown', { button: 0, preventDefault() {} });
      r.win.fire('mousemove', { clientX: 450 });
      r.win.fire('mouseup');
      assert.strictEqual(r.dockEl.style.width, '550px', 'ENTER: the drag stored 550px');
      r.win.innerWidth = 800;
      r.dock.reveal();
      assert.strictEqual(r.dockEl.style.width, '480px');
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
      const moved = [];
      const origInsert = r.dockEl.insertBefore;
      r.dockEl.insertBefore = (child, ref) => { moved.push(child.id); return origInsert(child, ref); };
      r.dock.addPane('feed', fakeEl('feed'), 2);
      assert.deepStrictEqual(moved, ['feed'], 'adding a pane moves no other pane');
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['side-pane', 'tickets', 'feed']);
      r.dock.removePane('feed');
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
];

for (const row of ROWS) {
  test(`dock: ${row.name}`, async () => {
    await row.run(rig(row.opts));
  });
}
