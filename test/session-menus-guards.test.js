'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { initSessionMenus } = require('../renderer/popovers/session-menus');

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function parseButtons(html) {
  return [...html.matchAll(/<button([^>]*)>/g)].map((m) => {
    const dataset = {};
    for (const a of m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) dataset[camel(a[1])] = decode(a[2]);
    const classes = ((m[1].match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/);
    const child = { dataset, disabled: /\sdisabled(\s|$)/.test(m[1]) };
    child.closest = (sel) => (classes.includes(sel.replace(/^\./, '')) ? child : null);
    return child;
  });
}

function mkEl() {
  const listeners = new Map();
  return {
    dataset: {},
    style: {},
    children: [],
    isConnected: true,
    offsetWidth: 300,
    offsetHeight: 200,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    _text: '',
    _html: null,
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(html) { this._html = html; this.children = parseButtons(html); },
    get innerHTML() {
      return this._html != null ? this._html
        : this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    getBoundingClientRect: () => ({ left: 300, top: 860, width: 90, height: 24 }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    remove() { this.isConnected = false; },
    contains: () => false,
    querySelector: () => null,
    fire(type, target) {
      return Promise.all((listeners.get(type) || []).map((fn) => fn({ type, target })));
    },
  };
}

function harness({ active = () => 'a', proxyState = new Map(), row = null, api = {}, deps = {} } = {}) {
  const prev = { document: global.document, window: global.window, CSS: global.CSS,
    confirm: global.confirm, alert: global.alert };
  const appended = [];
  const alerts = [];
  global.document = {
    createElement: () => mkEl(),
    addEventListener() {},
    body: { appendChild: (el) => appended.push(el) },
    querySelector: () => null,
  };
  global.window = { innerWidth: 1400, innerHeight: 900, api };
  global.CSS = { escape: (s) => s };
  global.confirm = () => true;
  global.alert = (m) => alerts.push(m);
  const menus = initSessionMenus({
    getActiveSession: active,
    proxyState,
    sessionList: { querySelector: () => row },
    switchSession() {},
    createTerminal() {}, addSessionToSidebar() {}, markSeatIo() {},
    ...deps,
  });
  return {
    menus,
    appended,
    alerts,
    last: () => appended[appended.length - 1],
    restore() { Object.assign(global, prev); },
  };
}

test('a strip-menu pick made after a seat switch is dropped, not applied to the new seat', async () => {
  let active = 'a';
  const calls = [];
  const h = harness({
    active: () => active,
    proxyState: new Map([['a', { payload: {} }], ['b', { payload: {} }]]),
    api: { setStripLevel: async (n, l) => { calls.push([n, l]); return { ok: true }; } },
  });
  try {
    h.menus.openStripMenu(mkEl(), 0);
    const item = h.last().children.find((c) => c.dataset.level === '1');
    assert.ok(item, 'ENTER: the level-1 item was rendered');
    active = 'b';
    await h.last().fire('click', item);
    assert.deepStrictEqual(calls, []);
  } finally { h.restore(); }
});

function rebuildHarness(api) {
  const rebuilt = [];
  const row = { dataset: { type: 'claude', cwd: '/w', account: 'sub-2', noWire: '1' } };
  const h = harness({
    row,
    api,
    deps: {
      rowSnapshot: (name, el) => ({ name, type: el.dataset.type, cwd: el.dataset.cwd,
        account: el.dataset.account, noWire: el.dataset.noWire === '1', label: 'Renamed' }),
      rebuildLiveRow: (name, snap, res) => rebuilt.push({ name, snap, res }),
    },
  });
  return { h, rebuilt };
}

test('hard restart rebuilds the row through rebuildLiveRow with the snapshot it took', async () => {
  const { h, rebuilt } = rebuildHarness({ restartSession: async () => ({ ok: true, io: 'pty', backend: 'kimi' }) });
  try {
    await h.menus.doHardRestart('s');
    assert.strictEqual(rebuilt.length, 1, 'the injected rebuild ran');
    assert.strictEqual(rebuilt[0].snap.account, 'sub-2');
    assert.strictEqual(rebuilt[0].snap.noWire, true);
    assert.strictEqual(rebuilt[0].snap.label, 'Renamed');
    assert.deepStrictEqual(rebuilt[0].res, { io: 'pty', backend: 'kimi' });
  } finally { h.restore(); }
});

test('a history resume rebuilds the row through rebuildLiveRow with the snapshot it took', async () => {
  const { h, rebuilt } = rebuildHarness({
    getSessionHistory: async () => ({ ok: true, sessions: [{ sessionId: 'abcdef1234', title: 't' }] }),
    restartSession: async () => ({ ok: true, io: 'stream', backend: 'kimi' }),
  });
  try {
    await h.menus.openHistoryMenu('a', mkEl());
    const item = h.last().children.find((c) => c.dataset.sid === 'abcdef1234');
    assert.ok(item, 'ENTER: the past conversation is listed');
    await h.last().fire('click', item);
    assert.strictEqual(rebuilt.length, 1, 'the injected rebuild ran');
    assert.strictEqual(rebuilt[0].snap.account, 'sub-2');
    assert.deepStrictEqual(rebuilt[0].res, { io: 'stream', backend: 'kimi' });
  } finally { h.restore(); }
});

test('two history opens racing one load leave exactly one history menu in the DOM', async () => {
  let release;
  const load = new Promise((r) => { release = r; });
  const h = harness({ api: { getSessionHistory: () => load } });
  try {
    const both = Promise.all([h.menus.openHistoryMenu('a', mkEl()), h.menus.openHistoryMenu('a', mkEl())]);
    release({ ok: true, sessions: [] });
    await both;
    assert.ok(h.appended.length >= 1, 'ENTER: a history menu was built');
    assert.strictEqual(h.appended.filter((el) => el.isConnected).length, 1);
  } finally { h.restore(); }
});

test('an Always pick never reaches proxyHold, even if the poll flips holdSource after the menu opened', async () => {
  const proxyHoldCalls = [];
  const wireHoldCalls = [];
  const proxyState = new Map([['a', { payload: { holdSource: 'wire' } }]]);
  const h = harness({
    proxyState,
    api: {
      wireHold: async (...a) => { wireHoldCalls.push(a); return { ok: true, armed: true }; },
      proxyHold: async (...a) => { proxyHoldCalls.push(a); return { ok: true, armed: true }; },
    },
  });
  try {
    h.menus.openWarmMenu(mkEl(), false);
    const always = h.last().children.find((c) => c.dataset.act === 'always');
    assert.ok(always, 'ENTER: Always is offered while the wire owns the hold');
    proxyState.get('a').payload.holdSource = 'proxy';
    await h.last().fire('click', always);
    assert.strictEqual(proxyHoldCalls.length, 0);
    assert.strictEqual(h.alerts.length, 1, 'the refusal is said, not silent');
  } finally { h.restore(); }
});

test('an Always pick still arms through wireHold while the wire owns the hold', async () => {
  const wireHoldCalls = [];
  const h = harness({
    proxyState: new Map([['a', { payload: { holdSource: 'wire' } }]]),
    api: { wireHold: async (...a) => { wireHoldCalls.push(a); return { ok: true, armed: true }; }, proxyHold() {} },
  });
  try {
    h.menus.openWarmMenu(mkEl(), false);
    await h.last().fire('click', h.last().children.find((c) => c.dataset.act === 'always'));
    assert.deepStrictEqual(wireHoldCalls, [['a', 0, false, true]]);
  } finally { h.restore(); }
});

test('a plugin menu entry whose act contains a quote round-trips to onPick unchanged', () => {
  const h = harness();
  try {
    const picks = [];
    h.menus.openSessionMenu(mkEl(), 'claude', (act) => picks.push(act), [{ act: 'p:x"y', label: 'X' }]);
    const item = h.last().children.find((c) => String(c.dataset.act).startsWith('p:x'));
    assert.ok(item, 'ENTER: the plugin entry was rendered');
    h.last().fire('click', item);
    assert.deepStrictEqual(picks, ['p:x"y']);
  } finally { h.restore(); }
});
