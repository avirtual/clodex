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
const { mkTmpRoot } = require('./lib/tmp-roots');

const ON_CHANNELS = new Set(API_CONTRACT.filter((r) => r.kind === 'on').map((r) => r.channel));

// ── Fixtures ────────────────────────────────────────────────────────────────

function mkHome() {
  const home = mkTmpRoot('teams-menu-');
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
function fakeManager(created, live = []) {
  return {
    create: async (...args) => { created.push(args); return { name: args[0] }; },
    // Pre-seeded names drive spawnFromParams' nameConflict throw, which is how a
    // team:create fails AFTER its manifest write.
    sessions: new Map(live.map((n) => [n, {}])),
    list: () => [],
  };
}

function bareHandlers(home, created, { live = [] } = {}) {
  const { createTeam, listTeams, loadManifest } = createTeamManifest({ fs, clodexHome: home });
  // The app menu is a rebuilt TEMPLATE with no open-time hook, so every write
  // route owes it a refresh. Recording the seam is the only way to see that: the
  // Proxy's inert stub would swallow a missing call and the test would pass.
  const refreshed = [];
  const handlers = registerWith({
    manager: fakeManager(created, live),
    createTeam,
    listTeams,
    loadManifest,
    refreshAppMenu: () => refreshed.push('refresh'),
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  return { handlers, createTeam, loadManifest, listTeams, refreshed };
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

test('a bare create REFRESHES the app menu, and a refusal does not', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, refreshed } = bareHandlers(home, created);

  // The headline flow of the whole ticket: fresh box → Create Team… → use the
  // menu. buildTeamsMenu reads listTeams() at BUILD time and the Electron menu is
  // re-set only by refreshAppMenu, so without this call the menu still says
  // "(no teams)" until some unrelated event happens to rebuild it. The web mirror
  // re-reads in items() and is therefore correct already — the two surfaces must
  // not be asymmetric in the direction that hurts.
  const ok = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop' });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(refreshed, ['refresh'], 'the new team must appear in the menu');

  const no = await handlers['team:createBare']({}, { name: 'shop2', root: 'relative' });
  assert.strictEqual(no.ok, false);
  assert.deepStrictEqual(refreshed, ['refresh'],
    'a refusal wrote nothing, so it must not rebuild the menu');
});

test('team:create refreshes the app menu too — the same staleness by a second route', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, loadManifest, refreshed } = bareHandlers(home, created);

  // Harmless before t288 because no menu listed teams; now it is a second write
  // route into the same stale menu.
  await handlers['team:create']({}, { teamName: 'shop', cwd: '/proj/shop', name: 'shop-lead' });
  assert.strictEqual(loadManifest('shop').root, '/proj/shop', 'ENTER: the write really happened');
  assert.deepStrictEqual(refreshed, ['refresh']);

  const no = await handlers['team:create']({}, { teamName: 'other', cwd: 'relative', name: 'x' });
  assert.strictEqual(no.ok, false);
  assert.deepStrictEqual(refreshed, ['refresh'], 'nothing written, nothing to refresh');
});

test('a team:create whose SPAWN fails still refreshes — the write landed', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, loadManifest, refreshed } = bareHandlers(home, created, { live: ['boss'] });

  // spawnFromParams throws on a name conflict AFTER createTeam has written the
  // manifest. The refresh therefore has to be gated on the WRITE, not on the
  // handler's return value, and it has to sit outside the try — a refresh placed
  // after the spawn never runs, and the menu is missing the team that now exists.
  const res = await handlers['team:create']({}, { teamName: 'x', cwd: '/proj/x', name: 'boss' });

  assert.strictEqual(res.ok, false, 'the operator is told the spawn failed');
  assert.match(res.error, /already exists/);
  assert.strictEqual(loadManifest('x').root, '/proj/x', 'but the team was written anyway');
  assert.deepStrictEqual(refreshed, ['refresh'], 'so the menu must show it');
});

test('a failing menu rebuild is never reported as a failed write', async () => {
  const home = mkHome();
  const created = [];
  const { createTeam, listTeams } = bareHandlers(home, created);
  // The refresh must sit OUTSIDE the try. Inside it, a throwing rebuild is caught
  // by the write's own handler and returned as {ok:false} for a team that exists —
  // and the operator's retry then bounces off "already exists". Outside, the
  // failure surfaces as itself.
  const handlers = registerWith({
    manager: fakeManager(created),
    createTeam,
    listTeams,
    loadManifest: () => { throw new Error('unused'); },
    refreshAppMenu: () => { throw new Error('menu rebuild blew up'); },
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });

  assert.throws(() => handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop' }),
    /menu rebuild blew up/, 'the rebuild failure is not swallowed into the write result');
  assert.deepStrictEqual(listTeams(), ['shop'], 'and the write it followed still stands');
});

test('a leading-dot team name is refused — it would be written and then invisible', async () => {
  const home = mkHome();
  const created = [];
  const { handlers, createTeam, listTeams } = bareHandlers(home, created);

  // NAME_RE accepts `.hidden` deliberately (t115, for SESSION names), but
  // listTeams filters dot-directories: the team would resolve for no cwd and
  // never reach the Teams menu, while the popover still opened it by path. The
  // free-text name field is what makes this reachable by typing.
  const res = await handlers['team:createBare']({}, { name: '.secret', root: '/proj/secret' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /must not start with "\."/);
  assert.match(res.error, /invisible/, 'the message names the consequence, not just the rule');
  assert.deepStrictEqual(listTeams(), [], 'and nothing was written');

  // The WRITER is the gate, not this one handler: team:create and any future
  // caller reach the same hole. A guard moved up into ipc-handlers would still
  // satisfy every assertion above.
  assert.throws(() => createTeam({ name: '.secret', root: '/proj/secret', lead: 'boss' }),
    /must not start with "\."/);
});

test('a team name too long for its DEFAULT lead is refused by naming the team name', async () => {
  const home = mkHome();
  const created = [];
  const { handlers } = bareHandlers(home, created);

  // 62 chars: a valid team name, but `${name}-lead` is 67 and overflows the
  // 64-char seat-name limit. The handler MINTS that default, so a bare
  // pass-through would refuse a `lead` field the Create Team… dialog never shows.
  const name = 'a'.repeat(62);
  const res = await handlers['team:createBare']({}, { name, root: '/proj/long' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /team name .* is too long/, 'the message names the field the operator can see');

  // An EXPLICIT lead is the caller's own value, so the limit is theirs to hear
  // about — and a short one for the same long team name still works.
  const ok = await handlers['team:createBare']({}, { name, root: '/proj/long', lead: 'boss' });
  assert.strictEqual(ok.ok, true);

  // The `!lead` half of the guard: an OVER-LONG explicit lead must reach the
  // WRITER and be refused in its words, not intercepted by the handler's
  // team-name message. Without this the `!lead` condition could be dropped and
  // every assertion above would still pass (the explicit lead there is 4 chars).
  const long = await handlers['team:createBare']({}, {
    name: 'shortname', root: '/proj/other', lead: 'b'.repeat(65),
  });
  assert.strictEqual(long.ok, false);
  assert.match(long.error, /lead must be a seat name/,
    "the writer's refusal, not the handler's — the caller named this field");
});

test('the 64-character seat limit binds at exactly the boundary, both sides', async () => {
  const home = mkHome();
  const created = [];
  const { handlers } = bareHandlers(home, created);

  // 59 + '-lead' = exactly 64: the last team name that can mint its own default
  // lead. 60 + '-lead' = 65: the first that cannot. Pinning both sides documents
  // the duplicated `64` literal as deliberate rather than a guess.
  const fits = await handlers['team:createBare']({}, { name: 'a'.repeat(59), root: '/proj/fits' });
  assert.strictEqual(fits.ok, true, 'a 64-char seat name is legal, so this must not be refused');

  const over = await handlers['team:createBare']({}, { name: 'a'.repeat(60), root: '/proj/over' });
  assert.strictEqual(over.ok, false, 'one character more and the seat name is 65');
  assert.match(over.error, /too long/);
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
  let broken = new Set();
  const ctx = {
    emit() {},
    teamNames: async () => ({ ok: true, names }),
    teamGet: async (n) => (broken.has(n) ? { ok: false, error: 'bad' } : { ok: true, team: {} }),
  };
  const menu = buildWebTeamsMenu(ctx);
  assert.deepStrictEqual((await menu.items()).filter((r) => !r.sep).map((r) => r.label),
    ['one', 'Create Team…']);

  // Flip BOTH inputs: a name added, and an existing name's manifest gone bad. A
  // per-name result cached across opens would still pass on the names alone,
  // since 'two' is new either way — the state change on 'one' is what forces a
  // genuine re-probe.
  names = ['one', 'two'];
  broken = new Set(['one']);
  assert.deepStrictEqual((await menu.items()).filter((r) => !r.sep).map((r) => r.label),
    ['one — not loaded', 'two', 'Create Team…'],
    'the second open sees the team created since AND the one that broke since');
});
