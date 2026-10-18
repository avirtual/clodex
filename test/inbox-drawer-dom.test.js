'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert');

class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc;
    this.children = [];
    this.className = '';
    this.style = {};
    this.listeners = {};
    this.innerHTMLWrites = [];
    this._text = '';
    this.value = '';
    this.open = false;
    this.disabled = false;
    this.scrollHeight = 0;
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    const cl = {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
      remove: (c) => { self.className = list().filter((x) => x !== c).join(' '); },
      toggle: (c, on) => (on ? cl.add(c) : cl.remove(c)),
    };
    return cl;
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parent = this;
    return c;
  }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.innerHTMLWrites.push(String(v)); this.children = []; this._text = ''; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra = {}) {
    const ev = { stopPropagation() {}, preventDefault() {}, shiftKey: false, isComposing: false, ...extra };
    return Promise.all((this.listeners[type] || []).map((fn) => fn(ev)));
  }
  setAttribute(k, v) { this[`attr:${k}`] = String(v); }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(a, b) { this.selection = [a, b]; }
  all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : []))]; }
  find(cls) { return this.all().filter((e) => e.classList && e.classList.contains(cls)); }
}

function harness({ snapshot, focusSeat = () => false, reveal = { ok: true }, reply = async () => ({ ok: true }) }) {
  const doc = { activeElement: null };
  const ids = {};
  for (const id of ['inbox-drawer', 'inbox-list', 'inbox-empty', 'inbox-coverage', 'inbox-mark-all', 'inbox-close', 'inbox-open', 'inbox-count']) {
    ids[id] = new FakeEl('div', doc);
  }
  ids['inbox-drawer'].className = 'hidden';
  doc.getElementById = (id) => ids[id];
  doc.createElement = (tag) => new FakeEl(tag, doc);
  doc.createTextNode = (t) => { const n = new FakeEl('#text', doc); n.textContent = t; return n; };
  const calls = [];
  const subs = {};
  const sub = (name) => (fn) => { subs[name] = fn; };
  const api = {
    openRequests: async (opts) => { calls.push(['openRequests', opts]); return snapshot(); },
    openRequestCount: async () => ({ open: snapshot().open }),
    listWorkspaces: async () => [],
    revealSession: async (name) => { calls.push(['revealSession', name]); return reveal; },
    replyNotification: async (id, text) => { calls.push(['replyNotification', id, text]); return reply(); },
    markNotificationRead: async (id) => { calls.push(['markNotificationRead', id]); },
    removeNotification: async () => {},
    markAllNotificationsRead: async () => {},
    onIpcMessage: sub('ipc'),
    onNotificationsChanged: sub('notes'),
    onAttentionChanged: sub('attention'),
    onRequestOpenInboxDrawer: sub('open'),
  };
  globalThis.document = doc;
  globalThis.window = { api, addEventListener: () => {} };
  globalThis.requestAnimationFrame = () => {};
  const { createInboxDrawer } = require('../renderer/inbox-drawer');
  const drawer = createInboxDrawer({
    openFilePeek: () => {},
    showToast: (msg) => calls.push(['toast', msg]),
    focusSeat: (name) => { calls.push(['focusSeat', name]); return focusSeat(name); },
  });
  return { doc, ids, calls, subs, drawer, list: ids['inbox-list'] };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const NOW = Date.now();
const shoutSnap = () => ({
  at: NOW, open: 1, blindSeats: [], requests: [],
  shouts: [{ id: 'n1', from: 'seat-a', body: 'need a call', createdAt: NOW, readAt: null, kind: 'shout', replyable: true }],
  other: [], resolved: { items: [], hasMore: false },
});

test('a permission row puts the tool preview in as text, never markup', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const message = 'Bash: <img src=x onerror="alert(1)">';
  const h = harness({ snapshot: () => ({
    at: NOW, open: 1, blindSeats: [], shouts: [], other: [], resolved: { items: [], hasMore: false },
    requests: [{ name: 'seat-b', workspaceId: null, ts: NOW, message, pending: 2 }],
  }) });
  h.drawer.openDrawer();
  await flush();
  const rows = h.list.find('request');
  assert.strictEqual(rows.length, 1, 'ENTER: one permission row rendered');
  const body = rows[0].find('inbox-body')[0];
  assert.strictEqual(body.textContent, message);
  for (const el of rows[0].all()) assert.deepStrictEqual(el.innerHTMLWrites, [], 'no element in the row was written as markup');
  assert.ok(rows[0].textContent.includes('2 dialogs'), 'the pending count shows');
  assert.ok(h.ids['inbox-coverage'].textContent.startsWith('Showing 1 open request ·'), 'the coverage line is written');
});

test('a half-typed reply and its focus survive an event-driven repaint', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness({ snapshot: shoutSnap });
  h.drawer.openDrawer();
  await flush();
  await h.list.find('inbox-reply-toggle')[0].fire('click');
  await flush();
  const ta = h.list.find('inbox-reply-input')[0];
  assert.ok(ta, 'ENTER: Reply opened a box');
  assert.strictEqual(h.doc.activeElement, ta, 'the box takes focus when opened');
  ta.value = 'half typed';
  await ta.fire('input');
  h.subs.attention({ name: 'seat-z', message: 'SECRET-PAYLOAD' });
  await flush();
  const again = h.list.find('inbox-reply-input')[0];
  assert.ok(again && again !== ta, 'ENTER: the list was rebuilt and the box re-opened');
  assert.strictEqual(again.value, 'half typed', 'the draft is restored');
  assert.strictEqual(h.doc.activeElement, again, 'focus returns to the box');
  assert.deepStrictEqual(again.selection, [10, 10], 'caret at the end');
  assert.ok(!h.list.textContent.includes('SECRET-PAYLOAD'), 'the attention payload is never rendered');
  assert.ok(h.calls.filter((c) => c[0] === 'openRequests').length >= 3, 'the event re-pulled the snapshot');
});

test('Send replies to the note the box belongs to', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness({ snapshot: shoutSnap });
  h.drawer.openDrawer();
  await flush();
  await h.list.find('inbox-reply-toggle')[0].fire('click');
  await flush();
  const ta = h.list.find('inbox-reply-input')[0];
  ta.value = 'go ahead';
  await h.list.find('inbox-reply-send')[0].fire('click');
  await flush();
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'replyNotification'), [['replyNotification', 'n1', 'go ahead']]);
});

test('a permission-row click focuses the local seat first, then asks main', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const snap = () => ({
    at: NOW, open: 1, blindSeats: [], shouts: [], other: [], resolved: { items: [], hasMore: false },
    requests: [{ name: 'seat-c', workspaceId: null, ts: NOW, message: 'Edit: x', pending: 0 }],
  });
  const local = harness({ snapshot: snap, focusSeat: () => true });
  local.drawer.openDrawer();
  await flush();
  await local.list.find('request')[0].fire('click');
  assert.deepStrictEqual(local.calls.filter((c) => c[0] === 'focusSeat' || c[0] === 'revealSession'), [['focusSeat', 'seat-c']]);
  assert.ok(local.ids['inbox-drawer'].classList.contains('hidden'), 'a successful focus closes the drawer');

  const remote = harness({ snapshot: snap, reveal: { ok: false } });
  remote.drawer.openDrawer();
  await flush();
  await remote.list.find('request')[0].fire('click');
  assert.deepStrictEqual(remote.calls.filter((c) => c[0] === 'focusSeat' || c[0] === 'revealSession'),
    [['focusSeat', 'seat-c'], ['revealSession', 'seat-c']]);
  assert.ok(remote.calls.some((c) => c[0] === 'toast' && /seat-c is in workspace/.test(c[1])), 'a refused reveal toasts');
});

test('a repaint during an in-flight reply cannot send it twice, and a failure shows on the rebuilt row', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let settle;
  const h = harness({ snapshot: shoutSnap, reply: () => new Promise((r) => { settle = r; }) });
  h.drawer.openDrawer();
  await flush();
  await h.list.find('inbox-reply-toggle')[0].fire('click');
  await flush();
  const ta = h.list.find('inbox-reply-input')[0];
  ta.value = 'once';
  await ta.fire('input');
  h.list.find('inbox-reply-send')[0].fire('click');
  await flush();
  h.subs.attention();
  await flush();
  const rebuilt = h.list.find('inbox-reply-send')[0];
  assert.ok(rebuilt && rebuilt.disabled, 'ENTER: the rebuilt Send is disabled while the reply is in flight');
  await rebuilt.fire('click');
  assert.strictEqual(h.calls.filter((c) => c[0] === 'replyNotification').length, 1, 'one reply sent');
  settle({ ok: false, code: 'gone' });
  await flush();
  const status = h.list.find('inbox-reply-status')[0];
  assert.ok(status && /seat-a is no longer running/.test(status.textContent), 'the error is on the attached row');
  assert.strictEqual(h.list.find('inbox-reply-input')[0].value, 'once', 'the draft stays');
});
