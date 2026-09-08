'use strict';
// team-role-kvs.test.js — t754: `[agent:team role-add|role-set]` carry
// `dispatch:` and `cwd:` to the REAL manifest mutators.
//
// The stubbed twins in session-manager.test.js pin what _handleTeam PASSES; this
// file pins what the manifest then DOES with it, because the two halves fail
// differently: a def that reaches addRole intact still lands nothing on disk if
// the field is dropped by pickRoleKeys, and a validation this ticket declined to
// duplicate in _handleTeam is only a refusal if the mutator really throws.
//
// So every dependency that decides the outcome is real: a real teams dir, a real
// team root with a real subdirectory for `cwd` to name, and tm.addRole/tm.setRole
// themselves. Assertions read the FILE back, not the mutator's return.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTicketMethods } = require('../team-tickets');
const { createTeamManifest } = require('../team-manifest');

function mkBox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't754-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't754-root-'));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const teamsDir = path.join(home, 'teams');
  const dir = path.join(teamsDir, 'clodex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify({
    root, lead: 'lead',
    roles: { lead: { prompt: 'lead-prompt', brief: 'the lead' }, hand: { brief: 'the hand' } },
  }, null, 2));
  const tm = createTeamManifest({ fs, clodexHome: home });
  const team = { name: 'clodex', root, lead: 'lead', file, dir, roles: tm.loadManifest('clodex').roles };
  const injected = [];
  const methods = createTicketMethods({
    fs, path, teamsDir,
    addRole: tm.addRole,
    setRole: tm.setRole,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === root ? team : null),
    refreshAppMenu: () => {},
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  if (t) t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  return {
    m, injected, file, root,
    lead: { name: 'lead', agentType: 'claude', cwd: root },
    roles: () => tm.loadManifest('clodex').roles,
    bytes: () => fs.readFileSync(file, 'utf-8'),
    last: () => injected[injected.length - 1] || '',
  };
}

test('t754: role-add dispatch:worktree lands dispatch "worktree" in the loaded manifest', (t) => {
  const b = mkBox(t);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', dispatch: 'worktree', body: 'builds' });
  assert.strictEqual(b.roles().builder.dispatch, 'worktree',
    'the read-back role really dispatches to a worktree — the whole point of the ticket');
  assert.ok(/role "builder" added/.test(b.last()), 'and the lead was told so');
});

test('t754: role-add cwd: lands the relative cwd, and role-set can change both', (t) => {
  const b = mkBox(t);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', cwd: 'sub', body: 'builds' });
  assert.strictEqual(b.roles().builder.cwd, 'sub');
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'builder', dispatch: 'spawn', body: '' });
  assert.strictEqual(b.roles().builder.dispatch, 'spawn', 'role-set patched dispatch');
  assert.strictEqual(b.roles().builder.cwd, 'sub', 'and left the cwd it did not name alone');
});

// The before/after the ticket asks for: the same role, added with and without the
// new kvs present-but-absent, must produce the same FILE. A `dispatch: null` that
// leaked into the def would be invisible in the loaded manifest (normalizeRoleDef
// fills a default anyway) and visible only here, as a null on disk.
test('t754: a role-add with NO kvs writes byte-identical team.json to the pre-t754 path', (t) => {
  const a = mkBox(t);
  const c = mkBox(t);
  a.m._handleTeam(a.lead, { type: 'team', sub: 'role-add', name: 'builder', prompt: 'p1', body: 'builds' });
  c.m._handleTeam(c.lead, { type: 'team', sub: 'role-add', name: 'builder', prompt: 'p1', dispatch: null, cwd: null, body: 'builds' });
  const norm = (s, box) => s.split(box.root).join('<ROOT>');
  assert.strictEqual(norm(c.bytes(), c), norm(a.bytes(), a),
    'absent kvs must add no bytes at all');
  assert.ok(!/"dispatch"/.test(a.bytes()) && !/"cwd"/.test(a.bytes()),
    'and neither key is on disk — a stored null reads as a policy nobody wrote');
});

test('t754: dispatch:bogus is refused by the mutator and surfaced as an error: reply, writing nothing', (t) => {
  const b = mkBox(t);
  const before = b.bytes();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', dispatch: 'bogus', body: 'builds' });
  assert.ok(/^\[agent:team\] error: role "builder" dispatch must be one of standing, spawn, worktree/.test(b.last()),
    `expected the mutator's own text, got: ${b.last()}`);
  assert.strictEqual(b.bytes(), before, 'a refused role-add writes nothing');
});

test('t754: role-add lead dispatch:worktree is refused — a reserved role stays standing', (t) => {
  const b = mkBox(t);
  const before = b.bytes();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'lead', dispatch: 'worktree', body: 'the lead' });
  assert.ok(/^\[agent:team\] error: /.test(b.last()) && /lead/.test(b.last()),
    `expected a refusal naming the role, got: ${b.last()}`);
  assert.strictEqual(b.bytes(), before, 'and the manifest is untouched');
});

test('t754: an ABSOLUTE cwd: is refused — an agent cannot point a seat at another project', (t) => {
  const b = mkBox(t);
  const before = b.bytes();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', cwd: '/tmp', body: 'builds' });
  assert.ok(/^\[agent:team\] error: /.test(b.last()) && /absolute/.test(b.last()),
    `expected the absolute-cwd refusal, got: ${b.last()}`);
  assert.strictEqual(b.bytes(), before, 'nothing written');
});
