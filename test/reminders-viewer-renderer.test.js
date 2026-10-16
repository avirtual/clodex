'use strict';

const test = require('node:test');
const assert = require('node:assert');

const viewer = require('../plugins/reminders-viewer/renderer');
const { fmtNextFire, preview, visibleRows } = viewer;

const row = (over) => ({
  id: 'aaa111', agent: 'lead', kind: 'every', spec: 'every 30m', body: 'check the board',
  nextFireAt: Date.UTC(2026, 9, 16, 13, 5), createdAt: 0, lastFiredAt: null, ticket: null, live: true, ...over,
});

test('fmtNextFire: absolute time with a zone abbreviation; oncompact reads "on compact"', () => {
  assert.strictEqual(fmtNextFire(row(), 'UTC'), '2026-10-16 13:05 UTC');
  assert.strictEqual(fmtNextFire(row(), 'America/New_York'), '2026-10-16 09:05 EDT');
  assert.strictEqual(fmtNextFire(row({ kind: 'oncompact', nextFireAt: null }), 'UTC'), 'on compact');
});

test('preview: 60 characters at most, whitespace flattened', () => {
  assert.strictEqual(preview('a\n  b'), 'a b');
  const p = preview('x'.repeat(100));
  assert.strictEqual(p.length, 60);
  assert.ok(p.endsWith('…'));
  assert.strictEqual(preview('y'.repeat(60)), 'y'.repeat(60));
});

test('visibleRows: the selected seat by default, everything with All Seats or no selection', () => {
  const rows = [row({ id: 'a1', agent: 'lead' }), row({ id: 'b2', agent: 'hand' })];
  assert.deepStrictEqual(visibleRows(rows, 'hand', false).map((r) => r.id), ['b2']);
  assert.deepStrictEqual(visibleRows(rows, 'hand', true).map((r) => r.id), ['a1', 'b2']);
  assert.deepStrictEqual(visibleRows(rows, null, false).map((r) => r.id), ['a1', 'b2']);
});

function fakeDom() {
  const make = (tag) => ({
    tag, className: '', children: [], listeners: {}, disabled: false, isConnected: true, title: '', _text: '',
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() { return this._text; },
    set innerHTML(_v) { this.children.length = 0; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn(); },
  });
  const prev = global.document;
  global.document = { createElement: make };
  return { root: make('div'), restore: () => { global.document = prev; } };
}

function find(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children) find(c, pred, out);
  return out;
}

const settle = () => new Promise((r) => setImmediate(r));

async function mount({ rows, active = 'lead', cancelRes = { ok: true } }) {
  const invokes = [];
  const toasts = [];
  let current = rows.slice();
  const rhost = {
    workspaceId: 'ws-1',
    invoke(method, ...args) {
      invokes.push({ method, args });
      if (method === 'list') return Promise.resolve({ ok: true, rows: current });
      if (method === 'cancel') {
        current = current.filter((r) => r.id !== args[0].id);
        return Promise.resolve(cancelRes);
      }
      return Promise.resolve({ ok: false });
    },
    sessions: { active: () => active },
    log: { info() {}, error() {} },
    ui: {
      surfaces: { overlay: (spec) => { rhost._overlay = spec; return { open() {}, close() {} }; } },
      sidebar: { footerButton: () => () => {} },
      showToast: (msg, opts) => toasts.push({ msg, opts }),
    },
  };
  const { root, restore } = fakeDom();
  const teardown = viewer.activate(rhost);
  rhost._overlay.mount(root);
  await rhost._overlay.onOpen();
  await settle();
  const seats = () => find(root, (n) => n.tag === 'td' && n.className.startsWith('rv-seat'));
  const buttons = (cls) => find(root, (n) => n.tag === 'button' && n.className === cls);
  const done = () => { teardown(); restore(); };
  return { root, invokes, toasts, seats, buttons, done };
}

test('renderer: lists for the window workspace, filtered to the selected seat, All Seats widens', async () => {
  const m = await mount({ rows: [row({ id: 'a1', agent: 'lead' }), row({ id: 'b2', agent: 'sleeper', live: false })] });
  try {
    assert.deepStrictEqual(m.invokes[0], { method: 'list', args: ['ws-1'] });
    assert.deepStrictEqual(m.seats().map((s) => s.textContent), ['lead']);
    m.buttons('rv-toggle')[0].click();
    assert.deepStrictEqual(m.seats().map((s) => [s.textContent, s.className]),
      [['lead', 'rv-seat'], ['sleeper', 'rv-seat rv-seat-inactive']]);
    assert.strictEqual(m.buttons('rv-toggle')[0].textContent, 'Selected Seat');
  } finally { m.done(); }
});

test('renderer: a row shows on compact, the preview, full text on hover and the ticket', async () => {
  const long = 'z'.repeat(80);
  const m = await mount({ rows: [row({ kind: 'oncompact', spec: 'on compact', nextFireAt: null, body: long, ticket: 't42' })] });
  try {
    const cell = (cls) => find(m.root, (n) => n.tag === 'td' && n.className === cls)[0];
    assert.strictEqual(cell('rv-next').textContent, 'on compact');
    assert.strictEqual(cell('rv-text').textContent, preview(long));
    assert.strictEqual(cell('rv-text').title, long);
    assert.strictEqual(cell('rv-ticket').textContent, 't42');
  } finally { m.done(); }
});

test('renderer: Cancel invokes cancel with agent+id, toasts "Schedule cancelled" and refreshes', async () => {
  const m = await mount({ rows: [row({ id: 'a1' })] });
  try {
    m.buttons('rv-cancel')[0].click();
    await settle(); await settle();
    assert.deepStrictEqual(m.invokes.map((i) => i.method), ['list', 'cancel', 'list']);
    assert.deepStrictEqual(m.invokes[1].args, [{ agent: 'lead', id: 'a1' }]);
    assert.deepStrictEqual(m.toasts, [{ msg: 'Schedule cancelled', opts: undefined }]);
    assert.strictEqual(m.buttons('rv-cancel').length, 0);
  } finally { m.done(); }
});

test('renderer: an already-gone row refreshes without an error toast', async () => {
  const m = await mount({ rows: [row({ id: 'a1' })], cancelRes: { ok: false, gone: true, error: 'no such reminder for that agent' } });
  try {
    m.buttons('rv-cancel')[0].click();
    await settle(); await settle();
    assert.deepStrictEqual(m.invokes.map((i) => i.method), ['list', 'cancel', 'list']);
    assert.deepStrictEqual(m.toasts, []);
  } finally { m.done(); }
});

test('renderer: a refused cancel raises an error toast and does not refresh', async () => {
  const m = await mount({ rows: [row({ id: 'a1' })], cancelRes: { ok: false, gone: false, error: 'no such reminder for that agent' } });
  try {
    m.buttons('rv-cancel')[0].click();
    await settle(); await settle();
    assert.deepStrictEqual(m.invokes.map((i) => i.method), ['list', 'cancel']);
    assert.deepStrictEqual(m.toasts, [{ msg: 'Could not cancel: no such reminder for that agent', opts: { kind: 'error' } }]);
  } finally { m.done(); }
});
