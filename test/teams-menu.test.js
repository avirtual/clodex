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

function sandboxHandlers(home, {
  mgrBoxes = ['team-shop'], noManager = false, bringUp, createMade,
} = {}) {
  const real = createTeamManifest({ fs, clodexHome: home });
  const createArgs = [];
  const createTeam = (spec) => { createArgs.push(spec); return real.createTeam(spec); };
  const boxes = new Map(mgrBoxes.map((id) => [id, { id }]));
  const mgrCalls = [];
  const mgr = {
    get: (id) => boxes.get(id) || null,
    create: (id, label) => {
      mgrCalls.push([id, label]);
      if (createMade) return createMade;
      boxes.set(id, { id });
      return { ok: true, box: { id, label } };
    },
  };
  const upCalls = [];
  const manager = {
    sessions: new Map(),
    list: () => [],
    create: async () => { throw new Error('a sandboxed create must not spawn a local seat'); },
    _bringUpTeamBox: async (team, opts) => {
      upCalls.push([team.name, { patch: opts.patch, action: opts.action, boxId: opts.boxId }]);
      return bringUp ? bringUp(team, opts) : (opts.reply('sandbox team-shop up @ abcdef12'),
        { ok: true, record: {}, webUrl: 'http://127.0.0.1:7812' });
    },
  };
  const handlers = registerWith({
    manager,
    createTeam,
    listTeams: real.listTeams,
    loadManifest: real.loadManifest,
    getSandboxManager: () => (noManager ? null : mgr),
    refreshAppMenu: () => {},
    agentDefaults: { getDefaultDeny: () => [], getStrip: () => 0 },
    persistence: { setStripLevel: () => {}, get: () => null },
    workspaceOfSender: () => 'ws1',
  });
  return { handlers, createArgs, upCalls, mgrCalls, listTeams: real.listTeams };
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

test('a sandboxed bare create writes a POINTER manifest and brings its box up', async () => {
  const home = mkHome();
  const { handlers, createArgs, upCalls } = sandboxHandlers(home);

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop', sandboxed: true });

  assert.deepStrictEqual(createArgs, [{
    name: 'shop', root: '/proj/shop', lead: 'shop-lead', kit: undefined, sandboxed: true,
  }], 'the checkbox reaches the WRITER — that boolean is what makes the manifest a pointer');
  assert.deepStrictEqual(upCalls, [['shop', {
    boxId: 'team-shop', action: 'up', patch: { workDir: '/proj/shop' },
  }]], 'the host folder is mounted as the box work dir, and NO ref: a packaged app resolves the released image');
  assert.deepStrictEqual(res, {
    ok: true,
    team: res.team,
    webUrl: 'http://127.0.0.1:7812',
    lines: ['sandbox team-shop up @ abcdef12'],
  });
  assert.strictEqual(res.team.sandboxed, true);
});

test('a sandboxed create on a host with sandboxes off writes NOTHING', async () => {
  const home = mkHome();
  const { handlers, createArgs, listTeams } = sandboxHandlers(home, { noManager: true });

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop', sandboxed: true });

  assert.deepStrictEqual(res, { ok: false, error: 'sandboxes are disabled on this host' });
  assert.deepStrictEqual(createArgs, [],
    'the manager check precedes the write: a pointer manifest for a box that can never be built is unretryable');
  assert.deepStrictEqual(listTeams(), []);
});

test('a box phase that fails carries the reply stream as the error — _bringUpTeamBox returns a bare {ok:false}', async () => {
  const home = mkHome();
  const { handlers } = sandboxHandlers(home, {
    bringUp: (_t, opts) => {
      opts.reply('team shop shipped into the box (teams/shop)');
      opts.reply('error: health check failed');
      return { ok: false };
    },
  });

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop', sandboxed: true });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'error: health check failed',
    'the only reason lives in the reply stream, so the last line is the message');
  assert.deepStrictEqual(res.lines, [
    'team shop shipped into the box (teams/shop)',
    'error: health check failed',
  ]);
  assert.strictEqual(res.team.name, 'shop', 'the team was written before the box phase and still exists');
});

test('a THROWING box phase is reported, not propagated to the renderer as a rejection', async () => {
  const home = mkHome();
  const { handlers } = sandboxHandlers(home, {
    bringUp: () => { throw new Error('docker is not running'); },
  });

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop', sandboxed: true });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'docker is not running',
    'box.up() rejecting is a real path, and an unhandled rejection would leave the dialog stuck on Creating…');
  assert.deepStrictEqual(res.lines, []);
});

test('an unsandboxed create never reaches the sandbox manager', async () => {
  const home = mkHome();
  const { handlers, upCalls, mgrCalls, createArgs } = sandboxHandlers(home);

  const res = await handlers['team:createBare']({}, { name: 'shop', root: '/proj/shop' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual('webUrl' in res, false, "today's shape is unchanged, so the dialog still opens the roles popover");
  assert.deepStrictEqual(createArgs[0].sandboxed, false);
  assert.deepStrictEqual(upCalls, []);
  assert.deepStrictEqual(mgrCalls, []);
});

test('the dialog carries the sandboxed checkbox and passes it through', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = src.indexOf('function openCreateTeamDialog()');
  assert.ok(at > 0, 'ENTER: openCreateTeamDialog was found — a rename makes every assertion below vacuous');
  const rest = src.slice(at);
  const end = rest.search(/\n\}/);
  assert.ok(end > 0, 'ENTER: the end of openCreateTeamDialog was found');
  const body = rest.slice(0, end);

  assert.match(body, /data-f="sandboxed"/, 'the checkbox itself');
  assert.match(body, /sandboxed: sandboxedInput\.checked/, 'and it is what teamCreateBare is told');
  assert.match(body, /Creating…/, 'a box takes minutes, so OK says so while the invoke is pending');
  assert.match(body, /res\.webUrl/, 'and a box that came up routes to its web UI, not the local roles popover');
});

// ── The desktop Teams menu ──────────────────────────────────────────────────

// app-menus.js requires('electron') at module scope. Load it with a stub whose
// focused window RECORDS what the menu sends, so a click is observable.
function loadAppMenus(sent, dialog = {}, shell = {}) {
  const win = { webContents: { send: (ch, ...a) => sent.push([ch, ...a]) } };
  const stub = {
    app: { getName: () => 'Clodex', getVersion: () => '0.0.0', setAboutPanelOptions: () => {} },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} },
    Tray: function Tray() {},
    // app-menus destructures `dialog` at module scope, so this object IS the one
    // a click handler reaches later — no stub needs to stay installed for the
    // dialog to be observable at fire time, unlike Module._load itself.
    dialog, shell, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
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

function menusWith(getTeams, sent = [], dialog = {}, shell = {}) {
  const createAppMenus = loadAppMenus(sent, dialog, shell);
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
    ['broken — not loaded', 'good', 'Create Team…', 'Delete Team…'],
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

test('a sandboxed team is listed as "name — sandboxed" and opens its box web UI', () => {
  const home = mkHome();
  const write = (name, body, sandbox) => {
    fs.mkdirSync(path.join(home, 'teams', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'teams', name, 'team.json'), JSON.stringify(body));
    if (sandbox !== undefined) {
      fs.writeFileSync(path.join(home, 'teams', name, 'sandbox.json'),
        typeof sandbox === 'string' ? sandbox : JSON.stringify(sandbox));
    }
  };
  write('boxed', { root: '/proj/boxed', lead: 'boss', sandboxed: true, roles: { lead: {} } },
    { boxId: 'team-boxed', webUrl: 'http://127.0.0.1:7812' });
  write('cold', { root: '/proj/cold', lead: 'boss', sandboxed: true, roles: { lead: {} } });
  write('local', { root: '/proj/local', lead: 'boss', roles: { lead: {} } });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const opened = [];
  const { menus, sent } = menusWith(
    () => ({ listTeams: tm.listTeams, loadManifest: tm.loadManifest }),
    [], {}, { openExternal: (u) => opened.push(u) });

  const rows = menus.buildTeamsMenu().submenu.filter((i) => i.type !== 'separator');
  // ENTER: pin the whole row set first — a listTeams that stopped reaching one of
  // the three would make the per-row assertions below vacuous.
  assert.deepStrictEqual(rows.map((r) => r.label),
    ['boxed — sandboxed', 'cold — sandboxed', 'local', 'Create Team…', 'Delete Team…']);

  rows[0].click();
  assert.deepStrictEqual(opened, ['http://127.0.0.1:7812'],
    'the operator works with a sandboxed team through the box, so the row leaves the desktop');
  assert.deepStrictEqual(sent, [], 'and emphatically NOT the local roles popover');

  // A never-started (or torn-down) box has no sandbox.json, so there is no URL to
  // open — the row still appears, disabled, exactly like a broken manifest.
  assert.strictEqual(rows[1].enabled, false);
  assert.strictEqual(typeof rows[1].click, 'undefined');

  rows[2].click();
  assert.deepStrictEqual(sent, [['request-open-team-roles', 'local']],
    'an ordinary team is untouched by any of this');
});

test('a sandboxed team whose sandbox.json is unparseable is disabled, not a crash', () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, 'teams', 'boxed'), { recursive: true });
  fs.writeFileSync(path.join(home, 'teams', 'boxed', 'team.json'),
    JSON.stringify({ root: '/proj/boxed', lead: 'boss', sandboxed: true, roles: { lead: {} } }));
  fs.writeFileSync(path.join(home, 'teams', 'boxed', 'sandbox.json'), 'half-written{');
  const tm = createTeamManifest({ fs, clodexHome: home });
  const { menus } = menusWith(() => ({ listTeams: tm.listTeams, loadManifest: tm.loadManifest }));

  const row = menus.buildTeamsMenu().submenu.find((r) => r.label === 'boxed — sandboxed');
  assert.ok(row, 'the team is still listed');
  assert.strictEqual(row.enabled, false);
});

test('the Teams menu survives a team reader that is not there yet', () => {
  // getTeams is lazy because the engine is assigned after createAppMenus runs.
  // A menu built in that window must still carry Create Team…, not throw.
  const { menus } = menusWith(() => null);
  const menu = menus.buildTeamsMenu();
  assert.ok(menu.submenu.some((i) => i.label === 'Create Team…'));
});

// ── Delete Team… (t783) ─────────────────────────────────────────────────────

// The same on-disk reader as teamsOnDisk, plus the delete pair the menu calls
// in-process (main.js has no IPC to itself). The check and the delete are the
// REAL engine leaf over the REAL manifest, so a menu that stopped matching the
// backend fails here rather than passing against a stub of itself.
function deletableTeamsOnDisk(spec, { seats = [], tickets = [], saved = 0 } = {}) {
  const home = mkHome();
  for (const [name, body] of Object.entries(spec)) {
    fs.mkdirSync(path.join(home, 'teams', name, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'teams', name, 'prompts', 'lead.md'), '# lead');
    if (body !== undefined) {
      fs.writeFileSync(path.join(home, 'teams', name, 'team.json'),
        typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
  const tm = createTeamManifest({ fs, clodexHome: home });
  const forgotten = [];
  const manager = {
    _teamInUse: () => ({ seats, tickets, saved }),
    _forgetTeam: (name, root) => { forgotten.push([name, root]); },
  };
  const { createTeamDelete } = require('../team-delete');
  const { deleteCheck, deleteGated } = createTeamDelete({
    loadManifest: tm.loadManifest, deleteTeam: tm.deleteTeam, getManager: () => manager,
  });
  const getTeams = () => ({
    listTeams: tm.listTeams, loadManifest: tm.loadManifest, teamsDir: tm.teamsDir,
    deleteCheck, deleteTeam: deleteGated,
  });
  return { getTeams, home, forgotten, dirOf: (n) => path.join(home, 'teams', n) };
}

// A dialog that records what it was shown and answers with a scripted response.
function mkDialog(response = 0) {
  const shown = [];
  const errors = [];
  return {
    shown,
    errors,
    showMessageBox: async (opts) => { shown.push(opts); return { response }; },
    showErrorBox: (title, body) => errors.push([title, body]),
  };
}

test('Delete Team… sits after Create Team… and is DISABLED with no submenu on an empty box', () => {
  const { menus } = menusWith(teamsOnDisk({}));
  const rows = menus.buildTeamsMenu().submenu.filter((i) => i.type !== 'separator');
  const labels = rows.map((r) => r.label);
  assert.deepStrictEqual(labels, ['(no teams)', 'Create Team…', 'Delete Team…'],
    'the delete row follows create rather than replacing anything');
  const del = rows.find((r) => r.label === 'Delete Team…');
  assert.strictEqual(del.enabled, false, 'nothing to delete, so the row says so rather than opening an empty submenu');
  assert.strictEqual(typeof del.submenu, 'undefined', 'and carries no submenu at all');
});

test('the Delete Team… submenu lists a BROKEN team with a click target — unlike the open-roles listing above', () => {
  const { getTeams } = deletableTeamsOnDisk({
    good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } },
    bad: 'not json at all',
  });
  const { menus } = menusWith(getTeams);
  const rows = menus.buildTeamsMenu().submenu.filter((i) => i.type !== 'separator');
  const del = rows.find((r) => r.label === 'Delete Team…');
  assert.strictEqual(del.enabled, undefined, 'enabled with teams present');
  assert.deepStrictEqual(del.submenu.map((r) => r.label), ['bad — not loaded', 'good'],
    'both teams are offered, the broken one still labelled as such');
  // The whole point of the arm: an unloadable team is the one an operator most
  // wants gone, so it must be CLICKABLE here even though the listing above
  // disables it.
  for (const r of del.submenu) assert.strictEqual(typeof r.click, 'function', `${r.label} is clickable`);
});

test('clicking a team shows the confirm naming what goes and what stays; Cancel deletes NOTHING', async () => {
  const { getTeams, dirOf } = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } },
    { saved: 2 },
  );
  const dialog = mkDialog(1);
  const { menus } = menusWith(getTeams, [], dialog);
  const del = menus.buildTeamsMenu().submenu.find((r) => r.label === 'Delete Team…');
  await del.submenu.find((r) => r.label === 'good').click();

  assert.strictEqual(dialog.shown.length, 1, 'one dialog');
  const opts = dialog.shown[0];
  assert.strictEqual(opts.message, 'Delete team "good"?');
  assert.strictEqual(opts.type, 'warning');
  assert.deepStrictEqual(opts.buttons, ['Delete', 'Cancel']);
  assert.strictEqual(opts.defaultId, 1, 'the safe button is the default');
  assert.strictEqual(opts.cancelId, 1);
  assert.match(opts.detail, /its manifest, prompts and templates/, 'says what GOES');
  assert.match(opts.detail, /Keeps: the project at \/proj\/good/, 'and names the project it keeps');
  assert.match(opts.detail, /ticket history and task artifacts under ~\/\.clodex\/projects/);
  assert.match(opts.detail, /2 saved seats on this team become plain sessions/);

  assert.ok(fs.existsSync(dirOf('good')), 'response 1 removed nothing');
});

test('confirming deletes the team for real and refreshes the menus', async () => {
  const { getTeams, dirOf, forgotten } = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } },
  );
  const dialog = mkDialog(0);
  const { menus } = menusWith(getTeams, [], dialog);
  const del = menus.buildTeamsMenu().submenu.find((r) => r.label === 'Delete Team…');
  assert.ok(fs.existsSync(dirOf('good')), 'ENTER: the team is on disk before the click');

  await del.submenu.find((r) => r.label === 'good').click();

  assert.ok(!fs.existsSync(dirOf('good')), 'the directory is gone');
  assert.deepStrictEqual(forgotten, [['good', '/proj/good']], 'and its in-memory state was dropped');
  assert.deepStrictEqual(dialog.errors, [], 'no error box on the happy path');
  // The menu it was invoked from is a rebuilt template with no open-time hook,
  // so a delete that skipped the refresh leaves the deleted team clickable.
  assert.deepStrictEqual(menus.buildTeamsMenu().submenu.filter((i) => i.type !== 'separator').map((r) => r.label),
    ['(no teams)', 'Create Team…', 'Delete Team…'],
    'the rebuilt menu no longer offers it');
});

test('a team with a live seat gets the ERROR dialog naming both lists, and is not deleted', async () => {
  const { getTeams, dirOf } = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } },
    { seats: ['a', 'b'], tickets: ['t3', 't7'] },
  );
  const dialog = mkDialog(0);
  const { menus } = menusWith(getTeams, [], dialog);
  const del = menus.buildTeamsMenu().submenu.find((r) => r.label === 'Delete Team…');
  await del.submenu.find((r) => r.label === 'good').click();

  const opts = dialog.shown[0];
  assert.strictEqual(opts.type, 'error');
  assert.deepStrictEqual(opts.buttons, ['OK'], 'no Delete button on this arm at all');
  assert.strictEqual(opts.message, 'Team "good" is in use');
  assert.strictEqual(opts.detail,
    'Live seats: a, b. Open tickets: t3, t7. Retire the seats and close or cancel the tickets, then delete.');
  // Response 0 IS the confirm response on the other arm; the team surviving it
  // is what proves this arm never reaches the delete rather than reaching it
  // with a button the operator did not press.
  assert.ok(fs.existsSync(dirOf('good')), 'blocked, not deleted');
});

test('a blocked team names only the half that blocks — the instruction is never about an empty list', async () => {
  const seatsOnly = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } }, { seats: ['a'], tickets: [] });
  const d1 = mkDialog(0);
  await menusWith(seatsOnly.getTeams, [], d1).menus.buildTeamsMenu()
    .submenu.find((r) => r.label === 'Delete Team…').submenu[0].click();
  assert.strictEqual(d1.shown[0].detail, 'Live seats: a. Retire the seats, then delete.');

  const ticketsOnly = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } }, { seats: [], tickets: ['t3'] });
  const d2 = mkDialog(0);
  await menusWith(ticketsOnly.getTeams, [], d2).menus.buildTeamsMenu()
    .submenu.find((r) => r.label === 'Delete Team…').submenu[0].click();
  assert.strictEqual(d2.shown[0].detail, 'Open tickets: t3. Close or cancel the tickets, then delete.');
});

test('a broken team\'s confirm says the manifest could not be read, and deleting it works', async () => {
  const { getTeams, dirOf } = deletableTeamsOnDisk({ bad: 'not json at all' });
  const dialog = mkDialog(0);
  const { menus } = menusWith(getTeams, [], dialog);
  const del = menus.buildTeamsMenu().submenu.find((r) => r.label === 'Delete Team…');
  await del.submenu[0].click();

  const opts = dialog.shown[0];
  assert.strictEqual(opts.type, 'warning', 'deletable, so the confirm is the normal one');
  assert.strictEqual(opts.message, 'Delete team "bad"?');
  assert.match(opts.detail, /does not load \(/, 'the load error is quoted for the operator');
  assert.match(opts.detail, /so seats and tickets cannot be checked/);
  assert.match(opts.detail, /Removes the directory; nothing else is touched\./);
  // Displayed with ~ rather than the literal home, which is also what proves the
  // path in the sentence is the team's directory and not the project root.
  assert.ok(!/Keeps:/.test(opts.detail), 'no keeps-clause it could not have checked');
  assert.ok(!fs.existsSync(dirOf('bad')), 'and it really deleted');
});

test('a delete that FAILS shows the error box and refreshes nothing', async () => {
  const { getTeams, home } = deletableTeamsOnDisk(
    { good: { root: '/proj/good', lead: 'boss', roles: { lead: {} } } });
  const dialog = mkDialog(0);
  const { menus } = menusWith(getTeams, [], dialog);
  const del = menus.buildTeamsMenu().submenu.find((r) => r.label === 'Delete Team…');
  // Removed out from under the menu between build and click — the stale-template
  // window the confirm's click-time check exists for.
  fs.rmSync(path.join(home, 'teams', 'good'), { recursive: true, force: true });
  await del.submenu[0].click();

  assert.deepStrictEqual(dialog.errors.map((e) => e[0]), ['Delete team failed']);
  assert.match(dialog.errors[0][1], /does not exist/);
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
