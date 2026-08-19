'use strict';
// tickets-viewer-plugin.test.js — the plugin's ENGINE half, driven through the
// REAL plugin host engine against a real temp clodex home.
//
// The property this file exists for is NOT "the board lists tickets". It is
// that a board which FAILED TO READ never renders as a board with nothing on
// it. tickets-store.js's load() collapses missing / unreadable / invalid-JSON /
// non-array into `[]` — correct for a writer that must not crash a session on
// a corrupt registry, fatal for a viewer. Most read cases below are that
// distinction from one side or the other. Since t304 it matters twice over: the
// same collapse in a WRITE path would save an array rebuilt from a `[]` that
// really meant "this file did not parse", erasing the registry it failed to
// read.
//
// The board is the PROJECT's (t301) and needs no team (t304), so the unit the
// engine is keyed by is a project KEY — the directory name under projects/ —
// and a team is enrichment: a display name and a watchdogMs.
//
// The engine derives its clodex home from a bare homedir join, matching core's
// REGISTRY_DIR — it deliberately does NOT read CLODEX_HOME, or the board would
// report on a different tree than the app hosting it. So the seam here is
// _internals.setClodexHomeForTest, not an environment variable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const viewerEngine = require('../plugins/tickets-viewer/engine');

const {
  DEFAULT_STALL_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS, VIEWER_ACTOR,
  setClodexHomeForTest, projectDirFor,
  // Read here so the t435 cases can assert their OWN precondition — whether a
  // team names the project — through the engine's index rather than through a
  // second copy of the hashing a test could get wrong.
  teamIndex,
  // Read from the engine on purpose, so the delivery assertions below pin the
  // SHAPE (the close line rides every dispatch) and not the wording. The wording
  // is pinned once, against core's copy, in tickets-viewer-path-parity.test.js —
  // three hand-copied literals would just mean three places to forget.
  closeLine: viewerCloseLine,
} = viewerEngine._internals;
const HOUR = 60 * 60 * 1000;

function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tv-home-'));
  const teams = path.join(home, 'teams');
  fs.mkdirSync(teams, { recursive: true });
  // The HOME, not teams/ or projects/: they must be repointed together or the
  // fixture's manifests would be read against the operator's real boards.
  setClodexHomeForTest(home);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tv-data-'));
  const removals = [];
  // Every spec this engine delivers, so the delivery cases assert what a seat
  // was actually told rather than only that a write returned ok.
  const injected = [];
  const sessions = new Map();
  const host = createPluginHostEngine({
    manager: {
      sessions,
      list: () => [...sessions.values()].map((s) => ({ name: s.name, type: s.type, cwd: s.cwd })),
      listForWorkspace: () => [],
      _injectText: (s, text, opts) => injected.push({ name: s.name, text, opts }),
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dataDir,
    fs, path,
    gitWorktree: {},
    // Declared so a plugin that tried to delete through the seam would be
    // RECORDED rather than merely refused — the library seam is not this
    // plugin's write route and must stay untouched.
    libraryKinds: { memory: (ref) => { removals.push(ref); return { ok: true }; } },
  });
  // The SHIPPED manifest, not a stub: `surfaces` is what the dispatch gate reads
  // to decide whether a method serves the web, so registering without it would
  // make every "the writers are not web-reachable" assertion pass vacuously —
  // an unlisted method is desktop-only, and with no manifest NOTHING is listed.
  // Reading the real file also means a `surfaces` entry added to it later is
  // exercised here rather than only in the loader's own tests.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'plugins', 'tickets-viewer', 'manifest.json'), 'utf8'));
  host.register('tickets-viewer', viewerEngine, { ...manifest, hostApi: HOST_API_VERSION });

  const cleanup = () => {
    setClodexHomeForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { host, home, teams, removals, injected, sessions, cleanup };
}

function addSession(sessions, name, over = {}) {
  sessions.set(name, { name, type: 'claude', cwd: '/proj', ...over });
  return name;
}

// A team directory is one carrying team.json — the same thing that makes it a
// team to core (team-manifest's TEAM_FILE). The default manifest is one core's
// loadManifest ACCEPTS, so a warning appearing anywhere below is a test that
// asked for one rather than a property of the fixture.
// The root is per-NAME: the board is the project's, so two fixture teams on one
// root would share one board and every multi-project case would silently be a
// single-board case.
function mkTeam(teamsDir, name, teamJson = {}) {
  const dir = path.join(teamsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
    name, root: `/proj/${name}`, lead: 'lead', roles: { lead: {} }, ...teamJson,
  }));
  return dir;
}

// The project KEY for a root — the directory name the engine is addressed by.
// Derived through the engine's own projectDirFor so the fixture cannot disagree
// with the code under test about where a board lives.
function keyFor(home, root) {
  return path.basename(projectDirFor(home, root));
}

// The key a TEAM's board lives under, read from the same team.json the engine
// reads rather than from a second copy a test could get wrong.
function keyOfTeam(teamDir) {
  const home = path.dirname(path.dirname(teamDir));
  const { root } = JSON.parse(fs.readFileSync(path.join(teamDir, 'team.json'), 'utf8'));
  return keyFor(home, root);
}

function boardFileFor(home, key) {
  return path.join(home, 'projects', key, 'tickets.json');
}

// A project with NO team anywhere — the solo case, and the one the whole
// team-free half of this file is about.
function mkProject(home, root) {
  const key = keyFor(home, root);
  fs.mkdirSync(path.join(home, 'projects', key), { recursive: true });
  return key;
}

function writeTicketsAt(home, key, tickets) {
  writeRawBoardAt(home, key, JSON.stringify(tickets, null, 2));
}

// The malformed cases write BYTES, not records — a board that does not parse is
// precisely what several tests below are about, so it cannot go through JSON.
function writeRawBoardAt(home, key, text) {
  const file = boardFileFor(home, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// The team-rooted spellings, kept because most read cases are still most
// naturally written in terms of a team fixture.
function writeTickets(teamDir, tickets) {
  const home = path.dirname(path.dirname(teamDir));
  writeTicketsAt(home, keyOfTeam(teamDir), tickets);
}

function writeRawBoard(teamDir, text) {
  const home = path.dirname(path.dirname(teamDir));
  return writeRawBoardAt(home, keyOfTeam(teamDir), text);
}

// Fields the PRODUCT does not compute are hand-written here; nothing this
// helper sets is something the engine derives on the READ path. The engine's
// reading job is shaping records session-manager wrote, so a literal record IS
// the input.
function ticket(id, over = {}) {
  const now = Date.now();
  return {
    id, title: `title ${id}`, spec: 'spec', assignee: 'hand', opener: 'lead',
    state: 'open', openedAt: now - HOUR, closedAt: null,
    lastActivityAt: now - HOUR, nudgedAt: null, ...over,
  };
}

// Read the board back FROM DISK. Every write case asserts through this and not
// through the handler's return value: a handler that silently no-ops satisfies
// a return-value assertion perfectly, which is the one failure mode a CRUD test
// exists to catch.
function onDisk(home, key) {
  return JSON.parse(fs.readFileSync(boardFileFor(home, key), 'utf8'));
}

// The standing rule for this file since t304: before any test makes a write,
// assert the module's own resolved target is inside the fixture. The latch in
// the engine is the belt; this is the braces, and it catches a home that was
// never overridden even if the latch has a hole.
function assertWritesLandInFixture(home, key) {
  const target = viewerEngine._internals.boardPathForTest(key);
  assert.ok(target.startsWith(home + path.sep),
    `refusing to run: a write would land at ${target}, outside the fixture home ${home}`);
  assert.ok(target.startsWith(os.tmpdir()),
    `refusing to run: a write would land at ${target}, outside the temp dir`);
}

// ── the roots follow the app, not the environment ───────────────────────────

test('tickets-viewer: the teams root ignores CLODEX_HOME and matches core\'s', () => {
  // The board must report on the tree the app hosting it uses. Core's root is
  // engine.js:133's bare homedir join; if this plugin read CLODEX_HOME, a set
  // variable would point the two at different trees. Asserted with the variable
  // SET to something else, because with it unset the two agree whatever the
  // code does.
  const prev = process.env.CLODEX_HOME;
  process.env.CLODEX_HOME = path.join(os.tmpdir(), 'clodex-tv-decoy-home');
  try {
    setClodexHomeForTest(null);
    assert.equal(viewerEngine._internals.teamsRoot(), path.join(os.homedir(), '.clodex', 'teams'));
    // The projects root is the one that matters now — it is where the board
    // lives and, since t304, where a write lands.
    assert.equal(viewerEngine._internals.projectsRoot(), path.join(os.homedir(), '.clodex', 'projects'));
  } finally {
    if (prev === undefined) delete process.env.CLODEX_HOME; else process.env.CLODEX_HOME = prev;
  }
});

// ── the board needs no team ─────────────────────────────────────────────────

test('tickets-viewer: a project with NO team lists and opens its board', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/checkout');
    writeTicketsAt(home, key, [ticket('t1'), ticket('t2', { assignee: null })]);
    // The precondition, not decoration: with a team present this would resolve
    // through the team path and prove nothing about the solo case.
    assert.deepEqual(fs.readdirSync(teams), [], 'ENTER: no team exists for this project');

    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    assert.equal(list.ok, true);
    const row = list.projects.find((p) => p.key === key);
    assert.ok(row, 'a project with no team is still listed');
    assert.equal(row.team, '', 'no team names it, and that is a normal state');
    assert.equal(row.open, 2);
    assert.equal(row.backlog, 1);

    const board = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
    assert.equal(board.ok, true, 'the board opens with no team defined');
    assert.equal(board.team, '');
    assert.deepEqual(board.open.map((t) => t.id).sort(), ['t1', 't2']);
    // Core's default is what core would apply to a project with no manifest to
    // read a watchdogMs from, so the board must not invent its own number.
    assert.equal(board.stallMs, DEFAULT_STALL_MS);
  } finally { cleanup(); }
});

test('tickets-viewer: teams() with no teams at all is an empty list, never an error', async () => {
  const { host, teams, cleanup } = boot();
  try {
    // Two distinct shapes of "no teams": the directory exists and is empty, and
    // the directory was never created. On a box that has never made a team the
    // second is the ordinary state, so an ENOENT read as a failure would make a
    // stock solo install look broken.
    const empty = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.deepEqual(empty, { ok: true, teams: [] }, 'an empty teams dir is not an error');

    fs.rmSync(teams, { recursive: true, force: true });
    const none = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.deepEqual(none, { ok: true, teams: [] }, 'an absent teams dir is not an error either');

    // The accept half: a path that exists and cannot be read IS a failure, and
    // collapsing it into the empty answer above is the false green this plugin
    // exists to refuse.
    fs.writeFileSync(teams, 'not a directory');
    const broken = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.equal(broken.ok, false, 'an unreadable teams root is an error, not an empty list');
    assert.match(broken.error, /could not read/);
  } finally { cleanup(); }
});

test('tickets-viewer: no projects DIRECTORY is "no projects", an unreadable one is an error', async () => {
  const { host, home, cleanup } = boot();
  try {
    const none = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    assert.deepEqual(none, { ok: true, projects: [] }, 'nothing has opened a ticket yet');

    fs.writeFileSync(path.join(home, 'projects'), 'not a directory');
    const broken = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    assert.equal(broken.ok, false, 'an unreadable projects root is an error, not an empty list');
    assert.match(broken.error, /could not read/);
  } finally { cleanup(); }
});

test('tickets-viewer: a team names its project, and the board says which', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const key = keyOfTeam(dir);
    writeTickets(dir, [ticket('t1')]);

    const board = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
    assert.equal(board.team, 'alpha', 'the team is the name most operators know the board by');
    assert.equal(board.root, '/proj/alpha', 'and the root it came from');

    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    assert.equal(list.projects.find((p) => p.key === key).team, 'alpha');

    // The join in the other direction: teams() says which project each team's
    // board lives under, which is what lets a surface reach one by team name.
    const tl = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.equal(tl.teams.find((t) => t.team === 'alpha').project, key);
  } finally { cleanup(); }
});

// ── empty is not broken ─────────────────────────────────────────────────────

test('tickets-viewer: a project with no tickets.json is EMPTY, not failed', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    // The project dir exists (something created it) but no ticket was ever
    // opened — the one read failure that genuinely IS empty.
    fs.mkdirSync(path.join(home, 'projects', keyOfTeam(dir)), { recursive: true });
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.ok, true, 'a project that never opened a ticket is a healthy empty board');
    assert.deepEqual(res.open, []);
    assert.deepEqual(res.recent, []);
  } finally { cleanup(); }
});

test('tickets-viewer: an UNPARSEABLE tickets.json fails loudly instead of reading as empty', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeRawBoard(dir, '{ this is not json');
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    // The exact assertion that separates this plugin from tickets-store.load():
    // load() would answer [] here and the board would look idle.
    assert.equal(res.ok, false, 'a corrupt registry must NOT render as an empty board');
    assert.match(res.error, /not valid JSON/);
  } finally { cleanup(); }
});

test('tickets-viewer: a tickets.json that is not an ARRAY fails too', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    // Valid JSON, wrong shape — the second thing load() silently swallows.
    writeRawBoard(dir, '{"t1":{"state":"open"}}');
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.ok, false);
    assert.match(res.error, /ticket array/);
  } finally { cleanup(); }
});

test('tickets-viewer: non-object records inside a valid array are COUNTED, not silently dropped', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1'), 'garbage', null, 42]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.ok, true, 'one bad record does not fail a readable registry');
    assert.equal(res.open.length, 1);
    // A half-eaten registry would otherwise render as a shorter healthy board.
    assert.equal(res.counts.malformed, 3, 'the dropped records are reported');
  } finally { cleanup(); }
});

test('tickets-viewer: one broken project does not hide the healthy ones', async () => {
  const { host, home, cleanup } = boot();
  try {
    const bad = mkProject(home, '/proj/broken');
    writeRawBoardAt(home, bad, 'nonsense');
    const good = mkProject(home, '/proj/good');
    writeTicketsAt(home, good, [ticket('t1')]);

    const res = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    assert.equal(res.ok, true, 'the list survives a corrupt member');
    const byKey = Object.fromEntries(res.projects.map((p) => [p.key, p]));
    assert.equal(byKey[good].open, 1);
    // The broken row carries an error INSTEAD of a count — a `0 open` here is
    // the exact false green this plugin is built to avoid.
    assert.equal(byKey[bad].open, undefined, 'a broken project must not report a count');
    assert.match(byKey[bad].error, /not valid JSON/);
  } finally { cleanup(); }
});

test('tickets-viewer: a directory with no team.json is not listed as a team', async () => {
  const { host, teams, cleanup } = boot();
  try {
    mkTeam(teams, 'alpha');
    fs.mkdirSync(path.join(teams, 'stray-dir'), { recursive: true });
    const res = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.deepEqual(res.teams.map((t) => t.team), ['alpha']);
  } finally { cleanup(); }
});

test('tickets-viewer: an UNREADABLE team.json is an error, not an absent team', async () => {
  const { host, teams, cleanup } = boot();
  try {
    // A directory where team.json exists but reading it fails. existsSync
    // answers false for EACCES/EPERM/ELOOP alike, so a probe built on it would
    // make this team VANISH — the same picture as a directory that was never a
    // team, for a team that is there and broken.
    const dir = path.join(teams, 'unreadable');
    fs.mkdirSync(dir, { recursive: true });
    // A directory in team.json's place: readFileSync fails EISDIR, and unlike
    // a chmod this behaves the same for a root-run suite.
    fs.mkdirSync(path.join(dir, 'team.json'), { recursive: true });
    mkTeam(teams, 'alpha');

    const list = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    const row = list.teams.find((t) => t.team === 'unreadable');
    assert.ok(row, 'the team must not disappear from the list');
    assert.match(row.error, /could not read team\.json/);
    assert.equal(row.project, undefined, 'a team that could not be read names no board');
  } finally { cleanup(); }
});

test('tickets-viewer: a team.json core would REJECT is warned about, not rendered healthy', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    // loadManifest throws on each of these, so the app cannot resolve this team
    // at all. The tickets are real and still shown — this is not a false green
    // about tickets — but a board with no warning would let an unusable team
    // look entirely fine.
    //
    // Since t304 the board is reached by PROJECT key, so an unusable manifest no
    // longer hides the tickets: they are found regardless, and the warning is
    // purely about the team beside them.
    const cases = [
      [{ root: '/proj/bad', lead: '', roles: { lead: {} } }, /"lead" is not a seat name/],
      [{ root: '/proj/bad', lead: 'lead', roles: [] }, /"roles" is not an object/],
      [{ root: '/proj/bad', lead: 'lead', roles: { hand: {} } }, /no "lead" role/],
    ];
    const key = mkProject(home, '/proj/bad');
    for (const [manifest, re] of cases) {
      const dir = mkTeam(teams, 'bad');
      fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(manifest));
      writeTicketsAt(home, key, [ticket('t1')]);
      const res = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
      assert.equal(res.ok, true, 'the tickets are readable, so the board renders');
      assert.equal(res.open.length, 1, 'ENTER: the board under test actually has the row');
      assert.match(res.warning, re);
      const list = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
      assert.match(list.teams.find((t) => t.team === 'bad').warning, re);
    }

    // A manifest whose root is not absolute names no project at all, so it
    // cannot be matched to one — the team still warns, and the board it fails to
    // name is simply not this one.
    const relDir = mkTeam(teams, 'rel');
    fs.writeFileSync(path.join(relDir, 'team.json'),
      JSON.stringify({ root: 'relative/path', lead: 'lead', roles: { lead: {} } }));
    const rel = await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    assert.match(rel.teams.find((t) => t.team === 'rel').warning, /absolute path/);

    // The accept half, which is what catches a warning that fires on everything.
    const okDir = mkTeam(teams, 'good');
    writeTickets(okDir, [ticket('t1')]);
    const good = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(okDir)], 'desktop');
    assert.equal(good.warning, '', 'a manifest core accepts carries no warning');
  } finally { cleanup(); }
});

// ── containment ─────────────────────────────────────────────────────────────

test('tickets-viewer: a project key that escapes the projects root is REFUSED', async () => {
  const { host, home, cleanup } = boot();
  try {
    const real = mkProject(home, '/proj/alpha');
    // Assert the REFUSAL, not that some outside file survived: a test that only
    // checks "nothing was read" passes for an implementation that read the
    // wrong directory and found it empty.
    for (const name of ['.', '..', '../..', '../alpha', 'sub/alpha', '', null, 7]) {
      const res = await host.dispatch('tickets-viewer', 'board', [name], 'desktop');
      assert.equal(res.ok, false, `board(${JSON.stringify(name)}) must be refused`);
      assert.match(res.error, /valid project key/);
    }
    // `...` is deliberately NOT in that list. It resolves to a direct child of
    // the projects root, so containment has nothing to say about it — it is a
    // legal directory name that merely cannot name a project that exists. It is
    // refused one step later, by not existing, and so is any other absent key.
    // A nonexistent project rendering as an empty board is the same false green
    // as a corrupt one.
    for (const name of ['...', 'no-such-project']) {
      const res = await host.dispatch('tickets-viewer', 'board', [name], 'desktop');
      assert.equal(res.ok, false, `board(${JSON.stringify(name)}) must be refused`);
      assert.match(res.error, /no project/);
    }
    // The accept half, which is what catches an over-eager guard.
    const ok = await host.dispatch('tickets-viewer', 'board', [real], 'desktop');
    assert.equal(ok.ok, true, 'a real project key still opens');
  } finally { cleanup(); }
});

test('tickets-viewer: a WRITE cannot be aimed outside the projects root either', async () => {
  const { host, home, cleanup } = boot();
  try {
    const outside = path.join(home, 'escaped.json');
    for (const name of ['..', '../..', 'sub/alpha', '', null]) {
      const res = await host.dispatch('tickets-viewer', 'add',
        [{ project: name, spec: 'pwn' }], 'desktop');
      assert.equal(res.ok, false, `add(${JSON.stringify(name)}) must be refused`);
      assert.match(res.error, /valid project key/);
    }
    // The containment is asserted as an ABSENCE of the file a traversal would
    // have created, not only as a refusal: the refusal could be right for the
    // wrong reason while a write already happened.
    assert.equal(fs.existsSync(outside), false, 'no file was created outside projects/');
    assert.deepEqual(fs.readdirSync(home).sort(), ['teams'],
      'nothing was created under the home but the fixture teams dir');
  } finally { cleanup(); }
});

// ── stalled work is what the board is for ───────────────────────────────────

test('tickets-viewer: open tickets sort NEWEST first', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { openedAt: now - 2 * HOUR }),
      ticket('t2', { openedAt: now - 5 * HOUR }),
      ticket('t3', { openedAt: now - 30 * 1000 }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.deepEqual(res.open.map((t) => t.id), ['t3', 't1', 't2'],
      'the ticket just filed leads the board');
  } finally { cleanup(); }
});

// The ordering must key on when a ticket was OPENED, not on when it was last
// touched — otherwise chasing an old ticket teleports it to the top and the
// board reorders under the reader for a change that filed nothing.
test('tickets-viewer: activity on an old ticket does NOT move it to the top', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('old', { openedAt: now - 5 * HOUR, lastActivityAt: now - 1000 }),
      ticket('new', { openedAt: now - 30 * 1000, lastActivityAt: now - 30 * 1000 }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.deepEqual(res.open.map((t) => t.id), ['new', 'old'],
      'the freshly-touched OLD ticket stays below the newly-filed one');
  } finally { cleanup(); }
});

test('tickets-viewer: a ticket with no usable timestamp sorts to the TOP', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { openedAt: now - 5 * HOUR }),
      ticket('t2', { lastActivityAt: null, openedAt: null }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.open[0].id, 't2', 'an age that cannot be computed is itself worth looking at');
    assert.equal(res.open[0].quietMs, null);
    assert.equal(res.open[0].ageMs, null);
  } finally { cleanup(); }
});

test('tickets-viewer: lastActivityAt falls back to openedAt, as core measures it', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    // _sweepTickets reads `t.lastActivityAt || t.openedAt` — a ticket opened to
    // the backlog and never touched is quiet since it was opened, not unknown.
    writeTickets(dir, [ticket('t1', { lastActivityAt: null, openedAt: now - 3 * HOUR })]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.ok(res.open[0].quietMs >= 3 * HOUR - 5000, 'quiet since it was opened');
    assert.equal(res.open[0].stalled, true);
  } finally { cleanup(); }
});

test('tickets-viewer: the stall threshold is the TEAM\'s watchdogMs, not a number of its own', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const now = Date.now();
    // 40 minutes quiet: stalled under the 30m default, NOT stalled for a team
    // that set a longer watchdog. A hardcoded threshold would contradict the
    // nudge the lead has already seen (or not seen).
    const quiet = { lastActivityAt: now - 40 * 60 * 1000 };

    const def = mkTeam(teams, 'default-team');
    writeTickets(def, [ticket('t1', quiet)]);
    // Precondition, not decoration: this case proves watchdogMs passes THROUGH,
    // so its fixture has to sit inside the clamp window. Widen the window (or
    // narrow this number) and the case would still pass while testing the clamp
    // instead of the pass-through.
    const wide = 4 * HOUR;
    assert.ok(wide > WATCHDOG_MIN_MS && wide < WATCHDOG_MAX_MS,
      'fixture must be unclamped for this case to be about pass-through');
    const slow = mkTeam(teams, 'slow-team', { watchdogMs: wide });
    writeTickets(slow, [ticket('t1', quiet)]);

    const a = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(def)], 'desktop');
    assert.equal(a.stallMs, 30 * 60 * 1000);
    assert.equal(a.open[0].stalled, true);

    const b = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(slow)], 'desktop');
    assert.equal(b.stallMs, 4 * HOUR);
    assert.equal(b.open[0].stalled, false, 'a team that widened its own window is not stalled here');
  } finally { cleanup(); }
});

test('tickets-viewer: watchdogMs is CLAMPED as core clamps it, in both directions', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const now = Date.now();
    // team-manifest's loadManifest clamps into [5m, 7d] at READ because
    // team.json is agent-writable. This plugin does not go through that loader,
    // so an unclamped board would disagree with the watchdog about the exact
    // number the whole surface is organised around.
    // Both fixtures are derived from the bounds rather than written beside
    // them: a hardcoded pair stops straddling the window the moment either
    // bound moves, and the case then passes without exercising a clamp.
    const below = WATCHDOG_MIN_MS / 300;
    const above = WATCHDOG_MAX_MS * 52;
    assert.ok(below < WATCHDOG_MIN_MS && above > WATCHDOG_MAX_MS,
      'fixtures must straddle the clamp window for this case to mean anything');
    // Quiet times likewise straddle the CLAMPED thresholds, not the raw ones.
    const tiny = mkTeam(teams, 'tiny', { watchdogMs: below });
    writeTickets(tiny, [ticket('t1', { lastActivityAt: now - WATCHDOG_MIN_MS / 2 })]);
    const huge = mkTeam(teams, 'huge', { watchdogMs: above });
    writeTickets(huge, [ticket('t1', { lastActivityAt: now - WATCHDOG_MAX_MS * 4 })]);

    const a = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(tiny)], 'desktop');
    assert.equal(a.stallMs, WATCHDOG_MIN_MS, 'below the floor reads as the floor');
    assert.equal(a.open[0].stalled, false, 'quiet under the FLOORED threshold is not stalled');

    const b = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(huge)], 'desktop');
    assert.equal(b.stallMs, WATCHDOG_MAX_MS, 'above the ceiling reads as the ceiling');
    assert.equal(b.open[0].stalled, true, 'quiet past the CAPPED threshold is stalled');
  } finally { cleanup(); }
});

test('tickets-viewer: a non-finite watchdogMs cannot empty the stalled column', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const now = Date.now();
    // JSON.parse('1e400') is Infinity: typeof "number", > 0, and every
    // `stalled` on the board becomes false while core keeps nudging on 30m.
    // The silent direction — the board would look calm, not broken.
    const inf = mkTeam(teams, 'inf');
    fs.writeFileSync(path.join(teams, 'inf', 'team.json'),
      '{"name":"inf","root":"/proj/inf","lead":"lead","roles":{"lead":{}},"watchdogMs":1e400}');
    writeTickets(inf, [ticket('t1', { lastActivityAt: now - 5 * HOUR })]);

    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(inf)], 'desktop');
    assert.ok(Number.isFinite(res.stallMs), 'the threshold is always a real number');
    assert.equal(res.stallMs, DEFAULT_STALL_MS, 'a non-finite value reads as absent, as in loadManifest');
    assert.equal(res.open[0].stalled, true, 'a ticket quiet for 5h is stalled whatever team.json claims');
  } finally { cleanup(); }
});

test('tickets-viewer: an UNASSIGNED open ticket is backlog, never stalled', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    // _sweepTickets skips `t.assignee == null` outright — "backlog/closed
    // exempt" — because there is no seat to nudge. A board that flagged these
    // would show a stall core can neither produce nor clear, and the action it
    // asks for (chase the seat) is the wrong one: there is no seat.
    writeTickets(dir, [
      ticket('t1', { assignee: null, lastActivityAt: now - 40 * HOUR }),
      ticket('t2', { assignee: 'hand', lastActivityAt: now - 5 * HOUR }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.stalled, false, 'an unassigned ticket has nobody to have gone quiet');
    assert.equal(byId.t1.backlog, true, 'it is backlog, which is its own state');
    // The age is still computed and still shown — knowing a backlog ticket has
    // sat for two days is the useful part; calling it a stall is not.
    assert.ok(byId.t1.quietMs >= 39 * HOUR, 'backlog age is still measured');
    assert.equal(byId.t2.stalled, true, 'an assigned ticket past the threshold still stalls');
    assert.equal(byId.t2.backlog, false);

    assert.equal(res.counts.backlog, 1);
    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    const row = list.projects.find((p) => p.key === keyOfTeam(dir));
    // The two chips are separate numbers on purpose: assign versus chase.
    assert.equal(row.stalled, 1, 'the sidebar stall count excludes backlog too');
    assert.equal(row.backlog, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: a PARKED open ticket is parked, never stalled (t174)', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    // Core exempts a parked ticket from the sweep the same way it exempts
    // backlog, so flagging it here would invent a stall core can neither
    // produce nor clear. The distinguishing fixture: t1 is ASSIGNED, so only
    // the parked term can be exempting it — with an unassigned one the backlog
    // exemption would answer the same and prove nothing.
    writeTickets(dir, [
      ticket('t1', { assignee: 'hand', parked: true, lastActivityAt: now - 40 * HOUR }),
      ticket('t2', { assignee: 'hand', lastActivityAt: now - 5 * HOUR }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.parked, true);
    assert.equal(byId.t1.stalled, false, 'nothing was dispatched, so quiet is expected');
    assert.equal(byId.t1.backlog, false, 'it HAS an assignee — parked and backlog are different rows');
    assert.equal(byId.t2.parked, false, 'an ordinary ticket carries the flag as false, not undefined');
    assert.equal(byId.t2.stalled, true);
    assert.equal(res.counts.parked, 1);
    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    const row = list.projects.find((p) => p.key === keyOfTeam(dir));
    assert.equal(row.stalled, 1, 'the sidebar stall count excludes parked too');
    assert.equal(row.parked, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: an UNSTARTED open ticket is never stalled, however assigned (t329)', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    // The third exemption in core's gate, and the one an `assignee` test cannot
    // stand in for: `add` writes the ROLE NAME into `assignee`, so a ticket the
    // lead filed and never dispatched is assigned, quiet forever, and past any
    // threshold — 28 of them on the real board the day this landed. Core skips
    // them (`!ticketStarted(t)`); a board that flagged them would show 28 stalls
    // core can neither produce nor clear, for seats that do not exist.
    //
    // Every fixture below is ASSIGNED and past the threshold, so `assignee` and
    // the threshold can exempt none of them — only started-ness separates them.
    const fixtures = [
      // Filed, never dispatched: the key is PRESENT and null.
      ticket('t1', { assignee: 'hand', startedAt: null, lastActivityAt: now - 40 * HOUR }),
      // Dispatched, then went quiet: the stall the board exists to show.
      ticket('t2', { assignee: 'hand', startedAt: now - 6 * HOUR, lastActivityAt: now - 5 * HOUR }),
      // The legacy shape, and the arm of ticketStarted that is easiest to drop:
      // records predating `startedAt` have NO such key and were all dispatched,
      // so key-absent reads as STARTED. Getting this wrong empties the stalled
      // column of the oldest tickets — silently, since an absent stall looks
      // like a calm board.
      ticket('t3', { assignee: 'hand', lastActivityAt: now - 5 * HOUR }),
      // Second reading for a record _repinTicketToSeat left with a null
      // startedAt but a `role`: still started.
      ticket('t4', { assignee: 'seat-1', role: 'hand', startedAt: null, lastActivityAt: now - 5 * HOUR }),
    ];
    // Asserted on the FIXTURES, before they are written, and never on a shaped
    // row: `shape()` returns a fresh object literal that carries no `startedAt`
    // key for ANY input, so the same check against a board row is satisfied by
    // every fixture alike and can never fail. What it has to catch is someone
    // giving the `ticket()` helper a default `startedAt`, which would silently
    // turn t3 into a non-legacy fixture and delete the legacy-arm coverage
    // below while every assertion kept passing.
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fixtures[2], 'startedAt'), false,
      'the legacy fixture must have NO startedAt key, or it stops exercising the absent-key arm');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fixtures[0], 'startedAt'), true,
      'and the undispatched fixture must HAVE the key, or it is the legacy shape by accident');
    writeTickets(dir, fixtures);

    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    // ENTER: every assertion below reads through this reduction, and the
    // interesting row is the unstarted one — a board that dropped it would let
    // the rest of the test pass while proving nothing.
    assert.ok(byId.t1, 'the unstarted ticket must survive into the board');

    assert.equal(byId.t1.stalled, false, 'nothing was ever dispatched, so quiet is expected');
    assert.equal(byId.t1.backlog, false, 'it HAS an assignee — unstarted and backlog are different rows');
    assert.equal(byId.t1.parked, false, 'and it is not parked either');
    // Still measured and still shown: how long a filed ticket has sat is worth
    // seeing, it is just not a stall.
    assert.ok(byId.t1.quietMs >= 39 * HOUR, 'the age of an undispatched ticket is still measured');

    assert.equal(byId.t2.stalled, true, 'a dispatched ticket past the threshold still stalls');
    assert.equal(byId.t3.stalled, true, 'an absent startedAt key reads as STARTED, as in core');
    assert.equal(byId.t4.stalled, true, 'a `role` is the second reading of started-ness');

    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    const row = list.projects.find((p) => p.key === keyOfTeam(dir));
    assert.equal(row.stalled, 3, 'the sidebar stall count excludes the unstarted one too');
  } finally { cleanup(); }
});

test('tickets-viewer: an already-nudged stall is marked as such', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { lastActivityAt: now - 5 * HOUR, nudgedAt: now - HOUR }),
      ticket('t2', { lastActivityAt: now - 4 * HOUR }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    // "Nobody has chased this" and "it was chased and is still quiet" are
    // different problems for a lead.
    assert.equal(byId.t1.nudged, true);
    assert.equal(byId.t2.nudged, false);
  } finally { cleanup(); }
});

// ── the other columns ───────────────────────────────────────────────────────

test('tickets-viewer: the artifact path crosses, and its ABSENCE is representable', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [
      ticket('t1', { taskDir: 'tasks/some-task' }),
      ticket('t2'), // extractTaskDir found nothing — the field is simply absent
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.taskDir, 'tasks/some-task');
    assert.equal(byId.t2.taskDir, '', 'an absent taskDir is an empty string, never undefined');
  } finally { cleanup(); }
});

test('tickets-viewer: the spec body crosses whole, and its absence is representable', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    // Long enough that any "reasonable" engine-side cap would bite: a real spec
    // runs to a couple of KB of implementation detail.
    const long = `tasks/deep-work — do the thing\n\n- step one\n- step two\n\n${'x'.repeat(4000)}`;
    writeTickets(dir, [ticket('t1', { spec: long }), ticket('t2', { spec: null })]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    // Deliberately NOT truncated here. A JS-side cap drops content with nothing
    // on screen to say so; the display limit belongs in CSS, where the rest of
    // the body is a scroll away rather than gone. Since t304 the editor reads
    // this field too, so a truncation here would be SAVED BACK as the spec.
    assert.equal(byId.t1.spec, long);
    assert.equal(byId.t2.spec, '', 'an absent spec is an empty string, never undefined');
  } finally { cleanup(); }
});

test('tickets-viewer: an unassigned ticket keeps an empty assignee rather than a placeholder', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1', { assignee: null })]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    // The wording of "unassigned" belongs to the renderer; baking it in here
    // would put a user-facing string in the engine and hide the null.
    assert.equal(res.open[0].assignee, '');
  } finally { cleanup(); }
});

// Core re-pins `assignee` to a concrete seat at delivery and keeps the filed ROLE
// in `role`. Both boards render the role, so a viewer rendering the pin raw names
// a seat for the same ticket the others call `hand`. `assignee` stays raw because
// `stalled`/`backlog` key off "is anyone on the hook", which is what it answers.
test('tickets-viewer: a re-pinned ticket shows the ROLE it was filed under, not the seat pin', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [
      ticket('t1', { assignee: 'team-hand-9', role: 'hand' }),
      ticket('t2', { assignee: 'team-hand-9' }),   // no role — the un-pinned shape
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.shownFor, 'hand', 'the role is what the board shows');
    assert.equal(byId.t1.assignee, 'team-hand-9', 'the pin survives for stall/backlog logic');
    assert.equal(byId.t1.backlog, false, 'ENTER: a pinned ticket is not backlog');
    assert.equal(byId.t2.shownFor, 'team-hand-9',
      'with no role there is nothing to prefer — the pin is the only name it has');
  } finally { cleanup(); }
});

// ── recently closed, on core's terms ────────────────────────────────────────

test('tickets-viewer: recently-closed is DONE only, newest first, inside a 24h window', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { state: 'done', closedAt: now - 2 * HOUR }),
      ticket('t2', { state: 'done', closedAt: now - HOUR }),
      ticket('t3', { state: 'done', closedAt: now - 40 * HOUR }),   // outside the window
      ticket('t4', { state: 'cancelled', closedAt: now - HOUR }),   // never in this section
      ticket('t5'),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.deepEqual(res.recent.map((t) => t.id), ['t2', 't1']);
    assert.deepEqual(res.open.map((t) => t.id), ['t5'], 'closed tickets never appear as open');
    // Counted separately: one number answers neither "what did we ship" nor
    // "what did we drop".
    assert.equal(res.counts.done, 3);
    assert.equal(res.counts.cancelled, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: recently-closed is capped, and says how many it left out', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    const many = [];
    for (let i = 1; i <= 14; i++) many.push(ticket(`t${i}`, { state: 'done', closedAt: now - i * 60 * 1000 }));
    writeTickets(dir, many);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.recent.length, 10, 'core\'s RECENT_DONE_CAP');
    assert.equal(res.counts.recentOver, 4);
  } finally { cleanup(); }
});

test('tickets-viewer: a state this app never writes is surfaced, not swallowed', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1'), ticket('t2', { state: 'archived' })]);
    const res = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(res.open.length, 1);
    // Invisible in every other listing too — the board is where it shows up.
    assert.equal(res.counts.unknownState, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: the per-project open count agrees with the board it opens', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { lastActivityAt: now - 5 * HOUR }),
      ticket('t2', { lastActivityAt: now - 10 * 1000 }),
      ticket('t3', { state: 'done', closedAt: now }),
    ]);
    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    const row = list.projects.find((p) => p.key === keyOfTeam(dir));
    const board = await host.dispatch('tickets-viewer', 'board', [keyOfTeam(dir)], 'desktop');
    assert.equal(row.open, board.open.length, 'the sidebar count is the board it opens');
    assert.equal(row.stalled, board.open.filter((t) => t.stalled).length);
    assert.equal(row.stalled, 1);
  } finally { cleanup(); }
});

// ── the project's own identity ──────────────────────────────────────────────

test('tickets-viewer: a .project marker is believed only when it still hashes to its directory', async () => {
  const { host, home, cleanup } = boot();
  try {
    // The honest case: the marker names the path this directory is named for.
    const good = mkProject(home, '/proj/honest');
    fs.writeFileSync(path.join(home, 'projects', good, '.project'),
      JSON.stringify({ path: '/proj/honest' }));
    // The stale case: a marker left behind by a checkout that MOVED. Its path
    // hashes to a different directory, so displaying it would name a project
    // whose tickets these are not.
    const stale = mkProject(home, '/proj/moved');
    fs.writeFileSync(path.join(home, 'projects', stale, '.project'),
      JSON.stringify({ path: '/somewhere/else' }));
    assert.notEqual(keyFor(home, '/somewhere/else'), stale,
      'ENTER: the stale marker must really hash elsewhere, or this case proves nothing');

    const list = await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    const byKey = Object.fromEntries(list.projects.map((p) => [p.key, p]));
    assert.equal(byKey[good].root, '/proj/honest', 'a marker that checks out is used');
    assert.equal(byKey[stale].root, '', 'a marker that does not is discarded, not displayed');
  } finally { cleanup(); }
});

test('tickets-viewer: a team manifest OUTRANKS a .project marker', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    // Core writes team.json; nothing in the app writes .project. When the two
    // disagree the authored one wins, or a stale marker would rename a live
    // project under the operator.
    const dir = mkTeam(teams, 'alpha');
    const key = keyOfTeam(dir);
    fs.mkdirSync(path.join(home, 'projects', key), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', key, '.project'),
      JSON.stringify({ path: '/a/lie' }));

    const board = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
    assert.equal(board.root, '/proj/alpha', 'the manifest is the authored source of truth');
  } finally { cleanup(); }
});

// ── the write half ──────────────────────────────────────────────────────────
//
// Every case here asserts the BOARD ON DISK changed, re-read through onDisk().
// A handler that returned `{ok:true}` and wrote nothing satisfies a
// return-value assertion perfectly, so the return value is never the evidence.

test('tickets-viewer: add writes a ticket to the project board, with no team anywhere', async () => {
  const { host, home, teams, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/checkout');
    assert.deepEqual(fs.readdirSync(teams), [], 'ENTER: no team exists — this is the solo path');
    assertWritesLandInFixture(home, key);

    const res = await host.dispatch('tickets-viewer', 'add',
      [{ project: key, spec: 'tasks/the-work — do the thing\n\nbody' }], 'desktop');
    assert.equal(res.ok, true, res.error);
    assert.equal(res.id, 't1', 'the first ticket on an empty board');

    const board = onDisk(home, key);
    assert.equal(board.length, 1, 'the record reached the disk, not just the response');
    const t = board[0];
    // The record must be one session-manager would have written, field for
    // field: another reader (the CLI, the intent path, clodex-team) reads this
    // file, and a viewer-shaped record is a record they mis-handle.
    assert.equal(t.id, 't1');
    assert.equal(t.title, 'tasks/the-work — do the thing', 'the title is the first non-empty line');
    assert.equal(t.spec, 'tasks/the-work — do the thing\n\nbody');
    assert.equal(t.state, 'open');
    assert.equal(t.assignee, '', 'no assignee given, so it opens to the backlog');
    assert.equal(t.opener, VIEWER_ACTOR);
    assert.equal(t.closedAt, null);
    assert.equal(t.nudgedAt, null);
    assert.equal(t.taskDir, 'tasks/the-work', 'the artifact link is extracted from the first line');
    assert.ok(Number.isFinite(t.openedAt) && Number.isFinite(t.lastActivityAt));
    // `parked: false` is a state core never writes and every reader tests for
    // truthiness — storing one would be a shape core cannot produce.
    assert.equal('parked' in t, false, 'an unparked ticket carries NO parked key');
    // The key is written EXPLICITLY, against the convention `parked` follows one
    // line up, and that asymmetry is the whole point: `ticketStarted` reads an
    // absent `startedAt` as a pre-upgrade record that the old `add` dispatched,
    // so omitting it here would file every viewer-minted ticket as already
    // STARTED — from the writer that also reads that shape as legacy.
    assert.equal('startedAt' in t, true, 'the key is explicit, or a fresh ticket reads as legacy-started');
    assert.equal(t.startedAt, null, 'nothing was dispatched, so nothing started');
  } finally { cleanup(); }
});

test('tickets-viewer: a ticket added WITH an assignee is stamped as started (t329)', async () => {
  const { host, home, sessions, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/add-started');
    addSession(sessions, 'hand-1');
    assertWritesLandInFixture(home, key);
    const before = Date.now();

    // This is where the viewer parts from core's `add`, which always writes
    // null: core split dispatch out into `_taskStart`, but the viewer DELIVERS
    // the spec in this same call. A delivered spec whose record says unstarted
    // is exempt from the stall gate and from core's watchdog for as long as the
    // seat holds it — the silent direction, and worse than over-flagging.
    const res = await host.dispatch('tickets-viewer', 'add',
      [{ project: key, spec: 'do it', assignee: 'hand-1' }], 'desktop');
    assert.equal(res.ok, true, res.error);
    assert.equal(res.delivered, true, 'ENTER: the spec was actually delivered — that is what makes it started');

    const t = onDisk(home, key)[0];
    assert.ok(t.startedAt >= before, 'a delivered ticket records WHEN it started');
    assert.equal(viewerEngine._internals.ticketStarted(t), true,
      'and reads as started, so the stall gate can still see it go quiet');
  } finally { cleanup(); }
});

test('tickets-viewer: add mints the next id over the WHOLE board, closed records included', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/ids');
    // An id is a public reference — branch names, artifact dirs, commit
    // messages — so reusing a closed ticket's id still resolves, to the wrong
    // work. max+1 over every record, not over the open ones.
    writeTicketsAt(home, key, [
      ticket('t1', { state: 'done', closedAt: Date.now() }),
      ticket('t7', { state: 'cancelled', closedAt: Date.now() }),
      ticket('t3'),
    ]);
    assertWritesLandInFixture(home, key);

    const res = await host.dispatch('tickets-viewer', 'add', [{ project: key, spec: 'next' }], 'desktop');
    assert.equal(res.id, 't8', 'the cancelled t7 still holds its number');
    assert.deepEqual(onDisk(home, key).map((t) => t.id), ['t1', 't7', 't3', 't8']);
  } finally { cleanup(); }
});

test('tickets-viewer: add DELIVERS the spec to a live assignee, and says when it could not', async () => {
  const { host, home, sessions, injected, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/deliver');
    addSession(sessions, 'hand-1');
    assertWritesLandInFixture(home, key);

    const live = await host.dispatch('tickets-viewer', 'add',
      [{ project: key, spec: 'do the thing', assignee: 'hand-1' }], 'desktop');
    assert.equal(live.ok, true, live.error);
    assert.equal(live.delivered, true);
    // The seat must be TOLD, in the shape core uses, or an assignment nobody
    // saw looks exactly like one that was picked up.
    assert.deepEqual(injected.map((i) => ({ name: i.name, text: i.text })),
      [{ name: 'hand-1', text: `[ticket t1] ${viewerCloseLine('t1')}do the thing` }]);
    assert.equal(onDisk(home, key)[0].assignee, 'hand-1', 'and the record says who holds it');

    // The seat is not running. The ticket is still written — that is the point
    // of a backlog — but the caller is told nobody was notified, because this
    // is the half-success an ok/error pair cannot express.
    const dead = await host.dispatch('tickets-viewer', 'add',
      [{ project: key, spec: 'later', assignee: 'ghost' }], 'desktop');
    assert.equal(dead.ok, true, 'a ticket for an absent seat is still a ticket');
    assert.equal(dead.delivered, false, 'and the caller learns it was not delivered');
    assert.equal(injected.length, 1, 'nothing was sent to a session that does not exist');
    assert.equal(onDisk(home, key).length, 2, 'the record is on disk regardless');
  } finally { cleanup(); }
});

test('tickets-viewer: add refuses an empty spec, and writes nothing', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/empty');
    writeTicketsAt(home, key, [ticket('t1')]);
    const before = fs.readFileSync(boardFileFor(home, key), 'utf8');

    for (const spec of ['', '   ', '\n\n', null, undefined]) {
      const res = await host.dispatch('tickets-viewer', 'add', [{ project: key, spec }], 'desktop');
      assert.equal(res.ok, false, `add(${JSON.stringify(spec)}) must be refused`);
      assert.match(res.error, /needs a spec/);
    }
    // The refusal is only worth anything if the board is untouched: a refusal
    // that still rewrote the file would have bumped ids and timestamps.
    assert.equal(fs.readFileSync(boardFileFor(home, key), 'utf8'), before,
      'a refused add leaves the registry byte-identical');
  } finally { cleanup(); }
});

// t339: core's `task respec` records each supersession on the ticket. The board
// is the surface the lead actually reads, so it carries the COUNT — a history
// no reader ever surfaces satisfies "show the spec was superseded" literally and
// not actually. A count, not the entries: the row renders no titles.
test('tickets-viewer: shape surfaces respecCount, defaulting to 0', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/respec');
    writeTicketsAt(home, key, [
      ticket('t1'),
      ticket('t2', { respecs: [{ at: Date.now(), by: 'lead', title: 'superseded' }] }),
      ticket('t3', { respecs: [{ at: 1, by: 'lead', title: 'a' }, { at: 2, by: 'lead', title: 'b' }] }),
    ]);

    const res = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    // ENTER: all three rows survive the reduction — the assertions below are a
    // 0 and two positives, and a dropped row would satisfy the 0 vacuously.
    assert.ok(byId.t1 && byId.t2 && byId.t3, 'every fixture reached the board');

    assert.strictEqual(byId.t1.respecCount, 0, 'an uncorrected ticket reads 0, not undefined');
    assert.strictEqual(byId.t2.respecCount, 1);
    assert.strictEqual(byId.t3.respecCount, 2, 'the count tracks repeated corrections');
    assert.ok(!('respecs' in byId.t3), 'the entries themselves stay off the wire — the row shows a count');
  } finally { cleanup(); }
});

test('tickets-viewer: editSpec rewrites the spec AND everything derived from it', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/edit');
    writeTicketsAt(home, key, [ticket('t1', {
      spec: 'tasks/old-dir — the old title\n\nold body', title: 'the old title', taskDir: 'tasks/old-dir',
    })]);
    assertWritesLandInFixture(home, key);

    const res = await host.dispatch('tickets-viewer', 'editSpec',
      [{ project: key, id: 't1', spec: 'tasks/new-dir — the new title\n\nnew body' }], 'desktop');
    assert.equal(res.ok, true, res.error);

    const t = onDisk(home, key)[0];
    assert.equal(t.spec, 'tasks/new-dir — the new title\n\nnew body');
    // Title and taskDir are DERIVED. Leaving either stale would make the board's
    // summary line and its artifact path describe a spec that no longer exists —
    // and the artifact path is what a fresh seat follows to pick the work up.
    assert.equal(t.title, 'tasks/new-dir — the new title', 'the title is recomputed');
    assert.equal(t.taskDir, 'tasks/new-dir', 'and so is the artifact link');
  } finally { cleanup(); }
});

test('tickets-viewer: an edit that removes the task dir REMOVES it, rather than leaving a stale one', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/untask');
    writeTicketsAt(home, key, [ticket('t1', { spec: 'tasks/some-dir — x', taskDir: 'tasks/some-dir' })]);
    assertWritesLandInFixture(home, key);

    await host.dispatch('tickets-viewer', 'editSpec',
      [{ project: key, id: 't1', spec: 'no artifact path here' }], 'desktop');
    const t = onDisk(home, key)[0];
    // A path pointing at ANOTHER ticket's artifacts is worse than the absence
    // the row already knows how to render.
    assert.equal('taskDir' in t, false, 'the stale artifact link is gone, not merely blanked');
  } finally { cleanup(); }
});

test('tickets-viewer: assign re-points a ticket, clears the nudge and the park, and delivers', async () => {
  const { host, home, sessions, injected, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/assign');
    const now = Date.now();
    writeTicketsAt(home, key, [ticket('t1', {
      assignee: 'old-hand', role: 'hand', parked: true, nudgedAt: now - HOUR, spec: 'the work',
    })]);
    addSession(sessions, 'new-hand');
    assertWritesLandInFixture(home, key);

    const res = await host.dispatch('tickets-viewer', 'assign',
      [{ project: key, id: 't1', assignee: 'new-hand' }], 'desktop');
    assert.equal(res.ok, true, res.error);
    assert.equal(res.delivered, true);

    const t = onDisk(home, key)[0];
    assert.equal(t.assignee, 'new-hand');
    // Each of these mirrors a specific line of core's assign, and each has its
    // own failure: a surviving `role` makes the board render the OLD role over
    // the new holder; a surviving `nudgedAt` marks the new holder as already
    // chased; a surviving `parked` leaves it held out of dispatch after the act
    // that is supposed to release it.
    assert.equal('role' in t, false, 'the stale role is dropped, or shownFor names the wrong holder');
    assert.equal(t.nudgedAt, null, 'the new holder has not been chased');
    assert.equal('parked' in t, false, 'assigning is what releases a parked ticket');
    assert.ok(t.lastActivityAt >= now, 'the clock moved');
    assert.deepEqual(injected.map((i) => i.text), [`[ticket t1] ${viewerCloseLine('t1')}the work`]);
  } finally { cleanup(); }
});

test('tickets-viewer: assign STAMPS the dispatch it performs, and never restates it (t329)', async () => {
  const { host, home, sessions, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/assign-started');
    const now = Date.now();
    // The exact shape this ticket is about: `startedAt` present and null, no
    // `role`, no `worktree` — a ticket filed and never dispatched. Assigning it
    // from the board delivers the spec, so it HAS started; leaving it unstamped
    // exempts it from the stall gate above and from core's watchdog forever,
    // and t329's own gate is what makes that silence possible.
    writeTicketsAt(home, key, [
      ticket('t1', { assignee: 'hand', startedAt: null, spec: 'the work' }),
      ticket('t2', { assignee: 'hand', startedAt: now - 40 * HOUR, spec: 'older work' }),
    ]);
    addSession(sessions, 'new-hand');
    assertWritesLandInFixture(home, key);

    for (const id of ['t1', 't2']) {
      const res = await host.dispatch('tickets-viewer', 'assign',
        [{ project: key, id, assignee: 'new-hand' }], 'desktop');
      assert.equal(res.ok, true, res.error);
      assert.equal(res.delivered, true, `ENTER: ${id}'s spec was delivered — the dispatch this stamps`);
    }

    const byId = Object.fromEntries(onDisk(home, key).map((t) => [t.id, t]));
    assert.ok(byId.t1.startedAt >= now, 'the undispatched ticket is stamped by the assign that dispatched it');
    assert.equal(viewerEngine._internals.ticketStarted(byId.t1), true,
      'so the stall gate can see this seat go quiet');
    // The other half of core's `if (!ticketStarted(...))`: this is the moment
    // work FIRST started, so a re-assignment must not restate it. Without the
    // guard every re-send would reset the clock §4/§5 measure from.
    assert.equal(byId.t2.startedAt, now - 40 * HOUR, 'an already-started ticket keeps its ORIGINAL start');
  } finally { cleanup(); }
});

// ── assign makes the same dispatch-time refusal the intent verbs make (t435) ─
//
// t431 gated `_taskStart` and `_taskAssign` on the ticket having a task dir,
// because a ticket whose spec names no `tasks/…` path has nowhere for the review
// step to write its diff and dies at VERIFY — after the hand has done the whole
// job. On t429 that cost two no-op rounds. The viewer's assign is the other
// dispatch path, so until this gate it was the one remaining door into that
// state: the same act, typed as an intent, refused; clicked on the board,
// allowed. The three tests below are the door and its two exemptions, and all
// three are needed — the first alone passes against a viewer that refuses
// everything.

test('tickets-viewer: assign REFUSES a task-dir-less ticket on a team board, writing nothing (t435)', async () => {
  const { host, home, teams, sessions, injected, cleanup } = boot();
  try {
    // A TEAM board, because a project no team names is the viewer's solo
    // equivalent and is exempt by design — see the next test.
    const teamDir = mkTeam(teams, 'gated');
    const key = keyOfTeam(teamDir);
    const now = Date.now();
    // No `taskDir` key: the shape `add` writes when extractTaskDir found nothing
    // in the spec. No worktree and no startedAt either, so neither exemption can
    // be what the refusal is measured against.
    writeTickets(teamDir, [ticket('t1', {
      assignee: 'old-hand', spec: 'do the thing', startedAt: null,
      nudgedAt: now - HOUR, lastActivityAt: now - HOUR,
    })]);
    addSession(sessions, 'new-hand');
    assertWritesLandInFixture(home, key);

    const before = onDisk(home, key)[0];
    assert.equal('taskDir' in before, false, 'ENTER: the fixture ticket really has no task dir');
    assert.ok(teamIndex().get(key), 'ENTER: a team names this project, so the solo carve-out is not in play');

    const res = await host.dispatch('tickets-viewer', 'assign',
      [{ project: key, id: 't1', assignee: 'new-hand' }], 'desktop');

    assert.equal(res.ok, false, 'the assign is refused');
    assert.match(res.error, /^ticket t1 has no task dir, so nothing was assigned/);
    assert.match(res.error, /\[agent:task respec t1\]/,
      'and names the fix — a refusal the lead cannot act on is a worse failure than the gap');

    // "Nothing was changed" is a promise about DISK, and the return value cannot
    // keep it: mutateBoard refuses before the save only if the gate sits inside
    // the mutate callback. Asserted field by field against the record as filed,
    // because a gate placed one line late still returns this exact string having
    // already re-pointed the assignee and cleared the park.
    assert.deepEqual(onDisk(home, key)[0], before, 'not one byte of the record moved');
    assert.deepEqual(injected, [], 'and no seat was told to start work that would die at verify');
  } finally { cleanup(); }
});

test('tickets-viewer: a SOLO board assigns a task-dir-less ticket as before (t435)', async () => {
  const { host, home, teams, sessions, injected, cleanup } = boot();
  try {
    // The carve-out core spells `team.solo`, which is set only by _soloContext,
    // in memory, and never written to a manifest — so the viewer can never read
    // it. Its observable equivalent is that NO team names this project: a solo
    // ticket mints no worktree and gets no loop step, so it cannot reach the
    // verify-time refusal, and gating it would be pure cost on a shipped path.
    const key = mkProject(home, '/solo/no-task-dir');
    writeTicketsAt(home, key, [ticket('t1', { assignee: 'old-hand', spec: 'do the thing', startedAt: null })]);
    addSession(sessions, 'new-hand');
    assertWritesLandInFixture(home, key);

    assert.equal('taskDir' in onDisk(home, key)[0], false,
      'ENTER: task-dir-less, so this passes because of the carve-out and not because the gate had nothing to refuse');
    assert.deepEqual(fs.readdirSync(teams), [], 'ENTER: no team exists, which IS the solo case here');

    const res = await host.dispatch('tickets-viewer', 'assign',
      [{ project: key, id: 't1', assignee: 'new-hand' }], 'desktop');

    assert.equal(res.ok, true, res.error);
    assert.equal(res.delivered, true, 'the spec still reaches the seat');
    assert.equal(onDisk(home, key)[0].assignee, 'new-hand', 'and the board still moved');
    assert.equal(injected.length, 1, 'exactly the one delivery');
  } finally { cleanup(); }
});

test('tickets-viewer: a re-send to a ticket that owns a TREE is exempt from the gate (t435)', async () => {
  const { host, home, teams, sessions, injected, cleanup } = boot();
  try {
    // Core's re-send test is `ownSeat || the ticket's tree`. The viewer has no
    // `ownSeat` — that is read off persisted records the plugin cannot see — so
    // this half is the whole of the viewer's exemption, and it is NARROWER than
    // core's on purpose. The tree is the work: the cost this gate avoids was
    // already paid when the tree was minted, and refusing here would strand the
    // redelivery a respawned or stuck seat recovers through.
    const teamDir = mkTeam(teams, 'resend');
    const key = keyOfTeam(teamDir);
    writeTickets(teamDir, [ticket('t1', {
      assignee: 'old-hand', spec: 'do the thing',
      worktree: { path: '/tmp/tree-t1', branch: 't1' },
    })]);
    addSession(sessions, 'new-hand');
    assertWritesLandInFixture(home, key);

    assert.equal('taskDir' in onDisk(home, key)[0], false,
      'ENTER: still task-dir-less, so only the re-send exemption can be letting this through');
    assert.ok(teamIndex().get(key), 'ENTER: and a team names it, so the solo carve-out is not what passes it');

    const res = await host.dispatch('tickets-viewer', 'assign',
      [{ project: key, id: 't1', assignee: 'new-hand' }], 'desktop');

    assert.equal(res.ok, true, res.error);
    assert.equal(res.delivered, true, 'the redelivery a stuck seat recovers through still lands');
    assert.equal(onDisk(home, key)[0].assignee, 'new-hand');
    assert.equal(injected.length, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: close and cancel write the SAME closing shape, differing only in state', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/close');
    writeTicketsAt(home, key, [ticket('t1'), ticket('t2')]);
    assertWritesLandInFixture(home, key);
    const before = Date.now();

    assert.equal((await host.dispatch('tickets-viewer', 'close', [{ project: key, id: 't1' }], 'desktop')).ok, true);
    assert.equal((await host.dispatch('tickets-viewer', 'cancel', [{ project: key, id: 't2' }], 'desktop')).ok, true);

    const byId = Object.fromEntries(onDisk(home, key).map((t) => [t.id, t]));
    assert.equal(byId.t1.state, 'done');
    assert.equal(byId.t2.state, 'cancelled');
    // One shape across both close verbs, as core writes them — the pair is what
    // keeps "what got shipped" and "what got dropped" countable apart while
    // still being closed the same way.
    for (const t of [byId.t1, byId.t2]) {
      assert.ok(t.closedAt >= before, `${t.id} is stamped with a close time`);
      assert.equal(t.closedBy, VIEWER_ACTOR, `${t.id} records who closed it`);
      assert.equal(t.lastActivityAt, t.closedAt, `${t.id} closes its activity clock with it`);
    }

    // And the board agrees on the read side, which is where the counts the
    // operator actually sees come from.
    const board = await host.dispatch('tickets-viewer', 'board', [key], 'desktop');
    assert.deepEqual(board.open, []);
    assert.equal(board.counts.done, 1);
    assert.equal(board.counts.cancelled, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: the lifecycle verbs refuse a ticket that is not OPEN, and write nothing', async () => {
  const { host, home, sessions, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/refuse');
    const closedAt = Date.now() - HOUR;
    writeTicketsAt(home, key, [
      ticket('t1', { state: 'done', closedAt, closedBy: 'someone' }),
      ticket('t2', { state: 'cancelled', closedAt, closedBy: 'someone' }),
    ]);
    addSession(sessions, 'hand-1');
    const before = fs.readFileSync(boardFileFor(home, key), 'utf8');

    for (const [method, payload] of [
      ['assign', { project: key, id: 't1', assignee: 'hand-1' }],
      ['close', { project: key, id: 't1' }],
      ['cancel', { project: key, id: 't2' }],
    ]) {
      const res = await host.dispatch('tickets-viewer', method, [payload], 'desktop');
      assert.equal(res.ok, false, `${method} on a closed ticket must be refused`);
      assert.match(res.error, /not open/);
    }
    // Re-closing a done ticket would overwrite closedAt/closedBy with the
    // viewer's, rewriting who finished the work and when.
    assert.equal(fs.readFileSync(boardFileFor(home, key), 'utf8'), before,
      'a refused lifecycle verb leaves the registry byte-identical');

    // An id that is not there at all is its own refusal, not a silent no-op.
    for (const method of ['assign', 'close', 'cancel', 'editSpec']) {
      const res = await host.dispatch('tickets-viewer', method,
        [{ project: key, id: 'nope', assignee: 'hand-1', spec: 'x' }], 'desktop');
      assert.equal(res.ok, false, `${method} on an absent id must be refused`);
      assert.match(res.error, /no ticket/);
    }
  } finally { cleanup(); }
});

test('tickets-viewer: a write REFUSES a board it could not read, rather than erasing it', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/corrupt');
    // The failure this guards is specific and silent: tickets-store's load()
    // answers `[]` for a file that did not parse, so a writer built on it would
    // push one record onto an empty array and save — erasing every ticket the
    // corrupt file still held. The bytes are recoverable by hand; a board
    // rewritten to a single record is not.
    const corrupt = '[{"id":"t1","state":"open"} TRUNCATED';
    writeRawBoardAt(home, key, corrupt);

    for (const [method, payload] of [
      ['add', { project: key, spec: 'new work' }],
      ['assign', { project: key, id: 't1', assignee: 'hand' }],
      ['close', { project: key, id: 't1' }],
      ['cancel', { project: key, id: 't1' }],
      ['editSpec', { project: key, id: 't1', spec: 'x' }],
    ]) {
      const res = await host.dispatch('tickets-viewer', method, [payload], 'desktop');
      assert.equal(res.ok, false, `${method} must refuse an unreadable board`);
      assert.match(res.error, /refusing to write/);
    }
    assert.equal(fs.readFileSync(boardFileFor(home, key), 'utf8'), corrupt,
      'the unreadable bytes are left exactly as found, for a human to repair');
  } finally { cleanup(); }
});

test('tickets-viewer: a write leaves the rest of the board untouched', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/neighbours');
    const others = [
      ticket('t1', { spec: 'first', assignee: 'a' }),
      ticket('t2', { spec: 'second', assignee: 'b', state: 'done', closedAt: 123, closedBy: 'b' }),
    ];
    writeTicketsAt(home, key, [...others, ticket('t3', { spec: 'third' })]);
    assertWritesLandInFixture(home, key);

    await host.dispatch('tickets-viewer', 'close', [{ project: key, id: 't3' }], 'desktop');

    const after = onDisk(home, key);
    // The whole array is rewritten on every save, so a neighbouring record is
    // exactly the thing a serialization bug drops or mangles silently.
    assert.deepEqual(after.slice(0, 2), others, 'every untouched record survives byte for byte');
    assert.equal(after.length, 3, 'and nothing was added or lost');
  } finally { cleanup(); }
});

test('tickets-viewer: the board a write lands in is the one that was ASKED for', async () => {
  const { host, home, cleanup } = boot();
  try {
    // Two projects, so a handler that ignored its `project` argument and wrote
    // to "the first one" would be caught. With one project on disk that bug
    // passes every other case in this file.
    const a = mkProject(home, '/proj/aaa');
    const b = mkProject(home, '/proj/bbb');
    writeTicketsAt(home, a, [ticket('t1')]);
    writeTicketsAt(home, b, [ticket('t1')]);
    const beforeA = fs.readFileSync(boardFileFor(home, a), 'utf8');

    await host.dispatch('tickets-viewer', 'add', [{ project: b, spec: 'only for b' }], 'desktop');

    assert.equal(fs.readFileSync(boardFileFor(home, a), 'utf8'), beforeA,
      'the project that was not named is untouched');
    assert.deepEqual(onDisk(home, b).map((t) => t.id), ['t1', 't2']);
    assert.equal(onDisk(home, b)[1].spec, 'only for b');
  } finally { cleanup(); }
});

// ── the write latch ─────────────────────────────────────────────────────────

test('tickets-viewer: a write REFUSES once the test home has been cleared', async () => {
  // The hazard this closes: clodexHome() falls back to the operator's REAL
  // ~/.clodex, which was harmless while this plugin only read. A mutating call
  // that lands outside a live boot()/cleanup() pair — a test that forgot to
  // boot, one whose cleanup already ran, an await resolving late — would
  // rewrite the operator's live board, and there is no undo.
  const { host, home, cleanup } = boot();
  const key = mkProject(home, '/solo/latched');
  writeTicketsAt(home, key, [ticket('t1')]);
  // Cleanup is the state under test, so it runs HERE rather than in a finally:
  // this case is about what happens after the fixture is gone.
  cleanup();

  // The precondition, without which this passes for the wrong reason — a
  // refusal because the project vanished is not a refusal because the home did.
  assert.equal(viewerEngine._internals.clodexHome(), path.join(os.homedir(), '.clodex'),
    'ENTER: the override really is cleared, so an unlatched write would hit the real home');

  for (const [method, payload] of [
    ['add', { project: key, spec: 'this must never reach the real board' }],
    ['assign', { project: key, id: 't1', assignee: 'hand' }],
    ['close', { project: key, id: 't1' }],
    ['cancel', { project: key, id: 't1' }],
    ['editSpec', { project: key, id: 't1', spec: 'x' }],
  ]) {
    const res = await host.dispatch('tickets-viewer', method, [payload], 'desktop');
    assert.equal(res.ok, false, `${method} must refuse once the test home is cleared`);
    assert.match(res.error, /test clodex home was cleared/);
  }

  // Reads are deliberately NOT latched: the CLODEX_HOME case above reads with
  // the override cleared on purpose, and breaking that would trade one hazard
  // for a blind spot.
  const reads = await viewerEngine._internals.projects();
  assert.equal(reads.ok, true, 'reading the real home is still allowed');
});

// ── the shape of the surface ────────────────────────────────────────────────

test('tickets-viewer: the engine registers its reads and its writes, and nothing else', async () => {
  const { host, cleanup } = boot();
  try {
    const keys = host._dispatchKeys().filter((k) => k.startsWith('tickets-viewer:')).sort();
    // A row appearing here that the manifest also opens to the web surface is
    // the thing plugin-surface-gate.test.js cross-checks; a row appearing here
    // at all is a scope decision for the lead, not something to discover in
    // review. The five writers are deliberately absent from manifest.surfaces.
    assert.deepEqual(keys, [
      'tickets-viewer:add',
      'tickets-viewer:assign',
      'tickets-viewer:board',
      'tickets-viewer:cancel',
      'tickets-viewer:close',
      'tickets-viewer:editSpec',
      'tickets-viewer:projects',
      'tickets-viewer:sessions',
      'tickets-viewer:teams',
    ]);
  } finally { cleanup(); }
});

test('tickets-viewer: the writers are NOT reachable from the web surface', async () => {
  const { host, home, cleanup } = boot();
  try {
    const key = mkProject(home, '/solo/web');
    writeTicketsAt(home, key, [ticket('t1')]);
    const before = fs.readFileSync(boardFileFor(home, key), 'utf8');

    for (const [method, payload] of [
      ['add', { project: key, spec: 'from a browser' }],
      ['assign', { project: key, id: 't1', assignee: 'hand' }],
      ['close', { project: key, id: 't1' }],
      ['cancel', { project: key, id: 't1' }],
      ['editSpec', { project: key, id: 't1', spec: 'x' }],
    ]) {
      const res = await host.dispatch('tickets-viewer', method, [payload], 'web');
      assert.equal(res.ok, false, `${method} must not serve the web surface`);
    }
    // The refusal must be a refusal to ACT, not merely a refusal to answer.
    assert.equal(fs.readFileSync(boardFileFor(home, key), 'utf8'), before,
      'a web-surface write changes nothing on disk');

    // The accept half: the reads ARE web-reachable, which is what makes the
    // denials above meaningful rather than a blanket transport failure.
    const board = await host.dispatch('tickets-viewer', 'board', [key], 'web');
    assert.equal(board.ok, true, 'reads still serve the web surface');
  } finally { cleanup(); }
});

test('tickets-viewer: the session list offers seats a spec can actually reach', async () => {
  const { host, sessions, cleanup } = boot();
  try {
    addSession(sessions, 'zeta');
    addSession(sessions, 'alpha');
    // Bash sessions are private — no registry, no socket, not DM-able — so a
    // ticket assigned to one could never have its spec delivered.
    addSession(sessions, 'a-shell', { type: 'bash' });

    const res = await host.dispatch('tickets-viewer', 'sessions', [], 'desktop');
    assert.deepEqual(res.sessions, ['alpha', 'zeta'], 'sorted, and the bash shell is not offered');
  } finally { cleanup(); }
});

test('tickets-viewer: reading a board writes NOTHING to disk', async () => {
  const { host, home, teams, removals, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1')]);
    const key = keyOfTeam(dir);
    const file = boardFileFor(home, key);
    const boardDir = path.dirname(file);
    const before = fs.readFileSync(file, 'utf8');
    const beforeEntries = fs.readdirSync(boardDir).sort();

    await host.dispatch('tickets-viewer', 'projects', [], 'desktop');
    await host.dispatch('tickets-viewer', 'teams', [], 'desktop');
    await host.dispatch('tickets-viewer', 'sessions', [], 'desktop');
    await host.dispatch('tickets-viewer', 'board', [key], 'desktop');

    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the registry is byte-identical after a read');
    // A temp file left behind by the atomic writer would show up here, which is
    // the other thing this catches now that the module can write at all.
    assert.deepEqual(fs.readdirSync(boardDir).sort(), beforeEntries, 'no file was created beside it');
    assert.deepEqual(removals, [], 'the library seam is never touched');
  } finally { cleanup(); }
});
