'use strict';

// team:addRole — the OPERATOR DOOR, driven through the real handler against the
// real team-manifest on a tmp ~/.clodex.
//
// Both halves matter and only the pair is meaningful, so neither is stubbed: the
// handler decides whether to substitute a stock def, and team-manifest decides
// what a def is allowed to do. Stubbing addRole would let this file assert the
// handler's intent while the manifest quietly refused it — which is the shape of
// bug team-hand-template-portable.test.js was widened to catch once already.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTeamManifest, STOCK_ROLE_DEFS } = require('../team-manifest');
const { createTeamDelete } = require('../team-delete');
const { registerIpcHandlers } = require('../ipc-handlers');
const { createTicketsStore } = require('../tickets-store');

// A team on disk plus the handler map, wired to the REAL manifest module.
// `roles` is the team.json as authored; the returned `read()` re-reads the file
// so assertions see what was WRITTEN, not what the handler returned.
function mkDoor(roles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-team-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-team-root-'));
  const dir = path.join(home, 'teams', 't');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(file, JSON.stringify({ root, lead: 'l', roles }, null, 2));

  const tm = createTeamManifest({ fs, clodexHome: home });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {} },
    loadManifest: tm.loadManifest,
    addRole: tm.addRole,
  });
  return {
    addRole: (role, def) => handlers.get('team:addRole')(null, 't', role, def),
    read: () => JSON.parse(fs.readFileSync(file, 'utf-8')).roles,
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const LEAD_ONLY = { lead: { prompt: 'clodex-team-lead' } };

test('team:addRole with an EMPTY def mints the stock def — the offer card cannot write an unbriefed hand', () => {
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    // Exactly what the offer card's Enable button posts.
    const res = d.addRole('hand', {});
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().hand;
    assert.ok(written, 'the hand role was written');
    // The prompt is the whole point: an empty def writes a role that exists,
    // spawns, and boots with no brief at all.
    assert.strictEqual(written.prompt, STOCK_ROLE_DEFS.hand.prompt,
      'the stock prompt reached disk, not null');
    for (const [k, v] of Object.entries(STOCK_ROLE_DEFS.hand)) {
      assert.deepStrictEqual(written[k], v, `stock field ${k} survived the write`);
    }
  } finally { d.cleanup(); }
});

test('team:addRole with a NON-EMPTY def honours it verbatim — the substitution never blends', () => {
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    const res = d.addRole('hand', { prompt: 'my-own-prompt', brief: 'mine' });
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().hand;
    assert.strictEqual(written.prompt, 'my-own-prompt', 'the caller\'s prompt was kept');
    assert.strictEqual(written.brief, 'mine');
    // A BLEND is the failure this asserts against: if the stock def were merged
    // under the caller's, the caller would silently inherit the stock template.
    assert.notStrictEqual(written.template, STOCK_ROLE_DEFS.hand.template,
      'no stock field leaked in beside the caller\'s');
  } finally { d.cleanup(); }
});

test('team:addRole on a RESERVED key still ignores its caller\'s def entirely', () => {
  // The security property, not a nicety: remove-then-re-add of a reviewer is
  // only safe because the re-mint writes Clodex's def and reads nothing of the
  // caller's. A def that survived here would be an authored reviewer — the
  // bypass the mint refusal exists to close.
  const d = mkDoor({ ...LEAD_ONLY });
  try {
    const res = d.addRole('reviewer', {
      prompt: 'attacker-prompt',
      brief: 'attacker brief',
      template: 'attacker-template',
    });
    assert.strictEqual(res.ok, true, `expected ok (got: ${res.error})`);
    const written = d.read().reviewer;
    assert.ok(written, 'the reviewer role was re-minted');
    assert.notStrictEqual(written.prompt, 'attacker-prompt', 'the caller\'s prompt did NOT land');
    assert.notStrictEqual(written.brief, 'attacker brief');
    assert.notStrictEqual(written.template, 'attacker-template');
    for (const [k, v] of Object.entries(STOCK_ROLE_DEFS.reviewer)) {
      assert.deepStrictEqual(written[k], v, `stock field ${k} is what reached disk`);
    }
  } finally { d.cleanup(); }
});

test('team:addRole leaves an EXISTING role alone — the stock def cannot rewrite or refuse a live team\'s hand', () => {
  // The seed-only property, and the reason the substitution is gated on ABSENCE
  // rather than on the def being empty alone. addRole is exact-match-or-throw, so
  // an empty re-add of a role authored empty is a NO-OP today; substituting the
  // stock def there would compare {prompt, brief, template} against all-nulls and
  // throw "already exists with a different definition" — the stock def refusing a
  // live team's role. A hand added through the Add Role form with blank fields is
  // exactly this shape on disk.
  const d = mkDoor({ ...LEAD_ONLY, hand: {} });
  try {
    const res = d.addRole('hand', {});
    assert.strictEqual(res.ok, true,
      `an empty re-add of an existing role must stay a no-op (got: ${res.error})`);
    // Nothing was written: the file still holds the team's own (empty) def, and
    // the stock prompt did NOT arrive behind the operator's back.
    assert.deepStrictEqual(d.read().hand, {}, 'the team\'s own definition is untouched');
  } finally { d.cleanup(); }
});

// --- t783: team:delete ------------------------------------------------------
//
// Driven through the registered handler against the REAL team-manifest and the
// REAL _teamInUse, for the reason at the top of this file: the gate and the
// removal are one decision, and stubbing either lets the handler assert an
// intent the other half quietly declines to honour.

function mkDeleteDoor({ manifest = 'ok', sessions = [], tickets = [], persisted = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-del-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-del-root-'));
  const dir = path.join(home, 'teams', 't');
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'lead.md'), '# lead');
  fs.writeFileSync(path.join(dir, 'team.json'), manifest === 'ok'
    ? JSON.stringify({ root, lead: 'l', roles: { lead: {}, hand: {} } }, null, 2)
    : manifest);

  const tm = createTeamManifest({ fs, clodexHome: home });
  const tstore = createTicketsStore({ fs, path, clodexHome: home });
  if (tickets.length) tstore.save(root, tickets);

  // The real _teamInUse and _forgetTeam, lifted onto a bare object with the two
  // fields they read. Borrowing the methods rather than restating their logic is
  // what makes a gate that stops matching this handler show up HERE.
  const { createTicketMethods } = require('../team-tickets');
  const methods = createTicketMethods(
    { fs, os, path, log: { info() {}, error() {}, warn() {} },
      getPersistence: () => ({ list: () => persisted }) },
    { ticketsStore: tstore, nameConflict: () => null, SPEC_CONFIRM_MS: 1000 },
  );
  const manager = {
    sessions: new Map(sessions.map((x) => [x.name, x])),
    _ticketWatch: new Map(),
    _teamInUse: methods._teamInUse,
    _forgetTeam: methods._forgetTeam,
  };

  const { deleteCheck, deleteGated } = createTeamDelete({
    loadManifest: tm.loadManifest, deleteTeam: tm.deleteTeam, getManager: () => manager,
  });
  const refreshed = [];
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {} },
    manager,
    loadManifest: tm.loadManifest,
    teamDeleteCheck: deleteCheck,
    teamDeleteGated: deleteGated,
    refreshAppMenu: () => refreshed.push('app'),
    refreshTrayMenu: () => refreshed.push('tray'),
  });
  return {
    root, dir, manager, refreshed,
    check: () => handlers.get('team:deleteCheck')(null, 't'),
    del: () => handlers.get('team:delete')(null, 't'),
    exists: () => fs.existsSync(dir),
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('team:delete refuses a team with a LIVE seat, names it in blockedBy, and removes nothing', () => {
  const d = mkDeleteDoor({ sessions: [{ name: 't-hand-1', agentType: 'claude' }] });
  try {
    const res = d.del();
    assert.strictEqual(res.ok, false, 'refused');
    assert.match(res.error, /team "t" is in use/);
    assert.deepStrictEqual(res.blockedBy, { seats: ['t-hand-1'], tickets: [] });
    assert.ok(d.exists(), 'the directory is still there — a refusal that had already removed would make the message a lie');
    assert.deepStrictEqual(d.refreshed, [], 'and no menu refresh was claimed for a delete that did not happen');
  } finally { d.cleanup(); }
});

test('team:delete refuses a team with an OPEN ticket', () => {
  const d = mkDeleteDoor({ tickets: [{ id: 't7', assignee: 'hand', state: 'open' }] });
  try {
    const res = d.del();
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.blockedBy, { seats: [], tickets: ['t7'] });
    assert.ok(d.exists(), 'nothing removed');
  } finally { d.cleanup(); }
});

test('team:delete succeeds on a clean team: the directory is GONE and both menus refresh', () => {
  const d = mkDeleteDoor({
    // Present but non-blocking, so this proves the gate discriminates rather
    // than that the fixture happens to be empty.
    sessions: [{ name: 't-hand-9', agentType: 'claude', _dead: true }],
    tickets: [{ id: 't1', assignee: 'hand', state: 'done' }],
  });
  try {
    assert.ok(d.exists(), 'ENTER: the directory exists before the delete');
    const res = d.del();
    assert.deepStrictEqual(res, { ok: true });
    assert.ok(!d.exists(), 'the team directory and its prompts are gone');
    assert.deepStrictEqual(d.refreshed, ['app', 'tray'], 'both menus were rebuilt');
  } finally { d.cleanup(); }
});

test('team:delete succeeds on a team whose manifest does not load', () => {
  const d = mkDeleteDoor({ manifest: 'not json at all' });
  try {
    const chk = d.check();
    assert.strictEqual(chk.ok, true);
    assert.strictEqual(chk.loaded, false, 'the check reports the manifest, it does not throw');
    assert.ok(chk.error, 'and carries the load error for the dialog to print');
    assert.deepStrictEqual(d.del(), { ok: true });
    assert.ok(!d.exists(), 'the unloadable team is gone');
  } finally { d.cleanup(); }
});

test('team:deleteCheck reports the root, the saved count and what blocks — without deleting', () => {
  const d = mkDeleteDoor({
    sessions: [{ name: 't-hand-1', agentType: 'claude' }],
    tickets: [{ id: 't2', assignee: 'hand', state: 'verify' }, { id: 't3', state: 'cancelled' }],
    persisted: [{ name: 't-hand-4' }, { name: 't-hand-1' }, { name: 'stranger' }],
  });
  try {
    const chk = d.check();
    assert.strictEqual(chk.loaded, true);
    assert.strictEqual(chk.root, d.root, 'the root the confirm names as KEPT');
    assert.deepStrictEqual(chk.seats, ['t-hand-1']);
    assert.deepStrictEqual(chk.tickets, ['t2'], 'verify blocks, cancelled does not');
    assert.strictEqual(chk.saved, 1, 'the persisted-only seat; the live one is already in seats');
    assert.ok(d.exists(), 'the check is a read — it removed nothing');
  } finally { d.cleanup(); }
});

test('team:delete forgets the deleted team\'s ticket watches', () => {
  const d = mkDeleteDoor();
  try {
    d.manager._ticketWatch.set('t-hand-1', { root: d.root, role: 'hand' });
    d.manager._ticketWatch.set('other-1', { root: '/elsewhere', role: 'hand' });
    assert.strictEqual(d.del().ok, true);
    assert.deepStrictEqual([...d.manager._ticketWatch.keys()], ['other-1'],
      "the deleted team's watch is dropped and another team's is not");
  } finally { d.cleanup(); }
});
