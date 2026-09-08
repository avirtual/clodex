'use strict';
// team-template-save-ipc.test.js — t748: templates:saveTeam / templates:removeTeam
// write and delete inside ~/.clodex/teams/<name>/templates/, and refuse anything
// that is not an existing team plus a legal stem.
//
// The refusals are asserted against the DISK, not against the return envelope: a
// handler that answered {ok:false} while having already created the directory
// would satisfy an envelope-only test, and "never creates the team dir" is the
// property that keeps a typo in a save from minting a team. So every refusal
// subject asserts the path is still absent afterwards.
//
// Bytes are asserted exactly (`JSON.stringify(body, null, 2) + '\n'`) rather than
// re-parsed: the file is read back by JSON.parse everywhere else, so a re-parse
// would agree with any formatting at all, including one that loses the trailing
// newline the rest of the library files carry.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A real teams dir on disk plus the handler table registered over it. Only the
// deps these two handlers touch are real; a Proxy answers everything else with
// an inert stub, the pattern team-frontdoor-seam.test.js established.
function mkBox({ teams = ['clodex'] } = {}) {
  const tmp = mkTmpRoot('t748-ipc-');
  const teamsDir = path.join(tmp, 'teams');
  for (const t of teams) {
    fs.mkdirSync(path.join(teamsDir, t, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, t, 'team.json'),
      JSON.stringify({ name: t, root: tmp, lead: `${t}-lead`, roles: {} }));
  }
  const handlers = {};
  const listed = [];
  const stub = () => () => {};
  const deps = new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    fs, path,
    teamsDir,
    listTeams: () => fs.readdirSync(teamsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    listAllTemplates: () => { listed.push(1); return [{ name: 'seat', id: 'seat' }]; },
    templates: { list: () => [] },
    refreshAppMenu: () => {},
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) });
  registerIpcHandlers(deps);
  return { tmp, teamsDir, handlers, listed };
}

const fileFor = (teamsDir, team, stem) => path.join(teamsDir, team, 'templates', `${stem}.json`);

test('saveTeam writes the exact bytes into the team\'s templates dir', () => {
  const { teamsDir, handlers } = mkBox();
  const body = { type: 'claude', cwd: '/proj', name: 'hand-seat', agents: ['Explore'] };
  const res = handlers['templates:saveTeam']({}, 'clodex', 'hand-seat', body);

  assert.strictEqual(res.ok, true, `save must succeed — got ${JSON.stringify(res)}`);
  const written = fs.readFileSync(fileFor(teamsDir, 'clodex', 'hand-seat'), 'utf8');
  assert.strictEqual(written, `${JSON.stringify(body, null, 2)}\n`,
    'the bytes are the pretty-printed body with a trailing newline');
  assert.ok(Array.isArray(res.templates), 'the reply carries the refreshed list');
});

test('saveTeam overwrites an existing team copy in place', () => {
  const { teamsDir, handlers } = mkBox();
  fs.writeFileSync(fileFor(teamsDir, 'clodex', 'seat'), JSON.stringify({ type: 'codex', old: true }));
  const res = handlers['templates:saveTeam']({}, 'clodex', 'seat', { type: 'claude' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(fileFor(teamsDir, 'clodex', 'seat'), 'utf8')),
    { type: 'claude' }, 'the old body is gone, not merged');
});

test('saveTeam refuses an unknown team and creates NOTHING', () => {
  const { teamsDir, handlers } = mkBox();
  const res = handlers['templates:saveTeam']({}, 'nosuch', 'seat', { type: 'claude' });
  assert.strictEqual(res.ok, false, 'an unknown team is a refusal');
  assert.ok(!fs.existsSync(path.join(teamsDir, 'nosuch')),
    'the team directory must NOT exist — a save may never mint a team');
});

for (const bad of ['..', '.', '../evil', 'a/b', 'a\\b', 'has:colon', '', 'x'.repeat(65)]) {
  test(`saveTeam refuses the stem ${JSON.stringify(bad)} and writes nothing`, () => {
    const { teamsDir, handlers } = mkBox();
    const before = fs.readdirSync(path.join(teamsDir, 'clodex', 'templates'));
    const res = handlers['templates:saveTeam']({}, 'clodex', bad, { type: 'claude' });
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.deepStrictEqual(fs.readdirSync(path.join(teamsDir, 'clodex', 'templates')), before,
      'the templates dir is untouched');
    assert.ok(!fs.existsSync(path.join(teamsDir, 'clodex', 'templates.json')),
      'nothing escaped the templates dir');
  });
}

for (const [label, body] of [
  ['null', null],
  ['an array', [{ type: 'claude' }]],
  ['a string', 'claude'],
  ['an object with no type', { cwd: '/proj' }],
  ['an object whose type is not a string', { type: 7 }],
]) {
  test(`saveTeam refuses a body that is ${label}`, () => {
    const { teamsDir, handlers } = mkBox();
    const res = handlers['templates:saveTeam']({}, 'clodex', 'seat', body);
    assert.strictEqual(res.ok, false, `${label} must be refused`);
    assert.ok(!fs.existsSync(fileFor(teamsDir, 'clodex', 'seat')), 'no file was written');
  });
}

test('saveTeam never writes team.json', () => {
  const { teamsDir, handlers } = mkBox();
  const before = fs.readFileSync(path.join(teamsDir, 'clodex', 'team.json'), 'utf8');
  handlers['templates:saveTeam']({}, 'clodex', 'team', { type: 'claude' });
  assert.strictEqual(fs.readFileSync(path.join(teamsDir, 'clodex', 'team.json'), 'utf8'), before,
    'a template stem of "team" lands in templates/team.json, never on the manifest');
  assert.ok(fs.existsSync(fileFor(teamsDir, 'clodex', 'team')), 'it did write the template');
});

test('removeTeam deletes the team copy', () => {
  const { teamsDir, handlers } = mkBox();
  fs.writeFileSync(fileFor(teamsDir, 'clodex', 'seat'), JSON.stringify({ type: 'claude' }));
  const res = handlers['templates:removeTeam']({}, 'clodex', 'seat');
  assert.strictEqual(res.ok, true, `delete must succeed — got ${JSON.stringify(res)}`);
  assert.ok(!fs.existsSync(fileFor(teamsDir, 'clodex', 'seat')), 'the file is gone');
});

test('removeTeam refuses an unknown team and a bad stem, deleting nothing', () => {
  const { teamsDir, handlers } = mkBox();
  fs.writeFileSync(fileFor(teamsDir, 'clodex', 'seat'), JSON.stringify({ type: 'claude' }));
  assert.strictEqual(handlers['templates:removeTeam']({}, 'nosuch', 'seat').ok, false);
  assert.strictEqual(handlers['templates:removeTeam']({}, 'clodex', '..').ok, false);
  assert.strictEqual(handlers['templates:removeTeam']({}, 'clodex', '../../team').ok, false);
  assert.ok(fs.existsSync(fileFor(teamsDir, 'clodex', 'seat')), 'the real copy survives every refusal');
  assert.ok(fs.existsSync(path.join(teamsDir, 'clodex', 'team.json')), 'so does the manifest');
});

test('removeTeam on an absent file is a refusal, not a silent ok', () => {
  const { handlers } = mkBox();
  const res = handlers['templates:removeTeam']({}, 'clodex', 'never-existed');
  assert.strictEqual(res.ok, false, 'nothing was deleted, so the caller must be told');
});

after(() => { setImmediate(() => process.exit(0)); });
