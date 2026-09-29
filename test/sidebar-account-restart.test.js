'use strict';
// Run: node --test test/sidebar-account-restart.test.js
//
// t812 r1 nit 1. A restart kills the PTY, `session-exit` REMOVES the sidebar row,
// and each restart path rebuilds it from a dataset snapshot taken beforehand. The
// account is not re-derived by any of those rebuilds — it rides `session:list`,
// which they do not read — so a path that fails to snapshot it drops the chip on
// every restart until the next meta refresh happens to repaint it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

function loadHelper(row) {
  const start = rendererSrc.indexOf('function accountOfRow(');
  assert.ok(start >= 0, 'ENTER: accountOfRow was not found in the shipped renderer');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 2);
  const env = {
    sessionList: { querySelector: () => row },
    CSS: { escape: (s) => s },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}; return accountOfRow;`)(...names.map((n) => env[n]));
}

test('accountOfRow reads the label a non-default row carries', () => {
  const read = loadHelper({ dataset: { account: 'sub-2' } });
  assert.strictEqual(read('seat-a'), 'sub-2');
});

test('accountOfRow answers null for a default row and for a row that is already gone', () => {
  // A default row carries no `dataset.account` at all (the builder only stamps
  // the exception), and a rebuild happening after session-exit finds no row —
  // both must come back as null, which addSessionToSidebar treats as "no chip".
  assert.strictEqual(loadHelper({ dataset: {} })('seat-a'), null);
  assert.strictEqual(loadHelper(null)('seat-a'), null);
});

test('every restart path snapshots the account and passes it to the rebuild', () => {
  const fn = (name) => {
    const start = rendererSrc.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `ENTER: ${name} was not found in the shipped renderer`);
    return rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 2);
  };
  const added = [];
  const env = {
    streamSeatNames: new Set(), sidebarMeta: new Map(),
    markSeatIo() {}, createTerminal() {}, markSeatEffort() {}, markSeatPosture() {},
    addSessionToSidebar: (...a) => added.push(a),
  };
  const names = Object.keys(env);
  const { rowSnapshot, rebuildLiveRow } = new Function(...names,
    `${fn('rowSnapshot')}\n${fn('rebuildLiveRow')}\nreturn { rowSnapshot, rebuildLiveRow };`)(...names.map((n) => env[n]));
  const row = { dataset: { type: 'claude', cwd: '/w', account: 'sub-2' }, querySelector: () => null };
  rebuildLiveRow('s', rowSnapshot('s', row), {});
  rebuildLiveRow('s', rowSnapshot('s', { dataset: { type: 'claude', cwd: '/w' }, querySelector: () => null }), {});
  assert.deepStrictEqual(added.map((a) => a[7]), ['sub-2', null]);

  const rebuildSites = [...rendererSrc.matchAll(/\brebuildLiveRow\(/g)].length - 1;
  assert.strictEqual(rebuildSites, 9, 'every live-row rebuild goes through rebuildLiveRow');

  assert.match(rendererSrc, /const snapAccount = env === undefined\s*\n\s*\? accountOfRow\(name\)\s*\n\s*: accountFromEnv\(/,
    'the args-save path recomputes from the env it is saving, falling back to the row for a peer save');
  assert.match(rendererSrc, /rebuildLiveRow\(name, \{ \.\.\.snap, account: snapAccount,/, 'the args-save rebuild carries the recomputed account');
});

function fakeChecklistDom() {
  const els = new Map();
  const mk = () => {
    const handlers = new Map();
    const classes = new Set();
    return {
      dataset: {}, style: {}, children: [], checked: false,
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
      addEventListener: (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); },
      fire: async (t) => { for (const fn of handlers.get(t) || []) await fn({}); },
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => false,
    };
  };
  const get = (id) => { if (!els.has(id)) els.set(id, mk()); return els.get(id); };
  return { els, get, doc: { getElementById: get, createElement: mk, addEventListener() {}, querySelector: () => null } };
}

test('a checklist-popover restart rebuilds the row with its label, effort and account', async () => {
  const { initChecklistPopovers } = require('../renderer/popovers/checklist-popovers');
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'popovers', 'checklist-popovers.js'), 'utf8');
  assert.doesNotMatch(src, /\baddSessionToSidebar\(/, 'a restart site still rebuilds the row from bare dataset fields');
  assert.strictEqual([...src.matchAll(/\brebuildLiveRow\(/g)].length, 5, 'every checklist restart rebuilds through rebuildLiveRow');

  const fn = (name) => {
    const start = rendererSrc.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `ENTER: ${name} was not found in the shipped renderer`);
    return rendererSrc.slice(start, rendererSrc.indexOf('\n}\n', start) + 2);
  };
  const added = [];
  const efforts = [];
  const env = {
    streamSeatNames: new Set(), sidebarMeta: new Map(),
    markSeatIo() {}, createTerminal() {}, markSeatPosture() {},
    markSeatEffort: (n, e) => efforts.push(e),
    addSessionToSidebar: (...a) => added.push(a),
  };
  const names = Object.keys(env);
  const { rowSnapshot, rebuildLiveRow } = new Function(...names,
    `${fn('rowSnapshot')}\n${fn('rebuildLiveRow')}\nreturn { rowSnapshot, rebuildLiveRow };`)(...names.map((n) => env[n]));

  let row = {
    dataset: { type: 'claude', cwd: '/w', account: 'sub-2', effort: 'high' },
    querySelector: (sel) => (sel === '.session-name' ? { textContent: 'Renamed' } : null),
  };
  const switched = [];
  const dom = fakeChecklistDom();
  const prev = { document: global.document, window: global.window, CSS: global.CSS, alert: global.alert };
  global.document = dom.doc;
  global.CSS = { escape: (s) => s };
  global.alert = (m) => { throw new Error(m); };
  global.window = { innerWidth: 1200, innerHeight: 800, api: {
    setSessionTools: async () => ({ ok: true }),
    restartSession: async () => { row = null; return { ok: true, io: 'pty', backend: null }; },
  } };
  try {
    initChecklistPopovers({
      sessionList: { querySelector: () => row },
      rowSnapshot, rebuildLiveRow,
      switchSession: (n) => switched.push(n),
      refreshSidebarMeta() {},
    });
    dom.get('tools-popover').dataset.name = 's';
    dom.get('tools-popover-restart').checked = true;
    await dom.get('tools-popover-apply').fire('click');
  } finally { Object.assign(global, prev); }

  assert.strictEqual(added.length, 1, 'ENTER: the restart rebuilt the row');
  const [name, type, cwd, label, , , , account] = added[0];
  assert.deepStrictEqual({ name, type, cwd, label, account }, { name: 's', type: 'claude', cwd: '/w', label: 'Renamed', account: 'sub-2' });
  assert.deepStrictEqual(efforts, ['high']);
  assert.deepStrictEqual(switched, ['s']);
});
