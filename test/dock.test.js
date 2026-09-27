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
    rect: { top: 0, right: 1000, bottom: 1000, height: 1000 },
    getBoundingClientRect: () => el.rect,
  };
  return el;
}

function fakeClock(win) {
  const clock = { t: 1000, frames: [], timers: [] };
  win.requestAnimationFrame = (fn) => { clock.frames.push(fn); return clock.frames.length; };
  win.cancelAnimationFrame = () => { clock.frames = []; };
  win.setTimeout = (fn, ms) => { const h = { fn, at: clock.t + ms }; clock.timers.push(h); return h; };
  win.clearTimeout = (h) => { clock.timers = clock.timers.filter((x) => x !== h); };
  clock.frame = () => { for (const fn of clock.frames.splice(0)) fn(); };
  clock.advance = (ms) => {
    clock.t += ms;
    for (const h of clock.timers.filter((x) => x.at <= clock.t)) {
      clock.timers = clock.timers.filter((x) => x !== h);
      h.fn();
    }
  };
  return clock;
}

function rig({ innerWidth = 1000, web = false, settings = {}, view, split = false } = {}) {
  const dockEl = fakeEl('dock');
  const handle = fakeEl('dock-handle');
  dockEl.classList.add('dock-closed');
  handle.classList.add('dock-closed');
  const byId = { dock: dockEl, 'dock-handle': handle };
  let splitEl = null;
  if (split) {
    splitEl = fakeEl('dock-split');
    splitEl.classList.add('dock-closed');
    dockEl.appendChild(splitEl);
    byId['dock-split'] = splitEl;
  }
  const doc = { getElementById: (id) => byId[id] || null, body: fakeEl('body') };
  const win = fakeEl('window');
  const clock = fakeClock(win);
  win.innerWidth = innerWidth;
  if (web) win.__CLODEX_WEB__ = true;
  const toasts = [];
  const saved = [];
  const views = [];
  const dock = createDock({
    doc, win,
    now: () => clock.t,
    showToast: (text, opts) => toasts.push({ text, opts }),
    getSettings: () => settings,
    setSettings: (patch) => saved.push(patch),
    loadView: view === undefined ? undefined : () => view,
    saveView: (patch) => views.push(patch),
  });
  return { dock, dockEl, handle, splitEl, doc, win, clock, toasts, saved, views };
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
      r.handle.fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} });
      assert.ok(r.doc.body.classList.contains('dock-dragging'), 'ENTER: the drag started');
      r.handle.fire('pointermove', { clientX: 100, clientY: 0 });
      r.handle.fire('pointerup', { pointerId: 1 });
      assert.strictEqual(r.doc.body.classList.contains('dock-dragging'), false);
      assert.deepStrictEqual(r.saved, [{ sidePaneWidth: 600 }]);
      assert.strictEqual(r.dockEl.style.width, '600px');
    },
  },
  {
    name: 'a pointerup with no drag started, or a press with no move, persists nothing',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('pointermove', { clientX: 100, clientY: 0 });
      r.handle.fire('pointerup', { pointerId: 1 });
      assert.deepStrictEqual(r.saved, []);
      r.handle.fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} });
      r.handle.fire('pointerup', { pointerId: 1 });
      assert.deepStrictEqual(r.saved, []);
      r.handle.fire('pointerdown', { button: 2, pointerId: 1, preventDefault() {} });
      r.handle.fire('pointermove', { clientX: 100, clientY: 0 });
      r.handle.fire('pointerup', { pointerId: 1 });
      assert.deepStrictEqual(r.saved, [], 'a right-button press is not a drag');
    },
  },
  {
    name: 'a drag applies the width live but persists only on release',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} });
      r.handle.fire('pointermove', { clientX: 500, clientY: 0 });
      r.clock.frame();
      assert.strictEqual(r.dockEl.style.width, '500px', 'ENTER: the move applied live');
      r.clock.advance(200);
      r.handle.fire('pointermove', { clientX: 550, clientY: 0 });
      r.clock.frame();
      assert.strictEqual(r.dockEl.style.width, '450px');
      assert.deepStrictEqual(r.saved, [], 'nothing is persisted during the drag');
      r.handle.fire('pointerup', { pointerId: 1 });
      assert.deepStrictEqual(r.saved, [{ sidePaneWidth: 450 }]);
    },
  },
  {
    name: 'the width drag is throttled to one apply per 150 ms, the latest position trailing',
    opts: { innerWidth: 1000 },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      r.handle.fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} });
      r.handle.fire('pointermove', { clientX: 500, clientY: 0 });
      r.handle.fire('pointermove', { clientX: 520, clientY: 0 });
      assert.strictEqual(r.clock.frames.length, 1, 'moves within one frame coalesce');
      r.clock.frame();
      assert.strictEqual(r.dockEl.style.width, '480px', 'ENTER: the first frame applies at once');
      r.clock.advance(50);
      r.handle.fire('pointermove', { clientX: 600, clientY: 0 });
      r.clock.frame();
      assert.strictEqual(r.dockEl.style.width, '480px', '50 ms after an apply, the next one waits');
      r.clock.advance(99);
      assert.strictEqual(r.dockEl.style.width, '480px', 'still inside the 150 ms window');
      r.clock.advance(1);
      assert.strictEqual(r.dockEl.style.width, '400px', 'the trailing apply lands at 150 ms');
    },
  },
  {
    name: 'double-click on the dock handle resets the width to 40% and persists null',
    opts: { innerWidth: 1000, settings: { sidePaneWidth: 560 } },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.setShown('files', true);
      await flush();
      assert.strictEqual(r.dockEl.style.width, '560px', 'ENTER: the stored width applied');
      r.handle.fire('dblclick', {});
      assert.strictEqual(r.dockEl.style.width, '400px');
      assert.deepStrictEqual(r.saved, [{ sidePaneWidth: null }]);
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
      r.handle.fire('pointerdown', { button: 0, pointerId: 1, preventDefault() {} });
      r.handle.fire('pointermove', { clientX: 100, clientY: 0 });
      r.handle.fire('pointerup', { pointerId: 1 });
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
  {
    name: 'the split handle sits between Files and the plugin panes and shows only with two panes up',
    opts: { innerWidth: 1000, split: true },
    async run(r) {
      const files = fakeEl('side-pane');
      const tickets = fakeEl('tickets');
      r.dock.addPane('files', files, 0);
      r.dock.addPane('tickets', tickets, 1);
      assert.deepStrictEqual(r.dockEl.children.map((c) => c.id), ['side-pane', 'dock-split', 'tickets']);
      r.dock.setShown('files', true);
      assert.ok(r.splitEl.classList.contains('dock-closed'), 'one pane shown → no split handle');
      assert.strictEqual(files.style.flex, '');
      r.dock.setShown('tickets', true);
      assert.strictEqual(r.splitEl.classList.contains('dock-closed'), false, 'two panes shown → the split handle');
      assert.strictEqual(files.style.flex, '0.5 1 0px');
      assert.strictEqual(tickets.style.flex, '0.5 1 0px');
      r.dock.setShown('files', false);
      assert.ok(r.splitEl.classList.contains('dock-closed'), 'Tickets alone → no split handle');
      assert.strictEqual(tickets.style.flex, '');
    },
  },
  {
    name: 'the split handle is absent on the web sheet',
    opts: { innerWidth: 500, web: true, split: true },
    async run(r) {
      r.dock.addPane('files', fakeEl('side-pane'), 0);
      r.dock.addPane('tickets', fakeEl('tickets'), 1);
      r.dock.setShown('files', true);
      r.dock.setShown('tickets', true);
      assert.ok(r.dockEl.classList.contains('dock-sheet'), 'ENTER: the dock is a sheet');
      assert.ok(r.splitEl.classList.contains('dock-closed'));
      r.win.innerWidth = 1000;
      r.win.fire('resize');
      assert.strictEqual(r.splitEl.classList.contains('dock-closed'), false, 'at full width the split handle is back');
    },
  },
  {
    name: 'a split drag sets the Files fraction live, clamps it, persists on release; dblclick resets to null',
    opts: { innerWidth: 1000, split: true },
    async run(r) {
      const files = fakeEl('side-pane');
      const tickets = fakeEl('tickets');
      r.dock.addPane('files', files, 0);
      r.dock.addPane('tickets', tickets, 1);
      r.dock.setShown('files', true);
      r.dock.setShown('tickets', true);
      r.splitEl.fire('pointerdown', { button: 0, pointerId: 2, preventDefault() {} });
      assert.ok(r.doc.body.classList.contains('dock-split-dragging'), 'ENTER: the split drag started');
      r.splitEl.fire('pointermove', { clientX: 0, clientY: 300 });
      r.clock.frame();
      assert.strictEqual(files.style.flex, '0.3 1 0px');
      assert.strictEqual(tickets.style.flex, '0.7 1 0px');
      assert.deepStrictEqual(r.saved, []);
      r.splitEl.fire('pointermove', { clientX: 0, clientY: 950 });
      r.splitEl.fire('pointerup', { pointerId: 2 });
      assert.strictEqual(files.style.flex, '0.8 1 0px');
      assert.deepStrictEqual(r.saved, [{ dockSplit: 0.8 }]);
      assert.strictEqual(r.doc.body.classList.contains('dock-split-dragging'), false);
      r.splitEl.fire('dblclick', {});
      assert.strictEqual(files.style.flex, '0.5 1 0px');
      assert.deepStrictEqual(r.saved, [{ dockSplit: 0.8 }, { dockSplit: null }]);
    },
  },
  {
    name: 'the boot read of dockSplit applies the Files fraction',
    opts: { innerWidth: 1000, split: true, settings: { dockSplit: 0.25 } },
    async run(r) {
      const files = fakeEl('side-pane');
      const tickets = fakeEl('tickets');
      r.dock.addPane('files', files, 0);
      r.dock.addPane('tickets', tickets, 1);
      r.dock.setShown('files', true);
      r.dock.setShown('tickets', true);
      await flush();
      assert.strictEqual(files.style.flex, '0.25 1 0px');
      assert.strictEqual(tickets.style.flex, '0.75 1 0px');
    },
  },
];

for (const row of ROWS) {
  test(`dock: ${row.name}`, async () => {
    await row.run(rig(row.opts));
  });
}

test('web: the three drag handles get a 10px hit area from ::before while the visual stays 5px', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const rule = (sel) => {
    const m = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel));
    assert.ok(m.length, `styles.css has a rule for ${sel}`);
    return m.map((x) => x[2]).join(';');
  };
  const px = (body, k) => { const m = body.match(new RegExp(`(?:^|[;\\s])${k}\\s*:\\s*(-?\\d+)px`)); return m ? Number(m[1]) : 0; };
  assert.match(rule('#dock-handle'), /width:\s*5px/);
  assert.match(rule('#dock-split'), /height:\s*5px/);
  assert.match(rule('#drawer-resize'), /height:\s*5px/);
  assert.match(rule('body.web-frontend #drawer-resize::before'), /content:\s*''/);
  assert.match(rule('body.web-frontend #dock-handle::before'), /position:\s*absolute/);
  const h = rule('body.web-frontend #dock-handle::before');
  assert.strictEqual(5 - px(h, 'left') - px(h, 'right'), 10);
  const s = rule('body.web-frontend #dock-split::before');
  assert.strictEqual(5 - px(s, 'top') - px(s, 'bottom'), 10);
  const d = rule('body.web-frontend #drawer-resize::before');
  assert.strictEqual(5 - px(d, 'top') - px(d, 'bottom'), 10);
  const drawer = rule('body.web-frontend #drawer');
  assert.match(drawer, /overflow:\s*clip/, 'the web drawer clips rather than hides, so the margin applies');
  assert.ok(px(drawer, 'overflow-clip-margin') >= -px(d, 'top'), 'the drawer lets the handle reach past its top edge');
  assert.match(rule('body.web-frontend #dock-split'), /position:\s*relative/);
  assert.match(rule('#drawer-resize'), /touch-action:\s*none/);
});
