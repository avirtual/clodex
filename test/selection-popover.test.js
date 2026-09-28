'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initSelectionPopover } = require('../renderer/popovers/selection-popover');

function fakeTextEl() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function makeEl() {
  const classes = new Set();
  return {
    dataset: {},
    style: {},
    textContent: '',
    innerHTML: '',
    offsetWidth: 300,
    offsetHeight: 200,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    getBoundingClientRect: () => ({ left: 500, right: 540, top: 700, width: 40, height: 20 }),
    addEventListener() {},
    contains: () => false,
  };
}

function harness(inspect, getActiveSession) {
  const prev = { document: global.document, window: global.window };
  const ids = ['selection-popover', 'selection-popover-name', 'selection-popover-body',
    'drawer-clipboard', 'drawer-clipboard-count', 'selection-popover-close'];
  const els = new Map(ids.map((id) => [id, makeEl()]));
  els.get('selection-popover').classList.add('hidden');
  global.document = { getElementById: (id) => els.get(id) || null, addEventListener() {}, createElement: fakeTextEl };
  global.window = { innerWidth: 1000, api: { drawerInspectSelection: inspect } };
  const api = initSelectionPopover({ getActiveSession });
  const btn = els.get('drawer-clipboard');
  const countEl = els.get('drawer-clipboard-count');
  return {
    api,
    btn,
    countEl,
    body: () => els.get('selection-popover-body').innerHTML,
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

const withHints = (n) => ({ enabled: true, proxy: { hints: Array.from({ length: n }, () => ({})) }, queued: [] });

test('a failed inspect read on open leaves the live badge exactly as it was', async () => {
  const reads = [async () => withHints(2), async () => { throw new Error('proxy down'); }];
  const h = harness(() => reads.shift()(), () => 'a');
  try {
    await h.api.refreshSelectionBadge();
    assert.strictEqual(h.countEl.textContent, '2', 'ENTER: a successful read painted a');
    await h.api.openSelectionPopover();
    assert.ok(h.body().includes('Could not read what is queued.'), 'ENTER: the failed-read branch ran');
    assert.strictEqual(h.countEl.textContent, '2');
    assert.ok(h.btn.classList.contains('live'));
  } finally { h.restore(); }
});

test('a refresh started for a session that is no longer active does not repaint the badge', async () => {
  let active = 'a';
  const pending = new Map();
  const calls = [];
  const h = harness((name) => {
    calls.push(name);
    return new Promise((resolve) => pending.set(name, resolve));
  }, () => active);
  try {
    const ra = h.api.refreshSelectionBadge();
    active = 'b';
    const rb = h.api.refreshSelectionBadge();
    assert.deepStrictEqual(calls, ['a', 'b'], 'ENTER: both reads in flight');
    pending.get('b')(withHints(0));
    await rb;
    pending.get('a')(withHints(2));
    await ra;
    assert.strictEqual(h.countEl.textContent, '');
    assert.ok(!h.btn.classList.contains('live'));
  } finally { h.restore(); }
});

test('a failed read for a newly active seat clears the count the badge held for the previous seat', async () => {
  let active = 'a';
  const h = harness(async (name) => (name === 'a' ? withHints(2) : null), () => active);
  try {
    await h.api.refreshSelectionBadge();
    assert.strictEqual(h.countEl.textContent, '2', 'ENTER: a successful read painted a');
    active = 'b';
    await h.api.refreshSelectionBadge();
    assert.strictEqual(h.countEl.textContent, '');
    assert.ok(!h.btn.classList.contains('live'));
  } finally { h.restore(); }
});

test('an open whose read lands after a keyboard switch does not paint the old session\'s count', async () => {
  let active = 'a';
  let release;
  const h = harness(() => new Promise((resolve) => { release = resolve; }), () => active);
  try {
    const opening = h.api.openSelectionPopover();
    active = 'b';
    release(withHints(3));
    await opening;
    assert.strictEqual(h.countEl.textContent, '');
    assert.ok(!h.btn.classList.contains('live'));
  } finally { h.restore(); }
});

test('switching the active session refreshes the selection badge beside the drawer switch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('drawerHost.onSessionChanged()'));
  assert.ok(line, 'ENTER: the switch path calls drawerHost.onSessionChanged()');
  assert.match(line, /if \(wasActive && wasActive !== name\) \{ drawerHost\.onSessionChanged\(\); refreshSelectionBadge\(\); \}/);
});
