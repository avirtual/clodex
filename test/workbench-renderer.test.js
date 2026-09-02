'use strict';
// workbench-renderer.test.js — the workbench's RENDERER half, driven through a
// fake rhost and a fake DOM.
//
// Written for a regression Bogdan found by RUNNING the headless workbench: in
// v5.4.0 the Files tree painted; in v5.5.1 the overlay opened but showed no file
// structure, and nothing in it could be clicked — buttons still lit on hover
// (CSS) while every click did nothing. It read like an invisible div on top. It
// was not: `wire()` threw a third of the way in, so the ~28 listeners below the
// throw were never attached and the tree was never painted. A half-wired overlay
// is indistinguishable from an overlaid one by eye, which is why this is pinned
// behaviourally rather than by looking at the source.
//
// The mechanism: 6123c89 removed the two browse controls on the web frontend,
// but `$` queries the LIVE tree, so the later `$('wb-files-goto')` re-query
// returned null and `null.addEventListener` threw. Desktop never hit it — the
// removal branch is web-only — so the suite and every desktop run stayed green.
//
// The old source-regex test asserted `$('wb-files-goto').remove();` verbatim,
// i.e. it pinned the defect: the fix could not land without failing it. Replaced
// here by "mount() completes under the web flag", which the removal shape cannot
// satisfy by accident.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'workbench', 'renderer.js');

// ── A fake DOM, sized to what wire() touches ────────────────────────────────
// Elements are minted lazily per id and cached, so any id the renderer asks for
// exists. The ONE behaviour modelled faithfully is the one under test:
// `remove()` detaches the node, and a later query for that id returns null —
// exactly as a real querySelector does. Everything else is a permissive sink.
function makeDom() {
  const byId = new Map();
  const removed = new Set();
  const listeners = [];

  const makeEl = (id) => {
    const el = {
      id,
      isConnected: true,
      disabled: false,
      value: '',
      textContent: '',
      innerHTML: '',
      title: '',
      style: {},
      dataset: {},
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; },
      },
      addEventListener(type) { listeners.push({ id, type }); },
      removeEventListener() {},
      appendChild() {},
      querySelectorAll() { return []; },
      querySelector() { return makeEl(`${id}-child`); },
      closest() { return null; },
      focus() {}, blur() {}, scrollIntoView() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      remove() { el.isConnected = false; removed.add(id); byId.delete(id); },
    };
    return el;
  };

  const resolve = (sel) => {
    if (typeof sel !== 'string' || !sel.startsWith('#')) return makeEl(sel);
    const id = sel.slice(1);
    if (removed.has(id)) return null;      // the real DOM's answer after remove()
    if (!byId.has(id)) byId.set(id, makeEl(id));
    return byId.get(id);
  };

  const rootEl = {
    innerHTML: '',
    querySelector: resolve,
    querySelectorAll() { return []; },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };

  return { rootEl, listeners, removed, resolve };
}

// ── A fake rhost ────────────────────────────────────────────────────────────
// `mount` is captured rather than called: the host calls it at first open, and
// the test drives that moment itself.
function makeRhost({ answers = {}, sessions = [] } = {}) {
  const state = { mount: null, onOpen: null, toasts: [], invokes: [] };
  const rhost = {
    workspaceId: 'default',
    setTimeout(fn) { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    invoke(method, ...args) {
      state.invokes.push({ method, args });
      const canned = answers[method];
      return Promise.resolve(
        typeof canned === 'function' ? canned(...args) : (canned || { ok: true }));
    },
    log: { info() {}, error() {}, warn() {} },
    sessions: {
      active: () => null,
      listWorkspace: () => Promise.resolve(sessions),
      onChange: () => () => {},
availability: () => ({}),
    },
    ui: {
      showToast(msg) { state.toasts.push(msg); },
      pickDirectory: () => Promise.resolve(null),
      confirm: () => true,
      surfaces: {
        overlay(spec) {
          state.mount = spec.mount;
          state.onOpen = spec.onOpen;
          return { open() {}, close() {}, isOpen: () => false };
        },
      },
      commands: { register: () => () => {} },
      sidebar: { rowBadge: () => () => {}, requestRelayout() {}, footerButton: () => () => {} },
      settings: { section: () => () => {} },
      statusBar: { item: () => () => {} },
    },
    on: () => () => {},
    onDispose: () => {},
  };
  return { rhost, state };
}

// Mount the plugin with `window.__CLODEX_WEB__` set to `web`, and report whether
// wire() ran to completion. Globals are set for the duration and restored, so
// this cannot leak into another test file sharing the process.
function installGlobals({ web, dom, created }) {
  global.window = { __CLODEX_WEB__: web, addEventListener() {}, removeEventListener() {} };
  global.document = {
    createElement: () => {
      const el = {
        style: {}, dataset: {}, classList: { add() {}, remove() {} },
        appendChild() {}, addEventListener() {}, textContent: '', innerHTML: '', value: '',
      };
      created.push(el);
      return el;
    },
    addEventListener() {}, removeEventListener() {},
    querySelector: dom.resolve, getElementById: (id) => dom.resolve(`#${id}`),
  };
}

function mountWorkbench({ web }) {
  const savedWindow = global.window;
  const savedDocument = global.document;
  const dom = makeDom();
  const { rhost, state } = makeRhost();

  installGlobals({ web, dom, created: [] });

  try {
    delete require.cache[require.resolve(PLUGIN)];
    require(PLUGIN).activate(rhost);
    assert.ok(state.mount, 'ENTER: the plugin registered an overlay surface with a mount');
    let error = null;
    try { state.mount(dom.rootEl); } catch (e) { error = e; }
    return { error, dom, state };
  } finally {
    global.window = savedWindow;
    global.document = savedDocument;
  }
}

// Mount AND drive the host's open on the Files tab, against a canned `fs.list`.
// The globals must stay installed across the open (it creates the tree rows), so
// unlike mountWorkbench this cannot restore them before returning.
async function openFilesTab(entries) {
  const savedWindow = global.window;
  const savedDocument = global.document;
  const dom = makeDom();
  const created = [];
  const { rhost, state } = makeRhost({
    sessions: [{ name: 'seat', cwd: '/tmp/seat' }],
    answers: {
      'fs.list': (name, rel) => ({ ok: true, dir: rel, entries: rel === '' ? entries : [] }),
      'wt.selected': { ok: true, selected: null },
    },
  });

  installGlobals({ web: false, dom, created });
  try {
    delete require.cache[require.resolve(PLUGIN)];
    require(PLUGIN).activate(rhost);
    state.mount(dom.rootEl);
    await state.onOpen({ tab: 'files' });
    // setTab -> refreshTab -> renderExplorer is fired, not awaited; drain the
    // microtask chain behind its two fs.list round trips.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  } finally {
    global.window = savedWindow;
    global.document = savedDocument;
  }
  const rows = created.filter((el) => String(el.className || '').includes('explorer-row'));
  return { rows, state };
}

test('the overlay wires completely on the WEB frontend', () => {
  // The regression: mount() threw here, so most of the overlay was never wired
  // and the Files tree never painted. The user-visible symptom was "nothing is
  // clickable", which is what an unwired overlay looks like.
  const { error } = mountWorkbench({ web: true });
  assert.equal(error, null,
    `mount() threw on the web frontend, leaving the overlay half-wired: ${error && error.stack}`);
});

test('the overlay wires completely on the DESKTOP frontend', () => {
  // The control arm. Desktop never took the removal branch, which is precisely
  // why the suite stayed green through the regression — so this passing is not
  // evidence about the web path, and is here to show the harness itself is not
  // what makes the test above pass.
  const { error } = mountWorkbench({ web: false });
  assert.equal(error, null, `mount() threw on desktop: ${error && error.stack}`);
});

test('wiring reaches the END of wire(), not merely past the browse controls', () => {
  // ENTER: "did not throw" is also true of a mount that silently returned early,
  // so the absence assertion above needs a positive witness that the far end of
  // wire() ran. `workbench-close` is the LAST listener attached (the close X),
  // and the throw sat roughly a third of the way in — so a listener on it means
  // everything between was reached too.
  //
  // Asserted on BOTH surfaces: the point is that the web build wires the same
  // set as desktop, minus the two controls it deliberately drops.
  for (const web of [true, false]) {
    const { listeners } = mountWorkbench({ web }).dom;
    const ids = new Set(listeners.map((l) => l.id));
    assert.ok(ids.has('workbench-close'),
      `${web ? 'web' : 'desktop'}: the close button was never wired — wire() did not reach its end`);
    assert.ok(ids.has('wb-files-refresh'),
      `${web ? 'web' : 'desktop'}: Refresh was never wired`);
    assert.ok(ids.has('wb-worktree-add'),
      `${web ? 'web' : 'desktop'}: Create Worktree was never wired`);
  }
});

test('the browse controls are REMOVED on web and PRESENT on desktop', () => {
  // The original intent of 6123c89, kept: fs.setRoot is desktop-only by the
  // surface gate, so on the web every Up / Go to Folder click would end in a
  // "Can't use that folder" toast. Removal, not `disabled` — a disabled control
  // still advertises a capability this surface does not have.
  //
  // Pinned by DOM outcome rather than by the source expression that performs it.
  // The previous version of this test matched `$('wb-files-goto').remove();`
  // verbatim, which made the null re-query below it un-fixable without failing
  // the test.
  const web = mountWorkbench({ web: true });
  assert.ok(web.dom.removed.has('wb-files-up'), 'Up is removed on the web surface');
  assert.ok(web.dom.removed.has('wb-files-goto'), 'Go to Folder is removed on the web surface');

  const desktop = mountWorkbench({ web: false });
  assert.equal(desktop.dom.removed.size, 0,
    'desktop removes neither control');
});

test('the web build still attaches the browse listeners, to the DETACHED nodes', () => {
  // Not a leak and not an accident: capturing both handles BEFORE the removal is
  // what keeps the later wiring from re-querying a null. A listener on a
  // detached node can never fire, so wiring it is inert — and it is what lets
  // the two code paths stay identical below the branch instead of forking.
  const { dom } = mountWorkbench({ web: true });
  const ids = new Set(dom.listeners.map((l) => l.id));
  assert.ok(ids.has('wb-files-goto'),
    'ENTER: the goto listener is still attached (to the detached node) on web');
});

// ── File-row meta: size, and the null-vs-zero distinction ───────────────────
const MTIME = Date.UTC(2026, 0, 2, 3, 4, 5);

test('a file row draws its size; a directory row draws no meta at all', async () => {
  const { rows } = await openFilesTab([
    { name: 'sub', rel: 'sub', type: 'dir', size: null, mtime: null },
    { name: 'big.bin', rel: 'big.bin', type: 'file', size: 2048, mtime: MTIME },
  ]);
  assert.equal(rows.length, 2, 'ENTER: both the dir and the file rows were painted');

  const [dir, file] = rows;
  assert.match(file.innerHTML, /<span class="explorer-meta">2\.0 KB<\/span>/,
    `the file row should carry its size: ${file.innerHTML}`);
  assert.doesNotMatch(dir.innerHTML, /explorer-meta/,
    `a directory's size is not the size of what it holds: ${dir.innerHTML}`);
});

test('a FAILED stat renders nothing, a genuinely EMPTY file renders 0 B', async () => {
  // The whole point of the feature: `size === null` means "could not tell", and
  // showing 0 B for it would assert a fact about the file that nobody measured.
  const { rows } = await openFilesTab([
    { name: 'dangling.txt', rel: 'dangling.txt', type: 'file', size: null, mtime: null },
    { name: 'empty.log', rel: 'empty.log', type: 'file', size: 0, mtime: MTIME },
  ]);
  assert.equal(rows.length, 2, 'ENTER: both the unreadable and the empty file were painted');

  const [failed, empty] = rows;
  assert.doesNotMatch(failed.innerHTML, /explorer-meta/,
    `an unreadable file must show no size at all: ${failed.innerHTML}`);
  assert.match(empty.innerHTML, /<span class="explorer-meta">0 B<\/span>/,
    `an empty file legitimately shows 0 B: ${empty.innerHTML}`);
});

test('the modified date rides the row tooltip, and a null mtime leaves the name alone', async () => {
  const { rows } = await openFilesTab([
    { name: 'dated.txt', rel: 'dated.txt', type: 'file', size: 10, mtime: MTIME },
    { name: 'undated.txt', rel: 'undated.txt', type: 'file', size: null, mtime: null },
  ]);
  assert.equal(rows.length, 2, 'ENTER: both the dated and the undated file were painted');

  const [dated, undated] = rows;
  // Local time, so pin the shape and the components rather than a fixed string:
  // a literal would encode the machine's zone and fail elsewhere.
  const d = new Date(MTIME);
  const pad = (x) => String(x).padStart(2, '0');
  assert.equal(dated.title,
    `dated.txt\nModified ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  assert.equal(undated.title, 'undated.txt',
    'with no readable mtime the tooltip is the bare filename, not a "Modified" line with nothing after it');
});

test('a file size never reaches innerHTML unescaped by luck — the formatter is total', async () => {
  // fmtSize/fmtWhen are interpolated into innerHTML, so a non-numeric size
  // arriving from a future payload change must yield '' rather than its own
  // string form. Each row's expected output is a literal, not a re-application
  // of the formatter's rule.
  const cases = [
    [undefined, ''],
    [NaN, ''],
    [-1, ''],
    ['12', ''],
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [1024 * 1024 * 3, '3.0 MB'],
  ];
  const { rows } = await openFilesTab(cases.map(([size], i) => (
    { name: `f${i}.txt`, rel: `f${i}.txt`, type: 'file', size, mtime: MTIME })));
  assert.equal(rows.length, cases.length, 'ENTER: every case row was painted');

  for (let i = 0; i < cases.length; i++) {
    const [, expected] = cases[i];
    const m = /<span class="explorer-meta">([^<]*)<\/span>/.exec(rows[i].innerHTML);
    assert.equal(m ? m[1] : '', expected,
      `size ${JSON.stringify(cases[i][0])} should render as ${JSON.stringify(expected)}: ${rows[i].innerHTML}`);
  }
});
