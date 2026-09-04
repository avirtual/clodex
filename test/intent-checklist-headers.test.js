'use strict';
// intent-checklist-headers.test.js — t654 round-2 P2: ONE group header per
// contributing plugin, whatever order its rows arrive in.
//
// The catalog is `[...CORE_ROWS, ...pluginRows]`, and pluginRows is a flat
// module-level array every registration pushes onto: two plugins that interleave
// their `intents.register` calls (a late lazy registration, a re-register after
// a reload) leave one plugin's rows non-contiguous. Keying the header on the
// PREVIOUS row's source then draws that plugin a second header, under which its
// remaining verbs read as a different plugin's.
//
// jsdom is not a dependency; the DOM here is the minimum renderIntentChecklist
// touches, the same shape test/skill-checklist-scope.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

function el(tag) {
  const e = {
    tagName: tag, className: '', type: '', value: '', checked: false, disabled: false,
    innerHTML: '', children: [],
    appendChild(c) { e.children.push(c); return c; },
  };
  let text = '';
  // format.js's `esc` round-trips through textContent/innerHTML, so the stub has
  // to model that pair or every label reads as empty.
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

const { renderIntentChecklist, setIntentCatalogCache, setPluginCatalogCache } =
  withDom(() => require('../renderer/lib/checklists'));

const row = (type, source) => ({ type, source, label: type, privileged: source !== 'core' });

// What the container holds, in order, as ('head'|'row', text) pairs — headers and
// verb rows are both direct children, so reducing to one list keeps their
// INTERLEAVING visible. Asserting only the header count would pass a checklist
// that drew every header up front, detached from its rows.
const laidOut = (c) => c.children.map((n) => (n.className === 'popover-subhead'
  ? ['head', n.textContent]
  : ['row', n.children.find((x) => x.tagName === 'input').value]));

test('P2: a plugin whose rows are NON-CONTIGUOUS gets one header, not two', () => withDom(() => {
  setPluginCatalogCache([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]);
  setIntentCatalogCache([
    row('dm', 'core'),
    row('a1', 'alpha'),
    row('b1', 'beta'),
    row('a2', 'alpha'),
  ]);
  const c = el('div');
  renderIntentChecklist(c, null);

  const out = laidOut(c);
  assert.ok(out.some(([kind, v]) => kind === 'row' && v === 'a2'),
    'ENTER: the out-of-order row rendered at all — without it every header assertion below is about a case the fixture never built');
  assert.deepStrictEqual(out, [
    ['row', 'dm'],
    ['head', 'Alpha'],
    ['row', 'a1'],
    ['head', 'Beta'],
    ['row', 'b1'],
    ['row', 'a2'],
  ], 'Alpha is headed once, at its first row; its later row falls under no new header');
  assert.strictEqual(out.filter(([k, v]) => k === 'head' && v === 'Alpha').length, 1,
    'a second Alpha header would file its own verb under a plugin the operator did not read');
}));

test('P2 CONTROL: contiguous rows still get exactly one header each, in first-row order', () => withDom(() => {
  setPluginCatalogCache([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]);
  setIntentCatalogCache([
    row('dm', 'core'),
    row('a1', 'alpha'),
    row('a2', 'alpha'),
    row('b1', 'beta'),
  ]);
  const c = el('div');
  renderIntentChecklist(c, null);
  assert.deepStrictEqual(laidOut(c), [
    ['row', 'dm'],
    ['head', 'Alpha'],
    ['row', 'a1'],
    ['row', 'a2'],
    ['head', 'Beta'],
    ['row', 'b1'],
  ], 'CONTROL: the ordinary case is unchanged — a fix that headed every row would fail here');
}));

test('P2: a plugin absent from the plugin catalog is headed by its raw id, once', () => withDom(() => {
  // The catalog is the NAME source, and a quarantined plugin is absent from it
  // while its already-registered rows are still in the intent catalog.
  setPluginCatalogCache([]);
  setIntentCatalogCache([row('g1', 'ghost'), row('c1', 'core'), row('g2', 'ghost')]);
  const c = el('div');
  renderIntentChecklist(c, null);
  const heads = laidOut(c).filter(([k]) => k === 'head');
  assert.deepStrictEqual(heads, [['head', 'ghost']],
    'the id stands in for a missing display name, and still only once');
}));
