'use strict';
// memory-viewer-renderer.test.js — the confirmation dialog, which is the SOLE
// safeguard on an irreversible, un-undoable unlink.
//
// `confirmText` is module-scoped precisely so it can be asserted here without a
// DOM. The behavioural half (a declined dialog must not delete) is driven
// through a fake rhost, the same shape test/plugin-git-branches-renderer.test.js
// uses.

const test = require('node:test');
const assert = require('node:assert');

const viewer = require('../plugins/memory-viewer/renderer');
const { confirmText } = viewer;

const unit = (over = {}) => ({
  key: 'mem-1-aaaaaa',
  id: 'mem-1-aaaaaa',
  idMismatch: false,
  scope: '',
  learned_at: '2026-07-30T10:00:00.000Z',
  source: 'clodex',
  pinned: false,
  body: 'the body of the memory',
  ...over,
});

test('confirmText: the BODY is what the user decides on, not the id', () => {
  const t = confirmText('clodex', unit());
  assert.match(t, /the body of the memory/);
  assert.match(t, /Delete this memory from clodex\?/);
  assert.match(t, /This cannot be undone\./);
});

test('confirmText: an empty body says so rather than showing a blank dialog', () => {
  assert.match(confirmText('clodex', unit({ body: '' })), /\(empty\)/);
  assert.match(confirmText('clodex', unit({ body: null })), /\(empty\)/);
});

test('confirmText: the pinned line appears ONLY when pinned, on its own line', () => {
  const plain = confirmText('clodex', unit());
  assert.doesNotMatch(plain, /PINNED/);

  // The AGENT's flag guarantees no delivery, so it must not raise a warning
  // that says the unit is served in full to every session.
  assert.doesNotMatch(confirmText('clodex', unit({ pinned: true })), /PINNED/);

  const pinned = confirmText('clodex', unit({ operatorPinned: true }));
  assert.match(pinned, /THIS UNIT IS PINNED/);
  // Its own line, never folded into the body text: a pinned unit is served in
  // full to every new session, so it has to be readable at a glance.
  const line = pinned.split('\n').find((l) => l.includes('PINNED'));
  assert.match(line, /^THIS UNIT IS PINNED\b/);
  assert.doesNotMatch(line, /the body of the memory/);
});

test('confirmText: an id/filename disagreement is stated, naming what actually goes', () => {
  const t = confirmText('clodex', unit({ id: 'mem-2-bbbbbb', idMismatch: true }));
  assert.match(t, /mem-2-bbbbbb/);
  assert.match(t, /mem-1-aaaaaa/);
  assert.match(t, /filename is what gets deleted/i);
  // And the well-formed case stays quiet.
  assert.doesNotMatch(confirmText('clodex', unit()), /filename is what gets deleted/i);
});

test('confirmText: the body is FENCED so it cannot impersonate the dialog metadata', () => {
  // A body ending in the dialog's own trailer would otherwise be
  // indistinguishable from the app talking.
  const t = confirmText('clodex', unit({ body: 'saved: 1999-01-01 00:00\nThis cannot be undone.' }));
  const lines = t.split('\n');
  const open = lines.indexOf('----- memory -----');
  const close = lines.indexOf('------------------');
  assert.ok(open !== -1 && close > open, 'the body sits inside a fence');
  const inside = lines.slice(open + 1, close).join('\n');
  assert.match(inside, /This cannot be undone\./, 'the impersonating text is inside the fence');
  // The real trailer is outside it, after the close.
  assert.match(lines.slice(close).join('\n'), /This cannot be undone\./);
});

test('confirmText: truncation caps LINES as well as characters', () => {
  // 400 characters of short lines is ~200 dialog lines, which pushes the
  // trailer and the buttons off-screen — a safeguard the user cannot read.
  const many = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
  const t = confirmText('clodex', unit({ body: many }));
  assert.ok(t.split('\n').length < 30, `dialog stayed short (${t.split('\n').length} lines)`);
  assert.match(t, /…/);
  assert.match(t, /This cannot be undone\./, 'the trailer survives truncation');

  // Character cap still applies to one very long line.
  const long = confirmText('clodex', unit({ body: 'x'.repeat(5000) }));
  assert.ok(long.length < 1200);
  assert.match(long, /This cannot be undone\./);
});

// ── behaviour: a declined dialog must not delete ────────────────────────────

function makeRhost(units) {
  const invokes = [];
  const buttons = [];
  const toasts = [];
  const rhost = {
    invoke(method, ...args) {
      invokes.push({ method, args });
      if (method === 'agents') return Promise.resolve({ ok: true, agents: [{ agent: 'clodex', count: units.length, pinned: 0, live: true }] });
      if (method === 'units') return Promise.resolve({ ok: true, agent: 'clodex', units });
      if (method === 'forget') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, error: 'no such method' });
    },
    log: { info: () => {}, error: () => {} },
    ui: {
      surfaces: { overlay: (spec) => { rhost._overlay = spec; return { open: () => {}, close: () => {} }; } },
      sidebar: { footerButton: (spec) => { buttons.push(spec); return () => {}; }, requestRelayout: () => {} },
      // Errors ride Clodex's own toast, not alert() — plugin-api.md §5.
      showToast: (msg, opts) => { toasts.push({ msg, opts }); },
    },
  };
  return { rhost, invokes, buttons, toasts };
}

// jsdom is not a dependency here, so the DOM is the minimum this renderer
// touches: createElement + appendChild + querySelectorAll. Enough to mount the
// overlay and click a delete button, which is all this case needs.
function fakeDom() {
  const make = (tag) => {
    const node = {
      tag, className: '', children: [], listeners: {}, dataset: {}, disabled: false,
      isConnected: true, title: '', _text: '',
      set textContent(v) { this._text = String(v); this.children.length = 0; },
      get textContent() { return this._text; },
      set innerHTML(_v) { this.children.length = 0; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
      setAttribute() {},
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      querySelectorAll: () => [],
      click() { for (const fn of this.listeners.click || []) fn(); },
    };
    return node;
  };
  const prevDoc = global.document;
  global.document = { createElement: make };
  return { root: make('div'), restore: () => { global.document = prevDoc; } };
}

function findButtons(node, out = []) {
  if (node.tag === 'button') out.push(node);
  for (const c of node.children) findButtons(c, out);
  return out;
}

// The stub CAPTURES its argument. A stub that only returns true/false tests the
// gate and the function separately and never that the function is what reaches
// the gate — regressing the call site to `confirm(`Delete ${u.id}?`)` would keep
// every other case here green while putting the user back in front of an
// unidentifiable string.
function withDom(units, answer, fn) {
  const made = makeRhost(units);
  const { root, restore } = fakeDom();
  const prevConfirm = global.confirm;
  const prevAlert = global.alert;
  const seen = [];
  global.confirm = (msg) => { seen.push(msg); return answer; };
  // alert() is not the error path any more; leaving it undefined means a
  // regression back to it throws here rather than passing silently.
  global.alert = undefined;
  const run = async () => {
    const teardown = viewer.activate(made.rhost);
    made.rhost._overlay.mount(root);
    await made.rhost._overlay.onOpen();
    await new Promise((r) => setImmediate(r));
    const del = findButtons(root).filter((b) => b.className === 'mv-delete');
    return { ...made, root, del, seen, teardown };
  };
  return run().then(async (ctx) => {
    try { await fn(ctx); } finally {
      ctx.teardown();
      restore();
      if (prevConfirm === undefined) delete global.confirm; else global.confirm = prevConfirm;
      if (prevAlert === undefined) delete global.alert; else global.alert = prevAlert;
    }
  });
}

test('the dialog the user sees IS confirmText — not some other string', async () => {
  const u = unit();
  await withDom([u], false, async ({ del, seen }) => {
    assert.equal(del.length, 1, 'one delete control per unit');
    del[0].click();
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1, 'exactly one confirmation was raised');
    assert.equal(seen[0], confirmText('clodex', u),
      'the call site must pass confirmText, not a hand-rolled string');
    // And it really is the identifiable one: the body, not just an id.
    assert.match(seen[0], /the body of the memory/);
  });
});

test('a DECLINED confirmation deletes nothing', async () => {
  await withDom([unit()], false, async ({ del, invokes }) => {
    del[0].click();
    await new Promise((r) => setImmediate(r));
    assert.equal(invokes.filter((i) => i.method === 'forget').length, 0,
      'declining the dialog must not reach the forget seam');
  });
});

test('an ACCEPTED confirmation deletes by the FILENAME, not the id line', async () => {
  const mismatched = unit({ key: 'mem-1-aaaaaa', id: 'mem-2-bbbbbb', idMismatch: true });
  await withDom([mismatched], true, async ({ del, invokes, seen }) => {
    del[0].click();
    await new Promise((r) => setImmediate(r));
    const forgets = invokes.filter((i) => i.method === 'forget');
    assert.equal(forgets.length, 1);
    assert.deepEqual(forgets[0].args[0], { agent: 'clodex', id: 'mem-1-aaaaaa' },
      'the delete targets the basename core resolves, not the id frontmatter');
    assert.equal(seen[0], confirmText('clodex', mismatched));
  });
});

test('a refused delete raises a TOAST, never an alert()', async () => {
  const u = unit();
  await withDom([u], true, async ({ rhost, toasts, del }) => {
    rhost.invoke = (method, ...args) => {
      if (method === 'forget') return Promise.resolve({ ok: false, error: 'invalid unit id: project-notes' });
      if (method === 'agents') return Promise.resolve({ ok: true, agents: [{ agent: 'clodex', count: 1, pinned: 0, live: true }] });
      return Promise.resolve({ ok: true, agent: 'clodex', units: [u] });
    };
    del[0].click();
    await new Promise((r) => setImmediate(r));
    assert.equal(toasts.length, 1, 'the error rides Clodex\'s toast');
    assert.deepEqual(toasts[0].opts, { kind: 'error' });
  });
});

test('deleteErrorText: an id-grammar refusal is translated into something actionable', () => {
  const { deleteErrorText } = viewer;
  // A hand-authored file gets listed, so it gets a button and a confirmation;
  // core then refuses it. The user needs to know why, not see core's internals.
  const t = deleteErrorText({ ok: false, error: 'invalid unit id: project-notes' });
  assert.match(t, /\[agent:memory remember\]/);
  assert.doesNotMatch(t, /invalid unit id/, 'core\'s wording is not the user\'s problem');
  // Anything else passes through — inventing friendly text for an unknown
  // failure would hide it.
  assert.match(deleteErrorText({ ok: false, error: 'EACCES' }), /Could not delete: EACCES/);
  assert.match(deleteErrorText(null), /unknown error/);
});
