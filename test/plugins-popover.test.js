'use strict';

// plugins-popover.test.js — the Plugins… popover (t656 C3/C4), the standalone
// editor for a seat's `plugins` list.
//
// Three properties, each with its own reason to be pinned here rather than read
// off the source:
//
//   ONE CHANNEL. Apply writes `session:setPlugins` and nothing else. The handler
//   prunes intents and grants against the list it is handed, so a child write
//   from a dialog that never DISPLAYED that child would fight the prune with
//   stale state and silently restore verbs the operator just removed. A stub api
//   that records every call is the only way to assert the two absences.
//
//   CARRY-FORWARD. A persisted plugin id absent from the catalog (quarantined,
//   globally disabled, kill switch) is invisible in the checklist, so collecting
//   the ticks alone would drop it — irreversibly, since the operator never saw a
//   row to re-tick. t654 r3 NIT3 keyed the survivor basis on the catalog cache;
//   this pins that it stayed keyed there.
//
//   THE C4 REPAINT. The t655 footer dim reads sidebarMeta, refreshed on a 30s
//   timer. Without a post-write nudge the dim lags the operator's own click by up
//   to half a minute. It must fire on success and NOT on failure — a repaint
//   after a rejected write paints the state the write did not reach.

const { test } = require('node:test');
const assert = require('node:assert');

const { initChecklistPopovers } = require('../renderer/popovers/checklist-popovers');

// A DOM stub answering exactly the calls initChecklistPopovers makes. Rich enough
// for the real renderPluginChecklist/collectPluginChecklist to run against it:
// those are the leaves under test's carry-forward arithmetic, and stubbing them
// would assert the fixture's idea of a tick rather than the shipped one.
function makeEl(tag = 'div') {
  const classes = new Set();
  const handlers = new Map();
  const el = {
    tagName: tag,
    dataset: {},
    style: {},
    value: '',
    type: '',
    checked: false,
    textContent: '',
    children: [],
    isConnected: true,
    offsetWidth: 300,
    offsetHeight: 200,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    set innerHTML(v) { el._html = v; if (v === '') el.children = []; },
    get innerHTML() { return el._html || ''; },
    appendChild: (c) => { el.children.push(c); return c; },
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20, bottom: 30 }),
    addEventListener: (t, fn) => {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t).push(fn);
    },
    fire: async (t, ev = {}) => {
      for (const fn of handlers.get(t) || []) await fn(ev);
    },
    querySelector: () => null,
    // Only the two selectors this module actually passes.
    querySelectorAll: (sel) => {
      if (sel === 'input[type="checkbox"]:checked') {
        return el.children
          .flatMap((row) => row.children || [])
          .filter((c) => c.type === 'checkbox' && c.checked);
      }
      return [];
    },
  };
  return el;
}

function makeDocument() {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  return {
    els,
    doc: {
      getElementById: get,
      createElement: (t) => makeEl(t),
      addEventListener() {},
      querySelector: () => null,
    },
  };
}

// `catalog` is what window.api.pluginCatalog() serves; `persisted` is the seat's
// stored list (array, or null for the pre-upgrade all-enabled default).
function harness({ catalog, persisted, setPluginsResult = { ok: true } } = {}) {
  const prevDoc = global.document;
  const prevWin = global.window;
  const prevCss = global.CSS;
  const prevAlert = global.alert;

  const { els, doc } = makeDocument();
  global.document = doc;
  global.CSS = { escape: (s) => s };
  global.alert = () => {};

  const calls = [];
  global.window = {
    innerWidth: 1200,
    innerHeight: 800,
    api: {
      getSettings: async () => ({ claudeTools: [] }),
      getSessionArgs: async (name) => { calls.push(['getSessionArgs', name]); return { ok: true, plugins: persisted }; },
      pluginCatalog: async () => catalog,
      setSessionPlugins: async (name, plugins) => { calls.push(['setSessionPlugins', name, plugins]); return setPluginsResult; },
      setSessionIntents: async (...a) => { calls.push(['setSessionIntents', ...a]); return { ok: true }; },
      setSessionPluginGrants: async (...a) => { calls.push(['setSessionPluginGrants', ...a]); return { ok: true }; },
      restartSession: async (...a) => { calls.push(['restartSession', ...a]); return { ok: true }; },
    },
  };

  const metaArgs = [];
  const api = initChecklistPopovers({
    sessionList: { querySelector: () => null },
    createTerminal() {}, addSessionToSidebar() {}, switchSession() {},
    refreshSidebarMeta: (opts) => { metaArgs.push(opts); },
  });

  return {
    api,
    els,
    calls,
    metaArgs,
    metaRefreshes: () => metaArgs.length,
    list: () => els.get('popover-plugins-list'),
    apply: () => els.get('plugins-popover-apply').fire('click'),
    restore() {
      global.document = prevDoc; global.window = prevWin;
      global.CSS = prevCss; global.alert = prevAlert;
    },
  };
}

// Both SHIPPED: an absent seat list resolves on origin (t661), so a fixture
// without the field would draw every row unticked and the all-ticked assertion
// below could not distinguish "pre-upgrade seat" from "custom plugin".
const CATALOG = [
  { id: 'github', name: 'GitHub', shipped: true },
  { id: 'workbench', name: 'Workbench', shipped: true },
];

test('Apply writes ONLY session:setPlugins — never intents, never grants', async () => {
  const h = harness({ catalog: CATALOG, persisted: ['github', 'workbench'] });
  try {
    await h.api.openPluginsPopover('seat-a', null);
    // ENTER: the checklist really drew the catalog. With no rows, collect returns
    // [] and every "wrote only setPlugins" assertion below would hold vacuously.
    assert.strictEqual(h.list().children.length, 2, 'ENTER: two plugin rows rendered');
    const rows = h.list().children.flatMap((r) => r.children).filter((c) => c.type === 'checkbox');
    rows.find((c) => c.value === 'workbench').checked = false;

    await h.apply();

    const wrote = h.calls.filter((c) => c[0].startsWith('setSession'));
    assert.deepStrictEqual(wrote, [['setSessionPlugins', 'seat-a', ['github']]],
      'exactly one write, carrying the surviving tick');
  } finally { h.restore(); }
});

test('a persisted plugin absent from the catalog survives Apply', async () => {
  // `quarantined` is persisted but has no catalog row, so it renders nothing and
  // collectPluginChecklist cannot see it. It must still come back in the payload.
  const h = harness({ catalog: CATALOG, persisted: ['github', 'quarantined'] });
  try {
    await h.api.openPluginsPopover('seat-b', null);
    const rows = h.list().children.flatMap((r) => r.children).filter((c) => c.type === 'checkbox');
    assert.deepStrictEqual(rows.map((c) => c.value), ['github', 'workbench'],
      'ENTER: the catalog rows are what got drawn — quarantined has none');
    assert.strictEqual(rows.find((c) => c.value === 'github').checked, true);
    assert.strictEqual(rows.find((c) => c.value === 'workbench').checked, false,
      'a catalog plugin absent from the persisted list renders unticked');

    await h.apply();

    const [, , plugins] = h.calls.find((c) => c[0] === 'setSessionPlugins');
    assert.deepStrictEqual(plugins, ['github', 'quarantined'],
      'the unlisted survivor is carried forward, not silently revoked');
  } finally { h.restore(); }
});

test('an EMPTY catalog makes Apply a no-op — it must not strip the seat', async () => {
  const h = harness({ catalog: [], persisted: ['github'] });
  try {
    await h.api.openPluginsPopover('seat-c', null);
    assert.match(h.list().innerHTML, /No plugins loaded/,
      'ENTER: the empty-catalog hint was drawn');
    await h.apply();
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'setSessionPlugins'), [],
      'a kill-switched catalog draws no rows; writing [] would strip every plugin');
    assert.strictEqual(h.metaRefreshes(), 0, 'and there is nothing to repaint');
  } finally { h.restore(); }
});

test('C4: refreshSidebarMeta fires once on a successful write', async () => {
  const h = harness({ catalog: CATALOG, persisted: ['github'] });
  try {
    await h.api.openPluginsPopover('seat-d', null);
    assert.strictEqual(h.metaRefreshes(), 0, 'ENTER: nothing repainted merely by opening');
    await h.apply();
    assert.strictEqual(h.metaRefreshes(), 1,
      'the t655 footer dim must follow the write, not the 30s timer');
    assert.deepStrictEqual(h.metaArgs[0], { includePr: false },
      'the default includePr:true runs git rev-parse + gh pr view (up to ~6s) '
      + 'before the footer repaints, and holds metaRefreshInFlight for that window; '
      + 'plugins rides the record tier either way');
  } finally { h.restore(); }
});

test('C4: refreshSidebarMeta does NOT fire when the write fails', async () => {
  const h = harness({ catalog: CATALOG, persisted: ['github'], setPluginsResult: { ok: false, error: 'nope' } });
  try {
    await h.api.openPluginsPopover('seat-e', null);
    await h.apply();
    assert.strictEqual(h.calls.filter((c) => c[0] === 'setSessionPlugins').length, 1,
      'ENTER: the write was attempted and rejected');
    assert.strictEqual(h.metaRefreshes(), 0,
      'a repaint after a rejected write paints a state the seat never reached');
  } finally { h.restore(); }
});

test('a pre-upgrade seat (plugins absent) opens all-ticked and Apply makes the list explicit', async () => {
  const h = harness({ catalog: CATALOG, persisted: null });
  try {
    await h.api.openPluginsPopover('seat-f', null);
    const rows = h.list().children.flatMap((r) => r.children).filter((c) => c.type === 'checkbox');
    assert.deepStrictEqual(rows.map((c) => c.checked), [true, true],
      'ENTER: an absent list takes the shipped default, and both rows are shipped');
    await h.apply();
    const [, , plugins] = h.calls.find((c) => c[0] === 'setSessionPlugins');
    assert.deepStrictEqual(plugins, ['github', 'workbench']);
  } finally { h.restore(); }
});

test('t661: on that same seat a CUSTOM plugin opens UNticked, and Apply leaves it out', async () => {
  // The other half of the row above, and the migration this ticket is for: the
  // popover is where a stranded seat is repaired, so it must show the operator
  // the reach the gate actually grants — an all-ticked draw here would hand back
  // the custom plugin on the next Apply.
  const h = harness({
    catalog: [{ id: 'github', name: 'GitHub', shipped: true }, { id: 'stocks', name: 'Stocks', shipped: false }],
    persisted: null,
  });
  try {
    await h.api.openPluginsPopover('seat-g', null);
    const rows = h.list().children.flatMap((r) => r.children).filter((c) => c.type === 'checkbox');
    assert.deepStrictEqual(rows.map((c) => c.checked), [true, false],
      'the shipped plugin is ticked and the custom one is not');
    await h.apply();
    const [, , plugins] = h.calls.find((c) => c[0] === 'setSessionPlugins');
    assert.deepStrictEqual(plugins, ['github'],
      'and Apply writes the list the operator was shown, custom plugin excluded');
  } finally { h.restore(); }
});

test('C4: the intents Apply repaints between the plugins write and the intents write', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'popovers', 'checklist-popovers.js'), 'utf8');
  const start = src.indexOf("document.getElementById('intents-popover-apply')");
  const end = src.indexOf("document.addEventListener('mousedown'", start);
  assert.ok(start > 0 && end > start,
    'ENTER: the intents Apply listener body was located and bounded');
  const body = src.slice(start, end);

  const iPlugins = body.indexOf('setSessionPlugins(name, plugins)');
  const iMeta = body.search(/refreshSidebarMeta\(\{\s*includePr:\s*false\s*\}\)/);
  const iIntents = body.indexOf('setSessionIntents(');
  assert.ok(iPlugins > -1, 'the intents Apply still writes the plugins parent');
  assert.ok(iMeta > -1,
    'and repaints with includePr:false — the default tier shells out to git and gh, '
    + 'up to ~6s, holding metaRefreshInFlight before the footer moves');
  assert.ok(iIntents > -1, 'and writes the intents child');
  assert.ok(iPlugins < iMeta && iMeta < iIntents,
    'PARENT FIRST, then the repaint, then the child: the setPlugins handler prunes '
    + 'intents against the list it was handed, so the child write must follow it');
});

test('the opener is exported and routeSessionAction reaches it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /else if \(act === 'plugins'\) openPluginsPopover\(activeSession, anchor\);/,
    "the menu's 'plugins' act must reach the popover — the entry is dead without it");
  assert.match(src, /openPluginsPopover,?\s*\n?\s*\} = initChecklistPopovers\(\{/,
    'and the opener must be destructured from the island that builds it');
  assert.match(src, /initChecklistPopovers\(\{\n\s*sessionList[^}]*refreshSidebarMeta,/,
    'refreshSidebarMeta is INJECTED — free-identifier-leaks forbids reaching it as a free name');
});
