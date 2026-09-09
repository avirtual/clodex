'use strict';
// team-prompt-save-ipc.test.js — t790: prompts:saveTeam / prompts:removeTeam
// write and delete inside ~/.clodex/teams/<name>/prompts/<kind>/, and
// team:rolePrompts offers a team's own system stems instead of calling them
// missing.
//
// The refusals are asserted against the DISK, not against the return envelope: a
// handler that answered {ok:false} while having already created the directory
// would satisfy an envelope-only test, and "never creates the team dir" is the
// property that keeps a typo in a save from minting a team. Same rule as the
// template twin in team-template-save-ipc.test.js.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A real teams dir on disk plus the handler table registered over it. Only the
// deps these handlers touch are real; a Proxy answers everything else with an
// inert stub, the pattern team-frontdoor-seam.test.js established.
//
// `listAllPrompts` is the ENGINE function under a scratch root in the engine
// test; here it is the thin fixture the handlers merely forward to, so this file
// pins the HANDLER's behaviour (which channel writes where, which rows reach
// rolePrompts) rather than re-testing the merge.
function mkBox({ teams = ['clodex'], teamPrompts = [], library = [] } = {}) {
  const tmp = mkTmpRoot('t790-ipc-');
  const teamsDir = path.join(tmp, 'teams');
  for (const t of teams) {
    fs.mkdirSync(path.join(teamsDir, t, 'prompts', 'system'), { recursive: true });
    fs.mkdirSync(path.join(teamsDir, t, 'prompts', 'append'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, t, 'team.json'),
      JSON.stringify({ name: t, root: tmp, lead: `${t}-lead`, roles: {} }));
  }
  const handlers = {};
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    fs, path,
    teamsDir,
    listTeams: () => fs.readdirSync(teamsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    listAllPrompts: (kind) => [...library, ...teamPrompts]
      .filter((p) => !kind || p.kind === kind),
    promptLibrary: { list: (kind) => library.filter((p) => !kind || p.kind === kind) },
    refreshAppMenu: () => {},
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) });
  registerIpcHandlers(deps);
  return { tmp, teamsDir, handlers };
}

const fileFor = (teamsDir, team, kind, stem) =>
  path.join(teamsDir, team, 'prompts', kind, `${stem}.md`);

test('saveTeam writes the body verbatim into the team\'s prompts dir', () => {
  const { teamsDir, handlers } = mkBox();
  const body = '---\nrail: append\n---\n\nbe brief.\n';
  const res = handlers['prompts:saveTeam']({}, 'clodex', 'append', 'n', body);

  assert.strictEqual(res.ok, true, `save must succeed — got ${JSON.stringify(res)}`);
  assert.strictEqual(fs.readFileSync(fileFor(teamsDir, 'clodex', 'append', 'n'), 'utf8'), body,
    'the bytes are the body as given — a prompt file is not reformatted');
  assert.ok(Array.isArray(res.prompts), 'the reply carries the refreshed list');
});

test('saveTeam writes the kind it was given, not a fixed one', () => {
  const { teamsDir, handlers } = mkBox();
  handlers['prompts:saveTeam']({}, 'clodex', 'system', 's', 'system body\n');
  assert.ok(fs.existsSync(fileFor(teamsDir, 'clodex', 'system', 's')), 'the system file exists');
  assert.ok(!fs.existsSync(fileFor(teamsDir, 'clodex', 'append', 's')),
    'and nothing was written under the other kind');
});

test('saveTeam refuses an unknown team and creates NOTHING', () => {
  const { teamsDir, handlers } = mkBox();
  const res = handlers['prompts:saveTeam']({}, 'nosuch', 'system', 's', 'body\n');
  assert.strictEqual(res.ok, false, 'an unknown team is a refusal');
  assert.ok(!fs.existsSync(path.join(teamsDir, 'nosuch')),
    'the team directory must NOT exist — a save may never mint a team');
});

test('saveTeam refuses an unknown kind and writes nothing', () => {
  const { teamsDir, handlers } = mkBox();
  const res = handlers['prompts:saveTeam']({}, 'clodex', 'templates', 's', 'body\n');
  assert.strictEqual(res.ok, false, 'only system and append are prompt kinds');
  assert.ok(!fs.existsSync(path.join(teamsDir, 'clodex', 'prompts', 'templates')),
    'no directory was minted for the bogus kind');
});

for (const bad of ['..', '.', '../evil', 'a/b', 'a\\b', 'has:colon', '', 'x'.repeat(65)]) {
  test(`saveTeam refuses the stem ${JSON.stringify(bad)} and writes nothing`, () => {
    const { teamsDir, handlers } = mkBox();
    const before = fs.readdirSync(path.join(teamsDir, 'clodex', 'prompts', 'system'));
    const res = handlers['prompts:saveTeam']({}, 'clodex', 'system', bad, 'body\n');
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.deepStrictEqual(fs.readdirSync(path.join(teamsDir, 'clodex', 'prompts', 'system')), before,
      'the prompts dir is untouched');
    assert.ok(!fs.existsSync(path.join(teamsDir, 'clodex', 'prompts', 'system.md')),
      'nothing escaped the prompts dir');
  });
}

test('saveTeam refuses an empty body — a prompt that composes nothing is a mistake', () => {
  const { teamsDir, handlers } = mkBox();
  const res = handlers['prompts:saveTeam']({}, 'clodex', 'system', 's', '   \n');
  assert.strictEqual(res.ok, false);
  assert.ok(!fs.existsSync(fileFor(teamsDir, 'clodex', 'system', 's')), 'no file was written');
});

test('removeTeam deletes the team copy and leaves the rest of the dir', () => {
  const { teamsDir, handlers } = mkBox();
  fs.writeFileSync(fileFor(teamsDir, 'clodex', 'system', 'gone'), 'a\n');
  fs.writeFileSync(fileFor(teamsDir, 'clodex', 'system', 'kept'), 'b\n');
  const res = handlers['prompts:removeTeam']({}, 'clodex', 'system', 'gone');
  assert.strictEqual(res.ok, true, `delete must succeed — got ${JSON.stringify(res)}`);
  assert.ok(!fs.existsSync(fileFor(teamsDir, 'clodex', 'system', 'gone')));
  assert.ok(fs.existsSync(fileFor(teamsDir, 'clodex', 'system', 'kept')),
    'the sibling prompt survives');
});

test('removeTeam refuses an unknown team', () => {
  const { handlers } = mkBox();
  const res = handlers['prompts:removeTeam']({}, 'nosuch', 'system', 's');
  assert.strictEqual(res.ok, false);
});

// --- team:rolePrompts -------------------------------------------------------

const RAIL = '---\nrail: append\n---\n\ndelta\n';
const NO_RAIL = 'a whole system prompt with no front matter\n';

function railBox() {
  return mkBox({
    library: [{ name: 'lib-rail', kind: 'system', body: RAIL }],
    teamPrompts: [
      { name: 'team-rail', kind: 'system', body: RAIL, team: 'clodex', id: 'team:clodex:system:team-rail' },
      { name: 'team-plain', kind: 'system', body: NO_RAIL, team: 'clodex', id: 'team:clodex:system:team-plain' },
      { name: 'other-rail', kind: 'system', body: RAIL, team: 'other', id: 'team:other:system:other-rail' },
    ],
  });
}

test('rolePrompts(team) names the team\'s own system stems in all and teamOwned', () => {
  const { handlers } = railBox();
  const res = handlers['team:rolePrompts']({}, 'clodex');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.teamOwned, ['team-rail', 'team-plain'],
    'both of the team\'s own system stems are named, rail or not');
  assert.ok(res.all.includes('team-plain'),
    'a team stem that is off the append rail is still ON DISK, so `all` carries it — that is the fact that tells "missing" from "off the rail"');
  assert.ok(res.all.includes('lib-rail'), 'the library stems are still there');
});

test('rolePrompts offers a team stem by its BARE name, and only if it passes the rail filter', () => {
  const { handlers } = railBox();
  const res = handlers['team:rolePrompts']({}, 'clodex');
  assert.ok(res.prompts.includes('team-rail'),
    'the rail-declaring team stem is offered — bare, because that is what the resolver looks up');
  assert.ok(!res.prompts.includes('team-plain'),
    'the team stem with no rail: append is NOT offered: a replace-class prompt blended onto the append rail corrupts the seat');
  assert.ok(res.prompts.includes('lib-rail'), 'the library offering survives beside it');
});

test('rolePrompts never leaks another team\'s prompts', () => {
  const { handlers } = railBox();
  const res = handlers['team:rolePrompts']({}, 'clodex');
  assert.ok(!res.teamOwned.includes('other-rail'), 'other team\'s stem is not teamOwned here');
  assert.ok(!res.all.includes('other-rail'), 'nor listed at all — stems are bare, so one team\'s copy would answer for another\'s');
});

test('rolePrompts with NO team is the library-only answer it always was', () => {
  const { handlers } = railBox();
  const res = handlers['team:rolePrompts']({});
  assert.deepStrictEqual(res.teamOwned, [], 'no team named → nothing is team-owned');
  assert.deepStrictEqual(res.all, ['lib-rail'], 'the New Session join flow still sees the library alone');
});

test('a stem owned by BOTH the team and the library is listed once, as the team\'s', () => {
  const { handlers } = mkBox({
    library: [{ name: 'dup', kind: 'system', body: RAIL }],
    teamPrompts: [{ name: 'dup', kind: 'system', body: RAIL, team: 'clodex', id: 'team:clodex:system:dup' }],
  });
  const res = handlers['team:rolePrompts']({}, 'clodex');
  assert.deepStrictEqual(res.all, ['dup'],
    'one entry, not two: the picker offers a bare stem and the team copy is what resolves');
  assert.deepStrictEqual(res.prompts, ['dup']);
  assert.deepStrictEqual(res.teamOwned, ['dup'],
    'and it is labelled team-owned, since that is the file a seat would read');
});

after(() => { setImmediate(() => process.exit(0)); });
