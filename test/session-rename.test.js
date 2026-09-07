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
//   the six shared dirs   messages/, pending/, promptcache/, notices/,
//                         library/memory/, library/exec/<name>.json are keyed
//                         by name at the ~/.clodex ROOT and outlive run/<name>/.
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
const { createTeamManifest, matchSeatRole } = require('../team-manifest');
const { projectDirFor } = require('../clodex-paths');
const { enqueueNotice, parseNotices } = require('../notice-queue');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ------------------------------------------------------------- the fixture

// The six per-name paths, as absolute src/dest pairs under `root`. Written out
// here as literals rather than by calling the manager's own `_renameDirs`: a
// test that asked the subject where its dirs are would agree with itself about
// a dir the subject forgot.
function dirsUnder(root, name) {
  return {
    messages: pathReal.join(root, 'messages', name),
    pending: pathReal.join(root, 'pending', name),
    promptcache: pathReal.join(root, 'promptcache', name),
    notices: pathReal.join(root, 'notices', name),
    memory: pathReal.join(root, 'library', 'memory', name),
    exec: pathReal.join(root, 'library', 'exec', `${name}.json`),
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
  fsReal.mkdirSync(pathReal.dirname(d.exec), { recursive: true });
  fsReal.writeFileSync(d.exec, JSON.stringify({ name: `exec of ${name}` }));
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
  assert.ok(!fsReal.existsSync(from.exec), `library/exec/${oldName}.json is gone`);
  assert.strictEqual(
    JSON.parse(fsReal.readFileSync(to.exec, 'utf8')).name, `exec of ${oldName}`,
    `library/exec/${newName}.json is the old file`,
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
  const reminders = reminderRows.map((r) => ({ ...r }));
  const remindStore = {
    listForAgent: (a) => reminders.filter((r) => r.agent === a),
    renameAgent: (a, newA) => {
      const mine = reminders.filter((r) => r.agent === a);
      for (const r of mine) r.agent = newA;
      return mine.length;
    },
  };
  const tm = teamHome ? createTeamManifest({ fs: fsReal, clodexHome: teamHome }) : null;
  const SessionManager = createSessionManager({
    REGISTRY_DIR,
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getRemindScheduler: () => ({ store: remindStore }),
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

  return { m, store, persistence, reminders, created, root: REGISTRY_DIR };
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

test('rename moves the record, all six shared dirs, the reminders and the conversation', async () => {
  const root = mkTmpRoot('clodex-rename-');
  seedDirs(root, 'seat');
  const { m, store, reminders, created } = mkRename({
    root,
    entries: [BASE],
    reminderRows: [
      { id: 'r1', agent: 'seat', spec: 'in 5m', body: 'mine' },
      { id: 'r2', agent: 'other', spec: 'in 5m', body: 'not mine' },
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

  assert.deepStrictEqual(
    reminders.map((x) => [x.id, x.agent]), [['r1', 'newseat'], ['r2', 'other']],
    'only this seat\'s reminder rows were re-pointed',
  );

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

// One case per dir: the collision check must cover ALL six, and a check that
// looked at only messages/ would pass every other row here while renaming a
// seat straight on top of a stranger's memory.
for (const key of ['messages', 'pending', 'promptcache', 'notices', 'memory', 'exec']) {
  test(`rename refuses when ${key} already exists under the new name`, async () => {
    const root = mkTmpRoot('clodex-rename-');
    seedDirs(root, 'seat');
    const dest = dirsUnder(root, 'newseat')[key];
    if (key === 'exec') {
      fsReal.mkdirSync(pathReal.dirname(dest), { recursive: true });
      fsReal.writeFileSync(dest, '{}');
    } else {
      fsReal.mkdirSync(dest, { recursive: true });
    }
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

test('rename refuses a seat holding an OPEN ticket — the board names it', async () => {
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
