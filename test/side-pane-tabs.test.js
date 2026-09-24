'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  emptyTabSet, fileTabId, sidePaneFits, clampSidePaneWidth, peekEditable, saveArgs, shouldKeepBuffer, reduceTabs,
  SIDE_PANE_MAX_TABS,
} = require('../renderer/lib/side-pane-tabs');
const { initStores } = require('../stores.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tab(id, over = {}) {
  return {
    id, kind: 'file', path: `/w/${id}`, preview: false, view: 'file', line: null, pushedBy: null,
    dirty: false, stale: false, banner: false, deleted: false, mtime: 100, used: 1, ...over,
  };
}

function set(tabs, active, over = {}) {
  return { tabs, active, open: true, clock: 50, ...over };
}

function pick(s) {
  return { ids: s.tabs.map((t) => t.id), active: s.active, open: s.open };
}

function props(s, id, keys) {
  const t = s.tabs.find((x) => x.id === id);
  const out = {};
  for (const k of keys) out[k] = t[k];
  return out;
}

const ACTIONS = [
  {
    name: 'single click on a file link opens the preview tab',
    before: emptyTabSet(),
    action: { type: 'open', id: 'a', path: '/w/a', preview: true },
    effect: 'fetch',
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { preview: true, view: null, mtime: null, pushedBy: null }],
  },
  {
    name: 'single click replaces the current preview tab in its slot',
    before: set([tab('p1'), tab('a', { preview: true }), tab('p2')], 'a'),
    action: { type: 'open', id: 'b', path: '/w/b', preview: true },
    effect: 'fetch',
    after: { ids: ['p1', 'b', 'p2'], active: 'b', open: true },
    tab: ['b', { preview: true }],
  },
  {
    name: 'a target already open in a permanent tab is focused, not duplicated',
    before: set([tab('a'), tab('b')], 'b'),
    action: { type: 'open', id: 'a', path: '/w/a', preview: true },
    effect: 'revalidate',
    after: { ids: ['a', 'b'], active: 'a', open: true },
    tab: ['a', { preview: false, used: 51 }],
  },
  {
    name: 'double click on the same source makes the preview permanent',
    before: set([tab('a', { preview: true })], 'a'),
    action: { type: 'open', id: 'a', path: '/w/a', preview: false },
    effect: 'show',
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { preview: false }],
  },
  {
    name: 'double click on the preview title or the pin button pins it',
    before: set([tab('a', { preview: true })], 'a'),
    action: { type: 'pin', id: 'a' },
    effect: null,
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { preview: false }],
  },
  {
    name: 'switching a file tab to Edit pins it',
    before: set([tab('a', { preview: true })], 'a'),
    action: { type: 'view', id: 'a', view: 'edit' },
    effect: null,
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { preview: false, view: 'edit' }],
  },
  {
    name: 'switching to Diff or File does not pin',
    before: set([tab('a', { preview: true })], 'a'),
    action: { type: 'view', id: 'a', view: 'diff' },
    effect: null,
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { preview: true, view: 'diff' }],
  },
  {
    name: 'after a pin the next single click opens a new preview beside it',
    before: set([tab('a')], 'a'),
    action: { type: 'open', id: 'b', path: '/w/b', preview: true },
    effect: 'fetch',
    after: { ids: ['a', 'b'], active: 'b', open: true },
    tab: ['b', { preview: true }],
  },
  {
    name: 'an agent push opens as a preview with its badge and never replaces a permanent tab',
    before: set([tab('a')], 'a'),
    action: { type: 'open', id: 'b', path: '/w/b', preview: true, pushedBy: 'hand-1' },
    effect: 'fetch',
    after: { ids: ['a', 'b'], active: 'b', open: true },
    tab: ['b', { preview: true, pushedBy: 'hand-1' }],
  },
  {
    name: 'an agent push replaces only the preview tab',
    before: set([tab('a'), tab('p', { preview: true })], 'a'),
    action: { type: 'open', id: 'b', path: '/w/b', preview: true, pushedBy: 'hand-1' },
    effect: 'fetch',
    after: { ids: ['a', 'b'], active: 'b', open: true },
    tab: ['a', { preview: false }],
  },
  {
    name: 'a 13th tab closes the least recently used clean permanent tab',
    before: set([
      tab('t1', { used: 1, dirty: true }), tab('t2', { used: 2 }), tab('t3', { used: 9 }), tab('t4', { used: 3 }),
      tab('t5', { used: 4 }), tab('t6', { used: 5 }), tab('t7', { used: 6 }), tab('t8', { used: 7 }),
      tab('t9', { used: 8 }), tab('t10', { used: 10 }), tab('t11', { used: 11 }), tab('t12', { used: 12 }),
    ], 't12'),
    action: { type: 'open', id: 'n', path: '/w/n', preview: false },
    effect: 'fetch',
    after: { ids: ['t1', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 'n'], active: 'n', open: true },
    tab: ['t1', { dirty: true }],
  },
  {
    name: 'a dirty tab never closes automatically, even over the cap',
    before: set([
      tab('t1', { dirty: true }), tab('t2', { dirty: true }), tab('t3', { dirty: true }), tab('t4', { dirty: true }),
      tab('t5', { dirty: true }), tab('t6', { dirty: true }), tab('t7', { dirty: true }), tab('t8', { dirty: true }),
      tab('t9', { dirty: true }), tab('t10', { dirty: true }), tab('t11', { dirty: true }), tab('t12', { dirty: true }),
    ], 't12'),
    action: { type: 'open', id: 'n', path: '/w/n', preview: false },
    effect: 'fetch',
    after: { ids: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 'n'], active: 'n', open: true },
    tab: ['n', { preview: false }],
  },
  {
    name: 'x on a tab closes it and focuses its right neighbour',
    before: set([tab('a'), tab('b'), tab('c')], 'b'),
    action: { type: 'close', id: 'b' },
    effect: 'revalidate',
    after: { ids: ['a', 'c'], active: 'c', open: true },
    tab: ['c', { used: 51 }],
  },
  {
    name: 'x on the last tab in the strip focuses its left neighbour',
    before: set([tab('a'), tab('b')], 'b'),
    action: { type: 'close', id: 'b' },
    effect: 'revalidate',
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { used: 51 }],
  },
  {
    name: 'x on an inactive tab keeps the active one',
    before: set([tab('a'), tab('b')], 'b'),
    action: { type: 'close', id: 'a' },
    effect: null,
    after: { ids: ['b'], active: 'b', open: true },
    tab: ['b', { used: 1 }],
  },
  {
    name: 'closing the last tab closes the pane',
    before: set([tab('a')], 'a'),
    action: { type: 'close', id: 'a' },
    effect: null,
    after: { ids: [], active: null, open: false },
  },
  {
    name: 'x on a dirty tab asks first and changes nothing',
    before: set([tab('a', { dirty: true }), tab('b')], 'a'),
    action: { type: 'close', id: 'a' },
    effect: 'confirm',
    after: { ids: ['a', 'b'], active: 'a', open: true },
    tab: ['a', { dirty: true }],
  },
  {
    name: 'a confirmed discard closes the dirty tab',
    before: set([tab('a', { dirty: true }), tab('b')], 'a'),
    action: { type: 'close', id: 'a', force: true },
    effect: 'revalidate',
    after: { ids: ['b'], active: 'b', open: true },
  },
  {
    name: 'x on the pane closes it and keeps the tabs',
    before: set([tab('a'), tab('b')], 'b'),
    action: { type: 'closePane' },
    effect: null,
    after: { ids: ['a', 'b'], active: 'b', open: false },
  },
  {
    name: 'the next open after a pane close restores the kept tabs',
    before: set([tab('a'), tab('b')], 'b', { open: false }),
    action: { type: 'open', id: 'c', path: '/w/c', preview: true },
    effect: 'fetch',
    after: { ids: ['a', 'b', 'c'], active: 'c', open: true },
  },
  {
    name: 'clicking a tab focuses it',
    before: set([tab('a'), tab('b')], 'b'),
    action: { type: 'focus', id: 'a' },
    effect: 'revalidate',
    after: { ids: ['a', 'b'], active: 'a', open: true },
    tab: ['a', { used: 51 }],
  },
];

const MATRIX = [
  {
    name: 'File view, visible: re-fetch and re-render',
    before: set([tab('a', { view: 'file' })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'reload',
    tab: ['a', { stale: false, banner: false, mtime: 100 }],
  },
  {
    name: 'Diff view, visible: re-fetch and re-render',
    before: set([tab('a', { view: 'diff' })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'reload',
    tab: ['a', { stale: false, banner: false, mtime: 100 }],
  },
  {
    name: 'File view, hidden: the tab gets the changed dot',
    before: set([tab('a', { view: 'file' }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: null,
    tab: ['a', { stale: true, banner: false, mtime: 100 }],
  },
  {
    name: 'Diff view, hidden: the tab gets the changed dot',
    before: set([tab('a', { view: 'diff' }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: null,
    tab: ['a', { stale: true, banner: false, mtime: 100 }],
  },
  {
    name: 'becoming visible re-fetches the dotted tab and clears the dot',
    before: set([tab('a', { stale: true }), tab('b')], 'b'),
    action: { type: 'focus', id: 'a' },
    effect: 'reload',
    tab: ['a', { stale: false, banner: false, mtime: 100 }],
  },
  {
    name: 'Edit view, clean, visible: reload silently',
    before: set([tab('a', { view: 'edit' })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'reload',
    tab: ['a', { stale: false, banner: false, mtime: 100 }],
  },
  {
    name: 'Edit view, clean, hidden: dot, reload when seen',
    before: set([tab('a', { view: 'edit' }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: null,
    tab: ['a', { stale: true, banner: false, mtime: 100 }],
  },
  {
    name: 'Edit view, dirty, visible: banner, buffer and mtime untouched',
    before: set([tab('a', { view: 'edit', dirty: true })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, mtime: 100 }],
  },
  {
    name: 'Edit view, dirty, hidden: banner, buffer and mtime untouched',
    before: set([tab('a', { view: 'edit', dirty: true }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, mtime: 100 }],
  },
  {
    name: 'File view over a dirty buffer, visible: banner, mtime untouched',
    before: set([tab('a', { view: 'file', dirty: true })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, stale: false, mtime: 100 }],
  },
  {
    name: 'Diff view over a dirty buffer, visible: banner, mtime untouched',
    before: set([tab('a', { view: 'diff', dirty: true })], 'a'),
    action: { type: 'changed', id: 'a', visible: true },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, stale: false, mtime: 100 }],
  },
  {
    name: 'File view over a dirty buffer, hidden: banner, mtime untouched',
    before: set([tab('a', { view: 'file', dirty: true }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, stale: false, mtime: 100 }],
  },
  {
    name: 'Diff view over a dirty buffer, hidden: banner, mtime untouched',
    before: set([tab('a', { view: 'diff', dirty: true }), tab('b')], 'b'),
    action: { type: 'changed', id: 'a', visible: false },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, stale: false, mtime: 100 }],
  },
  {
    name: 'a fetch in the Diff view over a dirty buffer that finds a new mtime raises the banner and keeps the old mtime',
    before: set([tab('a', { view: 'diff', dirty: true })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 200, content: 'theirs' } },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, mtime: 100 }],
  },
  {
    name: 'a forced fetch over a dirty buffer still does not adopt the new mtime',
    before: set([tab('a', { view: 'file', dirty: true })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 200, content: 'theirs' }, force: true },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, mtime: 100 }],
  },
  {
    name: 'a fetch under a dirty Edit that finds a new mtime raises the banner and keeps the old mtime',
    before: set([tab('a', { view: 'edit', dirty: true })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 200, content: 'theirs' } },
    effect: 'banner',
    tab: ['a', { dirty: true, banner: true, mtime: 100 }],
  },
  {
    name: 'a fetch under a dirty Edit with an unchanged mtime changes nothing',
    before: set([tab('a', { view: 'edit', dirty: true })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 100, content: 'same' } },
    effect: null,
    tab: ['a', { dirty: true, banner: false, mtime: 100 }],
  },
  {
    name: 'a clean fetch with a new mtime adopts it and renders',
    before: set([tab('a', { view: 'file' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 200, content: 'x' } },
    effect: 'render',
    tab: ['a', { dirty: false, banner: false, mtime: 200, deleted: false }],
  },
  {
    name: 'a revalidation with an unchanged mtime does not re-render',
    before: set([tab('a', { view: 'file' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 100, content: 'x' } },
    effect: null,
    tab: ['a', { mtime: 100, deleted: false }],
  },
  {
    name: 'a forced reload re-renders even at the same mtime',
    before: set([tab('a', { view: 'edit' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: true, mtime: 100, content: 'x' }, force: true },
    effect: 'render',
    tab: ['a', { mtime: 100, deleted: false }],
  },
  {
    name: 'File view, file deleted: the tab stays, marked deleted',
    before: set([tab('a', { view: 'file' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: false, code: 'not-found', error: 'no such file' } },
    effect: 'render',
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { deleted: true, mtime: 100 }],
  },
  {
    name: 'a peer file that is gone is deleted too',
    before: set([tab('a', { view: 'diff' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: false, code: 'gone', error: 'gone' } },
    effect: 'render',
    tab: ['a', { deleted: true }],
  },
  {
    name: 'Edit view, dirty, file deleted: the buffer is kept',
    before: set([tab('a', { view: 'edit', dirty: true })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: false, code: 'not-found', error: 'no such file' } },
    effect: 'render',
    after: { ids: ['a'], active: 'a', open: true },
    tab: ['a', { deleted: true, dirty: true, view: 'edit' }],
  },
  {
    name: 'an unreadable file is not a deleted one',
    before: set([tab('a', { view: 'file' })], 'a'),
    action: { type: 'loaded', id: 'a', peek: { ok: false, code: 'outside', error: 'outside' } },
    effect: 'render',
    tab: ['a', { deleted: false, mtime: null }],
  },
  {
    name: 'banner Reload discards the buffer and re-fetches',
    before: set([tab('a', { view: 'edit', dirty: true, banner: true })], 'a'),
    action: { type: 'discard', id: 'a' },
    effect: 'reload',
    tab: ['a', { dirty: false, banner: false, mtime: 100 }],
  },
  {
    name: 'banner Keep editing hides it and keeps the old mtime for the save',
    before: set([tab('a', { view: 'edit', dirty: true, banner: true })], 'a'),
    action: { type: 'keep', id: 'a' },
    effect: null,
    tab: ['a', { dirty: true, banner: false, mtime: 100 }],
  },
  {
    name: 'a successful save adopts the written mtime',
    before: set([tab('a', { view: 'edit', dirty: true })], 'a'),
    action: { type: 'saved', id: 'a', mtime: 300 },
    effect: null,
    tab: ['a', { dirty: false, banner: false, mtime: 300 }],
  },
];

for (const row of [...ACTIONS, ...MATRIX]) {
  test(`side-pane tabs: ${row.name}`, () => {
    const { set: next, effect } = reduceTabs(row.before, row.action);
    assert.strictEqual(effect, row.effect);
    if (row.after) assert.deepStrictEqual(pick(next), row.after);
    if (row.tab) assert.deepStrictEqual(props(next, row.tab[0], Object.keys(row.tab[1])), row.tab[1]);
  });
}

test('side-pane tabs: the table covers every section 3.2 action and the section 3.3 matrix', () => {
  assert.strictEqual(ACTIONS.length, 21);
  assert.strictEqual(MATRIX.length, 27);
  assert.strictEqual(SIDE_PANE_MAX_TABS, 12);
});

test('side-pane tabs: a tab identity is per seat and per path', () => {
  assert.strictEqual(fileTabId('hand-1', '/w/a.js'), 'file:hand-1:/w/a.js');
  assert.notStrictEqual(fileTabId('hand-1', '/w/a.js'), fileTabId('hand-2', '/w/a.js'));
});

test('side-pane tabs: Edit is offered only for whole, local, text content', () => {
  const whole = { ok: true, binary: false, truncated: false, content: 'x' };
  assert.strictEqual(peekEditable(true, whole), true);
  assert.strictEqual(peekEditable(true, { ...whole, truncated: true }), false);
  assert.strictEqual(peekEditable(true, { ...whole, binary: true }), false);
  assert.strictEqual(peekEditable(true, { ok: false, error: 'x' }), false);
  assert.strictEqual(peekEditable(false, whole), false);
  assert.strictEqual(peekEditable(true, null), false);
});

test('side-pane tabs: a fetch keeps the buffer of a dirty tab, whatever its view or the file state', () => {
  const rows = [
    [{ view: 'edit', dirty: true }, true],
    [{ view: 'diff', dirty: true }, true],
    [{ view: 'file', dirty: true, deleted: true }, true],
    [{ view: 'edit', dirty: false }, false],
    [{ view: 'file', dirty: false, deleted: true }, false],
  ];
  for (const [over, keep] of rows) assert.strictEqual(shouldKeepBuffer(tab('a', over)), keep, JSON.stringify(over));
  let s = set([tab('a', { view: 'edit', dirty: true })], 'a');
  s = reduceTabs(s, { type: 'loaded', id: 'a', peek: { ok: false, code: 'not-found', error: 'no such file' } }).set;
  assert.strictEqual(shouldKeepBuffer(s.tabs[0]), true);
});

test('side-pane tabs: a save carries the mtime of the read the buffer came from', () => {
  assert.deepStrictEqual(saveArgs('hand-1', tab('a', { path: '/w/a.js', mtime: 111 }), 'mine'), ['hand-1', '/w/a.js', 'mine', 111]);
});

test('side-pane tabs: a save after an agent change is still sent with the pre-change mtime', () => {
  let s = set([tab('a', { path: '/w/a.js', view: 'edit', dirty: true, mtime: 111 })], 'a');
  s = reduceTabs(s, { type: 'changed', id: 'a', visible: true }).set;
  s = reduceTabs(s, { type: 'loaded', id: 'a', peek: { ok: true, mtime: 222, content: 'theirs' } }).set;
  s = reduceTabs(s, { type: 'keep', id: 'a' }).set;
  assert.deepStrictEqual(saveArgs('hand-1', s.tabs[0], 'mine'), ['hand-1', '/w/a.js', 'mine', 111]);
});

test('side-pane width: 40vw by default, clamped to 320px and 60vw', () => {
  assert.strictEqual(clampSidePaneWidth(null, 1000), 400);
  assert.strictEqual(clampSidePaneWidth(100, 1000), 320);
  assert.strictEqual(clampSidePaneWidth(900, 1000), 600);
  assert.strictEqual(clampSidePaneWidth(450.4, 1000), 450);
  assert.strictEqual(sidePaneFits(699), false);
  assert.strictEqual(sidePaneFits(700), true);
});

test('side-pane width: sidePaneWidth persists as an integer or not at all', () => {
  const open = (dir) => initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  }).uiSettings;
  const dir = mkTmpRoot('clodex-uisettings-');
  assert.strictEqual(open(dir).get().sidePaneWidth, null);
  const ui = open(dir);
  ui.set({ sidePaneWidth: 480 });
  assert.strictEqual(open(dir).get().sidePaneWidth, 480);
  ui.set({ theme: 'midnight' });
  assert.strictEqual(open(dir).get().sidePaneWidth, 480);
  const bad = mkTmpRoot('clodex-uisettings-');
  fs.writeFileSync(path.join(bad, 'ui-settings.json'), JSON.stringify({ sidePaneWidth: 'wide' }), { mode: 0o600 });
  assert.strictEqual(open(bad).get().sidePaneWidth, null);
});
