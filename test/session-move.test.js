'use strict';

// Run: node --test test/session-move.test.js
//
// "Move Session…" — same record, new cwd, restart. Three layers, each pinned
// against the thing it can silently get wrong:
//
//   exitDisposition   the leaf ptyProc.onExit reads. A move kills the pty on
//                     purpose, so the exit must read as EXPECTED (no
//                     missing-binary toast) without dropping a bash row's record.
//   manager.move      the refusals, the record-preserving rewrite, the team
//                     re-derivation from the new cwd, and the failure degrade.
//   session:context-menu  which rows are offered the item at all.
//
// The manager tests drive the REAL move() with a stubbed create()/pty, because
// what is under test is the ORDER of kill → setCwd → create and the record that
// survives it — not a spawn.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager, exitDisposition } = require('../session-manager');
const { createTeamManifest } = require('../team-manifest');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ---------------------------------------------------------------- the leaf

// The disposition table, one literal per row. `expected` and `dropRecord` are
// complements by construction in the shipped leaf, so asserting only one of them
// would pass against a version that computed the other wrong.
for (const row of [
  { what: 'a bash row exiting on its own', in: { agentType: null }, expected: false, dropRecord: true },
  { what: 'an agent exiting on its own', in: { agentType: 'claude' }, expected: false, dropRecord: false },
  { what: 'a user-killed bash row', in: { agentType: null, userKilled: true }, expected: true, dropRecord: false },
  { what: 'an archived bash row', in: { agentType: null, archived: true }, expected: true, dropRecord: false },
  { what: 'a bash row at app quit', in: { agentType: null, shuttingDown: true }, expected: true, dropRecord: false },
  // The move rows. A bash row cannot reach the menu today, but the leaf is
  // where the two questions are answered, and answering only the agent one
  // leaves the record-drop half unguarded the day the menu widens.
  { what: 'a MOVING agent seat', in: { agentType: 'claude', moving: true }, expected: true, dropRecord: false },
  { what: 'a MOVING bash row', in: { agentType: null, moving: true }, expected: true, dropRecord: false },
]) {
  test(`exitDisposition: ${row.what} → expected=${row.expected} dropRecord=${row.dropRecord}`, () => {
    assert.deepStrictEqual(exitDisposition(row.in), { expected: row.expected, dropRecord: row.dropRecord });
  });
}

// ------------------------------------------------------------- the fixture

// A manager with a Map-backed persistence and a create() that records its args
// instead of spawning. `teamHome` wires the REAL team-manifest so the team
// re-derivation is resolved the way the shipped code resolves it — a stub
// keyed on a path prefix would agree with itself about which cwd joins a team,
// which is the whole assertion.
function mkMove({ entries = [], teamHome = null, createThrows = null } = {}) {
  const store = entries.map((e) => ({ ...e }));
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    // The real setter's shape: resolves BY NAME and rewrites only `cwd`. A
    // fixture that spread a whole entry here would hide a move that carried
    // sibling fields along with it.
    setCwd: (n, cwd) => { const e = store.find((x) => x.name === n); if (e && cwd) e.cwd = cwd; },
    setStripLevel: (n, lvl) => { const e = store.find((x) => x.name === n); if (e) { if (lvl >= 1) e.stripLevel = lvl; else delete e.stripLevel; } },
    setLabel: (n, label) => { const e = store.find((x) => x.name === n); if (e) e.label = label; },
  };
  const tm = teamHome ? createTeamManifest({ fs: fsReal, clodexHome: teamHome }) : null;
  const SessionManager = createSessionManager({
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    fs: fsReal,
    path: pathReal,
    DEFAULT_WORKSPACE_ID: 'default',
    resolveTeam: tm ? tm.resolveTeam : () => null,
    findProjectRoot: tm ? tm.findProjectRoot : () => null,
    stripLevelOf: (e) => (e && e.stripLevel) || 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    notifyOS: () => {},
  });
  const m = new SessionManager();
  const created = [];
  m.create = async (...args) => {
    created.push(args);
    if (createThrows) throw new Error(createThrows);
    m.sessions.set(args[0], { name: args[0], cwd: args[2], backend: null, pty: { pid: 2, kill() {} } });
  };
  return { m, store, persistence, created };
}

// A live session whose pty.kill() actually frees the map slot, the way the real
// onExit does — move() waits on that, so a fake that never exits would hang.
function seedLive(m, name, extra = {}) {
  const s = {
    name,
    agentType: 'claude',
    pty: { pid: 4242, kill() { m.sessions.delete(name); } },
    ...extra,
  };
  m.sessions.set(name, s);
  return s;
}

const BASE = {
  name: 'seat', type: 'claude', cwd: '/old', workspaceId: 'ws1',
  sessionId: 'sess-abc', createdAt: 111, extraArgs: ['--x'],
  agents: ['a'], disabledTools: ['Bash'], env: { K: 'V' },
  plugins: ['p'], intents: ['dm'], execCommands: ['e'],
  stripLevel: 2, label: 'My Seat', ephemeral: true, sessionIds: ['sess-abc'],
};

// --------------------------------------------------------------- refusals

test('move refuses an unknown session', async () => {
  const { m, created } = mkMove();
  const r = await m.move('nope', mkTmpRoot('clodex-move-'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Session not found: nope/);
  assert.deepStrictEqual(created, [], 'nothing was respawned');
});

test('move refuses a RELATIVE destination', async () => {
  const { m, store, created } = mkMove({ entries: [BASE] });
  const r = await m.move('seat', 'projects/elsewhere');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /absolute path/);
  assert.strictEqual(store[0].cwd, '/old', 'the record was not rewritten');
  assert.deepStrictEqual(created, []);
});

test('move refuses a destination that does not exist', async () => {
  const { m, store } = mkMove({ entries: [BASE] });
  const gone = pathReal.join(mkTmpRoot('clodex-move-'), 'not-there');
  const r = await m.move('seat', gone);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Directory does not exist/);
  assert.strictEqual(store[0].cwd, '/old');
});

test('move refuses a destination that is a FILE, not a directory', async () => {
  const { m, store } = mkMove({ entries: [BASE] });
  const file = pathReal.join(mkTmpRoot('clodex-move-'), 'f.txt');
  fsReal.writeFileSync(file, 'x');
  const r = await m.move('seat', file);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Not a directory/);
  assert.strictEqual(store[0].cwd, '/old');
});

test('move refuses an UNCHANGED cwd — a no-op must not cost the seat a restart', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, created } = mkMove({ entries: [{ ...BASE, cwd: dir }] });
  const s = seedLive(m, 'seat');
  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already in/);
  assert.deepStrictEqual(created, [], 'no respawn');
  assert.strictEqual(m.sessions.get('seat'), s, 'the live process was never killed');
});

test('move refuses a WORKTREE seat and names the tree — the ticket loop owns that checkout', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({
    entries: [{ ...BASE, worktree: { path: '/repo-t9', branch: 't9' } }],
  });
  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ticket worktree/);
  assert.match(r.error, /\/repo-t9/, 'the refusal names the tree, per the ticket');
  assert.strictEqual(store[0].cwd, '/old');
  assert.deepStrictEqual(created, []);
});

// --------------------------------------------------- the record survives

test('move keeps the record and rewrites ONLY cwd', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  const before = { ...store[0] };

  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);

  const after = store.find((e) => e.name === 'seat');
  assert.ok(after, 'the record still exists — move must never drop it');
  assert.strictEqual(after.cwd, dir, 'cwd is the new folder');
  // The whole-object comparison, minus the one field that is allowed to change.
  // A field-by-field spot check would read around a move that quietly dropped
  // sessionId (the conversation) or createdAt (the sidebar sort).
  const strip = (e) => { const c = { ...e }; delete c.cwd; return c; };
  assert.deepStrictEqual(strip(after), strip(before),
    'every other field is byte-identical — same record, new cwd');
});

test('move respawns with --resume, in the same workspace, in the NEW cwd', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, created } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  await m.move('seat', dir);

  assert.strictEqual(created.length, 1, 'exactly one respawn');
  const [name, type, cwd, extraArgs, resumeId, wsId] = created[0];
  assert.strictEqual(name, 'seat');
  assert.strictEqual(type, 'claude');
  assert.strictEqual(cwd, dir, 'spawned in the destination');
  assert.deepStrictEqual(extraArgs, ['--x']);
  assert.strictEqual(resumeId, 'sess-abc', 'the conversation is carried by --resume');
  assert.strictEqual(wsId, 'ws1', 'same workspace — moving across workspaces is out of scope');
});

test('move does NOT go through kill() — kill drops the record unconditionally', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  let killCalls = 0;
  m.kill = async () => { killCalls += 1; };
  await m.move('seat', dir);
  assert.strictEqual(killCalls, 0, 'kill() was never called');
  assert.ok(store.find((e) => e.name === 'seat'), 'so the record survived');
});

test('move marks the exit EXPECTED via _moving before killing the pty', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m } = mkMove({ entries: [BASE] });
  let flagAtKill = null;
  const s = {
    name: 'seat', agentType: 'claude',
    pty: { pid: 7, kill() { flagAtKill = s._moving; m.sessions.delete('seat'); } },
  };
  m.sessions.set('seat', s);
  await m.move('seat', dir);
  // Set BEFORE the kill, not after: onExit fires off the kill, so a flag written
  // afterwards is read as unset and the exit reports as a crash.
  assert.strictEqual(flagAtKill, true, '_moving was already set when the pty was killed');
  assert.deepStrictEqual(
    exitDisposition({ agentType: 'claude', moving: true }),
    { expected: true, dropRecord: false },
    'and that flag is what makes the exit expected',
  );
});

test('move persists the new cwd only AFTER the old process is gone', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  let cwdWhileAlive = null;
  const s = {
    name: 'seat', agentType: 'claude',
    pty: {
      pid: 7,
      kill() {
        // The record as it stands while the old pty is still running in /old.
        cwdWhileAlive = store[0].cwd;
        m.sessions.delete('seat');
      },
    },
  };
  m.sessions.set('seat', s);
  await m.move('seat', dir);
  assert.strictEqual(cwdWhileAlive, '/old',
    'a record naming a folder the live process is not in is the window a crash restores from');
  assert.strictEqual(store[0].cwd, dir, 'and it is rewritten once the process is gone');
});

test('move re-asserts stripLevel and label, which are not spawn args', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  await m.move('seat', dir);
  assert.strictEqual(store[0].stripLevel, 2);
  assert.strictEqual(store[0].label, 'My Seat');
});

test('move works on an ARCHIVED (not live) seat — no process to kill', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({ entries: [BASE] });
  const r = await m.move('seat', dir); // nothing in m.sessions
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].cwd, dir);
  assert.strictEqual(created.length, 1, 'it is respawned in the new folder');
});

// -------------------------------------------------------- failure degrade

test('a failed respawn KEEPS the record at the new cwd — the retry/forget row, never a silent drop', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE], createThrows: 'spawn exploded' });
  seedLive(m, 'seat');
  const r = await m.move('seat', dir);

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /spawn exploded/);
  assert.match(r.error, /session kept/, 'the sentence tells the operator the seat survived');
  const after = store.find((e) => e.name === 'seat');
  assert.ok(after, 'the record is still there — this is the pre-v0.5.3 "agents vanish" bug');
  assert.strictEqual(after.cwd, dir, 'holding the NEW cwd, so the restore retries the move');
  assert.strictEqual(after.sessionId, 'sess-abc', 'and still the conversation');
});

// ------------------------------------------------- team re-derivation

// Two REAL teams on disk, one owning each repo, so `resolveTeam` answers from
// manifests rather than from a prefix rule that agrees with the assertion.
function mkTeamHome() {
  const home = mkTmpRoot('clodex-move-home-');
  const inRepo = mkTmpRoot('clodex-move-inrepo-');
  const outRepo = mkTmpRoot('clodex-move-outrepo-');
  const dir = pathReal.join(home, 'teams', 'alpha');
  fsReal.mkdirSync(dir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(dir, 'team.json'),
    JSON.stringify({ root: inRepo, lead: 'lead', roles: { lead: { prompt: 'p' } } }));
  return { home, inRepo, outRepo };
}

test('team re-derivation: a seat moved INTO a team\'s repo joins that team', async () => {
  const { home, inRepo, outRepo } = mkTeamHome();
  const { m, store } = mkMove({ entries: [{ ...BASE, cwd: outRepo }], teamHome: home });
  seedLive(m, 'seat');
  assert.strictEqual(m.teamNameFor(outRepo), null, 'ENTER: it starts teamless');

  const r = await m.move('seat', inRepo);
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(r.team, 'alpha', 'the result carries the team the NEW cwd derives');
  assert.strictEqual(m.teamNameFor(store[0].cwd), 'alpha', 'and the record derives it too');
});

test('team re-derivation: a seat moved OUT of a team\'s repo leaves that team', async () => {
  const { home, inRepo, outRepo } = mkTeamHome();
  const { m, store } = mkMove({ entries: [{ ...BASE, cwd: inRepo }], teamHome: home });
  seedLive(m, 'seat');
  assert.strictEqual(m.teamNameFor(inRepo), 'alpha', 'ENTER: it starts on the team');

  const r = await m.move('seat', outRepo);
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(r.team, null, 'the result reports no team');
  assert.strictEqual(m.teamNameFor(store[0].cwd), null);
});

// ---------------------------------------------------------- the menu item

// The real session:context-menu handler, with popupMenu capturing the template.
// Only the deps that path touches are wired; the rest are never reached.
function mkMenu(entry) {
  let template = null;
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, warn() {}, error() {} },
    persistence: { get: () => entry },
    promptLibrary: { list: () => [] },
    popupMenu: (tpl) => { template = tpl; },
  });
  handlers.get('session:context-menu')({ sender: { send: () => {} } }, { name: entry.name, cwd: entry.cwd });
  const labels = [];
  const walk = (items) => { for (const i of items || []) { if (i.label) labels.push(i.label); if (i.submenu) walk(i.submenu); } };
  walk(template);
  return labels;
}

test('the menu offers Move Session… for a local claude seat', () => {
  const labels = mkMenu({ name: 'a', type: 'claude', cwd: '/x' });
  assert.ok(labels.includes('Move Session…'), `expected the item, got: ${labels.join(' | ')}`);
});

test('the menu offers Move Session… for a local codex seat', () => {
  assert.ok(mkMenu({ name: 'a', type: 'codex', cwd: '/x' }).includes('Move Session…'));
});

test('the menu does NOT offer Move Session… for a bash row', () => {
  const labels = mkMenu({ name: 'a', type: 'bash', cwd: '/x' });
  assert.ok(!labels.includes('Move Session…'), 'a bash row has no conversation to carry');
  // ENTER: the menu really was built — without this the assertion above is true
  // of an empty template, and would stay true if the handler stopped running.
  assert.ok(labels.includes('Restart Session'), 'the menu was built for this row');
});

test('peer and sandbox rows never reach this menu at all', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'peers-ui.js'), 'utf-8');
  // The structural half of "not for peers": peer rows are built by peers-ui.js
  // and routed to peer:context-menu, so no gate in session:context-menu could
  // exclude them — a runtime fixture cannot show this, because the handler is
  // never called for them.
  assert.ok(src.includes('showPeerContextMenu'), 'peers-ui routes its rows to the PEER menu');
  assert.ok(!src.includes('showSessionContextMenu'), 'and never to the session menu this item lives in');
});
