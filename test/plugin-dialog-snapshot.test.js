'use strict';
// plugin-dialog-snapshot.test.js — t668 / design debt B7, extended by t671: each
// of the four plugin-checklist surfaces (New Session dialog, args dialog, Intents
// popover, Plugins popover) carries the catalog ids its checklist was DRAWN from,
// and the collect site reads that snapshot instead of the shared cache.
//
// THE INTERLEAVING THIS PINS. `pluginsForUnlistedPlugins` carries forward a
// persisted plugin id the checklist could not draw a row for. Its "listed" basis
// used to be re-read from the catalog cache at SAVE time, and the enable arm of
// `onPluginEvent` refills that cache — the one writer that fires while a dialog
// is open. So: a dialog opens for a seat whose list names X while X is globally
// disabled (no row, carried forward); someone enables X in another window; the
// refill lands; the save now sees X as "listed" and, with no row to have ticked,
// drops it. Recoverable only by re-ticking a row the operator never saw go blank.
//
// WHY THE SHIPPED SOURCE IS EXTRACTED AND RUN rather than asserted against.
// The two dialog collect sites are in renderer.js, which no test can require
// (DOM-bound, window.api at load). A source-shape scan could say "the snapshot
// identifier appears here", but that is one grep away from passing over a
// snapshot that is filled from the cache at collect time anyway — the same bug
// spelled with a new variable. Extracting the statement and EVALUATING it against
// the real leaves (renderPluginChecklist / collectPluginChecklist / mergePlugins /
// pluginsForUnlistedPlugins) asserts the value that reaches persistence. The
// idiom is test/dialog-escape-parity.test.js's. The two POPOVER sites are in
// checklist-popovers.js, which IS requireable against a DOM stub
// (test/plugins-popover.test.js does it), so those two subjects open the real
// popover, refill the cache under it and read the payload the real Apply writes —
// a stronger route, taken wherever it is available.
//
// EVALUATING THE STATEMENT DOES NOT FIX ITS POSITION. The extraction subjects
// stub the snapshot they feed in, so a fill moved down into the save handler —
// re-reading the refilled cache under the right variable name — would still pass
// them. The position subject below is what forbids that, for all four sites: the
// fill is assigned exactly once, above its own renderPluginChecklist call, and
// outside the collect/apply function entirely.
//
// `getPluginCatalogCache` is deliberately in the stub set even though the fixed
// source never calls it at collect: without it, reverting the fix would throw a
// ReferenceError, and a test that reds by crashing cannot tell a re-read from a
// typo. With it, the revert reds on the dropped plugin — the shipped symptom.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false,
    children: [], dataset: {}, style: {},
    appendChild(c) { e.children.push(c); return c; },
    querySelectorAll(sel) {
      assert.strictEqual(sel, 'input[type="checkbox"]:checked',
        'ENTER: the only selector collectPluginChecklist passes');
      return e.children
        .flatMap((row) => row.children || [])
        .filter((c) => c.type === 'checkbox' && c.checked);
    },
  };
  let html = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => html,
    set(v) { html = v == null ? '' : String(v); if (html === '') e.children = []; },
  });
  let text = '';
  Object.defineProperty(e, 'textContent', { get: () => text, set(v) { text = v == null ? '' : String(v); } });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const checklists = withDom(() => require('../renderer/lib/checklists'));
const {
  renderPluginChecklist, collectPluginChecklist, defaultPluginTicks,
  setPluginCatalogCache, getPluginCatalogCache,
} = checklists;
const { mergePlugins, pluginsForUnlistedPlugins } = require('../plugin-api');

// One statement of shipped source, captured to its first statement terminator.
function extract(re, what) {
  const m = re.exec(rendererSrc);
  assert.ok(m, `ENTER: ${what} was not found in renderer.js — every assertion below would be vacuous`);
  return m[1];
}

function run(stmt, stubs) {
  const names = Object.keys(stubs);
  return new Function(...names, `${stmt}\nreturn plugins;`)(...names.map((n) => stubs[n]));
}

// The catalog the dialog opens against: X is globally disabled, so it has no row.
const DRAWN = [{ id: 'workbench', name: 'Workbench', shipped: true }];
// After the enable arm's refill, mid-dialog.
const REFILLED = [
  { id: 'workbench', name: 'Workbench', shipped: true },
  { id: 'stocks', name: 'Stocks', shipped: false },
];
const PERSISTED = ['workbench', 'stocks'];

// The DRAW statements, run so the snapshot under test is the one the dialog
// actually computes rather than this file's idea of it.
const NEW_SNAPSHOT_STMT = extract(
  /\n(\s*newSessionPluginsRendered = .*?;)\n/,
  "the New Session dialog's rendered-catalog snapshot",
);
const ARGS_SNAPSHOT_STMT = extract(
  /\n(\s*argsPluginsRendered = .*?;)\n/,
  "the args dialog's rendered-catalog snapshot",
);

function snapshotFrom(stmt, varName) {
  const names = ['getPluginCatalogCache', varName];
  return new Function(...names, `${stmt}\nreturn ${varName};`)(getPluginCatalogCache, []);
}

test('t668: the New Session save keeps a plugin enabled between draw and save', () => withDom(() => {
  const stmt = extract(
    /\n(  const plugins = type === 'claude'[\s\S]*?;)\n/,
    "collectFormConfig's plugins expression",
  );
  assert.match(stmt, /pluginsForUnlistedPlugins\(/, 'ENTER: the captured statement is the carry-forward one');

  setPluginCatalogCache(DRAWN);
  const inputPluginList = el('div');
  renderPluginChecklist(inputPluginList, PERSISTED);
  // ENTER: the checklist really drew no row for the carried plugin. If it had
  // one, the operator's tick would carry it and this test would pass over a
  // collect that reads the cache.
  assert.deepStrictEqual(
    inputPluginList.children.flatMap((r) => r.children.filter((c) => c.type === 'checkbox')).map((c) => c.value),
    ['workbench'],
    'ENTER: only the listed plugin has a row — `stocks` is carried, not ticked',
  );
  const newSessionPluginsRendered = snapshotFrom(NEW_SNAPSHOT_STMT, 'newSessionPluginsRendered');
  assert.deepStrictEqual(newSessionPluginsRendered, ['workbench'],
    'ENTER: the snapshot is the drawn catalog, not the refilled one');

  // The enable arm fires in another window while the dialog sits open.
  setPluginCatalogCache(REFILLED);

  const saved = run(stmt, {
    type: 'claude',
    mergePlugins,
    collectPluginChecklist,
    inputPluginList,
    pluginsForUnlistedPlugins,
    newSessionPluginsPersisted: PERSISTED,
    newSessionPluginsRendered,
    defaultPluginTicks,
    getPluginCatalogCache,
  });
  assert.deepStrictEqual(saved.sort(), ['stocks', 'workbench'],
    'the mid-dialog refill does not turn a carried plugin into an unticked one');

  // CONTROL: unticking a plugin the checklist DID draw still removes it, so the
  // pin above is not satisfied by a collect that carries everything.
  for (const row of inputPluginList.children) for (const c of row.children) if (c.type === 'checkbox') c.checked = false;
  const unticked = run(stmt, {
    type: 'claude',
    mergePlugins,
    collectPluginChecklist,
    inputPluginList,
    pluginsForUnlistedPlugins,
    newSessionPluginsPersisted: PERSISTED,
    newSessionPluginsRendered,
    defaultPluginTicks,
    getPluginCatalogCache,
  });
  assert.deepStrictEqual(unticked, ['stocks'],
    'CONTROL: the drawn plugin obeys its box while the undrawn one still rides through');
}));

test('t668: the args-dialog save keeps a plugin enabled between draw and save', () => withDom(() => {
  const stmt = extract(
    /\n(  const plugins = \(argsPluginsSection[\s\S]*?;)\n/,
    "the args save's plugins expression",
  );
  assert.match(stmt, /pluginsForUnlistedPlugins\(/, 'ENTER: the captured statement is the carry-forward one');

  setPluginCatalogCache(DRAWN);
  const argsPluginList = el('div');
  renderPluginChecklist(argsPluginList, PERSISTED);
  const argsPluginsRendered = snapshotFrom(ARGS_SNAPSHOT_STMT, 'argsPluginsRendered');
  assert.deepStrictEqual(argsPluginsRendered, ['workbench'], 'ENTER: the snapshot is the drawn catalog');

  setPluginCatalogCache(REFILLED);

  const shown = { style: { display: '' } };
  const saved = run(stmt, {
    argsPluginsSection: shown,
    mergePlugins,
    collectPluginChecklist,
    argsPluginList,
    pluginsForUnlistedPlugins,
    argsPluginsPersisted: PERSISTED,
    argsPluginsRendered,
    getPluginCatalogCache,
  });
  assert.deepStrictEqual(saved.sort(), ['stocks', 'workbench'],
    'the mid-dialog refill does not drop the carried plugin from an edited seat');

  // The undefined-preserve guard, keyed on the snapshot: a dialog that drew no
  // rows saves nothing, and a refill arriving afterwards must not make it speak.
  const emptyDraw = run(stmt, {
    argsPluginsSection: shown,
    mergePlugins,
    collectPluginChecklist,
    argsPluginList,
    pluginsForUnlistedPlugins,
    argsPluginsPersisted: PERSISTED,
    argsPluginsRendered: [],
    getPluginCatalogCache,
  });
  assert.strictEqual(emptyDraw, undefined,
    'an empty DRAW is still "untouched" even though the cache has rows by now');

  const hidden = run(stmt, {
    argsPluginsSection: { style: { display: 'none' } },
    mergePlugins,
    collectPluginChecklist,
    argsPluginList,
    pluginsForUnlistedPlugins,
    argsPluginsPersisted: PERSISTED,
    argsPluginsRendered,
    getPluginCatalogCache,
  });
  assert.strictEqual(hidden, undefined, 'CONTROL: the hidden-section arm is unchanged');
}));

// --- t671: the two popovers, through the real module ------------------------

const POPOVERS = path.join(__dirname, '..', 'renderer', 'popovers', 'checklist-popovers.js');
const popoverSrc = fs.readFileSync(POPOVERS, 'utf8');

function popEl(tag = 'div') {
  const classes = new Set();
  const handlers = new Map();
  const e = {
    tagName: tag, dataset: {}, style: {}, value: '', type: '', checked: false,
    textContent: '', children: [], isConnected: true, offsetWidth: 300, offsetHeight: 200,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    set innerHTML(v) { e._html = v; if (v === '') e.children = []; },
    get innerHTML() { return e._html || ''; },
    appendChild: (c) => { e.children.push(c); return c; },
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20, bottom: 30 }),
    addEventListener: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
    fire: async (t, ev = {}) => { for (const fn of handlers.get(t) || []) await fn(ev); },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'input[type="checkbox"]:checked'
      ? e.children.flatMap((row) => row.children || []).filter((c) => c.type === 'checkbox' && c.checked)
      : []),
  };
  return e;
}

// `catalog` is what pluginCatalog() serves at open; the test refills the shared
// cache afterwards to stand in for onPluginEvent's enable arm.
function popoverHarness({
  catalog, persisted, grantPlugins = [], grantCaps = [], grantedTokens = [],
}) {
  const prev = {
    doc: global.document, win: global.window, css: global.CSS, alert: global.alert,
  };
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, popEl()); return els.get(id); };
  global.document = {
    getElementById: get, createElement: (t) => popEl(t), addEventListener() {}, querySelector: () => null,
  };
  global.CSS = { escape: (s) => s };
  global.alert = () => {};
  const calls = [];
  global.window = {
    innerWidth: 1200,
    innerHeight: 800,
    api: {
      getSettings: async () => ({ claudeTools: [] }),
      getSessionArgs: async () => ({ ok: true, plugins: persisted, intents: [], execCommands: [] }),
      pluginCatalog: async () => catalog,
      getIntentCatalog: async () => [],
      getSessionPluginGrants: async () => ({
        ok: true, plugins: grantPlugins, capabilities: grantCaps, granted: grantedTokens,
      }),
      setSessionPlugins: async (name, plugins) => { calls.push(['setSessionPlugins', name, plugins]); return { ok: true }; },
      setSessionIntents: async (...a) => { calls.push(['setSessionIntents', ...a]); return { ok: true }; },
      setSessionPluginGrants: async (...a) => { calls.push(['setSessionPluginGrants', ...a]); return { ok: true }; },
      restartSession: async () => ({ ok: true }),
    },
  };
  const api = require('../renderer/popovers/checklist-popovers').initChecklistPopovers({
    sessionList: { querySelector: () => null },
    createTerminal() {}, addSessionToSidebar() {}, switchSession() {},
    refreshSidebarMeta() {},
  });
  return {
    api,
    calls,
    els,
    ticks: (listId) => els.get(listId).children
      .flatMap((r) => r.children || []).filter((c) => c.type === 'checkbox'),
    apply: (id) => els.get(id).fire('click'),
    restore() {
      global.document = prev.doc; global.window = prev.win;
      global.CSS = prev.css; global.alert = prev.alert;
    },
  };
}

test('t671: the Intents popover Apply keeps a plugin enabled between draw and apply', async () => {
  const h = popoverHarness({ catalog: DRAWN, persisted: PERSISTED });
  try {
    await h.api.openIntentsPopover('seat-i', null);
    // ENTER: the checklist really drew no row for the carried plugin. With a row,
    // the operator's tick would carry it and this subject would pass over an
    // apply that re-reads the cache.
    assert.deepStrictEqual(h.ticks('intents-popover-plugins-list').map((c) => c.value), ['workbench'],
      'ENTER: only the listed plugin has a row — `stocks` is carried, not ticked');

    // The enable arm fires in another window while the popover sits open.
    setPluginCatalogCache(REFILLED);

    await h.apply('intents-popover-apply');
    const wrote = h.calls.find((c) => c[0] === 'setSessionPlugins');
    assert.ok(wrote, 'ENTER: the apply reached the plugins write at all');
    assert.deepStrictEqual(wrote[2].slice().sort(), ['stocks', 'workbench'],
      'the mid-popover refill does not turn a carried plugin into an unticked one');
  } finally { h.restore(); }
});

test('t671: the Intents popover still obeys an untick, and an empty DRAW still writes nothing', async () => {
  const h = popoverHarness({ catalog: DRAWN, persisted: PERSISTED });
  try {
    await h.api.openIntentsPopover('seat-i2', null);
    for (const c of h.ticks('intents-popover-plugins-list')) c.checked = false;
    setPluginCatalogCache(REFILLED);
    await h.apply('intents-popover-apply');
    assert.deepStrictEqual(h.calls.find((c) => c[0] === 'setSessionPlugins')[2], ['stocks'],
      'CONTROL: the drawn plugin obeys its box while the undrawn one still rides through');
  } finally { h.restore(); }

  // The guard now reads the snapshot: a kill-switched catalog drew no rows, and a
  // refill landing afterwards must not make the popover speak for a list it never
  // showed.
  const empty = popoverHarness({ catalog: [], persisted: PERSISTED });
  try {
    await empty.api.openIntentsPopover('seat-i3', null);
    setPluginCatalogCache(REFILLED);
    await empty.apply('intents-popover-apply');
    assert.deepStrictEqual(empty.calls.filter((c) => c[0] === 'setSessionPlugins'), [],
      'an empty DRAW writes no plugins even though the cache has rows by now');
    assert.ok(empty.calls.some((c) => c[0] === 'setSessionIntents'),
      'ENTER: the apply ran to the intents write — the absence above is the guard, not a bail');
  } finally { empty.restore(); }
});

test('t671: the Plugins popover Apply keeps a plugin enabled between draw and apply', async () => {
  const h = popoverHarness({ catalog: DRAWN, persisted: PERSISTED });
  try {
    await h.api.openPluginsPopover('seat-p', null);
    assert.deepStrictEqual(h.ticks('popover-plugins-list').map((c) => c.value), ['workbench'],
      'ENTER: only the listed plugin has a row — `stocks` is carried, not ticked');

    setPluginCatalogCache(REFILLED);

    await h.apply('plugins-popover-apply');
    const wrote = h.calls.find((c) => c[0] === 'setSessionPlugins');
    assert.ok(wrote, 'ENTER: the apply reached the plugins write at all');
    assert.deepStrictEqual(wrote[2].slice().sort(), ['stocks', 'workbench'],
      'the mid-popover refill does not drop the carried plugin from an edited seat');
  } finally { h.restore(); }

  const empty = popoverHarness({ catalog: [], persisted: PERSISTED });
  try {
    await empty.api.openPluginsPopover('seat-p2', null);
    setPluginCatalogCache(REFILLED);
    await empty.apply('plugins-popover-apply');
    assert.deepStrictEqual(empty.calls.filter((c) => c[0] === 'setSessionPlugins'), [],
      'CONTROL: the empty-DRAW guard reads the snapshot, not the refilled cache');
  } finally { empty.restore(); }
});

// The grants half, found by reviewer-671-r1. `renderPluginGrants` recomputes
// `unlistedGrants` on EVERY plugins-list tick (repaintPluginChildren), not only at
// open, so with the basis re-read from the cache a refill plus one tick makes the
// carried plugin "listed", leaving it no grants row to have been ticked:
// mergeGrants(checked, []) then overwrites the grant set, and the setPlugins
// handler prunes that plugin's verbs from the seat's intents on the same Apply.
test('t671: a tick after a refill does not drop the grants of an undrawn plugin', async () => {
  const h = popoverHarness({
    catalog: DRAWN,
    persisted: PERSISTED,
    grantPlugins: [{ id: 'workbench', name: 'Workbench' }],
    grantCaps: ['thinking'],
    grantedTokens: ['workbench:thinking', 'stocks:thinking'],
  });
  try {
    await h.api.openIntentsPopover('seat-g1', null);
    // ENTER: the grants block drew a row for the listed plugin only, so
    // `stocks:thinking` is carried rather than ticked — the case under test.
    const grantRows = h.els.get('intents-popover-grants-list').children
      .filter((c) => c.type === 'checkbox' || (c.children || []).some((x) => x.type === 'checkbox'));
    assert.ok(grantRows.length > 0, 'ENTER: the grants block drew at least one row');
    const drawnTokens = h.els.get('intents-popover-grants-list').children
      .flatMap((r) => r.children || []).filter((c) => c.type === 'checkbox').map((c) => c.value);
    assert.deepStrictEqual(drawnTokens, ['workbench:thinking'],
      'ENTER: only the listed plugin has a grants row — `stocks:thinking` is carried');

    // The enable arm refills the cache, then the operator ticks a plugin box —
    // which is what re-enters renderPluginGrants.
    setPluginCatalogCache(REFILLED);
    await h.els.get('intents-popover-plugins-list').fire('change');

    await h.apply('intents-popover-apply');
    const wrote = h.calls.find((c) => c[0] === 'setSessionPluginGrants');
    assert.ok(wrote, 'ENTER: the apply reached the grants write at all');
    assert.ok(wrote[2].includes('stocks:thinking'),
      'a tick after the refill must not silently revoke a grant the operator never saw');
  } finally { h.restore(); }
});

// nit 1 on the t668 review: the subjects above stub or re-run the snapshot, so a
// fill that moved down into the save handler would satisfy every one of them
// while reading the very cache the snapshot exists to stop reading.
// `applyTo` is the NEXT SITE MARKER, never a bare `\n}\n`: a terminator-bounded
// slice ends at whatever column-0 brace the body grows first, and a body that
// stops short of its own fill makes the containment assertion below pass by
// missing it. The ENTER re-checks that the slice still reaches the site's own
// carry-forward call.
const FILL_SITES = [
  {
    what: 'the New Session dialog', src: rendererSrc, file: 'renderer.js',
    fill: 'newSessionPluginsRendered', render: 'renderPluginChecklist(inputPluginList,',
    applyFrom: 'function collectFormConfig(', applyTo: '\nfunction collectDialogEnv(',
  },
  {
    what: 'the args dialog', src: rendererSrc, file: 'renderer.js',
    fill: 'argsPluginsRendered', render: 'renderPluginChecklist(argsPluginList,',
    applyFrom: "document.getElementById('btn-args-save').addEventListener",
    applyTo: '\n({ refreshTemplatesList: templatesDrawerRefresh }',
  },
  {
    what: 'the Intents popover', src: popoverSrc, file: 'checklist-popovers.js',
    fill: 'intentsPluginsRendered', render: 'renderPluginChecklist(intentsPluginsList,',
    applyFrom: "document.getElementById('intents-popover-apply').addEventListener",
    applyTo: "document.addEventListener('mousedown'",
  },
  {
    what: 'the Plugins popover', src: popoverSrc, file: 'checklist-popovers.js',
    fill: 'popoverPluginsRendered', render: 'renderPluginChecklist(popoverPluginsList,',
    applyFrom: "document.getElementById('plugins-popover-apply').addEventListener",
    applyTo: "document.addEventListener('mousedown'",
  },
];

for (const site of FILL_SITES) {
  test(`t671: ${site.what}'s snapshot is filled at DRAW, not at apply`, () => {
    // `let X = [];` does not match — the declaration is not a fill.
    const fills = [...site.src.matchAll(new RegExp(`^[ \\t]*${site.fill} = .*$`, 'gm'))];
    assert.strictEqual(fills.length, 1,
      `ENTER: exactly one statement assigns ${site.fill} in ${site.file}; `
      + 'two would leave this subject asserting about whichever came first');
    const iFill = fills[0].index;

    const iRender = site.src.indexOf(site.render);
    assert.ok(iRender > -1, `ENTER: ${site.what}'s renderPluginChecklist call was located`);
    assert.ok(iFill < iRender,
      `${site.fill} must be assigned BEFORE the checklist is drawn from it — `
      + 'a fill after the draw is a fill from whatever the cache holds by then');

    const start = site.src.indexOf(site.applyFrom);
    assert.ok(start > -1, `ENTER: ${site.what}'s collect/apply function was located`);
    const end = site.src.indexOf(site.applyTo, start);
    assert.ok(end > start, `ENTER: ${site.what}'s collect/apply function was bounded`);
    assert.ok(site.src.slice(start, end).includes('pluginsForUnlistedPlugins('),
      `ENTER: the slice for ${site.what} reaches its own carry-forward call — a slice `
      + 'cut short of the apply body would satisfy the containment check vacuously');
    assert.ok(iFill < start || iFill > end,
      `${site.fill} is assigned inside the collect/apply body — a snapshot filled `
      + 'there reads the refilled cache under a new name, which is the original bug');
  });
}
