'use strict';

// Run: node --test test/session-rename.test.js
//
// "Rename…" — the seat's NAME changes, everywhere it is keyed by name, and the
// conversation survives. Shaped after test/session-move.test.js because
// manager.rename() is shaped after manager.move(): the record stands, the pty
// is killed as an EXPECTED exit, and create() respawns with --resume.
//
// What rename can silently get wrong that move cannot:
//
//   the five shared dirs  messages/, pending/, promptcache/, notices/ and
//                         library/memory/ are keyed by SEAT NAME at the
//                         ~/.clodex ROOT and outlive run/<name>/.
//                         A rename that forgets one leaves the seat's DMs,
//                         parked messages, frozen prompt or memory behind under
//                         a name nothing answers to — silent, because the seat
//                         comes up fine and simply has nothing.
//   the refusals          each one must leave the WHOLE world untouched. A
//                         refusal that has already renamed the record or moved
//                         a dir is worse than no refusal: it is a half-rename.
//
// So every refusal test below asserts the dirs AND the record, not just the
// returned error — a refusal reached after the first side effect returns the
// same `{ok:false}` as one reached before it.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager } = require('../session-manager');
const { createRemindScheduler } = require('../remind-scheduler');
const { initStores } = require('../stores');
const { createTeamManifest, matchSeatRole } = require('../team-manifest');
const { projectDirFor } = require('../clodex-paths');
const { enqueueNotice, parseNotices } = require('../notice-queue');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ------------------------------------------------------------- the fixture

// The five per-SEAT paths, as absolute src/dest pairs under `root`. Written out
// here as literals rather than by calling the manager's own `_renameDirs`: a
// test that asked the subject where its dirs are would agree with itself about
// a dir the subject forgot.
//
// library/exec/ is deliberately NOT here. It is the exec COMMAND registry keyed
// by command id (clodex-monitor.json, clodex-check-syntax.json, …), shared by
// every seat — the r3 pin below is what holds it out.
function dirsUnder(root, name) {
  return {
    messages: pathReal.join(root, 'messages', name),
    pending: pathReal.join(root, 'pending', name),
    promptcache: pathReal.join(root, 'promptcache', name),
    notices: pathReal.join(root, 'notices', name),
    memory: pathReal.join(root, 'library', 'memory', name),
  };
}

// One marker file per dir, contents naming the dir, so a "moved" assertion
// proves the CONTENTS travelled and not merely that mkdir ran at the new name.
function seedDirs(root, name) {
  const d = dirsUnder(root, name);
  for (const key of ['messages', 'pending', 'promptcache', 'notices', 'memory']) {
    fsReal.mkdirSync(d[key], { recursive: true });
    fsReal.writeFileSync(pathReal.join(d[key], 'marker.txt'), `${key} of ${name}`);
  }
  return d;
}

function assertMoved(root, oldName, newName) {
  const from = dirsUnder(root, oldName);
  const to = dirsUnder(root, newName);
  for (const key of ['messages', 'pending', 'promptcache', 'memory']) {
    assert.ok(!fsReal.existsSync(from[key]), `${key}/${oldName} is gone`);
    assert.strictEqual(
      fsReal.readFileSync(pathReal.join(to[key], 'marker.txt'), 'utf8'), `${key} of ${oldName}`,
      `${key}/${newName} holds the OLD seat's contents — it moved, it was not recreated empty`,
    );
  }
  // notices/ is asserted apart from the loop: rename ENQUEUES into the new
  // name's queue, so the dir exists either way and only the marker proves a move.
  assert.ok(!fsReal.existsSync(from.notices), `notices/${oldName} is gone`);
  assert.strictEqual(
    fsReal.readFileSync(pathReal.join(to.notices, 'marker.txt'), 'utf8'), `notices of ${oldName}`,
    `notices/${newName} carries the old queue`,
  );
}

function assertUntouched(root, oldName, newName) {
  const from = dirsUnder(root, oldName);
  const to = dirsUnder(root, newName);
  for (const key of Object.keys(from)) {
    assert.ok(fsReal.existsSync(from[key]), `${key} still under ${oldName}`);
  }
  for (const key of Object.keys(to)) {
    assert.ok(!fsReal.existsSync(to[key]), `nothing was created under ${newName} (${key})`);
  }
}

function mkRename({ entries = [], reminderRows = [], teamHome = null, createThrows = null, root = null } = {}) {
  const REGISTRY_DIR = root || mkTmpRoot('clodex-rename-');
  const store = entries.map((e) => ({ ...e }));
  const persistence = {
    list: () => store,
    // A COPY, like stores.js get(): the caller holds a snapshot, so a later
    // mutation is not retroactively visible through `entry` and cannot vacuum
    // out a pin about a field rename clears.
    get: (n) => { const e = store.find((x) => x.name === n); return e ? { ...e } : null; },
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setCwd: (n, cwd) => { const e = store.find((x) => x.name === n); if (e && cwd) e.cwd = cwd; },
    setLabel: (n, label) => { const e = store.find((x) => x.name === n); if (e) e.label = label; },
    setArchived: (n, on) => {
      const e = store.find((x) => x.name === n);
      if (!e) return;
      if (on) e.archivedAt = Date.now(); else delete e.archivedAt;
    },
    // The real store's shape: rewrites `name` IN PLACE and drops `label`,
    // refusing when the destination is taken.
    rename: (n, newName) => {
      if (store.some((x) => x.name === newName)) return false;
      const e = store.find((x) => x.name === n);
      if (!e) return false;
      e.name = newName;
      delete e.label;
      return true;
    },
  };
  // The REAL scheduler over the REAL reminders store in a tmp userData dir, not
  // a stub shaped like one: r1 shipped a rename that called `sched.store`, which
  // createRemindScheduler does not expose, so the re-point was dead in the app
  // while a stub carrying a `store` key kept it green.
  const remindStore = initStores(mkTmpRoot('clodex-rename-ud-'),
    { log: { info() {}, warn() {}, error() {} }, registryDir: mkTmpRoot('clodex-rename-seed-') }).reminders;
  for (const r of reminderRows) {
    remindStore.add({ agent: r.agent, kind: r.kind || 'in', spec: r.spec || 'in 1h', body: r.body || '', nextFireAt: r.nextFireAt ?? null });
  }
  const scheduler = createRemindScheduler({
    now: () => Date.now(),
    setTimer: () => null,
    clearTimer: () => {},
    store: remindStore,
    deliver: () => {},
  });
  const tm = teamHome ? createTeamManifest({ fs: fsReal, clodexHome: teamHome }) : null;
  const SessionManager = createSessionManager({
    REGISTRY_DIR,
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getRemindScheduler: () => scheduler,
    fs: fsReal,
    path: pathReal,
    DEFAULT_WORKSPACE_ID: 'default',
    resolveTeam: tm ? tm.resolveTeam : () => null,
    findProjectRoot: tm ? tm.findProjectRoot : () => null,
    setLead: tm ? tm.setLead : () => {},
    loadManifest: tm ? tm.loadManifest : () => null,
    matchSeatRole,
    enqueueNotice,
    stripLevelOf: (e) => (e && e.stripLevel) || 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    notifyOS: () => {},
  });
  const m = new SessionManager();
  const created = [];
  m.create = async (...args) => {
    created.push(args);
    if (createThrows) throw new Error(createThrows);
    const type = args[1];
    const spawned = args[0];
    m.sessions.set(spawned, {
      name: spawned, cwd: args[2], backend: null,
      agentType: (type === 'claude' || type === 'codex') ? type : null,
      pty: { pid: 2, kill() { m.sessions.delete(spawned); } },
    });
  };

  // rename() arms `setTimeout(() => sigkillPid(pid, …), 5000)` and sigkillPid
  // calls the REAL process.kill. The test process outlives the timer, so an
  // unintercepted run SIGKILLs whatever the host has at the seeded pid. Only
  // the 5s backstop is held back — _waitForExit polls on a 100ms timer in the
  // same window and swallowing that one hangs the rename it is inside.
  const kills = [];
  let realKill = null;
  let realSetTimeout = null;
  const realRename = m.rename.bind(m);
  m.rename = async (...args) => {
    realKill = process.kill;
    realSetTimeout = global.setTimeout;
    process.kill = (pid, sig) => { kills.push({ pid, sig }); };
    global.setTimeout = (cb, ms) => {
      if (ms === 5000) return { unref() {}, close() {} };
      return realSetTimeout(cb, ms);
    };
    try { return await realRename(...args); } finally {
      process.kill = realKill;
      global.setTimeout = realSetTimeout;
    }
  };

  return { m, store, persistence, remindStore, created, root: REGISTRY_DIR };
}

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
  stripLevel: 2, label: 'My Seat', sessionIds: ['sess-abc'],
};

// ------------------------------------------------------------ happy path

test('rename moves the record, all five shared dirs, the reminders and the conversation', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, remindStore, created } = mkRename({
    root,
    entries: [BASE],
    reminderRows: [
      { agent: 'seat', spec: 'in 5m', body: 'mine', nextFireAt: 4242 },
      { agent: 'other', spec: 'in 5m', body: 'not mine' },
    ],
  });
  seedLive(m, 'seat');

  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(r.name, 'newseat');

  assert.ok(m.sessions.has('newseat'), 'the live seat is under the new name');
  assert.ok(!m.sessions.has('seat'), 'and no longer under the old one');

  assert.strictEqual(store.length, 1, 'one record, not two — it was rewritten, not copied');
  assert.strictEqual(store[0].name, 'newseat');
  assert.ok(!('label' in store[0]), 'the label is cleared — it only existed to show another name');
  assert.strictEqual(store[0].sessionId, 'sess-abc', 'the conversation id is carried');
  assert.strictEqual(store[0].stripLevel, 2, 'and every other field survives — the record stood');
  assert.strictEqual(store[0].createdAt, 111);

  assertMoved(root, 'seat', 'newseat');

  assert.deepStrictEqual(remindStore.listForAgent('seat'), [],
    'nothing is still scheduled under the old name');
  const moved = remindStore.listForAgent('newseat');
  assert.strictEqual(moved.length, 1, 'ENTER: the row is under the new name — the rest of this asserts on it');
  assert.strictEqual(moved[0].body, 'mine');
  assert.strictEqual(moved[0].nextFireAt, 4242, 'and it still fires when it was going to');
  assert.deepStrictEqual(remindStore.listForAgent('other').map((x) => x.body), ['not mine'],
    'another seat\'s rows are untouched');

  assert.strictEqual(created.length, 1, 'exactly one respawn');
  const [name, type, cwd, extraArgs, resumeId, wsId] = created[0];
  assert.strictEqual(name, 'newseat', 'spawned under the NEW name');
  assert.strictEqual(type, 'claude');
  assert.strictEqual(cwd, '/old', 'a rename does not move the seat');
  assert.deepStrictEqual(extraArgs, ['--x']);
  assert.strictEqual(resumeId, 'sess-abc', 'the conversation is carried by --resume');
  assert.strictEqual(wsId, 'ws1');
});

test('rename tells the seat its new name, in a notice under the NEW name', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m } = mkRename({ root, entries: [BASE] });
  seedLive(m, 'seat');
  await m.rename('seat', 'newseat');

  const texts = parseNotices(root, 'newseat').map((n) => n.text);
  const mine = texts.filter((t) => t.includes('renamed'));
  assert.strictEqual(mine.length, 1, `ENTER: exactly one rename notice (queue: ${JSON.stringify(texts)})`);
  assert.match(mine[0], /'seat'/, 'it names the old name');
  assert.match(mine[0], /'newseat'/, 'and the new one');
});

// r3, and it was a SPEC defect rather than an implementation slip: the spec
// listed library/exec/<name>.json among the per-seat dirs. It is not one — it is
// the exec COMMAND registry, keyed by command id and shared by every seat
// (stores.js execLibrary, session-manager's _resolveExecDefs and
// _handleExecIntent, renderer/library-drawers.js all read it that way). Moving it
// on a rename breaks the command for EVERY seat granted it, and the seat whose
// name happens to equal a command id is the whole hazard.
//
// A byte comparison, not an existence check: a rename that deleted and rewrote
// the def would leave a file at the same path and pass a weaker assertion.
test('renaming a seat whose name equals a COMMAND id leaves that command untouched', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const execDir = pathReal.join(root, 'library', 'exec');
  fsReal.mkdirSync(execDir, { recursive: true });
  // Named for the seat under rename: this is the collision, not a bystander.
  const def = pathReal.join(execDir, 'seat.json');
  const defBytes = JSON.stringify({ name: 'seat', argv: ['echo', 'hi'], description: 'a shared command' }, null, 2);
  fsReal.writeFileSync(def, defBytes);

  const { m, store } = mkRename({ root, entries: [BASE] });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].name, 'newseat', 'ENTER: the rename really happened');

  assert.strictEqual(fsReal.readFileSync(def, 'utf8'), defBytes,
    'the command def is byte-identical — a rename must never touch the shared registry');
  assert.ok(!fsReal.existsSync(pathReal.join(execDir, 'newseat.json')),
    'and no def was created under the new name');
  assert.deepStrictEqual(fsReal.readdirSync(execDir).sort(), ['seat.json'],
    'the registry holds exactly what it held before');
});

// The mirror of the test above on the REFUSAL side: an installed command id must
// not make a name unrenameable-to. Before r3 this was refused with "newseat
// already owns …", which is both wrong and misleading — the file belongs to no seat.
test('a name matching a COMMAND id is still available as a rename target', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const execDir = pathReal.join(root, 'library', 'exec');
  fsReal.mkdirSync(execDir, { recursive: true });
  const def = pathReal.join(execDir, 'newseat.json');
  const defBytes = JSON.stringify({ name: 'newseat', argv: ['echo', 'hi'] }, null, 2);
  fsReal.writeFileSync(def, defBytes);

  const { m, store } = mkRename({ root, entries: [BASE] });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `a command id must not block the name (got: ${r.error})`);
  assert.strictEqual(store[0].name, 'newseat');
  assert.strictEqual(fsReal.readFileSync(def, 'utf8'), defBytes, 'and the command is untouched');
});

test('rename works on a NOT-LIVE seat — no process to kill', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({ root, entries: [BASE] });
  const r = await m.rename('seat', 'newseat'); // nothing in m.sessions
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].name, 'newseat');
  assertMoved(root, 'seat', 'newseat');
  assert.strictEqual(created.length, 1, 'it is respawned under the new name');
});

test('rename sets _moving before killing the pty — the exit must not read as a crash', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m } = mkRename({ root, entries: [BASE] });
  let flagAtKill = null;
  const s = {
    name: 'seat', agentType: 'claude',
    pty: { pid: 7, kill() { flagAtKill = s._moving; m.sessions.delete('seat'); } },
  };
  m.sessions.set('seat', s);
  await m.rename('seat', 'newseat');
  assert.strictEqual(flagAtKill, true, '_moving was already set when the pty was killed');
});

test('rename rewrites the record only AFTER the old process is gone', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store } = mkRename({ root, entries: [BASE] });
  let nameWhileAlive = null;
  const s = {
    name: 'seat', agentType: 'claude',
    pty: {
      pid: 7,
      kill() { nameWhileAlive = store[0].name; m.sessions.delete('seat'); },
    },
  };
  m.sessions.set('seat', s);
  await m.rename('seat', 'newseat');
  assert.strictEqual(nameWhileAlive, 'seat',
    'a record renamed under a live process points its dirs away from what is running');
  assert.strictEqual(store[0].name, 'newseat');
});

// --------------------------------------------------------------- refusals

for (const row of [
  { what: 'a name with a slash', to: 'a/b', error: /1–64 chars/ },
  { what: 'a name that is only dots', to: '..', error: /1–64 chars/ },
  { what: 'a 65-char name', to: 'x'.repeat(65), error: /1–64 chars/ },
  { what: 'an empty name', to: '', error: /1–64 chars/ },
  { what: 'a non-string name', to: null, error: /1–64 chars/ },
  { what: 'the SAME name', to: 'seat', error: /already called that/ },
]) {
  test(`rename refuses ${row.what}, and nothing moves`, async () => {
    const root = mkTmpRoot('clodex-rename-');
    seedDirs(root, 'seat');
    const { m, store, created } = mkRename({ root, entries: [BASE] });
    const r = await m.rename('seat', row.to);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, row.error);
    assert.strictEqual(store[0].name, 'seat', 'the record was not rewritten');
    assert.strictEqual(store[0].label, 'My Seat', 'not even the label');
    assert.deepStrictEqual(created, [], 'nothing was respawned');
    assert.ok(fsReal.existsSync(dirsUnder(root, 'seat').messages), 'the dirs stayed put');
  });
}

test('rename refuses an unknown session', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { m, created } = mkRename({ root });
  const r = await m.rename('nope', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Session not found: nope/);
  assert.deepStrictEqual(created, []);
});

test('rename refuses a WORKTREE seat — the ticket loop keys it by name', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({
    root, entries: [{ ...BASE, worktree: { path: '/tmp/tree-t1', branch: 't1' } }],
  });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ticket worktree/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

test('rename refuses an EPHEMERAL seat — the ticket loop keys it by name', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({ root, entries: [{ ...BASE, ephemeral: true }] });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ephemeral seat/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

test('rename refuses when the new name is LIVE', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({ root, entries: [BASE] });
  seedLive(m, 'seat');
  seedLive(m, 'newseat');
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already a live session/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

test('rename refuses when the new name is PERSISTED but not live', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({
    root, entries: [BASE, { ...BASE, name: 'newseat', label: undefined }],
  });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already a saved session/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

// One case per dir: the collision check must cover ALL five, and a check that
// looked at only messages/ would pass every other row here while renaming a
// seat straight on top of a stranger's memory.
for (const key of ['messages', 'pending', 'promptcache', 'notices', 'memory']) {
  test(`rename refuses when ${key} already exists under the new name`, async () => {
    const root = mkTmpRoot('clodex-rename-');
    seedDirs(root, 'seat');
    const dest = dirsUnder(root, 'newseat')[key];
    fsReal.mkdirSync(dest, { recursive: true });
    const { m, store, created } = mkRename({ root, entries: [BASE] });
    const r = await m.rename('seat', 'newseat');
    assert.strictEqual(r.ok, false, `expected a refusal on a colliding ${key}`);
    assert.match(r.error, /already owns/);
    assert.strictEqual(store[0].name, 'seat', 'the record was not rewritten');
    assert.deepStrictEqual(created, []);
    const from = dirsUnder(root, 'seat');
    for (const k of Object.keys(from)) {
      assert.ok(fsReal.existsSync(from[k]), `${k} still under the old name`);
    }
  });
}

// ---------------------------------------------------------- team pointers

// A real team on disk, so resolveTeam / setLead / the ticket board are the
// shipped implementations. A stub keyed on a path prefix would agree with
// itself about which cwd joins which team, which is half the assertion.
//
// teams/ and projects/ both hang off the registry root, so `home` here is the
// SAME dir the manager gets as REGISTRY_DIR. Splitting them would put the board
// somewhere the shipped ticketsStore never looks, and the open-ticket refusal
// would read as "no tickets" against a board that has one.
function mkTeam(home, { lead = 'seat', tickets = null } = {}) {
  const projectRoot = mkTmpRoot('clodex-rename-proj-');
  const tm = createTeamManifest({ fs: fsReal, clodexHome: home });
  tm.createTeam({ name: 'shop', root: projectRoot, lead });
  if (tickets) {
    const dir = projectDirFor(home, projectRoot);
    fsReal.mkdirSync(dir, { recursive: true });
    fsReal.writeFileSync(pathReal.join(dir, 'tickets.json'), JSON.stringify(tickets, null, 2));
  }
  return { projectRoot };
}

test('rename re-points the team lead when the renamed seat IS the lead', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { projectRoot } = mkTeam(root, { lead: 'seat' });
  seedDirs(root, 'seat');
  const { m, store } = mkRename({
    root, teamHome: root, entries: [{ ...BASE, cwd: projectRoot }],
  });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].name, 'newseat');
  const manifest = JSON.parse(fsReal.readFileSync(pathReal.join(root, 'teams', 'shop', 'team.json'), 'utf8'));
  assert.strictEqual(manifest.lead, 'newseat',
    'a team whose lead pointer still names the old seat has no lead at all');
});

test('rename leaves the lead pointer alone when the renamed seat is NOT the lead', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { projectRoot } = mkTeam(root, { lead: 'boss' });
  seedDirs(root, 'seat');
  const { m } = mkRename({ root, teamHome: root, entries: [{ ...BASE, cwd: projectRoot }] });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  const manifest = JSON.parse(fsReal.readFileSync(pathReal.join(root, 'teams', 'shop', 'team.json'), 'utf8'));
  assert.strictEqual(manifest.lead, 'boss', 'someone else\'s lead pointer is not this rename\'s business');
});

// The QUEUED case is the one that shipped broken in r1: `_openTicketsFor`
// filters on ticketStarted, so a ticket assigned to the seat by name but never
// started passed the check and was stranded by the rename, left naming an
// assignee nothing answers to. `startedAt: null` with no role and no worktree is
// exactly what ticketStarted() reads as not-started.
test('rename refuses a seat holding a QUEUED (assigned, never started) ticket', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { projectRoot } = mkTeam(root, {
    lead: 'boss',
    tickets: [{ id: 't9', state: 'open', assignee: 'seat', startedAt: null, parked: true, body: 'not started yet' }],
  });
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({
    root, teamHome: root, entries: [{ ...BASE, cwd: projectRoot }],
  });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /open ticket t9/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

test('rename refuses a seat holding a STARTED open ticket — the board names it', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { projectRoot } = mkTeam(root, {
    lead: 'boss',
    tickets: [{ id: 't9', state: 'open', assignee: 'seat', startedAt: 5, body: 'do it' }],
  });
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({
    root, teamHome: root, entries: [{ ...BASE, cwd: projectRoot }],
  });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /open ticket t9/);
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, []);
  assertUntouched(root, 'seat', 'newseat');
});

test('rename allows a seat whose only ticket is CLOSED', async () => {
  const root = mkTmpRoot('clodex-rename-');
  const { projectRoot } = mkTeam(root, {
    lead: 'boss',
    tickets: [{ id: 't9', state: 'accepted', assignee: 'seat', startedAt: 5, body: 'did it' }],
  });
  seedDirs(root, 'seat');
  const { m, store } = mkRename({ root, teamHome: root, entries: [{ ...BASE, cwd: projectRoot }] });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].name, 'newseat');
});

// ---------------------------------------------------------- create() throws

// BOTH kept arms must carry a `name`, because the renderer builds its failed row
// from `res.name` — a kept arm that omits it puts a row named `undefined` on
// screen. The two arms carry DIFFERENT names on purpose: this one returns before
// the record is renamed, so the seat is still the old name.
test('the exit-timeout kept arm names the OLD seat — nothing was renamed yet', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, created } = mkRename({ root, entries: [BASE] });
  // A pty that never frees its map slot: _waitForExit polls the map, so this is
  // exactly the timeout the arm under test handles.
  m.sessions.set('seat', { name: 'seat', agentType: 'claude', pty: { pid: 9, kill() {} } });
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kept, true);
  assert.strictEqual(r.name, 'seat',
    'the record was never rewritten in this arm, so the row must be rebuilt under the old name');
  assert.strictEqual(store[0].name, 'seat');
  assert.deepStrictEqual(created, [], 'and nothing was respawned');
  assertUntouched(root, 'seat', 'newseat');
});

test('create() throwing keeps the record under the NEW name, with kept:true', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store } = mkRename({
    root, entries: [BASE], createThrows: 'claude binary missing',
  });
  seedLive(m, 'seat');
  const r = await m.rename('seat', 'newseat');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kept, true);
  assert.strictEqual(r.name, 'newseat');
  assert.match(r.error, /claude binary missing/);
  // The dirs already moved before create() ran, so a record rolled back to the
  // old name would point at dirs that are no longer there.
  assert.strictEqual(store.length, 1, 'one record');
  assert.strictEqual(store[0].name, 'newseat', 'kept under the NEW name — the dirs are already there');
  assert.strictEqual(store[0].sessionId, 'sess-abc', 'with the conversation still on it');
  assertMoved(root, 'seat', 'newseat');
});

// -------------------------------------------------------- the renderer half

// A source pin, because the renderer half has no runtime fixture here: the
// failure it guards is startRename still writing a LABEL, which leaves the
// whole main-process mechanism above dead code reachable from nothing.
// The kept arm has no runtime fixture here either, and its failure is invisible:
// the kill's session-exit has already removed the row, so a kept arm that does
// not rebuild one leaves a record on disk with nothing on screen naming it until
// the next launch. The row must be rebuilt under res.name — the record moved
// before create() threw, so the OLD name names nothing.
// The kept arm has no runtime fixture here, and it must serve TWO main-side
// arms that differ in a way no single path can satisfy:
//
//   create() threw    the record already moved to res.name, the pty exit was
//                     already consumed. Nothing will rebuild the row, so this
//                     arm must draw a failed one itself, under the NEW name.
//   _waitForExit timed out
//                     the record is STILL the old name and the pty is STILL in
//                     `sessions` — a wedged process that has not exited yet.
//                     Removing the session here disposes a LIVE terminal, and
//                     the failed row it draws is then deleted by the exit that
//                     eventually arrives, leaving the seat invisible until
//                     relaunch. This arm must stash into `movingFailed` and let
//                     that pending exit rebuild the row, exactly as
//                     moveSessionWithPicker's kept arm does.
//
// So both branches are asserted. A pin naming only one passes against a single
// unbranched path — which is how the timeout regression survived round 2.
test('renderer startRename splits its kept arm on liveness: stash if still live, failed row if not', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function startRename(');
  assert.ok(start > 0, 'ENTER: startRename is still in renderer.js under that name');
  const end = src.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, 'ENTER: and the next top-level function bounds it');
  const body = src.slice(start, end);
  const kept = body.indexOf('res.kept');
  assert.ok(kept > 0, 'ENTER: the kept arm is still branched on res.kept');
  const arm = body.slice(kept, body.indexOf('showToast(`Rename failed', kept));

  assert.match(arm, /sessions\.has\(sessionName\)/,
    'the arm branches on whether the old seat is still LIVE — the timeout arm returns while it is');
  assert.match(arm, /res\.name === sessionName/,
    'and on whether the record is still under the old name, which is what distinguishes the two arms');
  assert.match(arm, /movingFailed\.set\(sessionName,/,
    'the still-live branch stashes, so the pending exit rebuilds the row instead of this code disposing a running seat');

  assert.match(arm, /addFailedSessionToSidebar\(/, 'the not-live branch rebuilds a failed row');
  assert.match(arm, /name:\s*res\.name/,
    'under res.name — when create() threw, the record moved and the old name names nothing');
  assert.match(arm, /error:\s*res\.error/, 'carrying the error, so the row can say why');
});

test('renderer startRename calls renameSession, and no longer sets a label', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = src.indexOf('function startRename(');
  assert.ok(start > 0, 'ENTER: startRename is still in renderer.js under that name');
  const end = src.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, 'ENTER: and the next top-level function bounds it');
  const body = src.slice(start, end);
  assert.match(body, /window\.api\.renameSession\(/, 'it renames the seat');
  assert.doesNotMatch(body, /setSessionLabel/,
    'and does not also write a label — a label would show a name the backend does not know');
});
