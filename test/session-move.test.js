'use strict';

// Run: node --test test/session-move.test.js
//
// "Move Session…" — same record, new cwd, restart. Four layers, each pinned
// against the thing it can silently get wrong:
//
//   exitDisposition   the leaf ptyProc.onExit reads. A move kills the pty on
//                     purpose, so the exit must read as EXPECTED (no
//                     missing-binary toast) without dropping a bash row's record.
//   manager.move      the refusals, the record-preserving rewrite, the team
//                     re-derivation from the new cwd, and both failure degrades.
//   ptyProc.onExit    that the callback create() installs actually ASKS the leaf
//                     with the session's `_moving`. Answering right and asking
//                     wrong are independent failures, and the leaf table cannot
//                     see the second one.
//   session:context-menu  which rows are offered the item at all.
//
// The manager tests drive the REAL move() with a stubbed create()/pty, because
// what is under test is the ORDER of kill → setCwd → create and the record that
// survives it — not a spawn. The onExit tests are the opposite: they need the
// real create(), because the wiring is what they are about.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');

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
    // A COPY, like the real store: stores.js `get()` re-parses the file, so the
    // caller holds a snapshot. Handing out the live object instead makes every
    // later mutation retroactively visible through `entry`, which silently
    // vacuums out any pin about a field the move clears and the catch arm
    // restores — measured: it left the catch arm's setArchived unpinned.
    get: (n) => { const e = store.find((x) => x.name === n); return e ? { ...e } : null; },
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
    setArchived: (n, on) => {
      const e = store.find((x) => x.name === n);
      if (!e) return;
      if (on) e.archivedAt = Date.now(); else delete e.archivedAt;
    },
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
    // agentType, like the real create(): _notifyComposition returns on its
    // absence, so a stub omitting it makes every 'moved in' pin below vacuous.
    const type = args[1];
    const spawned = args[0];
    m.sessions.set(spawned, {
      name: spawned, cwd: args[2], backend: null,
      agentType: (type === 'claude' || type === 'codex') ? type : null,
      // Frees the map slot, like the real onExit — a second, sequential move on
      // the same seat waits on exactly that and otherwise sits out _waitForExit.
      pty: { pid: 2, kill() { m.sessions.delete(spawned); } },
    });
  };

  // move() arms `setTimeout(() => sigkillPid(pid, …), 5000)`, and sigkillPid calls
  // the REAL process.kill. The test process outlives the timer, so an unintercepted
  // run SIGKILLs whatever the host happens to have at the seeded pid. Capture rather
  // than perform — same reason as killsDuring in test/sigkill-pid-guard.test.js.
  // Depth-counted because two overlapping move() calls are themselves a subject
  // here: a naive save/restore pair would leave the inner stub installed for good.
  const kills = [];
  const armed = [];
  let depth = 0;
  let realKill = null;
  let realSetTimeout = null;
  const patch = () => {
    if (depth++ > 0) return;
    realKill = process.kill;
    realSetTimeout = global.setTimeout;
    process.kill = (pid, sig) => { kills.push({ pid, sig }); };
    // ONLY the 5s backstop is held back. _waitForExit polls on a 100ms timer in
    // the same window, and swallowing that one hangs the move it is inside.
    // A source change to the delay would empty `armed` — the ENTER assertion
    // below fails loudly on that rather than letting the real kill through.
    global.setTimeout = (cb, ms) => {
      if (ms === 5000) { armed.push(cb); return { unref() {}, close() {} }; }
      return realSetTimeout(cb, ms);
    };
  };
  const unpatch = () => {
    if (--depth > 0) return;
    process.kill = realKill;
    global.setTimeout = realSetTimeout;
  };
  const realMove = m.move.bind(m);
  m.move = async (...args) => { patch(); try { return await realMove(...args); } finally { unpatch(); } };
  const fireBackstops = () => { patch(); try { for (const cb of armed.splice(0)) cb(); } finally { unpatch(); } };

  return { m, store, persistence, created, kills, fireBackstops };
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

// stripLevel and label are NOT re-asserted by move(), unlike every kill()-based
// respawn: those drop the record and rebuild it from spawn args, while a move
// leaves it standing and create()'s upsert spread-merges over it. So this pins
// the SURVIVAL, not a setter call — it goes red when move routes through kill().
test('stripLevel and label survive a move — the record they live on was never dropped', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  await m.move('seat', dir);
  assert.strictEqual(store[0].stripLevel, 2);
  assert.strictEqual(store[0].label, 'My Seat');
});

test('move works on a NOT-LIVE seat — no process to kill', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({ entries: [BASE] });
  const r = await m.move('seat', dir); // nothing in m.sessions
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].cwd, dir);
  assert.strictEqual(created.length, 1, 'it is respawned in the new folder');
});

// A move spawns the seat LIVE. Leaving the archive stamp on the record it spawned
// from means the next launch restores it as a dimmed archived row — a seat the
// operator just moved and is typing into, greyed out and not resumed.
test('move on an ARCHIVED record clears the archive stamp — it comes back live, not dimmed', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({ entries: [{ ...BASE, archivedAt: 9090 }] });
  assert.strictEqual(store[0].archivedAt, 9090, 'ENTER: it starts archived');

  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.strictEqual(store[0].archivedAt, undefined, 'the stamp is gone');
  assert.strictEqual(store[0].cwd, dir);
  assert.strictEqual(created.length, 1);
});

test('a NON-archived record is left alone — move does not invent an archive stamp', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [BASE] });
  await m.move('seat', dir);
  assert.ok(!('archivedAt' in store[0]), 'no archivedAt key was written');
});

// ------------------------------------------------------------ re-entrancy

// Two overlapping moves (a double-click on the menu item, or a peer racing the
// operator). The second's create() throws "already exists" and its catch arm then
// upserts ITS destination over a seat now running somewhere else — a record naming
// a folder the live process is not in.
//
// The gate is a name Set held for the whole call, NOT `_moving` on the live
// session: `_moving` exists only while a session object does, so on a not-live
// record (the test below) both callers passed it. Once the first move kills the
// pty the session object is gone too, and the window a second move slips through
// is most of the first one.
test('a second move while one is in flight is refused, and rewrites nothing', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({ entries: [BASE] });
  const s = seedLive(m, 'seat');
  m._movingNames.add('seat');

  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'move already in progress');
  assert.strictEqual(store[0].cwd, '/old', 'the record still names the folder the live process is in');
  assert.deepStrictEqual(created, [], 'and nothing was respawned');
  assert.strictEqual(m.sessions.get('seat'), s, 'the in-flight move\'s process was not killed a second time');
});

test('two concurrent moves on a NOT-LIVE record: the second is refused, one respawn happens', async () => {
  const a = mkTmpRoot('clodex-move-a-');
  const b = mkTmpRoot('clodex-move-b-');
  const { m, store, created } = mkMove({ entries: [BASE] });
  // No session object, so there is no `_moving` flag anywhere to read — the old
  // gate passed both of these and the loser's catch arm rewrote the winner's cwd.
  assert.strictEqual(m.sessions.get('seat'), undefined, 'ENTER: nothing live under that name');

  const [r1, r2] = await Promise.all([m.move('seat', a), m.move('seat', b)]);
  const refused = [r1, r2].filter((r) => r.error === 'move already in progress');
  assert.strictEqual(refused.length, 1, 'exactly one of the two was refused');
  assert.strictEqual(created.length, 1, 'and exactly one respawn happened');
  assert.strictEqual(store[0].cwd, created[0][2],
    'the record names the folder the one surviving respawn was given');
});

test('the name is released when the move ends — a later move on the same seat is not refused forever', async () => {
  const a = mkTmpRoot('clodex-move-a-');
  const b = mkTmpRoot('clodex-move-b-');
  const { m, store } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  assert.strictEqual((await m.move('seat', a)).ok, true, 'ENTER: the first move succeeded');
  const r = await m.move('seat', b);
  assert.strictEqual(r.ok, true, `a second, sequential move must work (got: ${r.error})`);
  assert.strictEqual(store[0].cwd, b);
});

test('the name is released even when the move THROWS its way out', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  m._waitForExit = async () => { throw new Error('boom'); };
  await assert.rejects(() => m.move('seat', dir), /boom/);
  assert.strictEqual(m._movingNames.has('seat'), false,
    'a name left in the Set by an early throw wedges that seat against every later move, for the life of the app');
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

// The record surviving is only half of it. The pty is already dead and the row
// already gone from the sidebar by the time create() throws, so without these
// fields the renderer has nothing to rebuild a row from and the seat is invisible
// until the next launch.
test('the failed-respawn result carries what the retry ROW needs: kept, the NEW cwd, the type', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m } = mkMove({ entries: [BASE], createThrows: 'spawn exploded' });
  seedLive(m, 'seat');
  const r = await m.move('seat', dir);

  assert.strictEqual(r.kept, true, 'the flag the renderer branches on');
  assert.strictEqual(r.cwd, dir, 'the NEW cwd — retrySpawn re-creates from the record, which now holds it');
  assert.strictEqual(r.type, 'claude', 'the row needs a type for its chip and its retry');
  assert.ok('team' in r, 'and the team key so the row groups under the destination');
});

// The catch arm re-upserts a SNAPSHOT of the record as it was read at the top of
// move() — which still carried the archive stamp the move had just cleared. A
// spread-merge would put it straight back, and the seat the operator is about to
// retry would come back dimmed.
test('a failed respawn does not resurrect the archive stamp the move cleared', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store } = mkMove({ entries: [{ ...BASE, archivedAt: 9090 }], createThrows: 'spawn exploded' });
  seedLive(m, 'seat');
  assert.strictEqual(store[0].archivedAt, 9090, 'ENTER: it starts archived');

  const r = await m.move('seat', dir);
  assert.strictEqual(r.kept, true, 'ENTER: the failure arm ran');
  assert.strictEqual(store[0].archivedAt, undefined, 'the stamp stayed gone');
  assert.strictEqual(store[0].cwd, dir, 'and the record still holds the destination');
});

test('the exit-TIMEOUT result also carries a retry row, at the OLD cwd — that move never happened', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, store, created } = mkMove({ entries: [BASE] });
  const s = seedLive(m, 'seat');
  // The pty ignored SIGTERM past the deadline. SIGKILL is armed at 5s, so it is
  // dead by the time an operator sees anything — but it never ran in the
  // destination, so the row must name where it actually was.
  s.pty.kill = () => {};
  m._waitForExit = async () => false;

  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kept, true);
  assert.strictEqual(r.cwd, '/old', 'the OLD cwd — the record was never rewritten');
  assert.strictEqual(r.type, 'claude');
  assert.strictEqual(store[0].cwd, '/old', 'and the record agrees');
  assert.deepStrictEqual(created, [], 'nothing was respawned');
});

// A source-shape pin, like the peer/sandbox one below: this branch runs only
// against a live Electron sidebar, and the failure it guards is the ABSENCE of a
// call — a toast-only arm passes every runtime assertion about the toast.
test('the renderer rebuilds a failed row from res.kept, not just a toast', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
  const fn = src.slice(src.indexOf('function moveSessionWithPicker'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(/res\.kept/.test(body), 'it branches on the kept flag');
  assert.ok(/addFailedSessionToSidebar\(/.test(body),
    'and rebuilds the row the session-exit already removed — session:retrySpawn is what that row calls');
  assert.ok(/cwd: res\.cwd/.test(body), 'from the cwd the manager reports, not the stale sidebar dataset');
  // The exit-timeout arm returns while the pty may still be alive, so no
  // session-exit has fired and the LIVE row is still there. Adding the ghost row
  // beside it would put two rows under one data-name.
  assert.ok(body.indexOf('removeSession(name') < body.indexOf('addFailedSessionToSidebar('),
    'the live row is torn down BEFORE the ghost row is added');
});

// The exit-TIMEOUT arm again, one step later. There the live row is still up, so
// the branch above stashes instead of drawing — and the pty that outlasted
// _waitForExit dies a moment later, firing session-exit → removeSession, which
// has no `failed` guard and would wipe a row drawn beside it. So the ghost has to
// be drawn FROM the exit handler, the way archivingSessions does it. Source-shape
// for the same reason as the pin above: an Electron sidebar and a late pty death.
test('the renderer defers the ghost row to session-exit when the live row is still up', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
  const fn = src.slice(src.indexOf('function moveSessionWithPicker'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(/sessions\.has\(name\)/.test(body), 'it asks whether the live row survived the failure');
  assert.ok(/movingFailed\.set\(/.test(body), 'and stashes the row identity rather than drawing it beside the live one');

  const handler = src.slice(src.indexOf('window.api.onSessionExit('));
  const hBody = handler.slice(0, handler.indexOf('\n});\n') + 1);
  assert.ok(/movingFailed\.get\(name\)/.test(hBody), 'the exit handler reads the stash');
  assert.ok(/movingFailed\.delete\(name\)/.test(hBody), 'and clears it, so a later natural exit does not redraw a ghost');
  assert.ok(/addFailedSessionToSidebar\(/.test(hBody), 'and it is the exit handler that draws the ghost');
  // removeSession is what wipes the row, so a read taken after it is a read of
  // nothing — same ordering trap the archivingSessions stash sits in.
  assert.ok(hBody.indexOf('movingFailed.get(name)') < hBody.indexOf('removeSession(name)'),
    'the stash is read BEFORE removeSession, and the ghost added after');
  assert.ok(hBody.indexOf('removeSession(name)') < hBody.indexOf('addFailedSessionToSidebar('),
    'the ghost is added after the live row is gone — two rows under one data-name otherwise');
});

// -------------------------------------------- the real onExit wiring

// The leaf table at the top of this file proves exitDisposition ANSWERS
// correctly. It cannot prove ptyProc.onExit ASKS it correctly: delete the one
// `moving: session._moving` argument and every leaf test above stays green while
// every real move reports a crash ("exited unexpectedly (signal 15)") and, for a
// bash row, drops the record. So this one goes through the real create() with a
// fake pty, captures the callback create() installed, and fires it.
function mkExitProbe() {
  const root = mkTmpRoot('clodex-move-exit-');
  const removed = [];
  const sent = [];
  let onExit = null;
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    MSG_DIR: pathReal.join(root, 'messages'),
    PENDING_DIR: pathReal.join(root, 'pending'),
    fs: fsReal, path: pathReal, os: osReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: (d) => fsReal.mkdirSync(d, { recursive: true }),
    setupClaudeHook: (n) => {
      fsReal.mkdirSync(runDirForReal(root, n), { recursive: true });
      return pathReal.join(root, 'settings.json');
    },
    bakePrompt: (_r, _n, realIpc) => realIpc,
    promptCacheDir: () => pathReal.join(root, 'cache'),
    readCache: () => null,
    buildIpcPrompt: () => 'IPC\n',
    mergeClaudeSystemPrompt: (extraArgs, ipcPrompt) => ({ cleaned: [...extraArgs], append: ipcPrompt }),
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [],
    resolveTeam: () => null,
    formatTeamBlock: () => '',
    matchSeatRole: () => null,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null,
    effectiveInjectedAgents: () => [],
    writeSkillPlugin: () => null,
    effectiveInjectedSkills: () => [],
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {},
      remove: (n) => removed.push(n),
    }),
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    resolveProxyBase: () => null,
    resolveProxyAgentId: ({ name }) => `clodex-${name}-rt`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class {
      static async isSocketLive() { return false; }
      async start() {}
      stop() {}
    },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => ({
        pid: 4242,
        onData() {},
        onExit(fn) { onExit = fn; },
        kill() {},
        write() {}, resize() {},
      }),
    },
    notifyOS: () => {},
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    // _cleanup runs off the same onExit callback, AFTER the assertions' event —
    // unstubbed it throws there and the fire() call never returns.
    cleanupClaudeHook: () => {},
    cleanupCodexHook: () => {},
    cleanupSkillPlugin: () => {},
    cleanupAgentPlugin: () => {},
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = (...args) => sent.push(args);
  m._broadcast = () => {};
  const spawn = async (name, type = 'claude') => {
    await m.create(name, type, osReal.tmpdir(), [], null, 'ws');
    const s = m.sessions.get(name);
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    return s;
  };
  return { m, spawn, removed, sent, fire: (payload) => onExit(payload) };
}

const exitEvent = (sent) => (sent.find((a) => a[1] === 'session-exit') || [])[4] || null;

test('onExit reads _moving off the session: a moved agent seat exits EXPECTED, record intact', async () => {
  const { spawn, removed, sent, fire } = mkExitProbe();
  const s = await spawn('seat');
  s._moving = true;
  fire({ exitCode: 0, signal: 15 });

  const ev = exitEvent(sent);
  assert.ok(ev, 'ENTER: the session-exit event was emitted at all');
  assert.strictEqual(ev.expected, true,
    'an unexpected exit toasts "exited unexpectedly (signal 15)" on every single move');
  assert.deepStrictEqual(removed, [], 'and the record the move is about to rewrite was not dropped');
});

test('onExit without _moving still reports an agent crash as UNEXPECTED', async () => {
  const { spawn, sent, fire } = mkExitProbe();
  await spawn('seat');
  fire({ exitCode: 1, signal: 15 });
  assert.strictEqual(exitEvent(sent).expected, false,
    'the flag is what flips it — not something that reads expected for every exit');
});

test('onExit reads _moving for a BASH row too: its record is not dropped mid-move', async () => {
  const { spawn, removed, sent, fire } = mkExitProbe();
  const s = await spawn('shell', 'bash');
  s._moving = true;
  fire({ exitCode: 0, signal: 15 });
  assert.strictEqual(exitEvent(sent).expected, true);
  assert.deepStrictEqual(removed, [],
    'a bash row exiting on its own IS dropped — the move flag is the only thing suppressing it here');
});

test('a bash row exiting on its own IS dropped — ENTER for the assertion above', async () => {
  const { spawn, removed, fire } = mkExitProbe();
  await spawn('shell', 'bash');
  fire({ exitCode: 0, signal: null });
  assert.deepStrictEqual(removed, ['shell'],
    'without this, the previous test\'s empty `removed` would also pass against a manager that never removes');
});

// ------------------------------------------------- team re-derivation

// Two REAL teams on disk, one owning each repo, so `resolveTeam` answers from
// manifests rather than from a prefix rule that agrees with the assertion.
function mkTeamHome() {
  const home = mkTmpRoot('clodex-move-home-');
  const inRepo = mkTmpRoot('clodex-move-inrepo-');
  const outRepo = mkTmpRoot('clodex-move-outrepo-');
  const betaRepo = mkTmpRoot('clodex-move-beta-');
  const outRepo2 = mkTmpRoot('clodex-move-outrepo2-');
  const write = (team, root, lead) => {
    const dir = pathReal.join(home, 'teams', team);
    fsReal.mkdirSync(dir, { recursive: true });
    fsReal.writeFileSync(pathReal.join(dir, 'team.json'),
      JSON.stringify({ root, lead, roles: { lead: { prompt: 'p' }, dev: { prompt: 'p' } } }));
  };
  write('alpha', inRepo, 'lead');
  write('beta', betaRepo, 'blead');
  return { home, inRepo, outRepo, betaRepo, outRepo2 };
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

// ------------------------------------------------- composition deltas

// Re-deriving the team is only half of a move across teams: the OLD lead's roster
// is now stale and the NEW lead never learns a seat arrived. kill() and archive()
// are the two existing departure notifiers and neither is on this path, and the
// arrival notifier _maybeInjectComposition returns early on `rosterSentAt`, which
// every seat that has run carries — so without an explicit pair of calls here
// both leads are silently wrong.
//
// The seat is named `alpha-dev` so its role differs on the two sides: `dev` under
// alpha (prefix match), none under beta. A body asserted as a literal would pass
// against a role resolved from the wrong team otherwise.
function mkDeltas({ from, to, teamHome, live = true, createThrows = null }) {
  const { m, store, created } = mkMove({
    entries: [{ ...BASE, name: 'alpha-dev', cwd: from }], teamHome, createThrows,
  });
  // `cwd` explicitly: the shipped session object always carries one and
  // _notifyComposition resolves the OLD team off it, so a fixture omitting it
  // makes every departure pin below assert an absence for the wrong reason.
  if (live) seedLive(m, 'alpha-dev', { cwd: from });
  const passive = [];
  m._deliverPassive = (target, sender, body, kind) => passive.push({ target, sender, body, kind });
  m._rebakeDigest = () => {};
  const seatIn = (name, cwd) => m.sessions.set(name, { name, agentType: 'claude', cwd });
  return { m, store, created, passive, seatIn, move: () => m.move('alpha-dev', to) };
}

test('a seat moved OUT of team alpha: alpha\'s lead is told it left', async () => {
  const { home, inRepo, outRepo } = mkTeamHome();
  const d = mkDeltas({ from: inRepo, to: outRepo, teamHome: home });
  d.seatIn('lead', inRepo);
  assert.strictEqual(d.m.teamNameFor(inRepo), 'alpha', 'ENTER: it starts on alpha');
  assert.strictEqual(d.m.teamNameFor(outRepo), null, 'ENTER: and lands teamless');

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive, [{
    target: 'lead', sender: 'team',
    body: '[team alpha] seat alpha-dev moved out (role: dev)',
    kind: 'dm',
  }], 'exactly one delta, to the OLD lead, resolved against the OLD cwd');
});

test('a seat moved INTO team beta: beta\'s lead is told it arrived', async () => {
  const { home, betaRepo, outRepo } = mkTeamHome();
  const d = mkDeltas({ from: outRepo, to: betaRepo, teamHome: home });
  d.seatIn('blead', betaRepo);
  assert.strictEqual(d.m.teamNameFor(outRepo), null, 'ENTER: it starts teamless');
  assert.strictEqual(d.m.teamNameFor(betaRepo), 'beta', 'ENTER: and lands on beta');

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive, [{
    target: 'blead', sender: 'team',
    body: '[team beta] seat alpha-dev moved in',
    kind: 'dm',
  }], 'the arrival body, with no role — `alpha-dev` matches no beta role');
});

test('a move between two teams tells BOTH leads, each about its own side', async () => {
  const { home, inRepo, betaRepo } = mkTeamHome();
  const d = mkDeltas({ from: inRepo, to: betaRepo, teamHome: home });
  d.seatIn('lead', inRepo);
  d.seatIn('blead', betaRepo);
  assert.strictEqual(d.m.teamNameFor(inRepo), 'alpha', 'ENTER: alpha on one side');
  assert.strictEqual(d.m.teamNameFor(betaRepo), 'beta', 'ENTER: beta on the other');

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive.map((p) => `${p.target}: ${p.body}`), [
    'lead: [team alpha] seat alpha-dev moved out (role: dev)',
    'blead: [team beta] seat alpha-dev moved in',
  ], 'departure first, arrival second — and neither lead hears the other team\'s half');
});

test('a NOT-LIVE record still tells the old lead — there is no session object to read the old cwd off', async () => {
  const { home, inRepo, outRepo } = mkTeamHome();
  const d = mkDeltas({ from: inRepo, to: outRepo, teamHome: home, live: false });
  d.seatIn('lead', inRepo);
  assert.strictEqual(d.m.sessions.get('alpha-dev'), undefined, 'ENTER: nothing live under that name');

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive.map((p) => p.body),
    ['[team alpha] seat alpha-dev moved out (role: dev)'],
    'the departure is built from the persisted entry, not from a session that is not there');
});

test('a move WITHIN one team is no membership change — no delta at all', async () => {
  const { home, inRepo } = mkTeamHome();
  const sub = pathReal.join(inRepo, 'sub');
  fsReal.mkdirSync(sub, { recursive: true });
  const d = mkDeltas({ from: inRepo, to: sub, teamHome: home });
  d.seatIn('lead', inRepo);
  // ENTER: both sides really do resolve to the SAME team. Without this the empty
  // `passive` below is equally true of a fixture where neither side has a team.
  assert.strictEqual(d.m.teamNameFor(inRepo), 'alpha');
  assert.strictEqual(d.m.teamNameFor(sub), 'alpha');

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive, [], 'the lead already has this seat and still has it');
});

test('a move between two TEAMLESS folders is silent', async () => {
  const { home, inRepo, outRepo, outRepo2 } = mkTeamHome();
  const d = mkDeltas({ from: outRepo, to: outRepo2, teamHome: home });
  d.seatIn('lead', inRepo); // a live lead exists — so an empty result is a gate, not an empty box
  assert.strictEqual(d.m.teamNameFor(outRepo), null, 'ENTER: teamless on both sides');
  assert.strictEqual(d.m.teamNameFor(outRepo2), null);

  const r = await d.move();
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(d.passive, []);
});

test('a FAILED respawn sends no delta — the seat is in neither team in any usable sense', async () => {
  const { home, inRepo, betaRepo } = mkTeamHome();
  const d = mkDeltas({ from: inRepo, to: betaRepo, teamHome: home, createThrows: 'spawn exploded' });
  d.seatIn('lead', inRepo);
  d.seatIn('blead', betaRepo);

  const r = await d.move();
  assert.strictEqual(r.kept, true, 'ENTER: the failure arm ran');
  assert.deepStrictEqual(d.passive, [],
    'the retry row carries the new cwd, and a later successful retry goes through create()');
});

// -------------------------------------------------------- the sigkill backstop

// seedLive seeds a real-looking pid and move() arms a real `process.kill(pid,
// SIGKILL)` at 5s. The test process outlives that timer, so an uncaptured run
// SIGKILLs whatever the HOST has at that pid. mkMove intercepts; this is the
// ENTER that the interception is not vacuous.
test('ENTER: the move backstop really is armed for the live pid, and would really call process.kill', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, kills, fireBackstops } = mkMove({ entries: [BASE] });
  seedLive(m, 'seat');
  const r = await m.move('seat', dir);
  assert.strictEqual(r.ok, true, `expected ok (got: ${r.error})`);
  assert.deepStrictEqual(kills, [], 'nothing has fired yet — the backstop is on a delay');
  fireBackstops();
  assert.deepStrictEqual(kills, [{ pid: 4242, sig: 'SIGKILL' }],
    'the seeded pid reaches process.kill — captured here, and NOT performed against the host');
});

test('a move on a NOT-LIVE seat arms no backstop — there is no process to kill', async () => {
  const dir = mkTmpRoot('clodex-move-');
  const { m, kills, fireBackstops } = mkMove({ entries: [BASE] });
  await m.move('seat', dir);
  fireBackstops();
  assert.deepStrictEqual(kills, []);
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
