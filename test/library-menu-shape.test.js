'use strict';
// library-menu-shape.test.js — t793: the Library submenus' category layout, and
// the ONE table both hosts are measured against.
//
// WHY ONE TABLE. The shape lives twice on purpose: library-menu-shape.js is a
// root leaf the Electron menu requires, and renderer/web/menubar.js carries a
// hand-written copy because the browser bundle cannot require a root module
// (build/build-web.js bundles renderer/web only). Two copies drift silently —
// the web bar would keep the old flat shape while the desktop folds, and every
// existing menu test would stay green because each host tests its own half. So
// every case below is asserted against BOTH, through a per-host projection into
// one neutral notation:
//   '—'      a separator          (Electron {type:'separator'} / web {sep:true})
//   '[X]'    a disabled header    (Electron {label,enabled:false} / web {head})
//   'x'      an enabled row       (both {label})
//   '>X: a,b' a folded submenu    (Electron {submenu:rows} / web {submenu:()=>rows})
// A row's own click/run is opaque to the builder — it passes the caller's object
// through untouched — so the table's rows are bare labels.

const test = require('node:test');
const assert = require('node:assert');

const { categoryMenu, FOLD_AT } = require('../library-menu-shape');
const { categoryRows, FOLD_AT: WEB_FOLD_AT } = require('../renderer/web/menubar');

const rows = (...labels) => labels.map((label) => ({ label }));
const nRows = (prefix, n) => rows(...Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`));

// Electron vocabulary → the neutral notation.
function shapeMain(items) {
  return items.map((i) => {
    if (i.type === 'separator') return '—';
    if (i.submenu) return `>${i.label}: ${i.submenu.map((r) => r.label).join(',')}`;
    return i.enabled === false ? `[${i.label}]` : i.label;
  });
}

// Web vocabulary → the same notation. The submenu is a thunk here (the nesting
// form the bar already uses for workspaces and peers), so it is called.
function shapeWeb(rowsOut) {
  return rowsOut.map((r) => {
    if (r.sep) return '—';
    if (r.head) return `[${r.head}]`;
    if (r.submenu) return `>${r.label}: ${r.submenu().map((x) => x.label).join(',')}`;
    return r.disabled ? `[${r.label}]` : r.label;
  });
}

const EMPTY = '(no agents in library)';

const TABLE = [
  {
    name: 'a: a lone Library category is flat and headerless',
    categories: [{ label: 'Library', rows: rows('one', 'two', 'three') }],
    expected: ['one', 'two', 'three'],
  },
  {
    name: 'b: Library then one plugin is the t680 sequence',
    categories: [
      { label: 'Library', rows: rows('lib-a', 'lib-b') },
      { label: 'Reviewer', rows: rows('critic') },
    ],
    expected: ['lib-a', 'lib-b', '—', '[Reviewer]', 'critic'],
  },
  {
    name: 'c: a team category sits between the library rows and the plugin one',
    categories: [
      { label: 'Library', rows: rows('lib-a', 'lib-b') },
      { label: 'Team shop', rows: rows('hand') },
      { label: 'Reviewer', rows: rows('critic') },
    ],
    expected: ['lib-a', 'lib-b', '—', '[Team shop]', 'hand', '—', '[Reviewer]', 'critic'],
  },
  {
    name: 'd: 17 rows fold every category into a submenu, Library included',
    categories: [
      { label: 'Library', rows: nRows('L', 9) },
      { label: 'Team shop', rows: nRows('T', 8) },
    ],
    expected: [
      '>Library: L1,L2,L3,L4,L5,L6,L7,L8,L9',
      '>Team shop: T1,T2,T3,T4,T5,T6,T7,T8',
    ],
  },
  {
    name: 'e: 16 rows is the boundary and stays flat',
    categories: [
      { label: 'Library', rows: nRows('L', 9) },
      { label: 'Team shop', rows: nRows('T', 7) },
    ],
    expected: [
      'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9',
      '—', '[Team shop]', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7',
    ],
  },
  {
    name: 'f: an empty library keeps its placeholder above the team header',
    categories: [
      { label: 'Library', rows: [] },
      { label: 'Team shop', rows: rows('hand') },
    ],
    opts: { empty: EMPTY },
    expected: [`[${EMPTY}]`, '—', '[Team shop]', 'hand'],
  },
];

// ENTER: the table must reach the assertions with every case, or a loop that
// silently iterates nothing passes as a green mirror check.
test('ENTER: the shared table carries all six cases and both hosts fold at the same count', () => {
  assert.strictEqual(TABLE.length, 6, `six cases, got ${TABLE.length}`);
  assert.strictEqual(FOLD_AT, 16, 'the leaf folds past sixteen rows');
  assert.strictEqual(WEB_FOLD_AT, FOLD_AT, 'the web mirror carries the same threshold');
});

for (const row of TABLE) {
  test(`main menu — ${row.name}`, () => {
    assert.deepStrictEqual(shapeMain(categoryMenu(row.categories, row.opts || {})), row.expected);
  });
  test(`web menubar — ${row.name}`, () => {
    assert.deepStrictEqual(shapeWeb(categoryRows(row.categories, row.opts || {})), row.expected);
  });
}

test('a category with no rows is dropped, and the fold counts rows only', () => {
  const categories = [
    { label: 'Library', rows: nRows('L', 16) },
    { label: 'Team shop', rows: [] },
  ];
  // 16 rows + 2 header/separator entries would exceed FOLD_AT if the count
  // included them; it does not, so this stays flat.
  assert.deepStrictEqual(shapeMain(categoryMenu(categories, {})), nRows('L', 16).map((r) => r.label));
  assert.deepStrictEqual(shapeWeb(categoryRows(categories, {})), nRows('L', 16).map((r) => r.label));
});

test('an empty library with no other category renders the placeholder alone', () => {
  const categories = [{ label: 'Library', rows: [] }];
  assert.deepStrictEqual(shapeMain(categoryMenu(categories, { empty: EMPTY })), [`[${EMPTY}]`]);
  assert.deepStrictEqual(shapeWeb(categoryRows(categories, { empty: EMPTY })), [`[${EMPTY}]`]);
});
