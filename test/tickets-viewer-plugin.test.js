'use strict';
// tickets-viewer-plugin.test.js — the plugin's ENGINE half, driven through the
// REAL plugin host engine against a real temp teams tree.
//
// The property this file exists for is NOT "the board lists tickets". It is
// that a board which FAILED TO READ never renders as a board with nothing on
// it. tickets-store.js's load() collapses missing / unreadable / invalid-JSON /
// non-array into `[]` — correct for a writer that must not crash a session over
// a corrupt registry, fatal for a viewer. Most cases below are that distinction
// from one side or the other.
//
// The engine reads CLODEX_HOME on every call (not at require time), so these
// tests point it at a temp tree and need no module-cache surgery.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const viewerEngine = require('../plugins/tickets-viewer/engine');

const { DEFAULT_STALL_MS, WATCHDOG_MIN_MS, WATCHDOG_MAX_MS } = viewerEngine._internals;
const HOUR = 60 * 60 * 1000;

function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tv-home-'));
  const teams = path.join(home, 'teams');
  fs.mkdirSync(teams, { recursive: true });
  const prev = process.env.CLODEX_HOME;
  process.env.CLODEX_HOME = home;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tv-data-'));
  const removals = [];
  const host = createPluginHostEngine({
    manager: {
      sessions: new Map(),
      list: () => [],
      listForWorkspace: () => [],
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dataDir,
    fs, path,
    gitWorktree: {},
    // Declared so a plugin that tried to delete through the seam would be
    // RECORDED rather than merely refused — see the read-only case below.
    libraryKinds: { memory: (ref) => { removals.push(ref); return { ok: true }; } },
  });
  host.register('tickets-viewer', viewerEngine, { hostApi: HOST_API_VERSION });

  const cleanup = () => {
    if (prev === undefined) delete process.env.CLODEX_HOME; else process.env.CLODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { host, teams, removals, cleanup };
}

// A team directory is one carrying team.json — the same thing that makes it a
// team to core (team-manifest's TEAM_FILE). The default manifest is one core's
// loadManifest ACCEPTS, so a warning appearing anywhere below is a test that
// asked for one rather than a property of the fixture.
function mkTeam(teamsDir, name, teamJson = {}) {
  const dir = path.join(teamsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
    name, root: '/tmp', lead: 'lead', roles: { lead: {} }, ...teamJson,
  }));
  return dir;
}

function writeTickets(dir, tickets) {
  fs.writeFileSync(path.join(dir, 'tickets.json'), JSON.stringify(tickets, null, 2));
}

// Fields the PRODUCT does not compute are hand-written here; nothing this
// helper sets is something the engine derives. The engine's job is reading and
// shaping records that session-manager wrote, so a literal record IS the input.
function ticket(id, over = {}) {
  const now = Date.now();
  return {
    id, title: `title ${id}`, spec: 'spec', assignee: 'hand', opener: 'lead',
    state: 'open', openedAt: now - HOUR, closedAt: null,
    lastActivityAt: now - HOUR, nudgedAt: null, ...over,
  };
}

// ── empty is not broken ─────────────────────────────────────────────────────

test('tickets-viewer: a team with no tickets.json is EMPTY, not failed', async () => {
  const { host, teams, cleanup } = boot();
  try {
    mkTeam(teams, 'alpha');
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(res.ok, true, 'a team that never opened a ticket is a healthy empty board');
    assert.deepEqual(res.open, []);
    assert.deepEqual(res.recent, []);
  } finally { cleanup(); }
});

test('tickets-viewer: an UNPARSEABLE tickets.json fails loudly instead of reading as empty', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    fs.writeFileSync(path.join(dir, 'tickets.json'), '{ this is not json');
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
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
    fs.writeFileSync(path.join(dir, 'tickets.json'), '{"t1":{"state":"open"}}');
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(res.ok, false);
    assert.match(res.error, /ticket array/);
  } finally { cleanup(); }
});

test('tickets-viewer: non-object records inside a valid array are COUNTED, not silently dropped', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1'), 'garbage', null, 42]);
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(res.ok, true, 'one bad record does not fail a readable registry');
    assert.equal(res.open.length, 1);
    // A half-eaten registry would otherwise render as a shorter healthy board.
    assert.equal(res.counts.malformed, 3, 'the dropped records are reported');
  } finally { cleanup(); }
});

test('tickets-viewer: no teams DIRECTORY is "no teams", an unreadable one is an error', async () => {
  const { host, teams, cleanup } = boot();
  try {
    fs.rmSync(teams, { recursive: true, force: true });
    const none = await host.dispatch('tickets-viewer', 'teams', []);
    assert.deepEqual(none, { ok: true, teams: [] }, 'nothing has created a team yet');

    // A path that exists but is not a directory: readdir fails with ENOTDIR,
    // which is a real failure and must not read as "no teams".
    fs.writeFileSync(teams, 'not a directory');
    const broken = await host.dispatch('tickets-viewer', 'teams', []);
    assert.equal(broken.ok, false, 'an unreadable teams root is an error, not an empty list');
    assert.match(broken.error, /could not read/);
  } finally { cleanup(); }
});

test('tickets-viewer: one broken team does not hide the healthy ones', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const bad = mkTeam(teams, 'broken');
    fs.writeFileSync(path.join(bad, 'tickets.json'), 'nonsense');
    const good = mkTeam(teams, 'alpha');
    writeTickets(good, [ticket('t1')]);

    const res = await host.dispatch('tickets-viewer', 'teams', []);
    assert.equal(res.ok, true, 'the list survives a corrupt member');
    const byName = Object.fromEntries(res.teams.map((t) => [t.team, t]));
    assert.equal(byName.alpha.open, 1);
    // The broken row carries an error INSTEAD of a count — a `0 open` here is
    // the exact false green this plugin is built to avoid.
    assert.equal(byName.broken.open, undefined, 'a broken team must not report a count');
    assert.match(byName.broken.error, /not valid JSON/);
  } finally { cleanup(); }
});

test('tickets-viewer: a directory with no team.json is not listed as a team', async () => {
  const { host, teams, cleanup } = boot();
  try {
    mkTeam(teams, 'alpha');
    fs.mkdirSync(path.join(teams, 'stray-dir'), { recursive: true });
    const res = await host.dispatch('tickets-viewer', 'teams', []);
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

    const list = await host.dispatch('tickets-viewer', 'teams', []);
    const row = list.teams.find((t) => t.team === 'unreadable');
    assert.ok(row, 'the team must not disappear from the list');
    assert.match(row.error, /could not read team\.json/);
    assert.equal(row.open, undefined, 'a team that could not be read reports no count');

    const board = await host.dispatch('tickets-viewer', 'board', ['unreadable']);
    assert.equal(board.ok, false);
    assert.match(board.error, /could not read team\.json/);
    // Distinct from the absent case, which is the whole point of the split.
    const gone = await host.dispatch('tickets-viewer', 'board', ['no-such-team']);
    assert.match(gone.error, /no team/);
  } finally { cleanup(); }
});

test('tickets-viewer: a team.json core would REJECT is warned about, not rendered healthy', async () => {
  const { host, teams, cleanup } = boot();
  try {
    // loadManifest throws on each of these, so the app cannot resolve this team
    // at all. The tickets are real and still shown — this is not a false green
    // about tickets — but a board with no warning would let an unusable team
    // look entirely fine.
    const cases = [
      [{ root: 'relative/path', lead: 'lead', roles: { lead: {} } }, /absolute path/],
      [{ root: '/tmp', lead: '', roles: { lead: {} } }, /"lead" is not a seat name/],
      [{ root: '/tmp', lead: 'lead', roles: [] }, /"roles" is not an object/],
      [{ root: '/tmp', lead: 'lead', roles: { hand: {} } }, /no "lead" role/],
    ];
    for (const [manifest, re] of cases) {
      const dir = mkTeam(teams, 'bad');
      fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(manifest));
      writeTickets(dir, [ticket('t1')]);
      const res = await host.dispatch('tickets-viewer', 'board', ['bad']);
      assert.equal(res.ok, true, 'the tickets are readable, so the board renders');
      assert.equal(res.open.length, 1);
      assert.match(res.warning, re);
      const list = await host.dispatch('tickets-viewer', 'teams', []);
      assert.match(list.teams.find((t) => t.team === 'bad').warning, re);
    }

    // A team.json that is not JSON at all: same treatment, not a board failure.
    const dir = mkTeam(teams, 'bad');
    fs.writeFileSync(path.join(dir, 'team.json'), '{ nope');
    writeTickets(dir, [ticket('t1')]);
    const res = await host.dispatch('tickets-viewer', 'board', ['bad']);
    assert.equal(res.ok, true);
    assert.match(res.warning, /not valid JSON/);
    assert.equal(res.stallMs, DEFAULT_STALL_MS, 'an unusable manifest still gets core\'s default threshold');

    // The accept half, which is what catches a warning that fires on everything.
    const okDir = mkTeam(teams, 'good', { root: '/tmp', lead: 'lead', roles: { lead: {} } });
    writeTickets(okDir, [ticket('t1')]);
    const good = await host.dispatch('tickets-viewer', 'board', ['good']);
    assert.equal(good.warning, '', 'a manifest core accepts carries no warning');
  } finally { cleanup(); }
});

// ── containment ─────────────────────────────────────────────────────────────

test('tickets-viewer: a team name that escapes the teams root is REFUSED', async () => {
  const { host, teams, cleanup } = boot();
  try {
    mkTeam(teams, 'alpha');
    // Assert the REFUSAL, not that some outside file survived: a test that only
    // checks "nothing was read" passes for an implementation that read the
    // wrong directory and found it empty.
    for (const name of ['.', '..', '../..', '../alpha', 'sub/alpha', '', null, 7]) {
      const res = await host.dispatch('tickets-viewer', 'board', [name]);
      assert.equal(res.ok, false, `board(${JSON.stringify(name)}) must be refused`);
      assert.match(res.error, /valid team name/);
    }
    // `...` is deliberately NOT in that list. It resolves to a direct child of
    // the teams root, so containment has nothing to say about it — it is a
    // legal directory name that merely cannot be a legal TEAM name. It is
    // refused one step later, by not existing, and so is any other name for a
    // team that is not there. A nonexistent team rendering as an empty board is
    // the same false green as a corrupt one.
    for (const name of ['...', 'no-such-team']) {
      const res = await host.dispatch('tickets-viewer', 'board', [name]);
      assert.equal(res.ok, false, `board(${JSON.stringify(name)}) must be refused`);
      assert.match(res.error, /no team/);
    }
    // The accept half, which is what catches an over-eager guard: dots in a
    // legal position are legal team names.
    mkTeam(teams, 'my.team');
    const ok = await host.dispatch('tickets-viewer', 'board', ['my.team']);
    assert.equal(ok.ok, true, 'a dotted team name is still a valid team name');
  } finally { cleanup(); }
});

// ── stalled work is what the board is for ───────────────────────────────────

test('tickets-viewer: open tickets sort QUIETEST first', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { lastActivityAt: now - 60 * 1000 }),
      ticket('t2', { lastActivityAt: now - 5 * HOUR }),
      ticket('t3', { lastActivityAt: now - 30 * 1000 }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.deepEqual(res.open.map((t) => t.id), ['t2', 't1', 't3'],
      'the ticket nobody has touched leads the board');
  } finally { cleanup(); }
});

test('tickets-viewer: a ticket with no usable timestamp sorts to the TOP', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { lastActivityAt: now - 5 * HOUR }),
      ticket('t2', { lastActivityAt: null, openedAt: null }),
    ]);
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
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

    const a = await host.dispatch('tickets-viewer', 'board', ['default-team']);
    assert.equal(a.stallMs, 30 * 60 * 1000);
    assert.equal(a.open[0].stalled, true);

    const b = await host.dispatch('tickets-viewer', 'board', ['slow-team']);
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

    const a = await host.dispatch('tickets-viewer', 'board', ['tiny']);
    assert.equal(a.stallMs, WATCHDOG_MIN_MS, 'below the floor reads as the floor');
    assert.equal(a.open[0].stalled, false, 'quiet under the FLOORED threshold is not stalled');

    const b = await host.dispatch('tickets-viewer', 'board', ['huge']);
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
      '{"name":"inf","root":"/tmp","lead":"lead","roles":{"lead":{}},"watchdogMs":1e400}');
    writeTickets(inf, [ticket('t1', { lastActivityAt: now - 5 * HOUR })]);

    const res = await host.dispatch('tickets-viewer', 'board', ['inf']);
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.stalled, false, 'an unassigned ticket has nobody to have gone quiet');
    assert.equal(byId.t1.backlog, true, 'it is backlog, which is its own state');
    // The age is still computed and still shown — knowing a backlog ticket has
    // sat for two days is the useful part; calling it a stall is not.
    assert.ok(byId.t1.quietMs >= 39 * HOUR, 'backlog age is still measured');
    assert.equal(byId.t2.stalled, true, 'an assigned ticket past the threshold still stalls');
    assert.equal(byId.t2.backlog, false);

    assert.equal(res.counts.backlog, 1);
    const list = await host.dispatch('tickets-viewer', 'teams', []);
    const row = list.teams.find((t) => t.team === 'alpha');
    // The two chips are separate numbers on purpose: assign versus chase.
    assert.equal(row.stalled, 1, 'the sidebar stall count excludes backlog too');
    assert.equal(row.backlog, 1);
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    const byId = Object.fromEntries(res.open.map((t) => [t.id, t]));
    assert.equal(byId.t1.taskDir, 'tasks/some-task');
    assert.equal(byId.t2.taskDir, '', 'an absent taskDir is an empty string, never undefined');
  } finally { cleanup(); }
});

test('tickets-viewer: an unassigned ticket keeps an empty assignee rather than a placeholder', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1', { assignee: null })]);
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    // The wording of "unassigned" belongs to the renderer; baking it in here
    // would put a user-facing string in the engine and hide the null.
    assert.equal(res.open[0].assignee, '');
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
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
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(res.recent.length, 10, 'core\'s RECENT_DONE_CAP');
    assert.equal(res.counts.recentOver, 4);
  } finally { cleanup(); }
});

test('tickets-viewer: a state this app never writes is surfaced, not swallowed', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1'), ticket('t2', { state: 'archived' })]);
    const res = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(res.open.length, 1);
    // Invisible in every other listing too — the board is where it shows up.
    assert.equal(res.counts.unknownState, 1);
  } finally { cleanup(); }
});

test('tickets-viewer: the per-team open count agrees with the board it opens', async () => {
  const { host, teams, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    const now = Date.now();
    writeTickets(dir, [
      ticket('t1', { lastActivityAt: now - 5 * HOUR }),
      ticket('t2', { lastActivityAt: now - 10 * 1000 }),
      ticket('t3', { state: 'done', closedAt: now }),
    ]);
    const list = await host.dispatch('tickets-viewer', 'teams', []);
    const row = list.teams.find((t) => t.team === 'alpha');
    const board = await host.dispatch('tickets-viewer', 'board', ['alpha']);
    assert.equal(row.open, board.open.length, 'the sidebar count is the board it opens');
    assert.equal(row.stalled, board.open.filter((t) => t.stalled).length);
    assert.equal(row.stalled, 1);
  } finally { cleanup(); }
});

// ── read-only, structurally ─────────────────────────────────────────────────

test('tickets-viewer: the engine registers exactly two rows, both reads', async () => {
  const { host, cleanup } = boot();
  try {
    const keys = host._dispatchKeys().filter((k) => k.startsWith('tickets-viewer:')).sort();
    // A close/assign row appearing here is the v1 scope boundary breaking, and
    // it is a decision for the lead, not something to discover in review.
    assert.deepEqual(keys, ['tickets-viewer:board', 'tickets-viewer:teams']);
  } finally { cleanup(); }
});

test('tickets-viewer: reading a board writes NOTHING to disk', async () => {
  const { host, teams, removals, cleanup } = boot();
  try {
    const dir = mkTeam(teams, 'alpha');
    writeTickets(dir, [ticket('t1')]);
    const file = path.join(dir, 'tickets.json');
    const before = fs.readFileSync(file, 'utf8');
    const beforeEntries = fs.readdirSync(dir).sort();

    await host.dispatch('tickets-viewer', 'teams', []);
    await host.dispatch('tickets-viewer', 'board', ['alpha']);

    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the registry is byte-identical after a read');
    assert.deepEqual(fs.readdirSync(dir).sort(), beforeEntries, 'no file was created beside it');
    assert.deepEqual(removals, [], 'the library seam is never touched');
  } finally { cleanup(); }
});
