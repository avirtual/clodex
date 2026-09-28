'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initSessionInfoPopover } = require('../renderer/popovers/session-info-popover');

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
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    getBoundingClientRect: () => ({ left: 10, right: 200, top: 100, width: 190, height: 20 }),
    addEventListener() {},
    contains: () => false,
  };
}

function harness(sessionInfo) {
  const prev = { document: global.document, window: global.window };
  const ids = ['session-info-popover', 'session-info-popover-name', 'session-info-popover-body', 'session-info-popover-close'];
  const els = new Map(ids.map((id) => [id, makeEl()]));
  els.get('session-info-popover').classList.add('hidden');
  global.document = { getElementById: (id) => els.get(id), addEventListener() {}, createElement: fakeTextEl };
  global.window = { innerWidth: 1200, innerHeight: 800, api: { sessionInfo } };
  const api = initSessionInfoPopover({ sessionList: makeEl() });
  return {
    api,
    pop: els.get('session-info-popover'),
    body: els.get('session-info-popover-body'),
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

test('removing the sidebar row of the session shown in the ⓘ popover closes the popover', async () => {
  const h = harness(async () => ({ ok: true, info: {} }));
  try {
    await h.api.openSessionInfoPopover('a', makeEl());
    assert.ok(!h.pop.classList.contains('hidden') && h.pop.dataset.name === 'a', 'ENTER: the panel shows a');
    h.api.closeIfShowing('b');
    assert.ok(!h.pop.classList.contains('hidden'), 'another session\'s removal leaves it open');
    h.api.closeIfShowing('a');
    assert.ok(h.pop.classList.contains('hidden'));
    assert.strictEqual(h.pop.dataset.name, '');
  } finally { h.restore(); }
});

test('a session-info read that lands after its row was removed renders nothing', async () => {
  let release;
  const h = harness(() => new Promise((r) => { release = r; }));
  try {
    const opening = h.api.openSessionInfoPopover('a', makeEl());
    h.api.closeIfShowing('a');
    release({ ok: true, info: {} });
    await opening;
    assert.ok(h.pop.classList.contains('hidden'));
    assert.ok(h.body.innerHTML.includes('Reading session history'), h.body.innerHTML);
  } finally { h.restore(); }
});

test('removeSessionFromSidebar closes the ⓘ popover showing the removed session', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const fn = src.match(/\nfunction removeSessionFromSidebar\(name\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'ENTER: removeSessionFromSidebar is still found by this anchor');
  assert.match(fn[0], /\n {2}closeSessionInfoIfShowing\(name\);\n/);
  assert.match(src, /const \{ openSessionInfoPopover, closeIfShowing: closeSessionInfoIfShowing \} = initSessionInfoPopover\(/);
});
