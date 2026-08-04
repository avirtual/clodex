'use strict';
// Run: node --test
// t157 — `[agent:context reload]` is a kill()+create() respawn, and it was the
// ONLY one of the three that dropped the session's env. create()'s signature ends
// `..., intents = null, sessionEnv = null, mint = false)`, so a call site that
// stops at the 18th positional does not fail — sessionEnv silently defaults to
// null and the fresh process spawns with no session env at all. engine.js
// (restartSession) and session-restore.js both pass it; the reload path did not.
//
// Silent twice over: create()'s own upsert rebuilds the persistence record from
// its spawn args, so the env is not merely absent from THIS process — it is
// erased from sessions.json, and every later --resume is wrong too. That is the
// same defect shape engine-args-env.test.js pins for the args-edit path.
//
// These drive a REAL create() through a fake pty rather than a create-spy: the
// claim is about what the respawned process actually receives, and a spy that
// records positional args can only pin the call, not the merge behind it (the
// deny-key case below is entirely inside that merge). The cost is a heavier
// harness; the ENTER assertions below are what keep it honest.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');

// Two keys, not one. The drop is a whole-env loss, not a hint-specific one — a
// single-key fixture would read as if some named variable were special-cased and
// would let a "fix" that threads exactly that key pass.
const ENV = { AWS_PROFILE: 'acct-prod', CLODEX_SPAWNER_HINT: 'off' };

function mkManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-reload-env-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-reload-ud-')); // no env-override.env inside
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
    setStripLevel: () => {},
    setLabel: () => {},
  };
  const spawns = [];
  let mgr = null;
  const fakePty = {
    spawn: (_cmd, _args, opts) => {
      const rec = { env: opts.env };
      spawns.push(rec);
      // kill() must drop the session from the map or the reload's waitExit poll
      // times out and create() is never reached (ENTER (b) below catches that).
      return { onData() {}, onExit() {}, pid: 999, kill() { if (mgr) mgr.sessions.delete(rec.name); } };
    },
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
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: fakePty,
    os,
    // Reached AFTER create() on the reload path. Without it the respawn throws
    // into the intent's catch, which does `persistence.upsert(entry)` to save the
    // record from a failed respawn — restoring the pre-reload env and making the
    // persistence assertion below pass no matter what create() wrote.
    stripLevelOf: () => 0,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  mgr = m;
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // Runs after create() and polls for a transcript symlink that never appears
  // here; best-effort and irrelevant to the seam under test.
  m._injectReloadHandoff = () => {};
  // A real create() leaves watchers/timers behind; an fs.watch handle would keep
  // the loop alive and turn a green file into a hang.
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, persistence, spawns, stop };
}

// Spawn the seat for real, then fire the reload intent and wait for the second
// spawn. Returns the two captured PTY envs.
// `seedEntry`, when given, rewrites the persisted record between the first spawn
// and the reload — the only way to model a sessions.json whose env create() did
// not itself write.
async function reloadCycle(m, persistence, spawns, name, sessionEnv, seedEntry = null) {
  await m.create(name, 'bash', os.tmpdir(), [], null, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], null, sessionEnv);
  spawns[0].name = name;
  const s = m.sessions.get(name);
  assert.ok(s, 'ENTER: the first create() must have produced a live session');
  assert.strictEqual(spawns.length, 1, 'ENTER: exactly one spawn before the reload');
  // Before the intent fires: it snapshots the record on entry, so a later write
  // would not be read.
  if (seedEntry) persistence.upsert({ name, ...seedEntry });

  m._handleContextIntent(s, 'reload', 'pick up at step 3');
  for (let i = 0; i < 300 && spawns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));

  // The reload path has two early returns (no persistence entry, blank handoff)
  // and a kill() that can time out — any of them leaves one spawn, and every
  // assertion below would then be inspecting the FIRST process's env and passing
  // for free.
  assert.strictEqual(spawns.length, 2,
    'ENTER: the reload must actually respawn — one spawn means it bailed early or kill() never released the '
    + 'session, and the assertions below would be reading the pre-reload process');
  return { first: spawns[0].env, second: spawns[1].env };
}

test('[agent:context reload] respawns with the session env intact (all keys, not one)', async () => {
  const { m, persistence, spawns, stop } = mkManager();
  try {
    const { first, second } = await reloadCycle(m, persistence, spawns, 'r1', ENV);
    assert.strictEqual(first.AWS_PROFILE, 'acct-prod', 'ENTER: the ORIGINAL spawn carried the env, so the '
      + 'comparison below is about the reload and not about create() never applying session env at all');
    assert.strictEqual(first.CLODEX_SPAWNER_HINT, 'off', 'ENTER: and the second key too');

    // Before the fix both of these were undefined: the 18-positional call left
    // sessionEnv null, so the reloaded process inherited the base env only.
    assert.strictEqual(second.AWS_PROFILE, 'acct-prod',
      'a context reload must respawn with the SAME session env — this is a cold respawn of the same seat, and '
      + 'an agent that reloads onto a different AWS identity than it was created with is the failure mode '
      + 'session env exists to prevent');
    assert.strictEqual(second.CLODEX_SPAWNER_HINT, 'off',
      'and EVERY key, not a threaded favourite — the drop was the whole map defaulting to null, so a fix that '
      + 'carries one named variable across leaves the bug in place for the rest');
  } finally { stop('r1'); }
});

test('[agent:context reload] leaves entry.env on the record, so the NEXT --resume is right too', async () => {
  // create()'s own upsert rebuilds the record from spawn args, so a dropped
  // sessionEnv does not just lose this process's env — it erases the persisted
  // one. That makes the loss outlive the reload.
  const { m, persistence, spawns, stop } = mkManager();
  try {
    await reloadCycle(m, persistence, spawns, 'r2', ENV);
    assert.deepStrictEqual(persistence.get('r2').env, ENV,
      'the persistence record must still carry env after the reload — create() re-writes the entry from its '
      + 'own arguments, so an env-less respawn silently strips sessions.json and every later --resume spawns '
      + 'wrong as well');
  } finally { stop('r2'); }
});

test('[agent:context reload] does not need its own deny filter — the merge still gates CLODEX_REMOTE_TOKEN', async () => {
  // env-scopes.js DENY_KEYS = { CLODEX_REMOTE_TOKEN }: the wire gate must not be
  // settable through the surface it gates. Threading entry.env raw is safe
  // because create() feeds it to mergeSessionEnv, whose sanitizeFlat drops denied
  // keys — so no filter belongs at this call site. Pinned because the property is
  // held somewhere else: a later "optimization" that assigns entry.env onto the
  // spawn env directly, skipping the merge, would reopen it silently.
  const { m, persistence, spawns, stop } = mkManager();
  try {
    // The deny key has to be SEEDED onto the record, not passed to create():
    // create()'s own upsert sanitizes at the persistence door, so a poisoned
    // create() argument leaves a clean entry and the reload would never see the
    // key at all — the assertion would then hold for the wrong reason and pass
    // with the merge's sanitizeFlat deleted. A hand-edited sessions.json is the
    // only way this state arises in production, and it is exactly the state the
    // read side must not assume away.
    const { second } = await reloadCycle(m, persistence, spawns, 'r3', ENV,
      { env: { AWS_PROFILE: 'acct-prod', CLODEX_REMOTE_TOKEN: 'leak' } });
    assert.strictEqual(second.AWS_PROFILE, 'acct-prod', 'ENTER: the legal sibling key did cross, so this test '
      + 'is observing a filtered env and not an env-less spawn');
    assert.strictEqual(second.CLODEX_REMOTE_TOKEN, process.env.CLODEX_REMOTE_TOKEN,
      'a reload must not inject the deny-listed remote-auth token into the PTY (base value, whatever it is, '
      + 'untouched) — the reload path threads a persisted map it did not sanitize itself');
  } finally { stop('r3'); }
});

after(() => { setImmediate(() => process.exit(0)); });
