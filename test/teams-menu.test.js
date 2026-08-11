'use strict';
// teams-menu.test.js — the Teams menu and its one new backend piece (t288).
//
// The feature exists because teams were unreachable: editing one was an unhinted
// right-click on a sidebar group header that only exists in the 'project'
// grouping mode, and creating one was a toggle inside the new-session dialog, so
// a team could only be born as a side effect of spawning a seat. Two properties
// carry that fix, and both are asserted here:
//
//   1. `team:createBare` writes the manifest and SPAWNS NOTHING. It is a sibling
//      of team:create precisely because that one is indivisible (write, then
//      spawn the lead). A createBare that reached the spawn path would silently
//      re-create the problem the ticket exists to remove.
//   2. The menu is NEVER absent. The Plugins menu it is modelled on returns null
//      when empty; copying that rule here would hide "Create Team…", which is
//      the ONLY route to a first team — an empty box would be a dead end.
//
// createTeam is the REAL writer on a tmpdir home, not a stub: the root-must-be-
// absolute refusal is the property under test, and a stub would assert the
// handler's own arithmetic rather than the gate that actually holds.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamManifest } = require('../team-manifest');
const { API_CONTRACT } = require('../api-contract');
const { buildTeamsMenu: buildWebTeamsMenu } = require('../renderer/web/menubar');

const ON_CHANNELS = new Set(API_CONTRACT.filter((r) => r.kind === 'on').map((r) => r.channel));

// ── Fixtures ────────────────────────────────────────────────────────────────

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-menu-'));
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  return home;
}

// Register the real ipc-handlers against capturing transport seams and a Proxy
// of inert stubs, so a handler body runs against the deps we name and nothing
// else. Same shape as team-frontdoor-seam.test.js, which this extends in spirit.
function registerWith(overrides = {}) {
  const handlers = {};
  const capture = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
  };
  const stub = () => () => {};
  const deps = new Proxy({ ...capture, ...overrides }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub();
    },
  });
  const { registerIpcHandlers } = require('../ipc-handlers');
  registerIpcHandlers(deps);
  return handlers;
}

// The manager whose create() would record a spawn. It exists so the "no spawn"
// assertion is a real observation of the spawn path, not the absence of a stub.
function fakeManager(created) {
  return {
    create: async (...args) => { created.push(args); return { name: args[0] }; },
    sessions: new Map(),
    list: () => [],
  };
}

function bareHandlers(home, created) {
  const { createTeam, listTeams, loadManifest } = createTeamManifest({ fs, clodexHome: home });
  const handlers = registerWith({
    manager: fakeManager(created),
    createTeam,
    listTeams,
    loadManifest,
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  return { handlers, loadManifest, listTeams };
}

// ── team:createBare ─────────────────────────────────────────────────────────

test('team:createBare writes the manifest and spawns NOTHING', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, loadManifest } = bareHandlers(home, created);
  assert.ok(handlers['team:createBare'], 'the channel is registered');

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop' });

  assert.strictEqual(res.ok, true);
  // The write really landed — read it back through the loader, not through the
  // handler's own return, so a handler that fabricated a team object fails here.
  const m = loadManifest('shop');
  assert.strictEqual(m.root, '/proj/shop');
  // The DECIDED default (spec §1): a bare team records a lead SEAT name with no
  // live seat behind it — the state every team is in whenever its lead is not
  // running. `<team>-lead`, and emphatically not a spawn.
  assert.strictEqual(m.lead, 'shop-lead');
  assert.deepStrictEqual(created, [], 'no seat was spawned');
});

test('team:createBare records a caller-supplied lead seat name verbatim', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, loadManifest } = bareHandlers(home, created);
  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop', lead: 'boss' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(loadManifest('shop').lead, 'boss');
  assert.deepStrictEqual(created, [], 'still no spawn');
});

test('team:createBare refuses a relative root, and writes nothing when it does', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, listTeams } = bareHandlers(home, created);

  const res = await handlers['team:createBare']({}, { name: 'shop', root: 'proj/shop' });

  assert.strictEqual(res.ok, false);
  // The writer's own message, surfaced verbatim — the dialog shows exactly this,
  // which is why the handler must not re-word or pre-normalize it.
  assert.match(res.error, /must be an absolute path/);
  // The refusal is REAL, not just a returned flag: a handler that resolved the
  // root against process.cwd() would return ok and leave a team on disk.
  assert.deepStrictEqual(listTeams(), [], 'no team directory was created');
});

test('team:createBare surfaces a duplicate-name refusal instead of overwriting', async () => {
  const home = mkHome();
  const created = [];
  const { handlers } = bareHandlers(home, created);
  await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop' });
  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/other' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already exists/);
});

// ── The desktop Teams menu ──────────────────────────────────────────────────

// app-menus.js requires('electron') at module scope. Load it with a stub whose
// focused window RECORDS what the menu sends, so a click is observable.
function loadAppMenus(sent) {
  const win = { webContents: { send: (ch, ...a) => sent.push([ch, ...a]) } };
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    dialog: {}, shell: {}, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../app-menus.js')];
    return require('../app-menus.js').createAppMenus;
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../app-menus.js')];
  }
}

function menusWith(getTeams, sent = []) {
  const createAppMenus = loadAppMenus(sent);
  const nothing = () => ({ list: () => [], get: () => ({}), sortedByRecent: () => [], statuses: () => [] });
  const menus = createAppMenus({
    DEFAULT_WORKSPACE_ID: 'default', LOG_FILE: '/dev/null', THEME_KEYS: [], path,
    checkForUpdate: () => {}, confirmRestartClodex: () => {}, createWindow: () => null,
    getManager: nothing, getPeerManager: () => null, getSandboxManager: () => null,
    getUpdateInfo: () => null, getUiSettings: nothing, getWorkspaces: nothing,
    getAgentLibrary: nothing, getSkillLibrary: nothing, getEnvScopes: () => null,
    getPluginHost: () => null,
    getTeams,
  });
  return { menus, sent };
}

// A team-reader over a real tmpdir home, so "broken" means what it means in
// production — a manifest loadManifest refuses — rather than a stub throwing.
function teamsOnDisk(spec) {
  const home = mkHome();
  for (const [name, body] of Object.entries(spec)) {
    fs.mkdirSync(path.join(home, 'teams', name), { recursive: true });
    if (body !== undefined) {
      fs.writeFileSync(path.join(home, 'teams', name, 'team.json'),
        typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
  const { listTeams, loadManifest } = createTeamManifest({ fs, clodexHome: home });
  return () => ({ listTeams, loadManifest });
}

test('the Teams menu is present with ZERO teams — Create Team… is the only route to the first', () => {
  const { menus } = menusWith(teamsOnDisk({}));
  const menu = menus.buildTeamsMenu();
  assert.ok(menu, 'not null, unlike the Plugins menu it is modelled on');
  assert.strictEqual(menu.label, 'Teams');
  const labels = menu.submenu.map((i) => i.label);
  assert.ok(labels.includes('Create Team…'), 'the create route is reachable on an empty box');
  assert.deepStrictEqual(
    menu.submenu.filter((i) => i.label === '(no teams)').map((i) => i.enabled),
    [false],
    'the empty state is said out loud, disabled — not an empty menu that reads as broken'
  );
});

test('the Teams menu lists a broken team disabled rather than hiding it', () => {
  const getTeams = teamsOnDisk({
    good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } },
    broken: 'not json at all',
  });
  const { menus, sent } = menusWith(getTeams);
  const menu = menus.buildTeamsMenu();

  const rows = menu.submenu.filter((i) => i.type !== 'separator');
  // ENTER: the reduction below asserts on named rows; if listTeams stopped
  // reaching either team the assertions would go vacuous, so pin both first.
  assert.deepStrictEqual(rows.map((r) => r.label),
    ['broken — not loaded', 'good', 'Create Team…'],
    'both teams reached the menu (listTeams sorts, so broken comes first)');

  const bad = rows.find((r) => r.label === 'broken — not loaded');
  assert.strictEqual(bad.enabled, false, 'no click target when the manifest is what is broken');
  assert.strictEqual(typeof bad.click, 'undefined');

  // The good row opens the EXISTING roles popover — the same surface as the
  // group-header right-click, reached by asking the renderer for it.
  rows.find((r) => r.label === 'good').click();
  assert.deepStrictEqual(sent, [['request-open-team-roles', 'good']]);
  assert.ok(ON_CHANNELS.has('request-open-team-roles'), 'and it is a real on-channel');

  rows.find((r) => r.label === 'Create Team…').click();
  assert.deepStrictEqual(sent[1], ['request-open-team-create']);
  assert.ok(ON_CHANNELS.has('request-open-team-create'), 'and so is this one');
});

test('the Teams menu survives a team reader that is not there yet', () => {
  // getTeams is lazy because the engine is assigned after createAppMenus runs.
  // A menu built in that window must still carry Create Team…, not throw.
  const { menus } = menusWith(() => null);
  const menu = menus.buildTeamsMenu();
  assert.ok(menu.submenu.some((i) => i.label === 'Create Team…'));
});

// ── The web Teams menu ──────────────────────────────────────────────────────

function webCtx(names, broken = new Set()) {
  const emits = [];
  const ctx = {
    emit: (ch, ...a) => emits.push([ch, ...a]),
    teamNames: async () => ({ ok: true, names }),
    teamGet: async (name) => (broken.has(name) ? { ok: false, error: 'bad' } : { ok: true, team: {} }),
  };
  return { ctx, emits };
}

test('the web Teams menu mirrors the desktop, including the never-null rule', async () => {
  const { ctx: emptyCtx } = webCtx([]);
  const emptyRows = await buildWebTeamsMenu(emptyCtx).items();
  assert.deepStrictEqual(emptyRows.filter((r) => !r.sep).map((r) => r.label),
    ['(no teams)', 'Create Team…'],
    'zero teams still offers the create route');

  const { ctx, emits } = webCtx(['broken', 'good'], new Set(['broken']));
  const menu = buildWebTeamsMenu(ctx);
  assert.strictEqual(menu.label, 'Teams');
  const rows = (await menu.items()).filter((r) => !r.sep);
  // ENTER: pin the whole row set before asserting on individual ones.
  assert.deepStrictEqual(rows.map((r) => r.label), ['broken — not loaded', 'good', 'Create Team…']);
  assert.strictEqual(rows[0].disabled, true);

  rows[1].run();
  rows[2].run();
  assert.deepStrictEqual(emits, [['request-open-team-roles', 'good'], ['request-open-team-create']]);
  for (const [ch] of emits) assert.ok(ON_CHANNELS.has(ch), `${ch} is a real on-channel`);
});

test('the web Teams menu re-reads on every open, so a new team is never missing', async () => {
  let names = ['one'];
  const ctx = {
    emit() {},
    teamNames: async () => ({ ok: true, names }),
    teamGet: async () => ({ ok: true, team: {} }),
  };
  const menu = buildWebTeamsMenu(ctx);
  assert.deepStrictEqual((await menu.items()).filter((r) => !r.sep).map((r) => r.label),
    ['one', 'Create Team…']);
  names = ['one', 'two'];
  assert.deepStrictEqual((await menu.items()).filter((r) => !r.sep).map((r) => r.label),
    ['one', 'two', 'Create Team…'], 'the second open sees the team created since');
});
