'use strict';
// plugin-checklist-origin.test.js — t661: the New Session pre-tick and the
// plugin checklist's absent-list arm both split on ORIGIN.
//
// These two are the DIALOG half of the gate, and they are the half that can
// disagree with it silently: the engine withholds a custom plugin from a seat
// with no list, but a dialog that pre-ticks it hands the operator a list saying
// otherwise, and SAVING it makes the tick real. So a drift here is not a cosmetic
// mismatch — it is the dialog granting reach the gate had withheld.
//
// jsdom is not a dependency; the DOM here is the minimum these two functions
// touch, the same shape test/intent-checklist-headers.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [], dataset: {},
    appendChild(c) { e.children.push(c); return c; },
  };
  let text = '';
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set(v) {
      text = v == null ? '' : String(v);
      e.innerHTML = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return e;
}

function withDom(fn) {
  const had = global.document;
  global.document = { createElement: el, addEventListener() {} };
  try { return fn(); } finally { global.document = had; }
}

const { renderPluginChecklist, defaultPluginTicks, setPluginCatalogCache } =
  withDom(() => require('../renderer/lib/checklists'));
const { seatHasPlugin } = require('../plugin-api');

const CATALOG = [
  { id: 'workbench', name: 'Workbench', shipped: true },
  { id: 'stocks', name: 'Stocks', shipped: false },
];

// Each row as (id, checked), which keeps the two plugins' DECISIONS visible
// side by side — asserting only the checked count would pass a checklist that
// ticked the wrong one.
const ticksOf = (c) => c.children.map((row) => {
  const cb = row.children.find((x) => x.tagName === 'input');
  return [cb.value, cb.checked];
});

test('t661: a new seat pre-ticks the SHIPPED plugins only', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  assert.deepStrictEqual(defaultPluginTicks(), ['workbench'],
    'the custom plugin is not pre-ticked — a new seat starts where an unedited one stands');
  // CONTROL: the custom row really is in the cache, so the absence above is the
  // origin filter and not an empty catalog.
  setPluginCatalogCache([{ id: 'stocks', name: 'Stocks', shipped: true }]);
  assert.deepStrictEqual(defaultPluginTicks(), ['stocks'],
    'the same id IS pre-ticked when it is shipped, so the filter reads `shipped` and not the id');
}));

test('t661: the checklist draws an unedited seat exactly as the gate resolves it', () => withDom(() => {
  setPluginCatalogCache(CATALOG);
  const absent = el('div');
  renderPluginChecklist(absent, null);
  assert.deepStrictEqual(ticksOf(absent), [['workbench', true], ['stocks', false]],
    'a seat with no list shows the shipped plugin ticked and the custom one not');
  // The dialog and the gate must answer the same question. Asserting the same
  // literals against seatHasPlugin is what makes this a cross-check rather than
  // two copies of one rule: a change to either side reds this row.
  for (const [id, drawn] of ticksOf(absent)) {
    const rec = CATALOG.find((p) => p.id === id);
    assert.strictEqual(seatHasPlugin(id, null, rec.shipped), drawn,
      `${id}: the tick the dialog draws matches the reach the gate grants`);
  }

  const explicit = el('div');
  renderPluginChecklist(explicit, ['stocks']);
  assert.deepStrictEqual(ticksOf(explicit), [['workbench', false], ['stocks', true]],
    'CONTROL: an explicit list is still the word, and origin says nothing about it');

  const empty = el('div');
  renderPluginChecklist(empty, []);
  assert.deepStrictEqual(ticksOf(empty), [['workbench', false], ['stocks', false]],
    'and an empty list is a seat with no plugins, not a seat with no decision');
}));
