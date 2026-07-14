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
const { buildMenus, mount, THEMES } = require('../renderer/web/menubar');

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

test('menu tree mirrors the Electron app menu: File / Agents / Skills / View / Window', () => {
  const { ctx } = recordingCtx();
  const menus = buildMenus(ctx);
  assert.deepEqual(menus.map((m) => m.label), ['File', 'Agents', 'Skills', 'View', 'Window']);
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
function fakeNode(tag) {
  return {
    tag: tag || '', id: '', className: '', textContent: '', style: {}, dataset: {},
    children: [], classList: fakeClassList(),
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
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
    assert.deepEqual(tops.map((t) => t.textContent), ['File', 'Agents', 'Skills', 'View', 'Window'],
      'five themed top-level menu titles, in order');
    // A <style> is injected for the bar's look.
    assert.ok(head.children.some((c) => c.tag === 'style'), 'bar styles are injected');
  } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete global[k]; else global[k] = prev[k]; }
  }
});
