'use strict';
// team-template-drawer.test.js — t748: a team-owned template (the copy Gather
// makes under ~/.clodex/teams/<name>/templates/) is a row of its own in the
// Templates drawer, edited and deleted where it lives, and the library row it
// shadows says so.
//
// The failure this closes: the drawer only ever listed the LIBRARY copy, while
// team-tickets.js `_templateShape` resolves the team copy first — so an operator
// editing the row the drawer showed changed a file no spawn reads, silently.
//
// listAllTemplates is driven through a REAL createEngine over a scratch
// registryDir, not a stub: the shadow relation is computed by walking two real
// directories, and a fixture that hands the function its own answer would pass
// against a version that never grew the team branch.
//
// Every shadow subject ENTERs on the team row being PRESENT before asserting the
// library row's `shadowedBy` — "the team dir was read" and "the shadow was
// computed" are otherwise the same observation, and an engine that listed no
// team rows at all would satisfy an absence assertion on its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A scratch clodex home with a library templates dir and, optionally, team dirs
// each holding templates/. `registryDir` is what the app hangs teams AND the
// library off, so both halves of the shadow relation come from one root.
function mkHome(prefix, { library = {}, teams = {} } = {}) {
  const tmp = mkTmpRoot(prefix);
  const registryDir = path.join(tmp, 'clodex-home');
  const libDir = path.join(registryDir, 'library', 'templates');
  fs.mkdirSync(libDir, { recursive: true });
  for (const [stem, body] of Object.entries(library)) {
    fs.writeFileSync(path.join(libDir, `${stem}.json`), JSON.stringify(body, null, 2));
  }
  for (const [team, files] of Object.entries(teams)) {
    const dir = path.join(registryDir, 'teams', team);
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
      name: team, root: tmp, lead: `${team}-lead`, roles: {},
    }));
    for (const [stem, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, 'templates', `${stem}.json`),
        typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
  }
  return { tmp, registryDir };
}

function engineOver(registryDir, userDataPath) {
  return createEngine({
    userDataPath,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
}

function mkEngine(prefix, spec) {
  const { tmp, registryDir } = mkHome(prefix, spec);
  return { tmp, registryDir, eng: engineOver(registryDir, path.join(tmp, 'userdata')) };
}

test('a team-owned template is its own row, after the library rows', () => {
  const { eng } = mkEngine('t748-rows-', {
    library: { 'clodex-hand-seat': { type: 'claude', cwd: '/lib' } },
    teams: { clodex: { 'clodex-hand-seat': { type: 'claude', cwd: '/team' } } },
  });
  const rows = eng.listAllTemplates();

  const team = rows.find((r) => r.id === 'team:clodex:clodex-hand-seat');
  assert.ok(team, `the team copy must be listed — got ${JSON.stringify(rows.map((r) => r.id))}`);
  assert.strictEqual(team.team, 'clodex', 'the row names the team that owns it');
  assert.strictEqual(team.teamName, 'clodex');
  assert.strictEqual(team.name, 'clodex-hand-seat', 'the stem is the row name');
  assert.strictEqual(team.cwd, '/team', 'the row carries the TEAM file\'s body, not the library one\'s');

  const lib = rows.find((r) => r.id === 'clodex-hand-seat');
  assert.ok(lib, 'the library row survives beside it');
  assert.strictEqual(lib.cwd, '/lib');
  assert.ok(rows.indexOf(lib) < rows.indexOf(team), 'library rows come before team rows');
});

test('a library row shadowed by a team copy carries shadowedBy: [team]', () => {
  const { eng } = mkEngine('t748-shadow-', {
    library: { 'clodex-hand-seat': { type: 'claude' }, solo: { type: 'claude' } },
    teams: { clodex: { 'clodex-hand-seat': { type: 'claude' } } },
  });
  const rows = eng.listAllTemplates();

  // ENTER: the shadow is only meaningful if the team row that causes it exists.
  assert.ok(rows.some((r) => r.id === 'team:clodex:clodex-hand-seat'),
    'the team row must be present before its shadow means anything');

  const shadowed = rows.find((r) => r.id === 'clodex-hand-seat');
  assert.deepStrictEqual(shadowed.shadowedBy, ['clodex'],
    'the shadowed library row names the team, as a literal list');

  const solo = rows.find((r) => r.id === 'solo');
  assert.ok(!('shadowedBy' in solo),
    `an unshadowed library row carries NO shadowedBy key — got ${JSON.stringify(solo)}`);
});

test('two teams holding the same stem both name themselves on the library row', () => {
  const { eng } = mkEngine('t748-two-', {
    library: { seat: { type: 'claude' } },
    teams: { alpha: { seat: { type: 'claude' } }, beta: { seat: { type: 'codex' } } },
  });
  const rows = eng.listAllTemplates();
  assert.ok(rows.some((r) => r.id === 'team:alpha:seat'), 'ENTER: alpha row present');
  assert.ok(rows.some((r) => r.id === 'team:beta:seat'), 'ENTER: beta row present');
  assert.deepStrictEqual(rows.find((r) => r.id === 'seat').shadowedBy, ['alpha', 'beta']);
});

test('an unparseable team template is a visible unreadable row, not a silent skip', () => {
  const { eng } = mkEngine('t748-bad-', {
    library: { seat: { type: 'claude' } },
    teams: { clodex: { seat: '{ not json', other: { type: 'claude' } } },
  });
  const rows = eng.listAllTemplates();

  const bad = rows.find((r) => r.id === 'team:clodex:seat');
  assert.ok(bad, 'the broken file still gets a row — dropping it would hide which file a seat reads');
  assert.strictEqual(bad.unreadable, true);
  assert.strictEqual(bad.team, 'clodex');

  assert.ok(rows.find((r) => r.id === 'team:clodex:other'),
    'the team\'s other rows are intact');
  assert.deepStrictEqual(rows.find((r) => r.id === 'seat').shadowedBy, ['clodex'],
    'an unreadable copy still shadows: it is what the resolver would find first');
});

test('a team with no templates dir contributes no rows and no shadows', () => {
  const { tmp, registryDir } = mkHome('t748-empty-', { library: { seat: { type: 'claude' } } });
  const dir = path.join(registryDir, 'teams', 'bare');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ name: 'bare', root: tmp, lead: 'l', roles: {} }));
  const rows = engineOver(registryDir, path.join(tmp, 'userdata')).listAllTemplates();
  assert.ok(!rows.some((r) => r.team), 'no team rows');
  assert.ok(!('shadowedBy' in rows.find((r) => r.id === 'seat')));
});

// The drawer is source-shape-pinned rather than DOM-driven: the ORDER of the two
// groups and the exact note sentence are what a reader of the drawer relies on,
// and both are single expressions in one function. `assert.ok(RE.test(src))`
// rather than assert.match so a failure does not format the whole file into the
// diff.
const DRAWER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'library-drawers.js'), 'utf8');

test('the drawer renders the team group before the plugin groups', () => {
  const teamHeader = DRAWER_SRC.indexOf('`Team ${team}`');
  const pluginGroups = DRAWER_SRC.indexOf("appendBundleGroups(templatesListEl, groups");
  assert.ok(teamHeader > 0, 'the drawer builds a `Team <name>` header');
  assert.ok(pluginGroups > 0, 'the drawer still appends the plugin bundle groups');
  assert.ok(teamHeader < pluginGroups,
    'team groups are emitted BEFORE the plugin groups, so the drawer reads library → team → plugin');
});

test('the drawer separates team rows from library rows and shows the shadow note', () => {
  assert.ok(/!t\.plugin && !t\.team/.test(DRAWER_SRC),
    'library rows exclude team-owned rows, or a team copy would draw twice');
  assert.ok(/Shadowed by team /.test(DRAWER_SRC),
    'a shadowed library row carries the note naming the team');
  assert.ok(/edits here do not reach that team's seats/.test(DRAWER_SRC),
    'the note says WHY it matters, not just that a copy exists');
  assert.ok(/openTemplateEditor\(tpl, null, \{ team: tpl\.team \}\)/.test(DRAWER_SRC),
    'a team row opens the editor in team-owner mode');
  assert.ok(/removeTeamTemplate\(team, t\.name\)/.test(DRAWER_SRC),
    'a team row deletes through the team IPC, not the library one');
});

// t793: the Library menu's team rows send `{team, name}`, and only the branch
// below tells that apart from the plugin `{plugin, name}` payload — both are
// objects, and `bundleTarget` answers for a plugin that is not there by returning
// nothing, so a missing branch opens NOTHING and looks like a dead menu row.
// Source-shape because the drawer is DOM-bound; the payload itself is asserted
// from the menu side in app-menus-plugins.test.js.
test('openTemplatesDrawer routes an arg.team payload to the team row before the plugin lookup', () => {
  const fn = DRAWER_SRC.slice(DRAWER_SRC.indexOf('async function openTemplatesDrawer'));
  const body = fn.slice(0, fn.indexOf('function closeTemplatesDrawer'));
  const iTeam = body.indexOf('if (arg.team)');
  const iBundle = body.indexOf("bundleTarget('templates', arg)");
  assert.ok(iTeam > 0, 'openTemplatesDrawer branches on arg.team');
  assert.ok(iBundle > iTeam, 'the team branch runs BEFORE the plugin lookup');
  assert.ok(/x\.team === arg\.team && x\.name === arg\.name/.test(body),
    'the row is found by team AND name — a bare name matches another team\'s copy');
  assert.ok(/openTeamTemplate\(row\)/.test(body),
    'it opens through openTeamTemplate, the same call the drawer\'s own Team group rows make');
});

// The two name-resolving consumers must NOT see team rows: they match by bare
// stem across every team, so admitting them lets one team's copy answer for
// another's. Source-shape because both are one-line filters whose absence is
// invisible from any fixture that installs a single team.
test('the by-name template consumers fence team rows out', () => {
  const tickets = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  assert.ok(/listAllTemplates\(\)\.filter\(\(t\) => t && !t\.team\)/.test(tickets),
    'team-tickets allTemplates() drops team rows before matching by name');
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.ok(/listTemplates: \(\) => \(listAllTemplates \? listAllTemplates\(\)\.filter\(\(t\) => !t\.team\)/.test(ipc),
    'team:preflight is handed library+plugin rows only; its team copy comes from readTeamTemplate');
});

// createEngine starts background timers that keep the loop alive.
const { after } = require('node:test');
after(() => { setImmediate(() => process.exit(0)); });
