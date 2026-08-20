'use strict';
// menubar.test.js — the browser frontend's top menu bar (web-frontend Phase 5).
// Two guards:
//   1. structural — buildMenus() takes an injected side-effect context, so the
//      whole tree walks with no DOM. Every action a click can fire is exercised;
//      each request-*/set-theme channel it emits must be a real `on`-channel in
//      api-contract (a typo would otherwise leave a dead entry that fails only
//      when a human clicks). Restart rides the browser-only app:restart invoke;
//      navigation rides ?workspace=.
//   2. DOM mount — mount() builds the bar, tags #main, and names its nodes. This
//      catches the className/id-typo class of bug the channel-only test can't see.

const test = require('node:test');
const assert = require('node:assert');
const { API_CONTRACT } = require('../api-contract');
const { buildMenus, buildPluginsMenu, mount, THEMES } = require('../renderer/web/menubar');

const ON_CHANNELS = new Set(API_CONTRACT.filter((r) => r.kind === 'on').map((r) => r.channel));

// A recording context: capture every emit / invoke / nav / newWorkspace the menu
// actions fire, and feed the async library/workspace/peer builders stub data so
// the dynamic rows exist.
function recordingCtx() {
  const rec = { emits: [], invokes: [], navs: [], newWorkspaces: 0 };
  const api = {
    listAgents: async () => [{ name: 'agent-one', description: 'first' }],
    listSkillLib: async () => [{ name: 'skill-one', description: 'a skill' }],
    listWorkspaces: async () => [{ id: 'w1', name: 'Alpha' }, { id: 'w2', name: 'Beta' }],
    currentWorkspace: async () => 'w1',
    peerList: async () => [
      { id: 'p1', label: 'Peer One', online: true, sessions: [{ name: 'psess' }] },
      { id: 'p2', label: 'Peer Two', online: false },
    ],
  };
  const ctx = {
    emit: (ch, ...a) => rec.emits.push([ch, ...a]),
    invoke: (ch, args) => { rec.invokes.push([ch, args]); return Promise.resolve({ ok: true }); },
    nav: (id) => rec.navs.push(id),
    newWorkspace: () => { rec.newWorkspaces++; },
    api,
    getTheme: () => 'claude',
  };
  return { ctx, rec };
}

// Walk a rows array: fire every action's run(), and descend one level into
// submenus (fire their runs too).
async function walkRows(rows) {
  for (const row of rows) {
    if (row.run) row.run();
    if (row.submenu) { const sub = await Promise.resolve(row.submenu()); await walkRows(sub); }
  }
}

test('menu tree mirrors the Electron app menu: File / Agents / Skills / View / Teams / Window', () => {
  const { ctx } = recordingCtx();
  const menus = buildMenus(ctx);
  assert.deepEqual(menus.map((m) => m.label), ['File', 'Agents', 'Skills', 'View', 'Teams', 'Window']);
});

test('every menu action targets a real channel (request-*/set-theme are on-channels)', async () => {
  const { ctx, rec } = recordingCtx();
  for (const menu of buildMenus(ctx)) await walkRows(await Promise.resolve(menu.items()));

  assert.ok(rec.emits.length >= 12, 'the bar offers a meaningful set of actions');
  for (const [channel, ...args] of rec.emits) {
    assert.ok(ON_CHANNELS.has(channel), `menu channel "${channel}" is a subscribed on-channel`);
    assert.ok(channel.startsWith('request-') || channel === 'set-theme', `"${channel}" is a request-*/set-theme event`);
    void args;
  }

  // Pin the core mappings so a rename can't silently drift them.
  const chans = rec.emits.map((e) => e[0]);
  for (const c of ['request-open-new-dialog', 'request-open-prompts-drawer', 'request-open-agents-drawer',
    'request-open-skills-drawer', 'request-open-ipc-log', 'request-rename-workspace',
    'request-open-preferences', 'request-open-peers-dialog', 'request-open-peer-session']) {
    assert.ok(chans.includes(c), `File/Agents/Skills/Window emits ${c}`);
  }
});

test('New Session… carries the Alt+T accelerator hint (its real browser Alt chord)', async () => {
  const { ctx } = recordingCtx();
  const file = buildMenus(ctx).find((m) => m.label === 'File');
  const rows = await Promise.resolve(file.items());
  const newSession = rows.find((r) => r.label === 'New Session…');
  // Platform-cosmetic glyph: ⌥ on a Mac, "Alt+" elsewhere. Node 21+ has a global
  // navigator, so the test sees the HOST's form — assert either, pinned to T.
  assert.match(newSession.accel, /^(⌥|Alt\+)T$/, 'New Session… advertises the Alt chord');
  // No other File row advertises an accelerator — only chords with a working
  // browser binding get a hint (New Workspace has no Alt binding).
  const labelled = rows.filter((r) => r.accel).map((r) => r.label);
  assert.deepEqual(labelled, ['New Session…'], 'only the honest accelerator is shown');
});

test('Theme submenu emits set-theme for each of the four themes', async () => {
  const { ctx, rec } = recordingCtx();
  const view = buildMenus(ctx).find((m) => m.label === 'View');
  const [themeRow] = await Promise.resolve(view.items());
  await walkRows([themeRow]);
  const themed = rec.emits.filter((e) => e[0] === 'set-theme').map((e) => e[1]);
  assert.deepEqual(themed, THEMES.map((t) => t.key), 'one set-theme per theme, in order');
});

test('Restart rides the browser-only app:restart invoke; navigation rides ?workspace=', async () => {
  const { ctx, rec } = recordingCtx();
  // window.confirm defaults to accept when absent (headless), so Restart fires.
  for (const menu of buildMenus(ctx)) await walkRows(await Promise.resolve(menu.items()));
  assert.deepEqual(rec.invokes, [['app:restart', []]], 'Restart Clodex invokes app:restart with no args');
  assert.ok(rec.newWorkspaces >= 1, 'New Workspace mints a fresh workspace');
  assert.ok(rec.navs.includes('w2'), 'a non-current workspace Open navigates to it');
  assert.ok(!rec.navs.includes('w1'), 'the current workspace offers Rename, not Open (no self-navigate)');
});

// ── DOM mount smoke: a minimal fake DOM, enough for mount() to build the bar.
function fakeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), _set: set };
}
// Parent-tracking, so insertBefore/remove are REAL — the Plugins top element is
// inserted at a position and removed again, and a no-op remove() would let a
// stale menu pass as removed.
function fakeNode(tag) {
  return {
    tag: tag || '', id: '', className: '', textContent: '', style: {}, dataset: {},
    children: [], classList: fakeClassList(), parent: null,
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      c.parent = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    },
    remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } },
    addEventListener() {}, removeEventListener() {},
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}

test('mount builds #clx-menubar under #main and tags it .has-web-menubar', () => {
  const prev = { window: global.window, document: global.document, location: global.location };
  const main = fakeNode('div'); main.id = 'main';
  const head = fakeNode('head');
  const body = fakeNode('body');
  global.document = {
    head, body,
    getElementById: (id) => (id === 'main' ? main : null),
    createElement: (t) => fakeNode(t),
    addEventListener() {}, removeEventListener() {},
  };
  global.window = { api: {} };
  global.location = { search: '?workspace=w1' };
  try {
    mount({ emit() {}, invoke() { return Promise.resolve(); } });

    assert.ok(main.classList.contains('has-web-menubar'), '#main is tagged for the top-offset');
    const bar = main.children.find((c) => c.id === 'clx-menubar');
    assert.ok(bar, 'the menu bar mounts inside #main');
    const tops = bar.children.filter((c) => c.className === 'clx-top');
    assert.deepEqual(tops.map((t) => t.textContent), ['File', 'Agents', 'Skills', 'View', 'Teams', 'Window'],
      'six themed top-level menu titles, in order');
    // A <style> is injected for the bar's look.
    assert.ok(head.children.some((c) => c.tag === 'style'), 'bar styles are injected');
  } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; }
  }
});

// ── The top-level Plugins menu (t28) ───────────────────────────────────────
// The desktop's version (app-menus.js:342) returns NULL when there is nothing to
// show, and its caller then splices nothing — an empty "Plugins" menu looks like
// a broken feature rather than an absent one. That rule is the whole reason the
// menu is trustworthy, so it is pinned from both sides here: as a pure function,
// and through mount(), where an async insert is exactly where it could rot.

const STATUS_ONE = { ok: true, plugins: [{ id: 'demo', name: 'Demo', enabled: true }], problems: [] };

test('buildPluginsMenu returns null on every "nothing to show" state', () => {
  const ctx = { emit() {}, pluginStatus: async () => null, setPluginEnabled() {} };
  assert.strictEqual(buildPluginsMenu(null, ctx), null, 'no status at all (no transport)');
  assert.strictEqual(buildPluginsMenu({ ok: false, error: 'no host' }, ctx), null, 'a refusal is not a menu');
  assert.strictEqual(buildPluginsMenu({ ok: true, plugins: [], problems: [] }, ctx), null,
    'zero plugins AND zero problems — the desktop null rule verbatim');
  assert.strictEqual(buildPluginsMenu({ ok: true }, ctx), null, 'missing arrays behave as empty');
});

test('buildPluginsMenu appears for a plugin OR for a problem alone', () => {
  const ctx = { emit() {}, pluginStatus: async () => null, setPluginEnabled() {} };
  assert.ok(buildPluginsMenu(STATUS_ONE, ctx), 'one plugin is enough');
  assert.ok(buildPluginsMenu({ ok: true, plugins: [], problems: [{ dir: 'broken' }] }, ctx),
    'a refused directory alone still earns the menu — it is the only place it is visible');
});

test('the Plugins menu toggles enablement and offers the shared dialog', async () => {
  const toggles = [];
  const emits = [];
  const status = {
    ok: true,
    plugins: [
      { id: 'demo', name: 'Demo', enabled: true },
      { id: 'off', name: 'Off One', enabled: false },
      { id: 'held', name: 'Held', enabled: true, quarantined: true, failCount: 2 },
    ],
    problems: [{ dir: 'bad-dir' }],
  };
  const ctx = {
    emit: (ch) => emits.push(ch),
    pluginStatus: async () => status,
    setPluginEnabled: (id, on) => toggles.push([id, on]),
  };
  const menu = buildPluginsMenu(status, ctx);
  assert.equal(menu.label, 'Plugins');
  const rows = await Promise.resolve(menu.items());

  // Enablement rides the ●/○ glyph this bar already uses for current-ness; the
  // bar has no checkbox row type. Quarantine is a THIRD state and goes in the
  // LABEL, for the desktop's reason: an unticked box would misreport the user's
  // choice, which the fail-safe design exists to keep separate.
  assert.match(rows[0].label, /^● Demo$/);
  assert.match(rows[1].label, /^○ Off One$/);
  assert.match(rows[2].label, /^● Held — held back after 2 failed launches$/);
  assert.equal(rows[3].label, 'bad-dir — not loaded');
  assert.equal(rows[3].disabled, true, 'no toggle: there is no id to key one by');

  rows[0].run(); rows[1].run();
  assert.deepEqual(toggles, [['demo', false], ['off', true]], 'each row toggles to the opposite state');

  const manage = rows[rows.length - 1];
  assert.equal(manage.label, 'Manage Plugins…');
  manage.run();
  assert.deepEqual(emits, ['request-open-plugins-dialog']);
  assert.ok(ON_CHANNELS.has('request-open-plugins-dialog'), 'and it is a real on-channel');
});

test('the Plugins menu re-reads status on every open, so a checkbox cannot go stale', async () => {
  let enabled = true;
  const ctx = {
    emit() {},
    pluginStatus: async () => ({ ok: true, plugins: [{ id: 'demo', name: 'Demo', enabled }], problems: [] }),
    setPluginEnabled() {},
  };
  const menu = buildPluginsMenu(STATUS_ONE, ctx);
  assert.match((await menu.items())[0].label, /^● /);
  enabled = false;
  assert.match((await menu.items())[0].label, /^○ /, 'the second open reflects the new state');
});

// mount()-level: presence is decided asynchronously and re-decided on the
// engine's plugin-state broadcast.
function mountWithPlugins(status) {
  const prev = { window: global.window, document: global.document, location: global.location };
  const main = fakeNode('div'); main.id = 'main';
  const head = fakeNode('head');
  const body = fakeNode('body');
  const listeners = [];
  global.document = {
    head, body,
    getElementById: (id) => (id === 'main' ? main : null),
    createElement: (t) => fakeNode(t),
    addEventListener() {}, removeEventListener() {},
  };
  global.window = {
    api: {
      pluginInvoke: async () => (typeof status === 'function' ? status() : status),
      pluginSetEnabled: async () => ({ ok: true }),
      onPluginEvent: (cb) => listeners.push(cb),
    },
  };
  global.location = { search: '' };
  mount({ emit() {}, invoke() { return Promise.resolve(); } });
  const bar = main.children.find((c) => c.id === 'clx-menubar');
  const labels = () => bar.children.map((c) => c.textContent);
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; } };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { bar, labels, listeners, restore, settle };
}

test('mount inserts Plugins between View and Window when there is something to show', async () => {
  const m = mountWithPlugins(STATUS_ONE);
  try {
    assert.deepEqual(m.labels(), ['File', 'Agents', 'Skills', 'View', 'Teams', 'Window'], 'not there synchronously');
    await m.settle();
    assert.deepEqual(m.labels(), ['File', 'Agents', 'Skills', 'View', 'Plugins', 'Teams', 'Window'],
      'inserted at the desktop position (app-menus.js:609), not appended at the end');
  } finally { m.restore(); }
});

test('mount inserts NO Plugins element when there is nothing to show', async () => {
  const m = mountWithPlugins({ ok: true, plugins: [], problems: [] });
  try {
    await m.settle();
    assert.deepEqual(m.labels(), ['File', 'Agents', 'Skills', 'View', 'Teams', 'Window'],
      'absent, not empty — an empty menu reads as a broken feature');
  } finally { m.restore(); }
});

test('mount REMOVES the Plugins element when the last plugin goes', async () => {
  // The half an insert-only implementation would get wrong: a re-scan that drops
  // the last plugin must take the top-level label with it, or the bar advertises
  // a feature that is no longer there.
  let status = STATUS_ONE;
  const m = mountWithPlugins(() => status);
  try {
    await m.settle();
    assert.ok(m.labels().includes('Plugins'));
    status = { ok: true, plugins: [], problems: [] };
    assert.equal(m.listeners.length, 1, 'mount subscribes to the plugin-state broadcast');
    m.listeners[0]('_host', 'plugin-state', { id: 'demo', enabled: false });
    await m.settle();
    assert.deepEqual(m.labels(), ['File', 'Agents', 'Skills', 'View', 'Teams', 'Window'], 'gone again');
  } finally { m.restore(); }
});

test('File keeps its Plugins… item — the top-level menu is absent exactly when a fresh install needs it', async () => {
  // At zero plugins the top-level menu is absent BY DESIGN, and that is the state
  // a fresh install is in. Dropping the File item would leave no route to the
  // dialog whose "Open/Show Plugins Folder" button is how you install your first
  // plugin.
  const { ctx } = recordingCtx();
  const file = buildMenus(ctx).find((m) => m.label === 'File');
  const rows = await Promise.resolve(file.items());
  assert.ok(rows.some((r) => r.label === 'Plugins…'), 'the always-available route survives');
});

// ── t445: a workspace switch must not disarm the loopback gate ───────────────

test('t445: navQuery carries via=tunnel and wirescope across a workspace switch', () => {
  const { navQuery } = require('../renderer/web/menubar');
  const prev = global.location;
  try {
    global.location = { search: '?workspace=w1&token=sekret&wirescope=45501&via=tunnel' };
    const p = new URLSearchParams(navQuery('w2'));
    assert.equal(p.get('workspace'), 'w2', 'the switch takes effect');
    // The two params whose loss is silent and lasting: the shim reads both at
    // module-eval, so a switch that drops them disarms the t445 gate and t443's
    // forward for the rest of the tab's life.
    assert.equal(p.get('via'), 'tunnel', 'the tunnel mark survives — else every box link opens locally again');
    assert.equal(p.get('wirescope'), '45501', 'and so does the forwarded port');
    assert.equal(p.get('token'), 'sekret', 'the token still rides too');
  } finally { global.location = prev; }
});

test('t445: navQuery on an ordinary local tab adds nothing it was not given', () => {
  const { navQuery } = require('../renderer/web/menubar');
  const prev = global.location;
  try {
    global.location = { search: '?workspace=w1' };
    const p = new URLSearchParams(navQuery('w2'));
    assert.equal(p.get('workspace'), 'w2');
    assert.equal(p.get('via'), null, 'a tab on the box does not acquire a tunnel mark by navigating');
    assert.equal([...p.keys()].length, 1, 'and gains no other params');
  } finally { global.location = prev; }
});
