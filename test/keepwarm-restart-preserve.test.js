'use strict';
// Run: node --test
//
// t487 — a perpetual keep-warm hold must survive an in-place restart.
//
// The mechanism, and why the loss was invisible. `keepWarmAlways` is written
// onto the session record by one explicit operator action (ipc-handlers.js
// `wire:hold` → setKeepWarmAlways). Every in-place restart is kill() + create():
// kill() REMOVES the record, create() rebuilds it from spawn arguments, and
// create() takes no keep-warm argument — so the flag was gone, on all three
// restart paths, and `_preserveAcrossRestart` named it on none of them.
//
// What made it silent for months is what the flag is FOR. A perpetual hold is
// the one keep-warm mode whose whole purpose is a seat nobody is sitting at, so
// there is no operator watching and no turn arriving: `_maybeRearmHold` runs on
// main-line turns and an idle seat takes none, while `_restorePerpetualHolds`
// runs at startup and reads the record it needs off the very list the restart
// just erased. Observed live: the flag went at 13:32 on 2026-08-23 and no
// `[keepwarm]` line appeared again.
//
// WHAT THIS FILE PINS, and what it deliberately does not. This is the
// PERSISTENCE half — that the flag is on the record after the restart, driven
// through the real restart entry points. The flag must not be written by the
// fixture at any point after the restart: a test that stamps it itself passes
// with the preservation deleted entirely, which is the failure shape this whole
// bug class is made of. test/wire-hold-restart.test.js pins the other half (the
// keeper replaying it with no intervening turn) and test/preserve-census.test.js
// pins that a NEW persisted field cannot reach master without a decision.
//
// THE ENTER QUESTIONS, same three as test/createdat-restart.test.js, and for the
// same reason — every assertion here is about a field surviving a window, and a
// test that never enters the window passes for free:
//   (a) kill() actually REMOVED the record. If it survived, create()'s own
//       read carries the flag and the preserve under test is doing nothing.
//   (b) create() was actually REACHED.
//   (c) the flag was actually SET going in.
//
// createEngine starts background timers with no host to stop them; force-exit in
// `after` once results flush, as engine-args-env.test.js does.

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A fixed past deadline, not an offset: a preserved value and a re-minted one
// must not be able to coincide by accident.
const DEADLINE = 1700000000000; // 2023-11-14T22:13:20Z

function mkEngine() {
  const tmp = mkTmpRoot('clx-keepwarm-');
  // registryDir, or the engine seeds the operator's live ~/.clodex (t359).
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
}

// A fake live session, so the restart paths take their `if (sessions.has(name))`
// kill branch instead of skipping it — without the kill there is no removal and
// nothing to preserve across. pty.kill() drops it from the map, which is what
// waitForSessionExit polls for.
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

// Records, per create() call, the persistence record AS IT STANDS at that
// moment — post-kill, post-preserve. That snapshot is byte-for-byte what
// create()'s own `getPersistence().get(name)` reads one line later, so the spy
// is a probe placed at the seam rather than a stand-in for the decision. Also
// wraps remove() so ENTER (a) is asserted from the product's own call.
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
    // create()'s own rebuild upsert, reduced to the part that matters here: it
    // spread-MERGES over whatever the preserve seeded. Modelling it is what
    // makes the final-state assertions below mean "survived the restart"
    // rather than "was seeded and then never overwritten" — the real create()
    // writes these keys and not the keep-warm ones, and if it ever did write
    // them this fixture would be the thing that is wrong.
    persistence.upsert({ name: args[0], type: args[1], cwd: args[2], sessionId: args[4] || null });
    return { name: args[0], backend: null };
  };
  return { seen, removals };
}

function assertEntered(seen, removals, name, path_) {
  assert.strictEqual(removals.length, 1,
    `ENTER: ${path_} must actually route through kill(), which REMOVES the record — zero removals means the `
    + 'record was never dropped and this test pins a path where the bug cannot occur');
  assert.strictEqual(removals[0].name, name, `ENTER: the removal was for ${name}`);
  assert.strictEqual(removals[0].recordAfter, null,
    `ENTER: after kill() the record for ${name} must be GONE — if it survives, create() finds the flag on its `
    + 'own and the preserve under test is doing nothing');
  assert.strictEqual(seen.length, 1,
    `ENTER: ${path_} must actually reach create() — zero calls means the assertions below inspect nothing`);
}

// --------------------------------------------------- engine.restartSession

test('restartSession carries keepWarmAlways across the kill+create seam', async () => {
  const eng = mkEngine();
  const entry = { name: 'a', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-1' };
  eng.stores.persistence.upsert(entry);
  // Written through the REAL setter, not stamped into the literal: the setter is
  // the only thing that puts this field on a record in production, and a
  // hand-stamped record would not prove the shape it writes is the shape the
  // preserve carries.
  eng.stores.persistence.setKeepWarmAlways('a', true);
  assert.strictEqual(eng.stores.persistence.get('a').keepWarmAlways, true,
    'ENTER (c): the flag is actually on the record going in');
  liveSession(eng, 'a', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('a', {}, 'default');
  assert.strictEqual(res.ok, true, 'the restart itself succeeded');
  assertEntered(seen, removals, 'a', 'restartSession');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.keepWarmAlways, true,
    'the perpetual flag must be back on the record before create() reads it — this is the observed defect: '
    + 'without it the seat comes back with keep-warm silently off, and because a perpetual hold exists for a '
    + 'seat nobody attends, no turn ever arrives for _maybeRearmHold to notice');
  assert.strictEqual(eng.stores.persistence.get('a').keepWarmAlways, true,
    "and it survives create()'s rebuild upsert, which spread-merges over the seed");
});

test('a FRESH restart carries it too — the hold is a seat property, not conversation state', async () => {
  const eng = mkEngine();
  const entry = { name: 'b', type: 'bash', cwd: '/tmp', workspaceId: 'default', rosterSentAt: 999 };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.setKeepWarmAlways('b', true);
  liveSession(eng, 'b', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.restartSession('b', { fresh: true }, 'default');
  assert.strictEqual(res.ok, true, 'the fresh restart itself succeeded');
  assertEntered(seen, removals, 'b', 'restartSession({fresh:true})');

  const at = seen[0].recordAtCreate;
  assert.strictEqual(at && at.keepWarmAlways, true,
    'a FRESH restart starts a new CONVERSATION; the operator\'s standing instruction to keep this SEAT warm is '
    + 'not part of the conversation it discards');
  // The contrast is what makes the line above a decision rather than a default:
  // rosterSentAt IS conversation state and must drop across the same boundary.
  assert.strictEqual(at && at.rosterSentAt, undefined,
    'ENTER: rosterSentAt must NOT carry across a fresh restart — if it did, this restart is not fresh and the '
    + 'contrast proves nothing');
});

// ------------------------------------------------- engine.applySessionArgs

test('the args-edit restart carries a TIMED holdUntil', async () => {
  const eng = mkEngine();
  const entry = { name: 'c', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-2' };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.setHoldUntil('c', DEADLINE);
  assert.strictEqual(eng.stores.persistence.get('c').holdUntil, DEADLINE,
    'ENTER (c): the deadline is actually on the record going in');
  liveSession(eng, 'c', entry);
  const { seen, removals } = probe(eng);

  const res = await eng.applySessionArgs('c', { extraArgs: ['--x'], restart: true }, 'default');
  assert.strictEqual(res.ok, true, 'the args-edit restart itself succeeded');
  assert.strictEqual(res.restarted, true, 'and it actually restarted (restart:true was honoured)');
  assertEntered(seen, removals, 'c', 'applySessionArgs({restart:true})');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.holdUntil, DEADLINE,
    'the timed deadline must carry too. Dropping it is not the milder half of this bug: rearmPlan is what '
    + 'decides a hold has LAPSED, and it cannot decide that about a field that is gone — the hold simply '
    + 'stops, and nothing clears or logs it');
});

// ------------------------------------------- [agent:context reload] respawn

test('[agent:context reload] carries keepWarmAlways across its cold respawn', async () => {
  const eng = mkEngine();
  const entry = { name: 'd', type: 'claude', cwd: '/tmp', workspaceId: 'default', sessionId: 's-3' };
  eng.stores.persistence.upsert(entry);
  eng.stores.persistence.setKeepWarmAlways('d', true);
  const s = liveSession(eng, 'd', entry);
  s.agentType = 'claude';
  const { seen, removals } = probe(eng);
  // Runs after create() and polls for a transcript symlink that never appears
  // here; best-effort and irrelevant to the seam under test.
  eng.manager._injectReloadHandoff = () => {};

  // The handoff body is MANDATORY — a blank one aborts BEFORE the kill, leaving
  // this test asserting nothing while still passing. ENTER (b) would catch it,
  // but pass a real body so the path exercised is the intended one.
  eng.manager._handleContextIntent(s, 'reload', 'pick up at step 3');
  for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

  assertEntered(seen, removals, 'd', '[agent:context reload]');
  assert.strictEqual(seen[0].args[4], null,
    'ENTER: reload is a COLD boot — resumeId must be null, or this is some other path');

  assert.strictEqual(seen[0].recordAtCreate && seen[0].recordAtCreate.keepWarmAlways, true,
    'the reload path is the one the live loss was traced to (a spawn with no `resumed`, three minutes after '
    + 'the last restore). It preserved the flag on no list at all');
});

// ------------------------------------------------------- the negative half

test('a seat that never held one is not handed a hold by the restart', async () => {
  const eng = mkEngine();
  const entry = { name: 'e', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-4' };
  eng.stores.persistence.upsert(entry);
  assert.strictEqual('keepWarmAlways' in eng.stores.persistence.get('e'), false,
    'ENTER: no hold on the record going in');
  liveSession(eng, 'e', entry);
  const { seen, removals } = probe(eng);

  await eng.restartSession('e', {}, 'default');
  assertEntered(seen, removals, 'e', 'restartSession');

  // ALWAYS_PRESERVE seeds only fields PRESENT on the prior entry, and that
  // matters beyond tidiness: setKeepWarmAlways(false) and setHoldUntil(null)
  // DELETE their keys rather than writing a falsy value, so a preserve that
  // re-seeded absent fields would resurrect what an explicit disarm removed.
  const at = seen[0].recordAtCreate || {};
  assert.strictEqual('keepWarmAlways' in at, false,
    'a seat with no perpetual hold must not come back holding one — the setters DELETE on disarm, so '
    + 'inventing the key here would undo an explicit "turn it off"');
  assert.strictEqual('holdUntil' in at, false, 'and no deadline either');
});

test('the two fields never cross: preserving one does not resurrect the other', async () => {
  // They are mutually exclusive states of ONE control — ipc-handlers' wire:hold
  // writes each by clearing the other — and rearmPlan checks `always` FIRST. A
  // restart that let both onto one record would silently outrank the deadline
  // the operator actually set with a flag they had already replaced.
  const eng = mkEngine();
  const entry = { name: 'f', type: 'bash', cwd: '/tmp', workspaceId: 'default', sessionId: 's-5' };
  eng.stores.persistence.upsert(entry);
  // The real transition an operator makes: perpetual, then back to a 4h timer.
  eng.stores.persistence.setKeepWarmAlways('f', true);
  eng.stores.persistence.setHoldUntil('f', null);
  eng.stores.persistence.setHoldUntil('f', DEADLINE);
  eng.stores.persistence.setKeepWarmAlways('f', false);
  const before = eng.stores.persistence.get('f');
  assert.strictEqual(before.holdUntil, DEADLINE, 'ENTER: the record holds the TIMED state going in');
  assert.strictEqual('keepWarmAlways' in before, false,
    'ENTER: and the perpetual flag was really cleared — if it lingered, the assertion below is about the '
    + 'setter rather than about the restart');

  liveSession(eng, 'f', entry);
  const { seen, removals } = probe(eng);
  await eng.restartSession('f', {}, 'default');
  assertEntered(seen, removals, 'f', 'restartSession');

  const at = seen[0].recordAtCreate;
  assert.strictEqual(at.holdUntil, DEADLINE, 'the surviving state is the timed one the operator last set');
  assert.strictEqual('keepWarmAlways' in at, false,
    'and the perpetual flag stays gone — a seat must never come back holding both');
});

// ---------------------------------- the latch on the far side of the restart

// Part 3 of the ticket: does `_holdRearmed` (session-manager.js `_maybeRearmHold`)
// interact badly with any of this? It latches TRUE when rearmPlan returns null,
// so a seat that came back without its flag stops re-checking for the whole
// spawn — and since a perpetual seat takes no organic turns, "the whole spawn"
// is until the next restart.
//
// The answer is that the latch has no independent defect: it reads the record,
// and the record is what the restart was erasing. But "the fix makes it
// unreachable" is a claim about a branch, and a claim about a branch is worth
// what a test says about it. These two run the REAL _maybeRearmHold over the two
// records a restart can now produce, and the pair is the point — either
// assertion alone is equally true of the broken code.

function mkManager(rec) {
  const { createSessionManager } = require('../session-manager');
  const armed = [];
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({
      list: () => (rec ? [rec] : []),
      get: () => null,
      setHoldUntil: () => {},
      setKeepWarmAlways: () => {},
    }),
    notifyOS: () => {},
    fs: require('node:fs'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._holdKeeper = {
    arm: (sid, hours, opts) => { armed.push({ sid, hours, opts }); return { armed: true, always: !!(opts && opts.always), until: null }; },
  };
  m._shadowLog = () => {};
  return { m, armed };
}

test('PART 3: with the flag preserved, the first turn after a restart re-arms', () => {
  const { m, armed } = mkManager({ name: 'a', keepWarmAlways: true });
  // A freshly spawned session: the gate starts open.
  const s = { name: 'a', sessionId: 'sid-new', agentType: 'claude' };
  assert.notStrictEqual(s._holdRearmed, true, 'ENTER: the gate is open on a fresh spawn');

  m._maybeRearmHold(s, 'a');

  assert.deepStrictEqual(armed, [{ sid: 'sid-new', hours: 0, opts: { always: true } }],
    'the restored flag makes rearmPlan return a plan, so the hold is re-armed on the live wire id');
  assert.strictEqual(s._holdRearmed, true, 'and the gate latches behind a re-arm that LANDED, which is correct');
});

test('PART 3: without it, the same first turn latches the gate shut having armed nothing', () => {
  // The record a restart produced BEFORE this ticket: create() rebuilt it from
  // spawn args, so the flag is simply absent.
  const { m, armed } = mkManager({ name: 'a' });
  const s = { name: 'a', sessionId: 'sid-new', agentType: 'claude' };

  m._maybeRearmHold(s, 'a');

  assert.deepStrictEqual(armed, [], 'nothing to arm — rearmPlan sees no intent on the record');
  assert.strictEqual(s._holdRearmed, true,
    'and the gate latches anyway, which is why the loss read as permanent rather than delayed: the seat stops '
    + 're-checking for the whole spawn, so nothing the SEAT does can recover the setting. The latch is not an '
    + 'independent defect — it reads the record faithfully, and the record was what the restart erased — so '
    + 'preserving the field is the whole fix. This pins that reading instead of asserting it in a comment.');
});

after(() => { setImmediate(() => process.exit(0)); });
