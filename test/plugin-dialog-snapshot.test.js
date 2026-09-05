'use strict';
// plugin-dialog-snapshot.test.js — t668 / design debt B7: each session dialog
// carries the catalog ids its plugin checklist was DRAWN from, and the collect
// site reads that snapshot instead of the shared cache.
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
// Both collect sites are in renderer.js, which no test can require (DOM-bound,
// window.api at load). A source-shape scan could say "the snapshot identifier
// appears here", but that is one grep away from passing over a snapshot that is
// filled from the cache at collect time anyway — the same bug spelled with a new
// variable. Extracting the statement and EVALUATING it against the real leaves
// (renderPluginChecklist / collectPluginChecklist / mergePlugins /
// pluginsForUnlistedPlugins) asserts the value that reaches persistence. The
// idiom is test/dialog-escape-parity.test.js's.
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
