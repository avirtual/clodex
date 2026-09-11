'use strict';
// Run: node --test
// The DOM half of the per-account quota chip (t813). test/quota-chip.test.js
// pins what `quotaChips` DECIDES; nothing pinned that the decision reaches the
// screen, and the strip is where a second account either appears as its own
// element or silently overwrites the first. drawer-host.js is otherwise
// DOM-bound and untested by its own R1 rule, so this file fakes the minimum
// document `createDrawerHost` touches rather than the whole drawer.
const { test } = require('node:test');
const assert = require('node:assert');
const { createDrawerHost } = require('../renderer/drawer-host');
const { quotaChip } = require('../proxy-util');

function el(tag = 'div') {
  const e = {
    tagName: tag,
    className: '',
    children: [],
    dataset: {},
    attrs: new Map(),
    title: '',
    _text: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute(k, v) { e.attrs.set(k, v); },
    removeAttribute(k) { e.attrs.delete(k); delete e.dataset[k.replace(/^data-/, '')]; },
    appendChild(c) { e.children.push(c); return c; },
    contains: () => false,
    closest: () => null,
    // textContent = '' is how setQuota clears the strip, so the fake has to
    // drop children on assignment the way the real one does — a fake that only
    // stored the string would let a stale chip survive every repaint and the
    // duplicate-element bug this file exists for would be invisible.
    get textContent() { return e._text; },
    set textContent(v) { e._text = String(v); e.children = []; },
  };
  return e;
}

function withDom(fn) {
  const had = { d: global.document, w: global.window, ls: global.localStorage, ro: global.ResizeObserver };
  const byId = new Map();
  global.document = {
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, el('div'));
      return byId.get(id);
    },
    createElement: el,
    addEventListener() {},
    activeElement: null,
  };
  global.window = { api: { onRequestOpenIpcLog() {} } };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.ResizeObserver = class { observe() {} };
  try {
    const host = createDrawerHost({ refitActiveTerminal() {}, getActiveSession: () => null });
    return fn(host, byId.get('drawer-quota'));
  } finally {
    global.document = had.d; global.window = had.w;
    global.localStorage = had.ls; global.ResizeObserver = had.ro;
  }
}

const LOUD = quotaChip({ status: 'rejected', window: '7d', usedPct: 69, resetsInS: 3600, ageS: 1 }, 0);
const QUIET = quotaChip({ status: 'rejected', window: '5h', usedPct: 12, resetsInS: 600, ageS: 1 }, 0);

test('setQuota: one chip is a single element, byte-identical to what quotaChip emits', () => {
  withDom((host, quotaEl) => {
    host.setQuota([LOUD]);
    assert.strictEqual(quotaEl.children.length, 1, 'ENTER: one element, or the field reads below come off nothing');
    const [chip] = quotaEl.children;
    assert.strictEqual(chip.textContent, 'week (all models) quota 69% used · resets in 1h');
    assert.strictEqual(chip.className, 'quota-chip');
    assert.strictEqual(chip.dataset.level, 'loud');
    assert.strictEqual(chip.title, LOUD.tip);
    assert.strictEqual(chip.dataset.stale, undefined);
  });
});

test('setQuota: two chips are two elements, each carrying its own level and tip', () => {
  withDom((host, quotaEl) => {
    host.setQuota([
      { ...LOUD, text: `default · ${LOUD.text}`, tip: `default · ${LOUD.tip}` },
      { ...QUIET, level: 'warn', stale: true, text: `sub-2 · ${QUIET.text}`, tip: `sub-2 · ${QUIET.tip}` },
    ]);
    assert.strictEqual(quotaEl.children.length, 2, 'ENTER: two elements — one joined string would read as a single chip below');
    assert.deepStrictEqual(quotaEl.children.map((c) => c.textContent), [
      'default · week (all models) quota 69% used · resets in 1h',
      'sub-2 · 5h quota 12% used · resets in 10m',
    ]);
    assert.deepStrictEqual(quotaEl.children.map((c) => c.dataset.level), ['loud', 'warn']);
    assert.deepStrictEqual(quotaEl.children.map((c) => c.dataset.stale), [undefined, '1']);
  });
});

test('setQuota: a repaint replaces the strip rather than appending to it', () => {
  // The chip refreshes every second. Appending would grow the header without
  // bound, and the `:empty` rule that hides it would never fire again.
  withDom((host, quotaEl) => {
    host.setQuota([LOUD, QUIET]);
    assert.strictEqual(quotaEl.children.length, 2, 'ENTER: something to replace');
    host.setQuota([QUIET]);
    assert.strictEqual(quotaEl.children.length, 1);
    assert.strictEqual(quotaEl.children[0].textContent, QUIET.text);
  });
});

test('setQuota: an empty list empties the strip, which is what the :empty rule hides', () => {
  withDom((host, quotaEl) => {
    host.setQuota([LOUD]);
    assert.strictEqual(quotaEl.children.length, 1, 'ENTER: a chip is up, so the clear below is not vacuous');
    host.setQuota([]);
    assert.strictEqual(quotaEl.children.length, 0);
    assert.strictEqual(quotaEl.textContent, '');
  });
});
