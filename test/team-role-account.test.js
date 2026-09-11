'use strict';
// team-role-account.test.js — t830: a role carries an `account:` LABEL, and the
// label is validated against the real registry at set time.
//
// The label is a property of the ROLE rather than of a template because the seats
// it must move are ephemeral: nobody can open Edit Session on a reviewer that
// lives six minutes, and a template cannot carry the key at all — reviewer
// template env goes through filterTemplateEnv, whose allowlist drops
// CLAUDE_CONFIG_DIR on purpose. So the validation has to bite HERE, where a human
// or an agent writes it, because the spawn that consumes it is unattended.
//
// Every dependency that decides the outcome is real: a real teams dir, real
// addRole/setRole, and assertions that read the FILE back rather than the
// mutator's return. The accounts registry is the one stub — it is a JSON file in
// the operator's home, and pointing the real store at a temp home would test the
// file format rather than the gate.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTicketMethods } = require('../team-tickets');
const { createTeamManifest, formatRoster } = require('../team-manifest');

const ACCOUNTS = [
  { label: 'default', configDir: '/home/u/.claude' },
  { label: 'work', configDir: '/home/u/.clodex/accounts/work' },
  { label: 'side', configDir: '/home/u/.clodex/accounts/side' },
];

function mkBox(t, accounts = ACCOUNTS) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't830-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't830-root-'));
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
    getAccounts: () => ({
      list: () => accounts,
      configDirFor: (label) => (accounts.find((a) => a.label === label) || {}).configDir || null,
    }),
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

// (a) The happy path, read back off DISK. The mutator's return would be green
// even if pickRoleKeys dropped the key, which is the failure mode a new schema
// field has: the handler builds the def, the manifest silently declines it, and
// the reply still says "updated".
test('t830: role-set account:<known label> lands the label in team.json and confirms', (t) => {
  const b = mkBox(t);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'hand', account: 'work', body: '' });
  assert.strictEqual(b.roles().hand.account, 'work',
    'the read-back role names the account every seat minted for it will boot on');
  assert.ok(/"account": "work"/.test(b.bytes()), 'and the label is really on disk');
  assert.ok(/role "hand" updated/.test(b.last()), `and the lead was told, got: ${b.last()}`);
});

test('t830: role-add account:<known label> lands it on a brand-new role', (t) => {
  const b = mkBox(t);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', account: 'side', body: 'builds' });
  assert.strictEqual(b.roles().builder.account, 'side');
  assert.ok(/role "builder" added/.test(b.last()));
});

// (b) The refusal names the accounts that DO exist, because the label is typed
// from memory and the registry lives in a file the lead cannot open. A bare
// "unknown account" sends them to the app to go and read the list.
test('t830: an unknown account: is refused, names the real accounts, and writes NOTHING', (t) => {
  const b = mkBox(t);
  const before = b.bytes();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'hand', account: 'nope', body: 'new brief' });
  assert.ok(/^\[agent:team\] error: no account "nope" — accounts: default, work, side$/.test(b.last()),
    `expected the label list in the refusal, got: ${b.last()}`);
  assert.strictEqual(b.bytes(), before,
    'and the whole patch is dropped — the brief sent alongside it must not land either, '
    + 'or a refused account silently half-applies');
});

test('t830: an unknown account: on role-add mints no role at all', (t) => {
  const b = mkBox(t);
  const before = b.bytes();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-add', name: 'builder', account: 'nope', body: 'builds' });
  assert.ok(/error: no account "nope"/.test(b.last()), `got: ${b.last()}`);
  assert.strictEqual(b.bytes(), before, 'nothing written');
  assert.ok(!b.roles().builder, 'and the role does not exist');
});

// (c) `default` is the ABSENCE of a pin, so it is stored as one. A role carrying
// `account: "default"` would render on the roster and read as a pin to a second
// subscription while pinning nothing — and it is also the only spelling that can
// undo a pin, so it must reach the delete rather than be refused as "unknown".
test('t830: account:default CLEARS the field rather than storing the default label', (t) => {
  const b = mkBox(t);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'hand', account: 'work', body: '' });
  assert.strictEqual(b.roles().hand.account, 'work', 'ENTER: a pin is in place to clear');
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'hand', account: 'default', body: '' });
  assert.strictEqual(b.roles().hand.account, null, 'the pin is gone');
  assert.ok(!/"account"/.test(b.bytes()),
    'and the KEY is gone from disk, not stored as "default" — a stored default reads as a pin');
});

// The registry is read at SET time, so a box with no accounts configured at all
// still has to answer the question. `default` is the one label that always
// exists — the app's own config dir — and the refusal must say so rather than
// printing an empty list.
test('t830: with no accounts registered, the refusal still names default', (t) => {
  const b = mkBox(t, []);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'hand', account: 'work', body: '' });
  assert.ok(/error: no account "work" — accounts: default$/.test(b.last()), `got: ${b.last()}`);
});

// (g) The roster is the only place a lead can SEE the pin: the seats it moves are
// ephemeral, so by the time one exists to inspect, the dispatch that placed it is
// over. It sits after the template name because that is the role's other spawn
// input, and before the brief, which is prose.
test('t830: formatRoster renders " · account: <label>" on a role that has one', () => {
  const team = {
    name: 'clodex', lead: 'lead',
    roles: {
      lead: { brief: 'the lead' },
      hand: { template: 'clodex-team-hand', account: 'work', brief: 'the hand' },
      plain: { template: 'clodex-team-hand', brief: 'unpinned' },
    },
  };
  const out = formatRoster(team, []).split('\n');
  const hand = out.find((l) => l.startsWith('- hand '));
  assert.strictEqual(hand,
    '- hand (session, tmpl clodex-team-hand) · account: work — the hand · no live seat — role definition only, not addressable',
    'the account rides between the template and the brief');
  const plain = out.find((l) => l.startsWith('- plain '));
  assert.ok(!/account/.test(plain),
    `a role with no account renders no account clause, got: ${plain}`);
});
