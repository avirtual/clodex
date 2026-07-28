'use strict';
// Run: node --test
// t71 — `createdAt` is the session's BIRTH TIME, and the sidebar sorts on it
// (renderer.js:955, `case 'created': return meta.createdAt || 0`). create()
// stamps it from the persisted record, falling back to Date.now():
//
//     const existingEntry = getPersistence().get(name);
//     const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();
//
// On the restore-on-launch path the record SURVIVES, so existingEntry carries
// the stamp and the fallback never fires — which is why the invariant read as
// true. But every kill()-based restart REMOVES the record first (kill() →
// persistence.remove, session-manager.js:1893), so existingEntry is null, the
// fallback fires, and a long-lived session's birth time silently becomes NOW.
// _preserveAcrossRestart is the mechanism built for exactly that gap and
// createdAt was in neither field list.
//
// WHY THE SPY DOES NOT MAKE THESE TESTS VACUOUS. Each test replaces
// manager.create with a recorder, so nothing spawns — and a recorder never runs
// create()'s stamping line, so asserting anything the recorder RETURNS would
// pass with the product fix deleted. What is asserted instead is what
// PERSISTENCE HOLDS at the instant create is called: that snapshot is taken
// after the real kill() and after the real _preserveAcrossRestart, so it is
// byte-for-byte the value create()'s own `getPersistence().get(name)` would
// read one line later. The spy is a probe placed at the seam, not a stand-in
// for the decision under test. (t63's revert B: a harness that recomputes the
// product's expression pins a copy of it, and reverting the product leaves
// every test green.)
//
// THE ENTER QUESTIONS. Every test here is about a fallback that must NOT fire,
// and a test that never enters the window passes for free. So three
// preconditions are asserted separately from the behaviour, each with its own
// message:
//   (a) kill() actually REMOVED the record — the load-bearing one. If the
//       record were still there, existingEntry was never null and the bug
//       cannot appear on the path being pinned.
//   (b) create was actually REACHED — the reload path has two early returns
//       (no entry, blank handoff) that abort before the kill, and a create that
//       never happened asserts nothing.
//   (c) the prior stamp is a fixed PAST ms, so "preserved" and "re-minted"
//       cannot coincide by accident.
//
// createEngine constructs electron-free against a temp userData; its
// construction starts background timers with no host to stop them, so we
// force-exit in `after` once assertions flush (node --test isolates each file
// in its own subprocess). Same discipline as engine-args-env.test.js.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');

// A fixed point in the past, not a relative offset: ENTER (c). Any re-mint
// lands on Date.now(), which cannot collide with it.
const BORN = 1700000000000; // 2023-11-14T22:13:20Z

function mkEngine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-createdat-'));
  return createEngine({ userDataPath: tmp, seams: {}, log: { info() {}, warn() {}, error() {} } });
}

// Put a fake live session in the manager's map so the restart paths take their
// kill() branch (`if (manager.sessions.has(name))`) instead of skipping it —
// without the kill there is no removal and nothing to preserve across.
// pty.kill() drops it from the map, which is what waitForSessionExit polls for.
function liveSession(eng, name, entry) {
  const s = {
    name,
    type: entry.type,
    cwd: entry.cwd,
    workspaceId: entry.workspaceId || 'default',
    agentType: null,
    pty: { pid: -1, kill() { eng.manager.sessions.delete(name); } },
  };
  eng.manager.sessions.set(name, s);
  return s;
}

// The probe. Records, per create() call, the persistence record AS IT STANDS at
// that moment — post-kill, post-preserve — plus the positional args. Also wraps
// persistence.remove so ENTER (a) can be asserted from the product's own call
// rather than from a re-reading of kill()'s source.
function probe(eng) {
  const seen = [];
  const removals = [];
  const persistence = eng.stores.persistence;
  const origRemove = persistence.remove.bind(persistence);
  persistence.remove = (n) => {
    origRemove(n);
    removals.push({ name: n, recordAfter: persistence.get(n) });
  };
  eng.manager.create = async (...args) => {
    seen.push({ args, recordAtCreate: persistence.get(args[0]) });
    return { name: args[0], backend: null };
  };
  return { seen, removals };
}

// ENTER (a) + (b), asserted the same way for every path below.
function assertEntered(seen, removals, name, path_) {
  assert.strictEqual(removals.length, 1,
    `ENTER: ${path_} must actually route through kill(), which REMOVES the persistence record — `
    + 'zero removals means existingEntry was never null and this test is pinning a path where the bug cannot occur');
  assert.strictEqual(removals[0].name, name, `ENTER: the removal was for ${name}`);
  assert.strictEqual(removals[0].recordAfter, null,
    `ENTER: after kill() the record for ${name} must be GONE — if it survives, create()'s existingEntry read `
    + 'finds the stamp on its own and the preserve under test is doing nothing');
  assert.strictEqual(seen.length, 1,
    `ENTER: ${path_} must actually reach create() — zero calls means the assertion below inspects nothing`);
}

// --------------------------------------------------- engine.restartSession

test('restartSession preserves createdAt across the kill+create seam', async () => {
  const eng = mkEngine();
  const entry = { name: 'a', type: 'bash', cwd: '/tmp', workspaceId: 'default', createdAt: BORN, sessionId: 's-1' };
  eng.stores.persistence.upsert(entry);
  liveSession(eng, 'a', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('a', {}, 'default');
  assert.strictEqual(res.ok, true, 'the restart itself succeeded');
  assertEntered(seen, removals, 'a', 'restartSession');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.createdAt, BORN,
    'the birth stamp must be re-seeded before create() reads existingEntry — without it create() falls back to '
    + 'Date.now() and the session\'s birth time silently becomes NOW, which jumps a long-lived session to the top '
    + 'of the sidebar\'s "created" sort (renderer.js:955) on every restart');
});

test('a FRESH restart preserves createdAt too — birth time is not conversation state', async () => {
  const eng = mkEngine();
  // rosterSentAt is the contrast: it IS conversation state, so a fresh restart
  // (new conversation, roster not in it) must drop it and re-deliver. createdAt
  // is true of the SESSION, so it survives the same boundary. Pinning both in
  // one test is the point — it says which side of that line each field is on.
  const entry = { name: 'b', type: 'bash', cwd: '/tmp', workspaceId: 'default', createdAt: BORN, rosterSentAt: 999 };
  eng.stores.persistence.upsert(entry);
  liveSession(eng, 'b', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('b', { fresh: true }, 'default');
  assert.strictEqual(res.ok, true, 'the fresh restart itself succeeded');
  assertEntered(seen, removals, 'b', 'restartSession({fresh:true})');

  const at = seen[0].recordAtCreate;
  assert.strictEqual(at && at.createdAt, BORN,
    'a FRESH restart must still carry the birth stamp — dropping it with the conversation state re-mints '
    + 'createdAt to Date.now() and jumps the session to the top of the sidebar\'s "created" sort');
  assert.strictEqual(at && at.rosterSentAt, undefined,
    'and rosterSentAt must NOT carry across a fresh restart — a new conversation has no roster in it, so '
    + 'create() has to re-deliver (this is the contrast that makes createdAt\'s survival a decision, not a default)');
});

// ------------------------------------------------- engine.applySessionArgs

test('the args-edit restart preserves createdAt', async () => {
  const eng = mkEngine();
  const entry = { name: 'c', type: 'bash', cwd: '/tmp', workspaceId: 'default', createdAt: BORN, sessionId: 's-2' };
  eng.stores.persistence.upsert(entry);
  liveSession(eng, 'c', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.applySessionArgs('c', { extraArgs: ['--x'], restart: true }, 'default');
  assert.strictEqual(res.ok, true, 'the args-edit restart itself succeeded');
  assert.strictEqual(res.restarted, true, 'and it actually restarted (restart:true was honoured)');
  assertEntered(seen, removals, 'c', 'applySessionArgs({restart:true})');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.createdAt, BORN,
    'editing a session\'s args must not change when it was born — without the re-seed, every visit to the Edit '
    + 'dialog with restart ticked re-mints createdAt to Date.now() and moves the session in the sidebar\'s '
    + '"created" sort');
});

// ------------------------------------------- [agent:context reload] respawn

test('[agent:context reload] preserves createdAt across its cold respawn', async () => {
  const eng = mkEngine();
  const entry = { name: 'd', type: 'claude', cwd: '/tmp', workspaceId: 'default', createdAt: BORN, sessionId: 's-3' };
  eng.stores.persistence.upsert(entry);
  const s = liveSession(eng, 'd', entry);
  s.agentType = 'claude';
  const { seen, removals } = probe(eng);
  // The respawn is deferred (setImmediate off the scan callback) behind a
  // waitExit poll, so the intent call returns long before create fires — await
  // the probe, don't assume synchrony. _injectReloadHandoff runs after create
  // and polls for a transcript symlink that will never appear here; it is
  // best-effort and irrelevant to the seam under test, and the after() hook
  // below exits the process rather than waiting it out.
  eng.manager._injectReloadHandoff = () => {};

  // The handoff body is MANDATORY — a blank body aborts BEFORE the kill, which
  // would leave this test asserting nothing while still passing. ENTER (b)
  // catches that, but pass a real body so we exercise the path we mean to.
  eng.manager._handleContextIntent(s, 'reload', 'pick up the migration at step 3');
  for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

  assertEntered(seen, removals, 'd', '[agent:context reload]');
  assert.strictEqual(seen[0].args[4], null,
    'ENTER: reload is a COLD boot — resumeId must be null, or this is some other path');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.createdAt, BORN,
    'a context reload must not change when the session was born — this path preserved NOTHING before t71, so '
    + 'every reload re-minted createdAt to Date.now() and jumped the seat to the top of the sidebar\'s '
    + '"created" sort');
});

// ------------------------------------------- the OTHER half of the invariant

// The three tests above pin the half that was BROKEN — the restart callers
// re-seeding the stamp so create()'s read finds it. This one pins the half that
// always worked: on restore-on-launch the record is never removed, so create()'s
// own `existingEntry` read is what preserves the stamp, with no help from
// anybody. Pinning only the broken direction would leave the working one free to
// break silently later, and the comment at session-manager.js:1458 claims both.
//
// This drives the REAL create() — no spy — because the line under test IS
// create()'s stamping line. Bash arm: it needs far fewer seams than the claude
// arm (no hooks, no prompt bake, no team resolution) and reaches the same
// persistence write. Nothing spawns; the pty seam returns an inert stub.
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');

function mkManagerWithStore(extraDeps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-createdat-mgr-'));
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
  };
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...extraDeps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // A real create() leaves watchers/timers behind and an fs.watch handle keeps
  // the event loop alive forever — the file would report every test as passing
  // and then HANG, which inside the full suite is indistinguishable from a
  // deadlock. (The bash arm probes clean today, but the teardown is not
  // conditional on that: it is the discipline for any real create() in a test.)
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, persistence, stop };
}

test('restore-on-launch keeps the record, so create()\'s own read preserves createdAt', async () => {
  const { m, persistence, stop } = mkManagerWithStore();
  // Restore-on-launch: the entry was never removed (archive/quit/natural exit
  // all KEEP it), so this is the state create() actually wakes up to.
  persistence.upsert({ name: 'r', type: 'bash', cwd: os.tmpdir(), workspaceId: 'ws', createdAt: BORN });
  assert.strictEqual(persistence.get('r').createdAt, BORN,
    'ENTER: the record must be PRESENT going in — that is what distinguishes restore from the kill-based '
    + 'restarts above, and with no record this test would just be re-testing the mint path');

  try {
    await m.create('r', 'bash', os.tmpdir(), [], null, 'ws');
  } finally { stop('r'); }

  assert.strictEqual(persistence.get('r').createdAt, BORN,
    'create() must adopt the surviving record\'s birth stamp rather than minting a new one — restoring a '
    + 'session at launch must not reorder the sidebar\'s "created" sort, and this half of the invariant needs '
    + 'no help from _preserveAcrossRestart because nothing removed the record');
});

test('a genuinely NEW session mints createdAt (the fallback is not dead code)', async () => {
  const { m, persistence, stop } = mkManagerWithStore();
  assert.strictEqual(persistence.get('n'), null,
    'ENTER: no prior record — this is the birth case, the one time the Date.now() fallback SHOULD fire');
  const before = Date.now();
  try {
    await m.create('n', 'bash', os.tmpdir(), [], null, 'ws');
  } finally { stop('n'); }

  const born = persistence.get('n').createdAt;
  assert.ok(typeof born === 'number' && born >= before,
    'a session with no prior record must get a FRESH birth stamp — the preserve work above must not be '
    + 'implemented by never minting at all, which would leave every new session sorting as epoch-0 in the '
    + 'sidebar\'s "created" sort');
});

test('create() puts the SAME birth stamp on the live session object, not a second Date.now()', async () => {
  const { m, persistence, stop } = mkManagerWithStore();
  persistence.upsert({ name: 'l', type: 'bash', cwd: os.tmpdir(), workspaceId: 'ws', createdAt: BORN });
  try {
    await m.create('l', 'bash', os.tmpdir(), [], null, 'ws');

    // The pending-store generation stamp (t71 phase 3b) reads createdAt off the
    // LIVE session — _bornFor prefers it over persistence — so a session object
    // built without the field, or built with a fresh Date.now(), silently
    // mis-stamps every DM parked for that seat.
    //
    // This has to be asserted from a REAL create(): the session object is the
    // product's own output, so nothing here can hand-write it. Every _bornFor
    // test in session-manager.test.js constructs its own session literal — an
    // honest way to test the READ, and structurally incapable of noticing if
    // create() stopped WRITING the field. Same shape as revert E in phase 3a: a
    // fixture may only model fields the product does not compute.
    const live = m.sessions.get('l');
    assert.ok(live, 'ENTER: create() must have put a session in the map, or there is nothing to inspect');
    assert.strictEqual(live.createdAt, BORN,
      'the live session must carry the SAME birth stamp the record does: _bornFor reads it from here first, so '
      + 'a missing or re-minted value makes every park stamp a generation that never existed — and the drain '
      + 'that follows discards the seat\'s own mail as a predecessor\'s');
    assert.strictEqual(live.createdAt, persistence.get('l').createdAt,
      'and it must be the same value as the persisted one — two independent Date.now() calls would drift, so '
      + 'an offline park (stamped from persistence) would never match a live drain (stamped from the session)');
  } finally { stop('l'); }
});

test('create() hands the birth stamp to setupClaudeHook, so the generated drain knows its generation', async () => {
  // The hook is the SECOND pending drainer and it cannot read persistence — the
  // stamp has to be baked into its bytes at setup time, which means create() must
  // PASS it. Dropping that one argument is silent: the hook still generates, the
  // session still spawns, and the drain simply reverts to "no expectation =
  // deliver everything". Nothing else in the suite fails, because every other
  // test of the comparison calls setupClaudeHook directly with its own stamp.
  // That is the gap this closes — cli-hooks.test.js pins what the hook DOES with
  // the value; only a real create() can pin that the value arrives at all.
  const seen = [];
  const { m, persistence, stop } = mkManagerWithStore({
    setupClaudeHook: (...args) => { seen.push(args); return path.join(os.tmpdir(), 'settings.json'); },
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {},
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    // The claude arm reaches further than the bash arm the other tests use.
    // These stub only what stands between create()'s entry and the
    // setupClaudeHook call — machinery this test says nothing about.
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => os.tmpdir(),
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
  });
  persistence.upsert({ name: 'h', type: 'claude', cwd: os.tmpdir(), workspaceId: 'ws', createdAt: BORN });
  // The full claude arm reaches a long way past the hook (wire registration,
  // agent library, MCP resolution, the PTY itself), and stubbing all of it would
  // make this test a model of create() rather than a test of it. setupClaudeHook
  // is called EARLY in that arm, so we let the spawn fail afterwards and inspect
  // what the hook received. This is only safe because of the ENTER assertion
  // below: a create() that threw BEFORE the hook leaves `seen` empty and fails
  // there, so "it crashed" can never be mistaken for "it passed the right value".
  try {
    await m.create('h', 'claude', os.tmpdir(), [], null, 'ws');
  } catch { /* past the point under test — ENTER below proves we got there */ }
  finally { stop('h'); }

  assert.strictEqual(seen.length, 1,
    'ENTER: setupClaudeHook must actually be reached — zero calls means the assertion below inspects nothing '
    + '(a claude spawn that took the user-supplied --settings branch, or threw before the hook, would skip it)');
  // Positional, because that is how the product calls it: name, proxyBase,
  // proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase, createdAt.
  assert.strictEqual(seen[0][7], BORN,
    'create() must pass the session\'s birth stamp to setupClaudeHook: the generated hook bakes it in as its '
    + 'own generation, and without it every hook drain falls back to "no expectation" — which delivers a dead '
    + 'predecessor\'s mail into a fresh seat, the exact defect the stamp exists to fix. It must also be the '
    + 'SAME expression create() persists, never a recomputed second copy');
  assert.strictEqual(seen[0][7], persistence.get('h').createdAt,
    'and it must equal the persisted value — a recomputed copy would drift the first time either was touched, '
    + 'which is the construction class this whole ticket exists to remove');
});

// createEngine's background timers keep the loop alive; exit once results flush.
after(() => { setImmediate(() => process.exit(0)); });
