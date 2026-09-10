'use strict';
// team-prompt-rows.test.js — t790: a team's own prompts under
// ~/.clodex/teams/<name>/prompts/{system,append}/ are rows of listAllPrompts,
// and the library row a team copy shadows says so.
//
// The failure this closes is the prompt twin of t748's: engine.js
// readSystemPromptBody/readAppendBodies resolve the TEAM file first, so an
// operator editing the library row the drawer showed changed a file that team's
// seats never read.
//
// listAllPrompts is driven through a REAL createEngine over a scratch
// registryDir, not a stub: the shadow relation is computed by walking two real
// directories, and a fixture that handed the function its own answer would pass
// against a version that never grew the team branch.
//
// Every shadow subject ENTERs on the team row being PRESENT before asserting the
// library row's `shadowedBy` — "the team dir was read" and "the shadow was
// computed" are otherwise the same observation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A scratch clodex home with a library prompts dir and, optionally, team dirs
// each holding prompts/<kind>/. `registryDir` is what the app hangs teams AND
// the library off, so both halves of the shadow relation come from one root.
// A file value of `null` means "make a DIRECTORY by that name" — the unreadable
// case, which must be a visible row rather than a throw or a silent skip.
function mkHome(prefix, { library = {}, teams = {} } = {}) {
  const tmp = mkTmpRoot(prefix);
  const registryDir = path.join(tmp, 'clodex-home');
  for (const [kind, files] of Object.entries(library)) {
    const dir = path.join(registryDir, 'library', 'prompts', kind);
    fs.mkdirSync(dir, { recursive: true });
    for (const [stem, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, `${stem}.md`), body);
    }
  }
  for (const [team, kinds] of Object.entries(teams)) {
    const dir = path.join(registryDir, 'teams', team);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({
      name: team, root: tmp, lead: `${team}-lead`, roles: {},
    }));
    for (const [kind, files] of Object.entries(kinds)) {
      fs.mkdirSync(path.join(dir, 'prompts', kind), { recursive: true });
      for (const [stem, body] of Object.entries(files)) {
        const p = path.join(dir, 'prompts', kind, `${stem}.md`);
        if (body === null) fs.mkdirSync(p, { recursive: true });
        else fs.writeFileSync(p, body);
      }
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

const SPEC = {
  library: { system: { a: 'library a\n' } },
  teams: { x: { system: { a: 'team a\n' }, append: { b: 'team b\n' } } },
};

test('a team-owned prompt is its own row, after the library rows', () => {
  const { eng } = mkEngine('t790-rows-', SPEC);
  const rows = eng.listAllPrompts('system');

  const team = rows.find((r) => r.id === 'team:x:system:a');
  assert.ok(team, `the team copy must be listed — got ${JSON.stringify(rows.map((r) => r.id || r.name))}`);
  assert.strictEqual(team.team, 'x', 'the row names the team that owns it');
  assert.strictEqual(team.teamName, 'x');
  assert.strictEqual(team.kind, 'system');
  assert.strictEqual(team.body, 'team a\n', 'the row carries the TEAM file\'s body, not the library one\'s');

  const lib = rows.find((r) => r.name === 'a' && !r.team);
  assert.ok(lib, 'the library row survives beside it');
  assert.strictEqual(lib.body, 'library a\n');
  assert.ok(rows.indexOf(lib) < rows.indexOf(team), 'library rows come before team rows');

  // ENTER-anchored count: exactly one library row and one team row for `system`,
  // so a version that listed the team dir twice (or leaked the append row into
  // the system listing) fails here rather than passing on a find().
  assert.strictEqual(rows.filter((r) => r.team).length, 1,
    `one team row for kind system — got ${JSON.stringify(rows.filter((r) => r.team).map((r) => r.id))}`);
});

test('a library row shadowed by a team copy carries shadowedBy: [team]', () => {
  const { eng } = mkEngine('t790-shadow-', {
    library: { system: { a: 'library a\n', solo: 'library solo\n' } },
    teams: { x: { system: { a: 'team a\n' } } },
  });
  const rows = eng.listAllPrompts('system');

  // ENTER: the shadow is only meaningful if the team row that causes it exists.
  assert.ok(rows.some((r) => r.id === 'team:x:system:a'),
    'the team row must be present before its shadow means anything');

  const shadowed = rows.find((r) => r.name === 'a' && !r.team);
  assert.deepStrictEqual(shadowed.shadowedBy, ['x'],
    'the shadowed library row names the team, as a literal list');

  const solo = rows.find((r) => r.name === 'solo');
  assert.ok(!('shadowedBy' in solo),
    `an unshadowed library row carries NO shadowedBy key — got ${JSON.stringify(solo)}`);
});

test('the shadow is keyed on kind+stem, not the stem alone', () => {
  const { eng } = mkEngine('t790-kind-', {
    library: { system: { a: 'library system a\n' }, append: { a: 'library append a\n' } },
    teams: { x: { append: { a: 'team append a\n' } } },
  });
  const rows = eng.listAllPrompts();

  // ENTER: the team's APPEND copy is the only team row here.
  assert.ok(rows.some((r) => r.id === 'team:x:append:a'), 'the team append row is present');

  const libAppend = rows.find((r) => r.name === 'a' && r.kind === 'append' && !r.team);
  assert.deepStrictEqual(libAppend.shadowedBy, ['x'], 'the append library row is shadowed');
  const libSystem = rows.find((r) => r.name === 'a' && r.kind === 'system' && !r.team);
  assert.ok(!('shadowedBy' in libSystem),
    'the SYSTEM row of the same stem is a different file and is NOT shadowed');
});

test('listAllPrompts() with no kind includes both kinds of team row', () => {
  const { eng } = mkEngine('t790-both-', SPEC);
  const rows = eng.listAllPrompts();
  const teamRows = rows.filter((r) => r.team).map((r) => r.id).sort();
  assert.deepStrictEqual(teamRows, ['team:x:append:b', 'team:x:system:a'],
    'both team kinds are listed when no kind is asked for');
});

test('an unreadable team prompt is a visible row, not a throw or a silent skip', () => {
  const { eng } = mkEngine('t790-bad-', {
    library: { system: { seat: 'library seat\n' } },
    teams: { x: { system: { seat: null, other: 'team other\n' } } },
  });
  const rows = eng.listAllPrompts('system');

  const bad = rows.find((r) => r.id === 'team:x:system:seat');
  assert.ok(bad, 'the broken file still gets a row — dropping it would hide which file a seat reads');
  assert.strictEqual(bad.unreadable, true);
  assert.strictEqual(bad.body, '', 'an unreadable row still carries a string body the drawer can slice');
  assert.strictEqual(bad.team, 'x');

  assert.ok(rows.find((r) => r.id === 'team:x:system:other'),
    'the team\'s other rows are intact');
  assert.deepStrictEqual(rows.find((r) => r.name === 'seat' && !r.team).shadowedBy, ['x'],
    'an unreadable copy still shadows: it is what the resolver would find first');
});

test('a team with no prompts dir contributes no rows and no shadows', () => {
  const { tmp, registryDir } = mkHome('t790-empty-', { library: { system: { seat: 'x\n' } } });
  const dir = path.join(registryDir, 'teams', 'bare');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ name: 'bare', root: tmp, lead: 'l', roles: {} }));
  const rows = engineOver(registryDir, path.join(tmp, 'userdata')).listAllPrompts('system');
  assert.ok(!rows.some((r) => r.team), 'no team rows');
  assert.ok(!('shadowedBy' in rows.find((r) => r.name === 'seat')));
});

// The drawer is source-shape-pinned rather than DOM-driven, exactly like the
// template twin in team-template-drawer.test.js: the ORDER of the groups and the
// exact note sentence are what a reader of the drawer relies on, and both are
// single expressions in one function.
const DRAWER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'library-drawers.js'), 'utf8');

test('the prompts drawer separates team rows from library rows and shows the shadow note', () => {
  assert.ok(/const items = all\.filter\(\(p\) => !p\.team\)/.test(DRAWER_SRC),
    'library rows exclude team-owned rows, or a team copy would draw twice');
  assert.ok(/Delete team \$\{team\}'s prompt/.test(DRAWER_SRC),
    'a team prompt row offers its own Delete');
  assert.ok(/removeTeamPrompt\(team, p\.kind, p\.name\)/.test(DRAWER_SRC),
    'a team row deletes through the team IPC, not the library one');
  assert.ok(/openPromptEditor\(p, null, \{ team: p\.team \}\)/.test(DRAWER_SRC),
    'a team row opens the editor in team-owner mode');
  assert.ok(/saveTeamPrompt\(editingPromptTeam, kind, name, body\)/.test(DRAWER_SRC),
    'the editor saves a team-owned prompt into the team dir');
  assert.ok(/Edit Prompt — team \$\{editingPromptTeam\}/.test(DRAWER_SRC),
    'the editor title names the team whose file is being written');
  assert.ok(/unreadable — Edit and save replaces the file/.test(DRAWER_SRC),
    'an unreadable team row previews what Edit would do to it');
});

// t793: the twin of the templates branch (team-template-drawer.test.js). The
// prompts payload carries `kind` as well, and kind+name is the file identity —
// a lookup that dropped it would open the append copy for a system row.
test('openPromptsDrawer routes an arg.team payload to the team row before the plugin lookup', () => {
  const fn = DRAWER_SRC.slice(DRAWER_SRC.indexOf('async function openPromptsDrawer'));
  const body = fn.slice(0, fn.indexOf('function closePromptsDrawer'));
  const iTeam = body.indexOf('if (arg.team)');
  const iPlugin = body.indexOf('if (arg.plugin)');
  assert.ok(iTeam > 0, 'openPromptsDrawer branches on arg.team');
  assert.ok(iPlugin > iTeam, 'the team branch runs BEFORE the plugin branch');
  assert.ok(/x\.team === arg\.team\s*\n?\s*&& x\.kind === kind && x\.name === arg\.name/.test(body),
    'the row is found by team, kind AND name');
  assert.ok(/openTeamPrompt\(row\)/.test(body),
    'it opens through openTeamPrompt, the same call the drawer\'s own Team group rows make');
});

test('a team prompt row offers no Inject — that is a library affordance', () => {
  // The team block runs from its `Team ${team}` header to the plugin groups.
  const start = DRAWER_SRC.indexOf('promptsList.appendChild(head);');
  const end = DRAWER_SRC.indexOf('appendBundleGroups(promptsList, groups');
  assert.ok(start > 0 && end > start, 'the team group sits before the plugin groups');
  const block = DRAWER_SRC.slice(start, end);
  assert.ok(!/data-action="inject"/.test(block),
    'no Inject button on a team row: Inject pastes into the active terminal, which the team dir has nothing to do with');
});

// createEngine starts background timers that keep the loop alive.
const { after } = require('node:test');
after(() => { setImmediate(() => process.exit(0)); });
