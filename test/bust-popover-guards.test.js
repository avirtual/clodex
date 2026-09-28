'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createPopoverGroup } = require('../renderer/lib/popover-group');
const { genuineBustCount } = require('../renderer/lib/render-html');

function fakeEl(classes = []) {
  const set = new Set(classes);
  return {
    dataset: {},
    style: {},
    textContent: '',
    offsetWidth: 320,
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    getBoundingClientRect: () => ({ left: 100, top: 400, width: 40, height: 16 }),
    innerHTML: '',
    addEventListener() {},
    contains: () => false,
  };
}

function harness(bust, payload = {}) {
  const prev = { document: global.document, window: global.window };
  const ids = ['bust-popover', 'bust-popover-name', 'bust-popover-body', 'bust-popover-close'];
  const els = new Map(ids.map((id) => [id, fakeEl(id === 'bust-popover' ? ['hidden'] : [])]));
  global.document = {
    getElementById: (id) => {
      if (!els.has(id)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return els.get(id);
    },
    createElement: () => {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
    addEventListener() {},
    documentElement: {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800, api: {} };
  const proxyState = new Map([['seat-1', { payload }]]);
  const { initBustPopover } = require('../renderer/popovers/bust-popover');
  const { openBustPopover } = initBustPopover({
    popoverApi: () => ({ bust }), proxyState, barPopovers: createPopoverGroup(),
  });
  return {
    open: () => openBustPopover('seat-1', fakeEl()),
    body: () => els.get('bust-popover-body').innerHTML,
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const lapse = () => ({ class: 'lapse', fault: 'environment', write_tokens: 0, write_frac: 0 });
const content = (i) => ({ i, class: 'preamble', fault: 'content', write_tokens: 5000, write_frac: 0.4,
  locus: { label: 'messages[0]', old: 'a', new: 'b' } });

test('the bust panel\'s genuine count agrees with the chip that opened it', async () => {
  const summary = { classes: [{ class: 'lapse', fault: 'environment', count: 3, restart_between: 0 }] };
  const chip = genuineBustCount(summary.classes);
  assert.strictEqual(chip, 3, 'the chip renders 💥 3 for this summary');
  const h = harness(async () => ({ ok: true, data: { count: 40, busts: [lapse(), lapse(), lapse()] } }),
    { busts: summary });
  try {
    await h.open();
    assert.ok(!h.body().includes('Loading'), 'ENTER: the fetch resolved and painted');
    assert.ok(h.body().includes(`<b>${chip}</b> genuine`), `panel disagrees with 💥 ${chip}: ${h.body()}`);
  } finally { h.restore(); }
});

test('genuineBustCount applies one rule to summary classes and series rows', () => {
  assert.strictEqual(genuineBustCount([
    { class: 'preamble', fault: 'content', count: 4, restart_between: 1 },
    { class: 'conversation', fault: 'self', count: 9, restart_between: 0 },
    { class: 'tools', count: 2, restart_between: 0 },
  ]), 3);
  assert.strictEqual(genuineBustCount([
    { fault: 'content', restart_between: true },
    { fault: 'content', restart_between: false },
    { fault: 'self', restart_between: false },
    { restart_between: false },
    lapse(),
  ]), 2);
});

test('a rejected bust fetch replaces the Loading note with an error', async () => {
  const h = harness(() => Promise.reject(new Error('boom')));
  try {
    await assert.doesNotReject(() => h.open());
    assert.ok(h.body().includes('boom'), h.body());
    assert.ok(!h.body().includes('Loading'), h.body());
  } finally { h.restore(); }
});

test('the later open\'s bust response wins over an earlier open still in flight', async () => {
  const d1 = deferred();
  const d2 = deferred();
  const queue = [d1, d2];
  const h = harness(() => queue.shift().promise);
  try {
    const first = h.open();
    const second = h.open();
    d2.resolve({ ok: true, data: { count: 50, busts: [1, 2, 3, 4, 5].map(content) } });
    await second;
    d1.resolve({ ok: true, data: { count: 10, busts: [content(1)] } });
    await first;
    assert.ok(h.body().includes('<b>5</b> genuine'), h.body());
  } finally { h.restore(); }
});
