// Run: node --test
// Covers session-manager.js's construction and window layer with fake
// BrowserWindow handles + fake deps — no PTY is spawned. What's exercised:
// construction (Maps + eager intent/activity trackers), the window bridge
// (registerWindow/windowForWorkspace/windowForSession, isDestroyed filtering),
// _sendToSession routing + pty-data buffering for detached sessions, _broadcast
// fan-out, the notify electron-seam (incl. the isFocused gating that stays in
// the class), and the create() name-collision guard (the pre-spawn path).
// The spawn/create happy path and intent dispatch need a live PTY / CLI and are
// left to integration + Bogdan's GUI smoke test.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSessionManager, deniedBodyDisposition, isStaleRegistration, nameConflict } = require('../session-manager');
const { canFireCompact } = require('../inject-queue');
const { intentEnabled } = require('../intent-catalog');
const { mkTmpRoot, trackTmpRoot } = require('./lib/tmp-roots');

// Minimal fake deps: only what the PTY-free methods touch. Everything else is
// undefined, which the destructure tolerates (those methods aren't reached).
function mk(overrides = {}) {
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled, // real pure leaf — the fire-time gate needs it on every _handleIntent
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor, // real leaf — _handleSpawnIntent strips privileged grants (core AND plugin verbs)
    fencedLines: require('../intent-scanner').fencedLines, // real pure leaf — _extractIntents maps fences unconditionally
    // The grammar table (intent-registry) — real pure leaf, like intent-catalog
    // above. _extractIntents asks it for every intent's body-capture mode and
    // _handleIntent asks it for the gate, the bounce list and the plugin
    // dispatch tail, so a fake here would test the fake.
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    // The FIRE gate, and the only one _handleIntent consults. Real leaf for the
    // same reason as the others here: it reads the whole persistence entry, so a
    // fake would answer off a shape the shipped code never sees.
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: require('node:fs'), // real — create()'s pre-spawn cwd validation stats it
    // Real pure leaf, like fs above: _flushParkedNow pre-counts with it OUTSIDE a
    // try/catch (the count decides whether to enqueue a producer at all), so an
    // unwired seam is an uncaughtException, not a silent no-op the way the old
    // in-try drainPending was. Reads the fixture's own PENDING_DIR and returns 0
    // for a missing dir, so a fixture that parks nothing needs no override.
    countPending: require('../pending-store').countPending,
    // The rest of the pending seam, for one reason: every OTHER caller of these
    // sits inside `try { … } catch { return; }`, so an unwired seam is a swallowed
    // TypeError — both drains become a silent no-op and any test written against
    // them passes vacuously. (Third time this family bit us: countPending above,
    // MSG_MAX_AGE below.) All three are pure leaves over the fixture's own
    // PENDING_DIR and answer "nothing parked" for the undefined one most fixtures
    // have, so wiring them here changes no behaviour — it only stops the silence.
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    // Every rejecting ticket verb calls this. Undefined here would make each one
    // run its catch branch and report the failure wording, so a host that stopped
    // wiring the seam would degrade silently instead of failing a test.
    spillToFile: () => '/tmp/spill-stub.txt',
    // The PRODUCTION value (engine.js), not a token: the spill bounce divides by it,
    // so an unset seam renders "NaN minutes" — a sentence no user can ever see, which
    // every assertion about that bounce would still pass against.
    MSG_MAX_AGE: 1800,
    // Real pure leaf, and deliberately NOT guarded for truthiness at the call
    // site: _handleTermIntent asks it whether the seat has a terminal at all, so
    // an unwired seam must throw rather than wave every session type through to
    // a shell it should not reach.
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    ...overrides,
  };
  const SessionManager = createSessionManager(deps);
  return new SessionManager();
}

function fakeWin({ destroyed = false, focused = false } = {}) {
  const win = {
    sent: [], shown: false, focusedCalled: false,
    webContents: { send: (...a) => win.sent.push(a) },
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    show() { win.shown = true; },
    focus() { win.focusedCalled = true; },
  };
  return win;
}

test('construction: builds empty session/window Maps and the eager trackers', () => {
  const m = mk();
  assert.ok(m.sessions instanceof Map);
  assert.ok(m.windows instanceof Map);
  assert.strictEqual(m.sessions.size, 0);
  assert.strictEqual(m.windows.size, 0);
  assert.ok(m._intentDeduper, 'IntentDeduper built in ctor');
  assert.ok(m._activity, 'ActivityTracker built in ctor');
});

test('registerWindow / windowForWorkspace: live handle resolves, destroyed/missing → null', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  assert.strictEqual(m.windowForWorkspace('ws1'), win);
  assert.strictEqual(m.windowForWorkspace('nope'), null);

  const dead = fakeWin({ destroyed: true });
  m.registerWindow('ws2', dead);
  assert.strictEqual(m.windowForWorkspace('ws2'), null, 'destroyed window is filtered');

  m.unregisterWindow('ws1');
  assert.strictEqual(m.windowForWorkspace('ws1'), null);
});

test('workspaceForWindow: reverse lookup by handle, null for unknown windows', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  assert.strictEqual(m.workspaceForWindow(win), 'ws1');
  assert.strictEqual(m.workspaceForWindow(fakeWin()), null);
});

test('_sendToSession: routes to the owning workspace window, buffers pty-data when detached', () => {
  const m = mk();
  m.sessions.set('a', { name: 'a', workspaceId: 'ws1' });
  const win = fakeWin();
  m.registerWindow('ws1', win);

  m._sendToSession('a', 'pty-data', 'a', 'hello');
  assert.deepStrictEqual(win.sent, [['pty-data', 'a', 'hello']]);

  // Detach the workspace: pty-data must buffer into the session, not throw.
  m.unregisterWindow('ws1');
  m._sendToSession('a', 'pty-data', 'a', 'buffered');
  assert.strictEqual(m.sessions.get('a').pendingOutput, 'buffered');
});

test('_broadcast: fans out to every live window, skips destroyed ones', () => {
  const m = mk();
  const a = fakeWin(), b = fakeWin(), dead = fakeWin({ destroyed: true });
  m.registerWindow('ws1', a);
  m.registerWindow('ws2', b);
  m.registerWindow('ws3', dead);

  m._broadcast('ipc-message', { hi: 1 });
  assert.deepStrictEqual(a.sent, [['ipc-message', { hi: 1 }]]);
  assert.deepStrictEqual(b.sent, [['ipc-message', { hi: 1 }]]);
  assert.deepStrictEqual(dead.sent, []);
});

test('_emitActivity notify seam: fires when no/unfocused window, silent when focused', () => {
  const calls = [];
  const m = mk({ notifyOS: (opts) => calls.push(opts) });
  m.sessions.set('a', { name: 'a', workspaceId: 'ws1', activityState: 'busy' });

  // No window attached → owningWin is null → notify fires.
  m._emitActivity('a', 'idle', true);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].title, /a finished/);

  // Focused window → the isFocused gate (which stays in the class) suppresses it.
  m.sessions.set('a', { name: 'a', workspaceId: 'ws1', activityState: 'busy' });
  m.registerWindow('ws1', fakeWin({ focused: true }));
  m._emitActivity('a', 'idle', true);
  assert.strictEqual(calls.length, 1, 'no new notify while the owning window is focused');
});

// The ctor wires the tracker's un-deduped event seam to s.activityTs, which the
// four idleMs read sites (and through them shouldHoldDm) consume. Driven through
// the real ActivityTracker: a fake would test the fake, and the whole defect was
// that the deduped `emit` seam is the wrong source for this number.
test('activityTs is stamped from wire events, not only from state transitions', () => {
  const m = mk();
  const seed = Date.now() - 600000; // a restored seat: seeded from lastTranscriptWrite
  m.sessions.set('a', { name: 'a', workspaceId: 'ws1', activityState: 'idle', activityTs: seed });

  // No wire event yet → the restore seed survives, so a long-cold seat is not
  // relabelled active-now by the mere existence of the new seam.
  m._activity.turnStarted('a', { reqId: 's1', sideCall: true });
  assert.strictEqual(m.sessions.get('a').activityTs, seed, 'side call is not activity');

  m._activity.turnStarted('a', { reqId: 'r1' });
  const first = m.sessions.get('a').activityTs;
  assert.ok(first > seed, 'first real request moves the clock off the seed');
  assert.strictEqual(m.sessions.get('a').activityState, 'thinking');

  // The defect: a further request in the SAME state emits no transition, so the
  // pre-fix clock stopped here while the seat kept working.
  m.sessions.get('a').activityTs = first - 300000; // as if stamped 5min ago
  m._activity.turnStarted('a', { reqId: 'r2' });
  assert.ok(m.sessions.get('a').activityTs >= first,
    'a request in an unchanged state still moves the clock');
  assert.strictEqual(m.sessions.get('a').activityState, 'thinking', 'state stayed deduped');

  // A late event carrying an older ts must not drag the clock backwards into the
  // dm-hold band (Math.max, not assignment). Driven through a real wire verb with
  // the tracker's clock pushed back, not by calling the callback directly — a
  // direct call would pass even if _touch stopped invoking it at all.
  const now = m.sessions.get('a').activityTs;
  m._activity._now = () => now - 900000;
  m._activity.turnStarted('a', { reqId: 'r3' });
  assert.strictEqual(m.sessions.get('a').activityTs, now, 'the clock never runs backwards');

  // An event for a session this manager does not own is a no-op, not a throw.
  m._activity.turnStarted('ghost', { reqId: 'g1' });
  assert.strictEqual(m.sessions.has('ghost'), false);
});

// The tracker's "timers are not activity" rule has to hold on the LABEL route
// too: gap-idle and post-sweep transitions reach the session only through
// _emitActivity, and stamping Date.now() there reports a seat as fresher than
// its last real event by up to INFLIGHT_MAX_AGE_MS (15min) — long enough to slip
// a cold seat's dm past the hold gate.
test('_emitActivity: a timer-inferred transition stamps the last wire event, not now', () => {
  const m = mk();
  m.sessions.set('a', { name: 'a', workspaceId: 'ws1', activityState: 'idle', activityTs: 0 });
  const wireTs = Date.now() - 600000; // the seat's last real request, 10 min ago
  m._activity._now = () => wireTs;
  m._activity.turnStarted('a', { reqId: 'r1' });
  assert.strictEqual(m.sessions.get('a').activityTs, wireTs);

  // The gap-idle / sweep path: a transition with no wire event behind it.
  m._emitActivity('a', 'idle', false);
  assert.strictEqual(m.sessions.get('a').activityState, 'idle');
  assert.strictEqual(m.sessions.get('a').activityTs, wireTs,
    'the timer transition must not refresh the clock');

  // A jsonl-source session has no wire events at all (the two watcher families
  // are disjoint: wire sessions get the sentinel, whose watcher passes a no-op in
  // the activity slot). It must keep today's behaviour — stamp now.
  m.sessions.set('j', { name: 'j', workspaceId: 'ws1', activityState: 'idle', activityTs: 0 });
  m._emitActivity('j', 'thinking', false);
  assert.ok(m.sessions.get('j').activityTs >= wireTs + 600000 - 5000,
    'no wire event for this session → falls back to now');
});

test('create: rejects a duplicate session name before any spawn', async () => {
  const m = mk();
  m.sessions.set('dup', { name: 'dup' });
  await assert.rejects(() => m.create('dup', 'claude', '/tmp'), /already exists/);
});

// create()'s own guard is live-only ON PURPOSE (Task 15): the resume paths
// (restore-on-launch, unarchive→retry, restart/reload) re-create a name that IS in
// persistence, and must pass. The mint-front-door guard that rejects persisted
// names lives in ipc-handlers spawnFromParams (nameConflict), not here — so a
// create() with a persisted-but-not-live name spawns (proving resume safety).
test('create: a persisted-but-not-live name is NOT rejected at the create layer (resume safety)', async () => {
  // Persistence "has" the name, but it isn't live → create() must proceed past the
  // dup guard. It then fails on the (missing) cwd, proving it got PAST the guard.
  const m = mk({ getPersistence: () => ({ list: () => [], get: () => ({ name: 'foo' }) }) });
  await assert.rejects(() => m.create('foo', 'claude', '/no/such/dir/anywhere'), /does not exist/);
});

// The pure mint-collision decision (Task 15, GH#9) — the truth table the
// spawnFromParams guard consumes. live wins over persisted (distinct error copy).
test('nameConflict: live | persisted | free truth table', () => {
  assert.strictEqual(nameConflict({ liveHas: true, persistedHas: false }), 'live');
  assert.strictEqual(nameConflict({ liveHas: false, persistedHas: true }), 'persisted', 'archived/saved record blocks a mint');
  assert.strictEqual(nameConflict({ liveHas: true, persistedHas: true }), 'live', 'live wins (error says "already exists")');
  assert.strictEqual(nameConflict({ liveHas: false, persistedHas: false }), null, 'free name mints');
});

test('create: rejects a nonexistent or non-directory cwd before any spawn', async () => {
  // A bad cwd used to reach the PTY spawn, where the CLI exits ~immediately and
  // the tab flickers away with no reason shown (found live in the docker web
  // frontend, where there is no native directory picker to keep paths honest).
  const m = mk();
  await assert.rejects(() => m.create('ghost', 'claude', '/no/such/dir/anywhere'), /does not exist/);
  await assert.rejects(() => m.create('ghost', 'bash', __filename), /Not a directory/);
});

// The registry-conflict staleness rule (extracted pure so it needs no PTY spawn).
// A blocking agent.json is force-cleaned when its pid is dead OR is our own pid —
// the latter being the deterministic-pid Docker case where the engine is the same
// pid every boot, so a leftover registration points at the new engine itself and a
// bare isAlive() check would wedge the name forever.
test('isStaleRegistration: dead pid OR our own pid is stale; a live OTHER pid is not', () => {
  const own = process.pid;
  const dead = () => false;
  const alive = () => true;
  // Dead pid → stale regardless of who it is.
  assert.equal(isStaleRegistration(999999, own, dead), true, 'dead pid is stale');
  // Our own pid, even when isAlive() says true (it always will — it's us) → stale.
  assert.equal(isStaleRegistration(own, own, alive), true, 'our own pid is stale (Docker deterministic-pid case)');
  // A different, genuinely-live pid → NOT stale (the two-Clodexes guard holds).
  assert.equal(isStaleRegistration(own + 1, own, alive), false, 'a live other pid is running elsewhere');
});

// Stray-wire-session discrimination (the 7-digests-in-4-minutes incident): the
// wire attributes requests by proxy route, so a child claude spawned inside a
// session mints fresh main-line-looking conversation ids on the session's own
// route. Neither the boot-digest path nor the identity backstop may trust an
// id the transcript symlink doesn't corroborate.
const fsReal = require('fs');
const osReal = require('os');
const pathReal = require('path');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');

function mkWithTranscript(sessionId, overrides = {}) {
  const root = mkTmpRoot('clodex-sm-');
  fsReal.mkdirSync(runDirForReal(root, 'a'), { recursive: true });
  if (sessionId) {
    const target = pathReal.join(root, `${sessionId}.jsonl`);
    fsReal.writeFileSync(target, '');
    fsReal.symlinkSync(target, pathForReal(root, 'a', 'transcript'));
  }
  const m = mk({
    REGISTRY_DIR: root, fs: fsReal, path: pathReal, pathFor: pathForReal,
    ...overrides,
  });
  return { m, root };
}

test('_wireSessionCorroborated: symlink agrees → true, disagrees → false, absent → true (backstop)', () => {
  const { m } = mkWithTranscript('real-conv-id');
  const s = { name: 'a' };
  assert.strictEqual(m._wireSessionCorroborated(s, 'real-conv-id'), true);
  assert.strictEqual(m._wireSessionCorroborated(s, 'stray-child-id'), false);
  const { m: m2 } = mkWithTranscript(null); // no symlink — can't testify
  assert.strictEqual(m2._wireSessionCorroborated({ name: 'a' }, 'anything'), true);
});

// ── removeMemoryUnit: the one delete path (intent + host.library.remove) ────
// The real writeClaudeDigestFile, on a temp REGISTRY_DIR, because the property
// under test is a filesystem SIDE EFFECT: it ensureDir's run/<name>/, so a stub
// would pin the call and miss the directory.
function mkRemover({ forget = () => {}, units = [], digestThrows = false } = {}) {
  const root = mkTmpRoot('clodex-rm-');
  const real = require('../cli-hooks').createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => units },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  }).writeClaudeDigestFile;
  const writeClaudeDigestFile = digestThrows
    ? () => { throw new Error('ENOSPC writing hook-digest.json'); }
    : real;
  const forgotten = [];
  const m = mk({
    REGISTRY_DIR: root, fs: fsReal, path: pathReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    memoryStore: { forget: (a, id) => { forgotten.push([a, id]); return forget(a, id); } },
    writeClaudeDigestFile,
  });
  return { m, root, forgotten, runDir: (n) => runDirForReal(root, n) };
}

test('removeMemoryUnit: a digest write that throws AFTER a successful forget still returns ok', () => {
  // The settled decision, pinned. The unlink already happened and is permanent,
  // so { ok: false } here invites a retry that fails with "no unit" and reads as
  // a bug in the delete path. The edit this catches: hoisting the try/catch to
  // wrap the whole method body, which flips the return with nothing else red.
  const { m, forgotten } = mkRemover({ digestThrows: true, units: [{ id: 'u1', pinned: true, body: 'x', learned_at: new Date().toISOString() }] });
  const session = { name: 'a', agentType: 'claude', digestNonEmpty: true };
  m.sessions.set('a', session);
  assert.deepStrictEqual(m.removeMemoryUnit('a', 'mem-1-aaaaaa'), { ok: true },
    'a failed digest write must not report the delete as failed');
  assert.deepStrictEqual(forgotten, [['a', 'mem-1-aaaaaa']], 'the unit really was deleted');
  // The throw leaves the OLD hook-digest.json in place, so an unchanged `true`
  // still describes a digest that exists — flag and file stay consistent.
  assert.strictEqual(session.digestNonEmpty, true, 'the flag is left as it was, not cleared');
});

test('removeMemoryUnit: a live claude session gets its digest rewritten and the flag REASSIGNED', () => {
  const { m, forgotten, runDir } = mkRemover({ units: [{ id: 'u1', pinned: true, body: 'kept', learned_at: new Date().toISOString() }] });
  const session = { name: 'a', agentType: 'claude', digestNonEmpty: false };
  m.sessions.set('a', session);
  assert.deepStrictEqual(m.removeMemoryUnit('a', 'mem-1-aaaaaa'), { ok: true });
  assert.deepStrictEqual(forgotten, [['a', 'mem-1-aaaaaa']]);
  assert.ok(fsReal.existsSync(runDir('a')), 'a live session DOES get the digest rewritten');
  assert.strictEqual(session.digestNonEmpty, true, 'the flag is assigned from the return value');

  // Emptied to zero: the flag must go false. _noteConversationForDigest gates
  // markDigested on it, so a stale true marks a conversation as digested that
  // never received a digest.
  const empty = mkRemover({ units: [] });
  const s2 = { name: 'a', agentType: 'claude', digestNonEmpty: true };
  empty.m.sessions.set('a', s2);
  empty.m.removeMemoryUnit('a', 'mem-1-aaaaaa');
  assert.strictEqual(s2.digestNonEmpty, false, 'an emptied store must clear the flag');
});

test('removeMemoryUnit: a DEAD agent is forgotten without recreating its run directory', () => {
  const { m, forgotten, runDir } = mkRemover({ units: [{ id: 'u1', pinned: true, body: 'x', learned_at: new Date().toISOString() }] });
  // No session in the map — memories outlive sessions, so this is the plugin
  // deleting a dead agent's unit. writeClaudeDigestFile ensureDir's the run
  // dir, so calling it here would recreate a dead agent's directory as a side
  // effect of a delete.
  assert.deepStrictEqual(m.removeMemoryUnit('ghost', 'mem-1-aaaaaa'), { ok: true });
  assert.deepStrictEqual(forgotten, [['ghost', 'mem-1-aaaaaa']], 'the unit is still deleted');
  assert.strictEqual(fsReal.existsSync(runDir('ghost')), false,
    'the delete must not resurrect run/<name>/');

  // A live NON-claude session is the same case: no claude digest to rewrite.
  const bash = mkRemover({ units: [] });
  bash.m.sessions.set('b', { name: 'b', agentType: 'codex' });
  bash.m.removeMemoryUnit('b', 'mem-1-aaaaaa');
  assert.strictEqual(fsReal.existsSync(bash.runDir('b')), false);
});

test('removeMemoryUnit: a store throw becomes an envelope, and skips the digest rewrite', () => {
  const { m, runDir } = mkRemover({ forget: () => { throw new Error('no unit mem-9-zzzzzz'); } });
  m.sessions.set('a', { name: 'a', agentType: 'claude', digestNonEmpty: true });
  const res = m.removeMemoryUnit('a', 'mem-9-zzzzzz');
  assert.deepStrictEqual(res, { ok: false, error: 'no unit mem-9-zzzzzz' });
  assert.strictEqual(fsReal.existsSync(runDir('a')), false,
    'a failed delete must not rewrite the digest');
});

test('[agent:memory forget] routes through removeMemoryUnit rather than a second copy', () => {
  const { m } = mkRemover({ units: [] });
  const acked = [];
  const injected = [];
  m._memoryAck = (s, line) => acked.push(line);
  m._injectText = (s, line) => injected.push(line);
  const calls = [];
  m.removeMemoryUnit = (agent, id) => { calls.push([agent, id]); return { ok: true }; };
  const session = { name: 'a', agentType: 'claude' };
  m._handleMemoryIntent(session, 'forget', ' mem-1-aaaaaa ');
  assert.deepStrictEqual(calls, [['a', 'mem-1-aaaaaa']], 'the intent is a CALLER, not a twin');
  assert.deepStrictEqual(acked, ['[agent:memory] removed mem-1-aaaaaa from the store']);

  m.removeMemoryUnit = () => ({ ok: false, error: 'no unit mem-1-aaaaaa' });
  m._handleMemoryIntent(session, 'forget', 'mem-1-aaaaaa');
  assert.deepStrictEqual(injected, ['[agent:memory] could not remove: no unit mem-1-aaaaaa'],
    'the branch keeps its own error text');
});

test('[agent:memory remember] parses tags=, and a pin BEHIND tags= still lands', () => {
  // The regression: the prefix loop halted on the first unrecognised key, so
  // `tags=a,b pinned=true` set neither — the pin was stranded in the body as
  // literal text. Four live units lost their pin this way. Order matters here:
  // pinned must come AFTER tags, or the test passes against the broken loop.
  const saved = [];
  const m = mk({
    memoryStore: { remember: (agent, opts) => { saved.push([agent, opts]); return { id: 'mem-1-aaaaaa' }; } },
    getPersistence: () => ({ markDigested: () => {} }),
    writeClaudeDigestFile: () => true,
  });
  const failed = [];
  m._memoryAck = () => {};
  m._injectText = (s, line) => failed.push(line);
  m._handleMemoryIntent({ name: 'a', agentType: 'claude' }, 'remember',
    'scope=ops tags=hints,security pinned=true the durable fact');
  assert.deepStrictEqual(failed, [], 'the save must not have taken the error path');
  assert.deepStrictEqual(saved, [['a', {
    scope: 'ops', tags: 'hints,security', text: 'the durable fact',
    source: 'a', pinned: true,
  }]], 'every directive is consumed and none leaks into the body');
});

test('_maybeDeliverDigest: stray sid (≠ s.sessionId) neither delivers nor marks', () => {
  const marked = [];
  const delivered = [];
  const m = mk({
    getPersistence: () => ({
      get: () => ({ name: 'a', digested: [] }),
      markDigested: (name, sid) => marked.push(sid),
    }),
    isDigested: () => false,
    memoryStore: { list: () => [{ id: 'u1' }] },
    composeDigest: () => 'DIGEST',
  });
  m._deliverMessage = (to, from, body) => delivered.push(body);
  const s = { name: 'a', agentType: 'claude', sessionId: 'real-conv-id' };
  m._maybeDeliverDigest(s, 'stray-child-id');
  assert.deepStrictEqual(delivered, [], 'stray id: no digest injected');
  assert.deepStrictEqual(marked, [], 'stray id: ledger untouched');
  // The PTY's own conversation still gets it.
  m._maybeDeliverDigest(s, 'real-conv-id');
  assert.strictEqual(delivered.length, 1);
  assert.deepStrictEqual(marked, ['real-conv-id']);
});

// Keep-warm lifecycle listener: re-anchors must RE-PERSIST the deadline (the
// keeper restarts its window on every organic turn, so a stale persisted
// holdUntil would wrongly lapse-clear a still-valid hold after a restart);
// NO disarm cause may erase a persisted intent; and a 'failures' disarm — alone
// among the causes — REOPENS the re-arm gate, because that disarm is provisional.
test('_onHoldLifecycle: re-anchor re-persists, no disarm erases an intent, only a failure disarm reopens the gate', () => {
  // ONE ordered log for both setters, not one array each: a write to the wrong
  // one of the two is the failure this pins, and separate arrays cannot see it.
  //
  // The body is wrapped in a swallow-everything try/catch, and the disarm
  // assertions below are now ABSENCES (`calls` stays empty) — exactly the shape
  // that would also hold if the branch threw on line one and was swallowed. The
  // `_holdRearmed` assertions are what stop that: each is a POSITIVE observation
  // of a mutation made at the END of the branch, so the branch cannot have
  // aborted early and still satisfy them. Do not drop them to "simplify".
  const calls = [];
  const m = mk({
    getPersistence: () => ({
      list: () => [], get: () => null,
      setHoldUntil: (name, v) => calls.push(['setHoldUntil', name, v]),
      setKeepWarmAlways: (name, v) => calls.push(['setKeepWarmAlways', name, v]),
    }),
    log: { info: () => {}, warn: () => {} },
  });
  // _holdRearmed starts LATCHED SHUT, which is the state a live armed seat is in
  // (_maybeRearmHold sets it once the arm lands). Starting it false would make
  // every "reopened the gate" assertion below vacuous.
  const seat = { name: 'a', sessionId: 'sid-1', _holdRearmed: true };
  m.sessions.set('a', seat);

  // Re-anchor: keeper's `until` is epoch SECONDS → persisted as epoch ms.
  m._onHoldLifecycle({ session: 'sid-1', event: 're-anchored', until: 1_700_000_000 });
  assert.deepStrictEqual(calls, [['setHoldUntil', 'a', 1_700_000_000_000]]);

  // Unknown wire sid (child claude / rotated id): never touches persistence.
  m._onHoldLifecycle({ session: 'stray', event: 're-anchored', until: 1_700_000_000 });
  assert.strictEqual(calls.length, 1);

  // A perpetual seat's re-anchor carries until:null and must persist NOTHING —
  // recording `now` here would give the seat both intents at once.
  m._onHoldLifecycle({ session: 'sid-1', event: 're-anchored', until: null });
  assert.strictEqual(calls.length, 1);

  // THE REGRESSION. A 401 strike-out used to clear keepWarmAlways + holdUntil,
  // which erased an explicit operator setting on a rejection that recovers by
  // itself in minutes (the CLI owns the OAuth file and refreshes it on its next
  // real turn). It must now write nothing and reopen the gate instead.
  calls.length = 0;
  assert.strictEqual(seat._holdRearmed, true,
    'ENTER: the gate is latched shut going in, or "reopened" below proves nothing');
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'failures', reason: 'whatever', pings: 2, lastResult: 'fail:401' });
  assert.strictEqual(seat._holdRearmed, false,
    'a 401 disarm reopens the gate so the surviving intent re-arms on the next main-line turn');
  assert.deepStrictEqual(calls, [], 'and it erases neither the seat flag nor the deadline');

  // Explicit off: the operator withdrew it. Handled (logged+cleared) by the
  // wire:hold handler, skipped here — and it must NOT reopen the gate, or the
  // seat would re-arm itself out of a withdrawal on the very next turn.
  seat._holdRearmed = true;
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'off', pings: 0 });
  assert.strictEqual(seat._holdRearmed, true, "'off' is a withdrawal, not a provisional stop");

  // Expiry/max-pings are terminal for the TIMED holds that can reach them (a
  // perpetual hold is `!hold.always`-guarded out of both), and 'session-ended'
  // is emitted on the /clear handover path, which resets the gate itself. None
  // of the three may reopen it here.
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'expired', pings: 5 });
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'max-pings', pings: 24 });
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'session-ended', pings: 2 });
  assert.strictEqual(seat._holdRearmed, true,
    'expired/max-pings are terminal and session-ended is the rotation path\'s own job');

  // A permanent but NON-credential failure now takes the SAME branch as the 401.
  // It always deserved the same treatment: ping() strips `thinking` and
  // `context_management` precisely because a wrong combination 400s, so an
  // upstream schema change makes the REPLAY 400 on a perfectly good credential.
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'failures', pings: 2, lastResult: 'fail:400' });
  assert.strictEqual(seat._holdRearmed, false, 'a 400 strike-out is provisional too');

  // A failures disarm with no label at all (older code path, or a keeper that
  // never pinged) is likewise provisional.
  seat._holdRearmed = true;
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'failures', pings: 2 });
  assert.strictEqual(seat._holdRearmed, false, 'an unlabelled failures disarm is provisional too');

  assert.deepStrictEqual(calls, [],
    'no disarm cause writes to persistence at all — a failed ping is not evidence about the setting');
});

// The end-to-end claim the ticket is about, driven through the real seams rather
// than asserted on source text: a perpetual seat strikes out on a transient 401,
// and its persisted flag both SURVIVES that and is re-armed on the next
// main-line turn. Needs the real _onHoldLifecycle → _maybeRearmHold pair,
// because the bug lived in the handoff between them: the old code cleared the
// flag, and clearing it was not even the whole defect — the re-arm gate stays
// latched shut after a disarm, so the flag alone would never have been restored.
test('a perpetual seat survives a 401 strike-out and re-arms itself on the next turn', () => {
  const calls = [];
  // A REAL record object, mutated by the fake setters exactly as persistence
  // would mutate sessions.json. list() reads it back, so if the disarm branch
  // ever clears keepWarmAlways again, the re-arm below sees the cleared record
  // and declines — the test fails on the behaviour, not on a recorded call.
  const rec = { name: 'a', keepWarmAlways: true };
  const m = mk({
    getPersistence: () => ({
      list: () => [rec],
      get: () => null,
      setHoldUntil: (n, v) => { calls.push(['setHoldUntil', n, v]); if (v == null) delete rec.holdUntil; else rec.holdUntil = v; },
      setKeepWarmAlways: (n, v) => { calls.push(['setKeepWarmAlways', n, v]); if (v) rec.keepWarmAlways = true; else delete rec.keepWarmAlways; },
    }),
    log: { info: () => {}, warn: () => {} },
  });
  m._holdKeeper = {
    endSession: (sid) => calls.push(['endSession', sid]),
    arm: (sid, hours, opts) => {
      calls.push(opts === undefined ? ['arm', sid, hours] : ['arm', sid, hours, opts]);
      return { armed: true, always: !!(opts && opts.always), until: null };
    },
  };
  m._shadowLog = (r) => calls.push(['shadow', r.type, r.error]);
  const s = { name: 'a', sessionId: 'sid-1', agentType: 'claude', _holdRearmed: true };
  m.sessions.set('a', s);

  // Two overnight 401s → the keeper strikes out and emits the disarm.
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'failures', pings: 2, lastResult: 'fail:401' });

  assert.strictEqual(rec.keepWarmAlways, true,
    'the operator setting is still in the record after the strike-out');

  // Morning: the CLI's OAuth has refreshed and the seat takes a real turn. This
  // is the exact call the wire's turn.completed handler makes.
  m._maybeRearmHold(s, 'a');

  assert.deepStrictEqual(calls.filter((c) => c[0] === 'arm'), [['arm', 'sid-1', 0, { always: true }]],
    'ENTER: it re-armed perpetually on the live wire id — everything else here is vacuous otherwise');
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'shadow'), [],
    'and no swallowed throw hid inside _maybeRearmHold');
  assert.deepStrictEqual(calls.filter((c) => c[0].startsWith('set')), [],
    'the whole round trip wrote nothing to persistence: the intent was never touched');
  assert.strictEqual(s._holdRearmed, true, 'and the gate latched shut again behind the re-arm');
});

// A /clear mints a new wire sessionId under a live session, and the keeper is
// keyed on that id. Both halves of the handover are exercised through their real
// seams — _onWireSessionRotated then _maybeRearmHold, the same order and the same
// turn as the wire's turn.completed handler calls them.
//
// ONE ordered log across the keeper AND persistence, because what matters is a
// SEQUENCE across two collaborators: ending the old hold after the reassignment
// would end the wrong conversation, and no per-object recorder can see that.
function rotationRig({ transcriptId = null, rec = null, sessionId = 'old-sid' } = {}) {
  const calls = [];
  const { m } = mkWithTranscript(transcriptId, {
    getPersistence: () => ({
      list: () => (rec ? [rec] : []),
      get: () => null,
      setSessionId: (n, v) => calls.push(['setSessionId', n, v]),
      setHoldUntil: (n, v) => calls.push(['setHoldUntil', n, v]),
      setKeepWarmAlways: (n, v) => calls.push(['setKeepWarmAlways', n, v]),
    }),
    log: { info: () => {}, warn: () => {} },
  });
  m._holdKeeper = {
    endSession: (sid) => { calls.push(['endSession', sid]); return { session: sid, holdDisarmed: true }; },
    // Records the arguments production ACTUALLY passed — no `opts = {}` default,
    // which would make a missing third argument indistinguishable from an empty
    // one and quietly turn the timed-arm assertion below into a tautology.
    arm: (sid, hours, opts) => {
      calls.push(opts === undefined ? ['arm', sid, hours] : ['arm', sid, hours, opts]);
      return { armed: true, always: !!(opts && opts.always), until: (opts && opts.always) ? null : 1_700_000_000 };
    },
  };
  // Both write real files off REGISTRY_DIR and neither is under test here.
  m._noteConversationForDigest = (_s, sid) => calls.push(['noteDigest', sid]);
  m._shadowLog = (r) => calls.push(['shadow', r.type]);
  return { m, calls, s: { name: 'a', sessionId, agentType: 'claude' } };
}

test('a /clear ends the OLD conversation hold before re-arming the perpetual seat on the new one', () => {
  const { m, s, calls } = rotationRig({ rec: { name: 'a', keepWarmAlways: true } });

  m._onWireSessionRotated(s, 'a', 'new-sid');
  m._maybeRearmHold(s, 'a');

  // The old id must reach endSession, which means endSession must run BEFORE
  // the reassignment. Nothing else ever disarms it: holdDecision's expired and
  // max-pings branches are both `!hold.always`-guarded and a dead prefix only
  // skips, so a stranded perpetual hold is re-hashed by every tick forever.
  assert.deepStrictEqual(calls, [
    ['endSession', 'old-sid'],
    ['setSessionId', 'a', 'new-sid'],
    ['noteDigest', 'new-sid'],
    ['arm', 'new-sid', 0, { always: true }],
  ]);
  assert.strictEqual(s.sessionId, 'new-sid');
  assert.strictEqual(s._holdRearmed, true, 'the gate closed again once the re-arm landed');
});

test('a /clear does not withdraw the seat property it is handing over', () => {
  const { m, s, calls } = rotationRig({ rec: { name: 'a', keepWarmAlways: true } });
  m._onWireSessionRotated(s, 'a', 'new-sid');
  m._maybeRearmHold(s, 'a');
  // The whole ordered log is asserted above; here the point is which writes are
  // ABSENT from it, and the only safe way to say that is to name every write
  // that did happen. keepWarmAlways surviving is what makes the re-arm possible.
  assert.deepStrictEqual(calls.filter((c) => c[0].startsWith('set')), [
    ['setSessionId', 'a', 'new-sid'],
  ], 'no setKeepWarmAlways and no setHoldUntil — the intent is untouched by a clear');
});

test('a timed hold rotates too, and re-arms the remaining window on the new id', () => {
  const holdUntil = Date.now() + 2 * 3600e3;
  const { m, s, calls } = rotationRig({ rec: { name: 'a', holdUntil } });

  m._onWireSessionRotated(s, 'a', 'new-sid');
  m._maybeRearmHold(s, 'a');

  assert.deepStrictEqual(calls.slice(0, 2), [['endSession', 'old-sid'], ['setSessionId', 'a', 'new-sid']]);
  const armed = calls.find((c) => c[0] === 'arm');
  assert.ok(armed, 'ENTER: it re-armed at all — the assertions below are vacuous otherwise');
  assert.strictEqual(armed[1], 'new-sid');
  assert.ok(armed[2] > 1.9 && armed[2] <= 2, `remaining window, got ${armed[2]}`);
  // Length, not deepStrictEqual on armed[3]: the rig defaults that parameter to
  // {}, so asserting the empty object would only pin the rig's own default and
  // would stay green if production started passing { always: true } here.
  assert.strictEqual(armed.length, 3, 'a timed re-arm passes no always flag at all');
});

test('a stale wire turn cannot rotate the seat BACK onto a conversation it has left', () => {
  const { m, s, calls } = rotationRig({ rec: { name: 'a', keepWarmAlways: true } });
  m._onWireSessionRotated(s, 'a', 'new-sid');
  m._maybeRearmHold(s, 'a');
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'arm').length, 1,
    'ENTER: the forward handover armed the new id — the backward attempt below is vacuous otherwise');
  calls.length = 0;

  // turn.completed from the OLD conversation, still in flight when the handover
  // ran. Corroboration is not what stops it and cannot be: rotationRig leaves the
  // transcript symlink unresolvable, so _wireSessionCorroborated fails OPEN and
  // returns true — which is exactly the transient state a clear produces.
  m._onWireSessionRotated(s, 'a', 'old-sid');

  assert.deepStrictEqual(calls, [['shadow', 'wire-stale-session']],
    'no endSession: ending old-sid here would kill the hold just handed to new-sid');
  assert.strictEqual(s.sessionId, 'new-sid', 'and the seat stays on the conversation it moved to');
});

test('a stray child-claude sessionId rotates nothing and ends no hold', () => {
  // Corroboration-gated: the wire attributes by proxy route, so a child claude
  // mints main-line-looking ids on the session's own route. Acting on one would
  // end the real conversation's hold and hand keep-warm to a transient child.
  const { m, s, calls } = rotationRig({
    transcriptId: 'real-conv-id', sessionId: 'real-conv-id', rec: { name: 'a', keepWarmAlways: true },
  });

  m._onWireSessionRotated(s, 'a', 'stray-child-id');

  assert.deepStrictEqual(calls, [['shadow', 'wire-stray-session']]);
  assert.strictEqual(s.sessionId, 'real-conv-id', 'the live conversation id is untouched');
  assert.notStrictEqual(s._holdRearmed, false, 'and the re-arm gate was not reopened');
});

// --- Compact latch (FIX C) ---------------------------------------------------
// A wire-owned Claude self-compact LATCHES instead of firing immediately: Claude
// Code silently drops slash commands mid-turn, so the wire turn.completed
// fire-check runs /compact only at a terminal stop with both queues empty. A fake
// InjectQueue (just a .length) + a captured _injectText/sentinel let us drive
// _maybeFireCompactLatch and _executeCompact without a PTY.
function mkCompact(overrides = {}) {
  const injected = [];
  const armed = [];
  // INJECT_HOLD_TIMEOUT set large so _armCompactGuard's inner _armInjectValve
  // doesn't fire a stray 0ms timer (undefined delay) during the assertions.
  const m = mk({
    log: { info: () => {}, warn: () => {} },
    INJECT_HOLD_TIMEOUT: 60_000,
    canFireCompact, // the real pure predicate (main.js injects it live)
    ...overrides,
  });
  m._injectText = (s, text) => injected.push(text);
  m._broadcast = () => {};
  return { m, injected, armed };
}

test('_maybeFireCompactLatch: fires on empty queues, skips when either queue non-empty', () => {
  const { m, injected } = mkCompact();
  const sentinelArmed = [];
  const s = {
    name: 'a', intentSource: 'wire', agentType: 'claude',
    _compactPending: { cmd: '/compact', continuation: 'carry on' },
    sentinel: { armCompact: (cb) => sentinelArmed.push(cb) },
    _injectQueue: [], _injectPtyQueue: { length: 0 },
  };
  m.sessions.set('a', s);

  // pty queue busy → skip, latch survives, nothing injected.
  s._injectPtyQueue.length = 1;
  m._maybeFireCompactLatch(s);
  assert.ok(s._compactPending, 'latch survives while a queue is non-empty');
  assert.deepStrictEqual(injected, []);

  // hold queue busy → still skip.
  s._injectPtyQueue.length = 0;
  s._injectQueue = ['queued dm'];
  m._maybeFireCompactLatch(s);
  assert.ok(s._compactPending);
  assert.deepStrictEqual(injected, []);

  // both empty → fire: latch cleared, /compact injected, continuation stashed,
  // sentinel armed, guard + valve set.
  s._injectQueue = [];
  m._maybeFireCompactLatch(s);
  assert.strictEqual(s._compactPending, null, 'latch cleared on fire');
  assert.deepStrictEqual(injected, ['/compact']);
  assert.strictEqual(s._compactContinuation, 'carry on');
  assert.strictEqual(sentinelArmed.length, 1);
  assert.strictEqual(s._compactGuard, true);
  assert.ok(s._compactValveTimer, 'valve armed at fire');
  clearTimeout(s._compactValveTimer);
  clearTimeout(s._injectHoldTimer);
});

test('_maybeFireCompactLatch: no latch or dead session is a no-op', () => {
  const { m, injected } = mkCompact();
  const s = { name: 'a', _injectQueue: [], _injectPtyQueue: { length: 0 } };
  m._maybeFireCompactLatch(s); // no _compactPending
  assert.deepStrictEqual(injected, []);
  s._compactPending = { cmd: '/compact', continuation: 'x' };
  s._dead = true;
  m._maybeFireCompactLatch(s); // dead
  assert.deepStrictEqual(injected, []);
  assert.ok(s._compactPending, 'dead session: latch untouched');
});

test('compact valve clears a stuck latch (never-fired) along with guard/continuation', async () => {
  // Drive the REAL valve body with a 1ms timeout (injected dep) rather than
  // reimplementing it, so the test breaks if _armCompactValve stops clearing
  // the latch.
  const flushed = [];
  const { m } = mkCompact({ COMPACT_INFLIGHT_TIMEOUT: 1 });
  m._maybeFlushInjectQueue = (s) => flushed.push(s.name);
  const s = { name: 'a', _compactPending: { cmd: '/compact', continuation: 'x' } };
  m.sessions.set('a', s);
  m._armCompactValve(s);
  assert.ok(s._compactValveTimer, 'valve armed at latch-set');
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(s._compactPending, null, 'valve cleared the stuck latch');
  assert.strictEqual(s._compactGuard, false);
  assert.strictEqual(s._compactContinuation, null);
  assert.deepStrictEqual(flushed, ['a'], 'valve flushed the queue');
});

test('_executeCompact: shared body stashes continuation, injects, arms guard + valve; each arm RESETS the valve', () => {
  const { m, injected } = mkCompact({ COMPACT_INFLIGHT_TIMEOUT: 60_000 });
  const s = { name: 'a', sentinel: { armCompact: () => {} } };
  m.sessions.set('a', s);
  m._executeCompact(s, '/compact', 'do the thing');
  assert.deepStrictEqual(injected, ['/compact']);
  assert.strictEqual(s._compactContinuation, 'do the thing');
  assert.strictEqual(s._compactGuard, true);
  const t1 = s._compactValveTimer;
  assert.ok(t1);
  // A second arm resets (clears then re-creates) — not a stacked second timer.
  m._armCompactValve(s);
  assert.notStrictEqual(s._compactValveTimer, t1, 'valve timer replaced, not stacked');
  clearTimeout(s._compactValveTimer);
  clearTimeout(s._injectHoldTimer);
});

// --- who lists all local agents, every workspace (federated-peer parity) -----
// who already surfaces `name@peer` agents from other Clodexes to every
// workspace, so it must also list same-Clodex agents in a different LOCAL
// workspace — hiding those was the inconsistent case. Two agents in different
// workspaces; who from one lists the other, flat (no workspace tag), self
// excluded.
test('who: lists agent sessions from all workspaces, flat, self excluded', async () => {
  const injected = [];
  const m = mk({
    registry: { listPeers: () => [] },
    getPeerManager: () => null,
    peerStatusLabel: () => 'idle',
  });
  m._injectText = (s, text) => injected.push(text);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', workspaceId: 'ws2' });
  m.sessions.set('sh', { name: 'sh', workspaceId: 'ws1' }); // bash: no agentType, excluded

  await m._handleIntent('a', { type: 'who' });

  assert.strictEqual(injected.length, 1);
  // Exactly the other-workspace agent, labelled, no workspace annotation — proves
  // cross-workspace visibility, self-exclusion, and bash exclusion in one shot.
  assert.strictEqual(injected[0], '[agent:peers] b (idle)');
});

// --- Fire-time intent gate (per-session `intents` allowlist) ------------------
// _handleIntent reads the SENDER's persisted `intents` FRESH on every fire and
// bounces a disabled intent before the switch — send-side only. Absent list =
// all enabled (back-compat). `name` is never gateable. `exec` passing the coarse
// gate still meets its finer per-command grant. The resend bounce spells out
// that the fallback is parking (a delay), not a loss.
function mkGate(intents, plugins) {
  // `intents` is the value persisted under sender 'a' (undefined = absent), and
  // `plugins` is the seat's plugin list on the same record (undefined = the
  // living all-enabled default).
  const injected = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents, plugins } : null) }),
    registry: { listPeers: () => [] },
    getPeerManager: () => null,
    peerStatusLabel: () => 'idle',
  });
  m._injectText = (_s, text) => injected.push(text);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', workspaceId: 'ws2' });
  return { m, injected };
}

test('gate: absent allowlist lets every intent through (back-compat default)', async () => {
  const { m, injected } = mkGate(undefined);
  await m._handleIntent('a', { type: 'who' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /^\[agent:peers\]/); // the real who reply, not a bounce
});

test('gate: an enabled intent in a restrictive allowlist fires normally', async () => {
  const { m, injected } = mkGate(['who', 'dm']);
  await m._handleIntent('a', { type: 'who' });
  assert.match(injected[0], /^\[agent:peers\]/);
});

test('gate: a disabled intent bounces loudly naming the gate, and does NOT run', async () => {
  const { m, injected } = mkGate(['dm']); // who is off
  await m._handleIntent('a', { type: 'who' });
  assert.strictEqual(injected.length, 1);
  assert.strictEqual(injected[0], '[agent:who] the who intent is disabled for this session');
});

test('gate: an empty array gates everything', async () => {
  const { m, injected } = mkGate([]);
  await m._handleIntent('a', { type: 'who' });
  assert.strictEqual(injected[0], '[agent:who] the who intent is disabled for this session');
});

test('gate: the resend bounce spells out the parking fallback (delay, not loss)', async () => {
  const { m, injected } = mkGate(['dm']); // resend off
  await m._handleIntent('a', { type: 'resend', id: 'p1' });
  assert.strictEqual(
    injected[0],
    "[agent:resend] the resend intent is disabled for this session — the message will deliver with the peer's next turn",
  );
});

test('gate: `name` is never gateable, even with an empty allowlist', async () => {
  const { m, injected } = mkGate([]);
  await m._handleIntent('a', { type: 'name' });
  assert.strictEqual(injected[0], '[agent:name] a');
});

// t654: the hole write-time pruning alone leaves. Every writer of `plugins`
// prunes the allowlist, but a writer can be forgotten and a record can be
// hand-edited — so the seat whose `intents` names a plugin verb while its
// `plugins` does not must be REFUSED at the fire point, not merely un-surfaced.
// Driven through _handleIntent rather than the predicate: the predicate agreeing
// with itself is not what protects the seat, the call site wiring is.
test('gate: a plugin verb whose plugin the seat does not have BOUNCES, allowlist notwithstanding', async () => {
  const registry = require('../intent-registry');
  registry.registerIntent({
    verb: 'seatgated',
    parse: (l) => (l === '[agent:seatgated]' ? { probe: 'seatgated' } : null),
    promptLines: '  [agent:seatgated]   a plugin verb.',
  }, 'gated-plug', { scope: 'session', shipped: true });
  try {
    // CONTROL: with the plugin held, the verb passes the gate — so the bounce
    // below is the seat filter, not a verb the registry refuses outright.
    const ok = mkGate(['seatgated'], ['gated-plug']);
    await ok.m._handleIntent('a', { type: 'seatgated' });
    assert.strictEqual(
      ok.injected.filter((t) => t.includes('is disabled for this session')).length, 0,
      'CONTROL: a seat that HAS the plugin is not bounced',
    );

    const { m, injected } = mkGate(['seatgated'], []);
    await m._handleIntent('a', { type: 'seatgated' });
    assert.strictEqual(injected[0], '[agent:seatgated] the seatgated intent is disabled for this session',
      'the verb is refused even though the allowlist still names it');

    // And the seat default is preserved for a SHIPPED plugin: a pre-upgrade seat
    // with no `plugins` key fires it exactly as before.
    const pre = mkGate(['seatgated'], undefined);
    await pre.m._handleIntent('a', { type: 'seatgated' });
    assert.strictEqual(
      pre.injected.filter((t) => t.includes('is disabled for this session')).length, 0,
      'a seat on the absent-list default is unaffected — the plugin is shipped',
    );
  } finally {
    registry._resetPluginRows();
  }
});

test('gate: exec disabled → coarse bounce before the per-command grant is consulted', async () => {
  const { m, injected } = mkGate(['dm']); // exec off
  let ran = false;
  m._handleExecIntent = () => { ran = true; };
  await m._handleIntent('a', { type: 'exec', cmd: 'bridge-reply', body: '{}' });
  assert.strictEqual(ran, false); // never reached the per-command layer
  // t170: the body is reported lost, not spilled — an exec payload is derived from
  // the line the sender just wrote and means nothing without the denied command.
  assert.strictEqual(injected[0],
    '[agent:exec] the exec intent is disabled for this session — this capability is off for this seat; '
    + 'retrying will bounce the same way, and only the operator can turn it on (Edit Session → Intents). '
    + 'Your exec body (2 bytes) was NOT saved and exists only in your own turn');
});

// --- t170: a DENIED intent must not destroy the sender's body ----------------
//
// Same data-loss shape as t166, different site and different answer. Two things
// make it different, and each is pinned below: the sender cannot fix a denial by
// retrying (only the operator can), and the path repeats every turn forever, so
// the spill needs a rate cap that MSG_MAX_AGE (an age bound) does not provide.
//
// The spill is REAL here (a temp dir) for the reason mkSpillTasks documents: a
// stub returning a fixed string cannot tell a written file from a named one.
function mkDenied(extra = {}) {
  const spillDir = mkTmpRoot('clodex-t170-');
  const spills = [];
  const injected = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents: [] } : null) }), // everything gated
    spillToFile: (sender, body, recipient) => {
      const p = pathReal.join(spillDir, `msg-${spills.length}.txt`);
      fsReal.writeFileSync(p, `From: ${sender}\n\n${body}`);
      spills.push({ sender, recipient, path: p });
      return p;
    },
    registry: { listPeers: () => [] },
    getPeerManager: () => null,
    peerStatusLabel: () => 'idle',
    // mk() does not wire `log`, and the spill-failure branch warns through it — an
    // unwired seam turns "the disk is full" into a TypeError thrown out of the gate,
    // i.e. no bounce at all on exactly the path that most needs one. mkTasks wires it
    // for the same reason.
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...extra,
  });
  m._injectText = (_s, text) => injected.push(text);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  // Read the payload back through the path the BOUNCE carries, never off the
  // recorded call: the sender has nothing but the reply text.
  const recovered = () => {
    const mm = /minutes and then swept: (\S+)/.exec(injected[injected.length - 1] || '');
    return mm ? fsReal.readFileSync(mm[1], 'utf8') : null;
  };
  return { m, injected, spills, recovered, last: () => injected[injected.length - 1] };
}

test('t170 a denied dm hands the body back on disk, and the bounce carries the path', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'dm', target: 'b', body: 'the composed message' });
  assert.strictEqual(f.spills.length, 1, 'exactly one file written');
  assert.match(f.recovered(), /the composed message/, 'and it is READABLE through the path the sender was given');
  assert.strictEqual(f.spills[0].recipient, 'a',
    'spilled into the SENDER\'s own directory — this is why handing the payload back does not weaken the gate: '
    + 'the denied target is never written to and never told');
});

// The whole bounce, as one literal. A regex would pass against a sentence
// containing `undefined` or `NaN` — which is exactly what an unwired fixture dep
// renders, and that family has cost three tickets running.
test('t170 the denial bounce is fully rendered and never advises a retry', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'dm', target: 'b', body: 'twenty-one chars here' });
  assert.strictEqual(f.last(),
    '[agent:dm] the dm intent is disabled for this session — this capability is off for this seat; '
    + 'retrying will bounce the same way, and only the operator can turn it on (Edit Session → Intents). '
    + `Your dm body (21 bytes) is saved for the next 30 minutes and then swept: ${f.spills[0].path} — copy it out before then`);
  // t166's sites tell the sender to fix the input and retry. Here retrying is
  // guaranteed to bounce identically, so that advice would be a loop with no exit.
  assert.doesNotMatch(f.last(), /try again|retry it|re-fire|re-emit/i,
    'a denial is the operator\'s configuration, not a sender mistake');
});

// The rate policy. sweepSpilledMessages bounds spill AGE, not RATE, and a seat
// that has not internalised a denial emits the same verb every turn forever — so
// without a cap here one seat writes files without bound. Four bounces, not two:
// the cap is only observable on the bounce AFTER the budget is spent.
test('t170 the spill budget is per (seat, verb) and the overflow bounce admits the loss', async () => {
  const f = mkDenied();
  for (let i = 0; i < 4; i++) await f.m._handleIntent('a', { type: 'dm', target: 'b', body: `body ${i}` });
  assert.strictEqual(f.spills.length, 3, 'three written, the fourth refused — the cap is DENIED_SPILL_CAP, not unbounded');
  assert.match(f.last(), /was NOT saved — 3 bodies for this verb have already been spilled/);
  assert.doesNotMatch(f.last(), /is saved for/,
    'the two outcomes must stay distinguishable: a sender that reads "saved" stops holding the only copy');

  // A different verb has its own budget. A seat can be denied several capabilities
  // and one must not consume another's allowance.
  await f.m._handleIntent('a', { type: 'notify-user', body: 'an operator note' });
  assert.strictEqual(f.spills.length, 4, 'notify-user spills despite dm being exhausted');
  assert.match(f.recovered(), /an operator note/);
});

test('t170 a fresh session gets a fresh budget (a respawn has not read the earlier bounces)', async () => {
  const f = mkDenied();
  for (let i = 0; i < 4; i++) await f.m._handleIntent('a', { type: 'dm', target: 'b', body: `body ${i}` });
  assert.strictEqual(f.spills.length, 3);
  f.m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' }); // respawn: new Session object
  await f.m._handleIntent('a', { type: 'dm', target: 'b', body: 'after the respawn' });
  assert.strictEqual(f.spills.length, 4, 'the budget rides the live Session, so a respawn starts over');
});

// The one verb whose denial makes the payload MOOT rather than lost: the reset did
// not happen, so the continuation note is still in the context it was written for.
// A "your body was not saved" line here would be a false alarm.
test('t170 a denied context keeps its ORIGINAL bounce — nothing was destroyed', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'context', sub: 'compact', body: 'pick up at phase 3' });
  assert.strictEqual(f.last(), '[agent:context] the context intent is disabled for this session');
  assert.strictEqual(f.spills.length, 0);
});

test('t170 a denied exec reports the loss but writes nothing', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'exec', cmd: 'c', body: '{"a":1}' });
  assert.strictEqual(f.spills.length, 0, 'a derived JSON args object is not worth a file');
  assert.match(f.last(), /Your exec body \(7 bytes\) was NOT saved/, 'but the loss is still announced');
});

// memory splits on `sub`: only `remember` carries a greedy body. A sub that gains
// one later must not be spilled under the `remember` label.
test('t170 memory spills only for `remember`', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'memory', sub: 'remember', body: 'a durable fact' });
  assert.strictEqual(f.spills.length, 1);
  assert.strictEqual(f.spills[0].sender, 'memory remember (denied)',
    'the on-disk label distinguishes a DENIED payload from t166\'s REJECTED ones');
  await f.m._handleIntent('a', { type: 'memory', sub: 'recall', body: 'x' });
  assert.strictEqual(f.spills.length, 1, 'a non-remember sub is reported, not written');
  assert.match(f.last(), /Your memory recall body \(1 bytes\) was NOT saved/);
});

// term's body is a shell command the agent can retype from the line it just
// wrote, and it is worthless without the terminal that was refused — so it is
// reported as lost and NOT written to disk. The verdict that matters is the
// second half: spilling it would leave a file full of shell commands in the
// messages directory, minted by the one verb the operator explicitly withheld.
test('t218 a denied term reports the loss but writes nothing', async () => {
  const f = mkDenied();
  await f.m._handleIntent('a', { type: 'term', sub: 'exec', body: 'npm test' });
  assert.strictEqual(f.spills.length, 0, 'a refused shell command is not spilled to disk');
  assert.match(f.last(), /Your term body \(8 bytes\) was NOT saved/, 'but the loss is announced');
});

test('t222 a seat with no terminal of its own is refused before any exec is attempted', () => {
  // The type guard in _handleTermIntent cannot fire through the intent switch
  // today — that path requires `agentType`, which only claude/codex have, and a
  // peer has no local session record at all. The guard stays because the reason
  // is an accident of two OTHER decisions (make bash sessions intent-capable, or
  // give a peer a local record, and this becomes the only thing between them and
  // a shell), and this test is what keeps it live code rather than something a
  // future reader deletes as unreachable. _handleTermIntent is directly callable,
  // so the guard is testable even while the route to it is closed.
  const calls = [];
  const injected = [];
  const m = mk({ termExec: (...a) => { calls.push(a); return { ok: true, command: 'x' }; } });
  m._injectText = (s, text) => injected.push(text);
  m._broadcast = () => {};

  m._handleTermIntent({ name: 'x', type: 'bash', agentType: null, workspaceId: 'ws' }, 'exec', 'ls');

  assert.deepStrictEqual(calls, [], 'the refusal happens BEFORE the terminal is asked to run anything');
  assert.strictEqual(injected.length, 1, 'ENTER: the agent was answered');
  assert.match(injected[0], /a bash session has no terminal tab of its own/);
});

// The five bodiless gateable verbs. The spec asks that a spill on these be
// IMPOSSIBLE rather than merely unreached, so this walks the catalogue against the
// grammar table instead of listing verbs by hand — a verb that gains a body later
// fails here and has to be classified deliberately.
test('t170 every bodiless gateable verb is structurally unspillable', () => {
  const { GATEABLE_INTENTS } = require('../intent-catalog');
  const { bodyModeFor } = require('../intent-registry');
  // Probed across subs, not called bare: `context`, `memory` and `term` answer
  // 'none' for a MISSING sub and 'greedy' for compact/remember/exec, so a single
  // bare call would misfile all three as bodiless and this test would then certify
  // a spill path it never exercised. Bodiless means bodiless for every sub the verb
  // can carry — so a verb whose body hides behind ONE sub needs that sub in this
  // list, or the ratchet below silently stops guarding it.
  const SUBS = [null, 'compact', 'clear', 'reload', 'remember', 'recall', 'add', 'done', 'list', 'exec'];
  const bodiless = GATEABLE_INTENTS
    .map((i) => i.type)
    .filter((t) => SUBS.every((sub) => bodyModeFor({ type: t, sub }) === 'none'));
  assert.deepStrictEqual(bodiless.sort(), ['file', 'reboot', 'resend', 'spawn', 'term', 'who'],
    'the bodiless six — if this list changed, the disposition table needs a deliberate verdict for the new verb');
  for (const type of bodiless) {
    assert.deepStrictEqual(deniedBodyDisposition({ type }), { how: 'none', label: null },
      `${type} carries no body, so it can never reach a spill`);
  }
  // `bodyModeFor === 'none'` means "captures no FOLLOWING lines", which is not
  // the same as "carries no body": reboot and term both take one on their own
  // line, so the loop above — which probes with no body at all — is vacuous for
  // them. The property this test is named for is that a denied body is never
  // written to disk, so assert that against the bodies they really carry.
  const { parseIntent } = require('../intent-scanner');
  for (const line of ['[agent:term exec] pwd', '[agent:reboot] because reasons']) {
    const i = parseIntent(line);
    assert.ok(i.body, `ENTER: ${i.type} parsed a same-line body — the vacuous case is what this guards`);
    assert.notStrictEqual(deniedBodyDisposition(i).how, 'spill',
      `a denied ${i.type} reports its body as lost; it must never spill one to disk`);
  }
});

// A path named for a file nobody wrote is worse than admitting the loss: the sender
// drops its only copy on the strength of it. Same invariant as t166, new site.
test('t170 a FAILED spill names no path and does not spend the budget', async () => {
  let boom = true;
  const f = mkDenied({ spillToFile: (...a) => { if (boom) throw new Error('disk full'); return '/tmp/ok.txt'; } });
  await f.m._handleIntent('a', { type: 'dm', target: 'b', body: 'the composed message' });
  assert.match(f.last(), /could NOT be saved \(disk full\)/);
  assert.doesNotMatch(f.last(), /is saved for|and then swept/, 'and must not read as a success');
  // The budget exists to bound DISK. A failed spill wrote nothing, so charging it
  // would let a transient error consume an allowance that cost no bytes.
  boom = false;
  for (let i = 0; i < 3; i++) await f.m._handleIntent('a', { type: 'dm', target: 'b', body: `retry ${i}` });
  assert.match(f.last(), /is saved for the next 30 minutes/,
    'the third post-failure spill still succeeds — the failure did not spend an allowance');
});

test('t170 an ENABLED intent spills nothing (the gate is the only entry point)', async () => {
  const f = mkDenied({ getPersistence: () => ({ list: () => [], get: () => ({ intents: null }) }) });
  await f.m._handleIntent('a', { type: 'who', body: '' });
  assert.strictEqual(f.spills.length, 0);
});

// [agent:reboot] (Task 27): operator-gated app relaunch. AUTH is the per-session
// `intents` allowlist — reboot is a PRIVILEGED intent (intent-catalog), so the
// generic fire-time gate at the top of _handleIntent bounces any seat not granted
// it BEFORE the handler runs. `intents` here is the value persisted under 'a'
// (['reboot'] = granted; undefined/absent = the default, which excludes privileged).
// The handler's own gate is the rate limit (lastRebootAt in a mutable uiSettings
// fake); the relaunchApp seam is captured, never fired for real.
function mkReboot({ intents = ['reboot'], lastRebootAt = 0, relaunchThrows = false, setThrows = false } = {}) {
  const state = { lastRebootAt };
  const relaunches = [];
  const injected = [];
  const broadcasts = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents } : null) }),
    getUiSettings: () => ({
      get: () => ({ ...state }),
      set: (partial) => {
        if (setThrows) throw new Error('disk full');
        Object.assign(state, partial); return { ...state };
      },
    }),
    // The seam now takes the requester's callbacks, so the fake keeps the OPTIONS
    // rather than a timestamp — the give-up path is only reachable through them.
    relaunchApp: (opts) => { if (relaunchThrows) throw new Error('relaunch boom'); relaunches.push(opts || {}); },
    log: { info: () => {}, error: () => {}, warn: () => {} },
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = (_ch, msg) => broadcasts.push(msg);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  return { m, state, relaunches, injected, broadcasts };
}

test('reboot: a seat granted the reboot intent → seam fires once, confirm injected, stamp written', async () => {
  const { m, state, relaunches, injected, broadcasts } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'overnight restart-window test' });
  assert.strictEqual(relaunches.length, 1, 'relaunchApp fired exactly once');
  assert.strictEqual(injected[0],
    '[agent:reboot] reboot queued — restarting once every session is idle; sessions resume on relaunch');
  assert.ok(state.lastRebootAt > 0, 'lastRebootAt stamped');
  const b = broadcasts.find((x) => x.type === 'reboot');
  assert.ok(b && /rebooting: overnight restart-window test/.test(b.body), 'ipc log carries reason');
});

// t282: the restart is DEFERRED by the host until every seat is idle, so it can
// also be GIVEN UP (30m cap). The seam therefore carries a callback back, and a
// seat that is never told sits blocked on a relaunch that will never come.
test('reboot: the seam is handed an onAbandon callback, not fired blind', async () => {
  const { m, relaunches } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'nightly' });
  assert.strictEqual(relaunches.length, 1, 'ENTER: the seam fired, so the options below are the real ones');
  assert.strictEqual(typeof relaunches[0].onAbandon, 'function',
    'the host can tell the seat the deferred restart was dropped');
  assert.strictEqual(relaunches[0].requester, 'a',
    'and the requesting seat by NAME — the give-up notification the OPERATOR reads is '
    + 'otherwise unattributed, and reads as their own restart failing');
});

test('reboot: firing onAbandon replies to the seat AND clears the armed notice', async () => {
  const { m, state, injected, relaunches } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'nightly' });
  assert.ok(state.pendingRebootNotice, 'ENTER: the notice is armed, so the clear below is this path deciding');
  assert.strictEqual(injected.length, 1, 'ENTER: only the queued confirmation so far');

  // Drive the give-up through the callback the HOST was handed, not a private
  // method — that handoff is the thing that has to work.
  relaunches[0].onAbandon();

  assert.strictEqual(state.pendingRebootNotice, null,
    'a restart that never happened must not announce itself on some later launch');
  assert.strictEqual(injected.length, 2, 'the seat was told');
  assert.match(injected[1], /^\[agent:reboot\] reboot DROPPED/);
  assert.match(injected[1], /Nothing was restarted/, 'and told unambiguously that no restart occurred');
});

test('reboot: an abandoned wait leaves a LATER requester\'s notice alone', async () => {
  // The notice is a single slot. Seat b overwrote seat a's; when a's wait is
  // abandoned it must not wipe the notice b is still waiting on.
  const { m, state } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'first' });
  state.pendingRebootNotice = { name: 'b', at: Date.now(), reason: 'second' };
  m._rebootAbandoned('a', 'gave-up');
  assert.ok(state.pendingRebootNotice, 'still armed');
  assert.strictEqual(state.pendingRebootNotice.name, 'b', "and it is still b's");
});

test('reboot: abandoning after the requesting seat is gone does not throw', async () => {
  // 30 minutes is long enough for the seat to have been archived or killed.
  const { m, state, injected } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'nightly' });
  m.sessions.delete('a');
  m._rebootAbandoned('a', 'gave-up');
  assert.strictEqual(state.pendingRebootNotice, null, 'the notice is still cleared');
  assert.strictEqual(injected.length, 1, 'nothing injected into a session that no longer exists');
});

test('reboot: an operator CANCEL and a 30m give-up reach the seat with different copy and advice', async () => {
  // Same seam, same clear, opposite meaning. "sessions stayed busy" is simply
  // false when a human pressed Cancel, and "ask again when work settles" tells
  // the seat to re-request in 5 minutes the thing the operator just refused —
  // so the operator cancels it again, and again.
  const gaveUp = mkReboot({ intents: ['reboot'] });
  await gaveUp.m._handleIntent('a', { type: 'reboot', body: 'nightly' });
  gaveUp.relaunches[0].onAbandon('gave-up');

  const cancelled = mkReboot({ intents: ['reboot'] });
  await cancelled.m._handleIntent('a', { type: 'reboot', body: 'nightly' });
  cancelled.relaunches[0].onAbandon('cancelled');

  assert.strictEqual(gaveUp.injected.length, 2, 'ENTER: both seats were told something');
  assert.strictEqual(cancelled.injected.length, 2, 'ENTER: both seats were told something');
  const g = gaveUp.injected[1];
  const c = cancelled.injected[1];
  assert.notStrictEqual(g, c, 'the two outcomes do not share one sentence');

  assert.match(g, /sessions stayed busy/, 'the cap says why it gave up');
  assert.match(g, /ask again when work settles/, 'and retrying is the right advice there');

  assert.match(c, /CANCELLED/, 'a cancel is named as a cancel');
  assert.doesNotMatch(c, /stayed busy|30 minutes/,
    'and does not invent a timeout that did not happen');
  assert.doesNotMatch(c, /ask again when work settles/,
    'a human said no — the seat must not be told to re-request it');
  for (const msg of [g, c]) {
    assert.match(msg, /Nothing was restarted/, 'both stay true about the one fact that matters');
  }

  // The notice is cleared either way — neither outcome may announce a restart later.
  assert.strictEqual(gaveUp.state.pendingRebootNotice, null);
  assert.strictEqual(cancelled.state.pendingRebootNotice, null);
});

test('reboot: DEFAULT-OFF — an all-enabled seat cannot reboot (generic gate bounce, no seam)', async () => {
  const { m, state, relaunches, injected } = mkReboot({ intents: null }); // absent = all-enabled default
  await m._handleIntent('a', { type: 'reboot', body: '' });
  assert.strictEqual(relaunches.length, 0, 'the default posture does not grant reboot');
  assert.strictEqual(injected[0], '[agent:reboot] the reboot intent is disabled for this session');
  assert.strictEqual(state.lastRebootAt, 0, 'the handler never ran, so no stamp');
});

test('reboot: a seat granted OTHER intents but not reboot is still gated', async () => {
  const { m, relaunches, injected } = mkReboot({ intents: ['dm', 'who'] }); // no reboot
  await m._handleIntent('a', { type: 'reboot', body: '' });
  assert.strictEqual(relaunches.length, 0);
  assert.strictEqual(injected[0], '[agent:reboot] the reboot intent is disabled for this session');
});

test('reboot: inside the rate-limit window → refused, seam NOT fired, stamp untouched', async () => {
  const recent = Date.now() - 10_000; // 10s ago, inside the 5min window
  const { m, state, relaunches, injected } = mkReboot({ intents: ['reboot'], lastRebootAt: recent });
  await m._handleIntent('a', { type: 'reboot', body: '' });
  assert.strictEqual(relaunches.length, 0, 'no relaunch inside the rate-limit window');
  assert.match(injected[0], /^\[agent:reboot\] rate-limited/);
  assert.strictEqual(state.lastRebootAt, recent, 'stamp not rewritten on a refusal');
});

// t284: the stamp is written when the reboot is QUEUED, and since t282 the restart
// waits for an all-idle window — so it may be pending, or already abandoned, with
// the stamp still standing (_rebootAbandoned leaves it deliberately). This drives
// the case where NO restart occurred at all and the refusal is the only thing the
// second seat is told about it.
test('reboot: the rate-limit refusal does not claim a restart that never happened', async () => {
  const { m, state, relaunches, injected } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'first' });
  assert.strictEqual(relaunches.length, 1, 'ENTER: the seam fired, so the wait below is a real one');
  relaunches[0].onAbandon('dropped'); // sessions stayed busy — nothing restarted
  assert.ok(state.lastRebootAt > 0, 'ENTER: the stamp survives the abandon, so the next request IS rate-limited');

  const before = injected.length;
  await m._handleIntent('a', { type: 'reboot', body: 'second' });
  const refusal = injected[before];
  assert.match(refusal, /^\[agent:reboot\] rate-limited/, 'ENTER: this is the refusal, not some other reply');
  assert.doesNotMatch(refusal, /reboot happened/,
    'no restart has occurred — the seat must not be told one did');
  assert.match(refusal, /a reboot was requested \d+s ago/, 'it reports the request, which is the fact the stamp actually holds');
});

test('reboot: an UNGRANTED bash pane gets neither relaunch nor a bounce typed into its shell', async () => {
  // Bash panes reach _handleIntent via _scanPtyOutput with any KNOWN type, and
  // reboot is gate-disabled on every default seat — so the gate bounce would
  // fire here for something as innocent as cat'ing a doc that quotes the
  // intent. The agentType guard on the gate bounce is what this pins.
  const { m, relaunches, injected } = mkReboot({ intents: ['reboot'] });
  m.sessions.set('sh', { name: 'sh', workspaceId: 'ws1' }); // no agentType, no persisted entry
  await m._handleIntent('sh', { type: 'reboot', body: '' });
  assert.strictEqual(relaunches.length, 0, 'gate stops the relaunch');
  assert.strictEqual(injected.length, 0, 'gate bounce must NOT be typed into a live shell');
});

test('reboot: even a GRANTED bash name never relaunches (case-level agentType guard)', async () => {
  const state = { lastRebootAt: 0 };
  const relaunches = [];
  const injected = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'sh' ? { intents: ['reboot'] } : null) }),
    getUiSettings: () => ({
      get: () => ({ ...state }),
      set: (partial) => { Object.assign(state, partial); return { ...state }; },
    }),
    relaunchApp: () => { relaunches.push(Date.now()); },
    log: { info: () => {}, error: () => {} },
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('sh', { name: 'sh', workspaceId: 'ws1' }); // bash: no agentType
  await m._handleIntent('sh', { type: 'reboot', body: '' });
  assert.strictEqual(relaunches.length, 0, 'bash panes are filtered inside the reboot case even when granted');
  assert.strictEqual(injected.length, 0, 'no reply typed into the shell either');
});

test('reboot: appears in the near-miss valid-intents bounce copy', async () => {
  const injected = [];
  const m = mk({ getPersistence: () => ({ list: () => [], get: () => ({ intents: null }) }) });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  await m._handleIntent('a', { type: 'unknown', text: '[agent:rebot]', more: 0 });
  assert.match(injected[0], /Valid intents:.*\breboot\b/);
});

// The bounce copy is now a registry join (plugin plan rule P4), so the join
// ORDER — which is neither parse nor catalog order; it is the string as it
// shipped — needs a real pin, not just a `\breboot\b` match. A refactor that
// regenerated the list from some other ordering would sail past the match above.
test('near-miss bounce: the WHOLE valid-intents string is pinned, byte for byte', async () => {
  const injected = [];
  const m = mk({ getPersistence: () => ({ list: () => [], get: () => ({ intents: null }) }) });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  await m._handleIntent('a', { type: 'unknown', text: '[agent:rebot]', more: 2 });
  assert.strictEqual(
    injected[0],
    '[agent:?] unrecognized intent `[agent:rebot]` (+2 more unrecognized [agent:…] lines this turn) — nothing was done. '
    // `term` sits beside `reboot` at the end: both are privileged, and the list
    // is the same for every seat because it names what the GRAMMAR has, not what
    // this seat was granted. Omitting a granted verb here is the defect that put
    // term in it — a seat that typos `[agent:term exex]` would be handed a list
    // missing the one verb it can actually use.
    + 'Valid intents: dm, resend, who, name, context, memory, spawn, file, exec, remind, notify-user, team-review, review-done, task, term, reboot, end. '
    + 'To quote an intent literally, put it in a ``` code fence or escape it as \\[agent:…].',
  );
});

test('reboot: an agent [agent:spawn] from a template STRIPS privileged intents (no self-grant)', async () => {
  let createdIntents = 'UNSET';
  const m = mk({
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'child' ? null : { extraArgs: [] }) }),
    getTemplates: () => ({ list: () => [{ name: 'rebooter', type: 'claude', cwd: '/tmp/spawn-x', intents: ['dm', 'reboot'] }] }),
    ensureDir: () => {},
    os: require('node:os'),
    path: require('node:path'),
    log: { info: () => {}, error: () => {} },
  });
  m._injectText = () => {};
  m._broadcast = () => {};
  m._sendToSession = () => {};
  // Capture create()'s intents arg (last positional, index 17).
  m.create = async (...args) => { createdIntents = args[17]; return { name: args[0], type: args[1] }; };
  const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' };
  m.sessions.set('a', spawner);
  m._handleSpawnIntent(spawner, { name: 'child', cwd: '/tmp/spawn-x', template: 'rebooter' });
  // _handleSpawnIntent defers the spawn into setImmediate(async …) — drain two ticks.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(createdIntents, ['dm'],
    'reboot filtered out of the template grant at the agent-spawn boundary');
});

// --- t8 F1: the strip must see PLUGIN verbs, not just core's PRIVILEGED_INTENTS.
// A plugin verb is FORCED privileged (rule P1), but it lives on the registry row,
// not in intent-catalog's literal Set — so the catalog's own strip passes it
// straight through. The test above cannot catch that: `reboot` is in the Set.
// Without the registry-aware strip, a self-authored template mints a seat holding
// a forced-privileged plugin verb that intentEnabledFor then honours at fire time. ---
test('t8 F1: an agent [agent:spawn] template carrying a PLUGIN verb has it stripped too (no self-grant)', async () => {
  await withVerb({ type: 'fake-grant', parse: (c) => (c === '[agent:fake-grant]' ? {} : null) }, async () => {
    let createdIntents = 'UNSET';
    const m = mk({
      AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
      getPersistence: () => ({ list: () => [], get: (n) => (n === 'child' ? null : { extraArgs: [] }) }),
      getTemplates: () => ({ list: () => [{ name: 'granter', type: 'claude', cwd: '/tmp/spawn-x', intents: ['dm', 'fake-grant', 'reboot'] }] }),
      ensureDir: () => {},
      os: require('node:os'),
      path: require('node:path'),
      log: { info: () => {}, error: () => {} },
    });
    m._injectText = () => {};
    m._broadcast = () => {};
    m._sendToSession = () => {};
    m.create = async (...args) => { createdIntents = args[17]; return { name: args[0], type: args[1] }; };
    const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' };
    m.sessions.set('a', spawner);
    m._handleSpawnIntent(spawner, { name: 'child', cwd: '/tmp/spawn-x', template: 'granter' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(createdIntents, ['dm'],
      'the plugin verb AND reboot are both stripped; only the ordinary grant survives');
  });
});

// ── Task 28: the one-shot post-reboot notice ────────────────────────────────
// [agent:reboot] arms uiSettings.pendingRebootNotice just before relaunch; on the
// next launch, engine.restoreSessionsForWorkspace calls maybeDeliverRebootNotice()
// after a workspace restore. Three delivery cases (mirror _deliverReminder): the
// requester is LIVE in the just-restored workspace, OFFLINE-but-resumable in one
// not yet restored (park by name), or GONE (deleted while down). Always one-shot:
// the flag clears on the first call regardless of outcome.

test('reboot notice: [agent:reboot] arms pendingRebootNotice (name/at/reason) alongside the stamp', async () => {
  const { m, state } = mkReboot({ intents: ['reboot'] });
  await m._handleIntent('a', { type: 'reboot', body: 'overnight restart-window test' });
  assert.ok(state.pendingRebootNotice, 'notice armed');
  assert.strictEqual(state.pendingRebootNotice.name, 'a');
  assert.strictEqual(state.pendingRebootNotice.reason, 'overnight restart-window test');
  assert.ok(state.pendingRebootNotice.at > 0, 'requested-at stamped');
});

// Build a manager whose uiSettings carries a pending notice, capturing active
// deliveries (_deliverMessage) and parks (the parkDelivery dep). Note: a LIVE
// CLAUDE seat now PARKS (T30 boot-safety) — it shows up in `parks`, not
// `delivered`; a live CODEX seat and the offline path behave as before.
function mkNotice({ notice, live = false, persisted = null, deliverThrows = false, parkThrows = false } = {}) {
  const state = { pendingRebootNotice: notice };
  const delivered = [];
  const parks = [];
  const m = mk({
    getUiSettings: () => ({
      get: () => ({ ...state }),
      set: (partial) => { Object.assign(state, partial); return { ...state }; },
    }),
    getPersistence: () => ({ list: () => [], get: (n) => (n === (notice && notice.name) ? persisted : null) }),
    parkDelivery: (_dir, name, text) => { if (parkThrows) throw new Error('park boom'); parks.push({ name, text }); },
    PENDING_DIR: '/tmp/pending-x',
    // Same reason as mkPark's: unwired, _armParkCap does setTimeout(fn, undefined),
    // which fires on the NEXT TICK rather than in 5 minutes. Every test here was
    // synchronous, so that cap never got to run and the omission stayed invisible —
    // until one awaited, and the cap fired a _flushParkedNow that the test read as
    // the notice's own deadline firing. A test that awaits anything needs this.
    INJECT_QUIET_MAXWAIT: 3_600_000,
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  });
  m._deliverMessage = (name, sender, body) => { if (deliverThrows) throw new Error('inject boom'); delivered.push({ name, sender, body }); };
  if (live) m.sessions.set(notice.name, { name: notice.name, agentType: 'claude', workspaceId: 'ws1' });
  // A live claude park arms two REAL timers (the park cap and the t229 in-launch
  // retry). Left running they fire after the test has ended, against a torn-down
  // fixture — which surfaces as an uncaughtException attributed to whichever test
  // is running at the time, and holds the runner open for the full timeout. So
  // every mkNotice test disarms; the ones asserting a timer exists do it by hand.
  const disarm = () => {
    const s = m.sessions.get(notice && notice.name);
    if (!s) return;
    clearTimeout(s._parkCapTimer);
    clearTimeout(s._rebootNoticeRetryTimer);
    clearTimeout(s._rebootNoticeFlushTimer);   // t360: a third real timer, same hazard
  };
  return { m, state, delivered, parks, disarm };
}

test('reboot notice: a LIVE CLAUDE requester gets the notice PARKED (boot-safe), then the flag clears', () => {
  const at = Date.now();
  const { m, state, delivered, parks, disarm } = mkNotice({
    notice: { name: 'a', at, reason: 'nightly' }, live: true, // mkNotice's live seat is claude
  });
  m.maybeDeliverRebootNotice();
  // T30: a just-restored claude seat is mid-boot; an active inject would have its
  // trailing Enter swallowed (the notice would strand in stdin). So the notice
  // PARKS (drains on the seat's first organic hook turn, no PTY typing) — the same
  // boot-safe path the initial roster uses — instead of live-injecting.
  assert.strictEqual(delivered.length, 0, 'no active inject into a booting claude TUI');
  assert.strictEqual(parks.length, 1, 'parked for the live claude seat');
  assert.strictEqual(parks[0].name, 'a');
  // New copy: no "relaunch complete" (flag is pre-relaunch), and the confusing
  // "does not grant reboot permission" line is gone — a plain, timestamped
  // "restarted and is running again". Parked text carries a single clean
  // [agent:from reboot] prefix (delivery adds it; no doubled prefix).
  assert.match(parks[0].text, /^\[agent:from reboot\] notice: Clodex restarted and is running again \(reboot requested at .+: nightly\)\.$/);
  assert.doesNotMatch(parks[0].text, /relaunch complete/);
  assert.doesNotMatch(parks[0].text, /does not grant/);
  // t229: the flag deliberately SURVIVES the park. A park is a promise to deliver,
  // and clearing here destroyed the only durable copy while the parked file was
  // still undelivered — the loss this ticket exists to fix. It clears on a
  // presumed-delivered turn, the attempt ceiling, or the 7d bound, never on park.
  assert.ok(state.pendingRebootNotice, 'notice RETAINED on park — clearing here is the t229 defect');
  assert.strictEqual(state.pendingRebootNotice.attempts, 1, 'first attempt stamped, so the ceiling can be reached');
  // T30 round 2 (field): a park alone strands on a seat that stays idle — every
  // drain trigger needs the seat to earn a turn. The starvation cap must be
  // armed so a forced drain lands within INJECT_QUIET_MAXWAIT.
  assert.ok(m.sessions.get('a')._parkCapTimer, 'starvation cap armed for the parked notice');
  // t229: the in-launch retry is armed alongside the cap — it is the primary
  // delivery path, the cap only forces the queue.
  assert.ok(m.sessions.get('a')._rebootNoticeRetryTimer, 'in-launch retry armed for the parked notice');
  // Existence asserted above, teardown delegated: hand-clearing each timer is what
  // let this test silently leak t360's third one. disarm() tracks the fixture.
  disarm();
});

test('reboot notice: a LIVE CODEX requester keeps the active inject (no passive store to park into)', () => {
  const { m, state, delivered, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: true,
  });
  // Flip the live seat to codex: it has no pending store, so a park would never
  // drain — it keeps the active delivery. The codex mid-boot race stays its own,
  // out-of-scope case (T30 scope is the notice; the field bug is a claude seat).
  m.sessions.get('a').agentType = 'codex';
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 1, 'codex live seat still actively delivered');
  assert.strictEqual(delivered[0].sender, 'reboot', 'system sender tag → no reply trailer');
  assert.match(delivered[0].body, /^notice: Clodex restarted and is running again \(reboot requested at /);
  assert.strictEqual(parks.length, 0, 'not parked — codex has no passive drain');
  assert.strictEqual(state.pendingRebootNotice, null, 'flag cleared');
  disarm();
});

test('reboot notice: an OFFLINE-but-resumable requester is PARKED by name, flag clears', () => {
  const { m, state, delivered, parks } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: false, persisted: { type: 'claude' },
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 0, 'no live inject — seat not in the map');
  assert.strictEqual(parks.length, 1, 'parked for the resumable seat');
  assert.strictEqual(parks[0].name, 'a');
  // Parked text is the full delivery form — a single clean [agent:from reboot] prefix, no doubling.
  assert.match(parks[0].text, /^\[agent:from reboot\] notice: Clodex restarted and is running again \(reboot requested at/);
  assert.strictEqual(state.pendingRebootNotice, null, 'flag cleared');
});

test('reboot notice: a GONE requester (no persisted entry) drops, flag still clears', () => {
  const { m, state, delivered, parks } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: false, persisted: null,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 0);
  assert.strictEqual(parks.length, 0, 'nothing to deliver to a deleted seat');
  assert.strictEqual(state.pendingRebootNotice, null, 'flag cleared even on a drop (never sticky)');
});

test('reboot notice: no armed notice → a clean no-op (no deliver, no park, no clear write)', () => {
  const { m, delivered, parks } = mkNotice({ notice: null });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 0);
  assert.strictEqual(parks.length, 0);
});

// ── Task 28 amendment (contrarian review) ───────────────────────────────────

test('reboot notice: relaunchApp throwing CLEARS the armed flag (no false success later)', async () => {
  const { m, state, relaunches } = mkReboot({ intents: ['reboot'], relaunchThrows: true });
  await m._handleIntent('a', { type: 'reboot', body: 'x' });
  assert.strictEqual(relaunches.length, 0, 'relaunch threw');
  assert.strictEqual(state.pendingRebootNotice, null, 'notice cleared — the process did not die');
  assert.ok(state.lastRebootAt > 0, 'rate-limit stamp still holds (no rapid-retry window)');
});

test('reboot notice: a settings-write failure at reboot time does NOT abort the relaunch', async () => {
  const { m, relaunches } = mkReboot({ intents: ['reboot'], setThrows: true });
  await m._handleIntent('a', { type: 'reboot', body: 'x' });
  assert.strictEqual(relaunches.length, 1, 'reboot proceeds — the notice is best-effort');
});

test('reboot notice: a transient LIVE-park error (claude) RETAINS the flag (retry next launch)', () => {
  // Live claude now parks; a park throw must reach retainOrExpire (the park stays
  // inside the live branch's try, NOT routed through _deliverPassive's silent
  // fallback), so the flag survives for a retry next launch.
  const { m, state } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: true, parkThrows: true,
  });
  m.maybeDeliverRebootNotice();
  assert.ok(state.pendingRebootNotice, 'flag survives a transient park failure on the live claude path');
});

test('reboot notice: a transient LIVE-inject error (codex) RETAINS the flag (retry next launch)', () => {
  const { m, state } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: true, deliverThrows: true,
  });
  m.sessions.get('a').agentType = 'codex'; // codex keeps the active deliver
  m.maybeDeliverRebootNotice();
  assert.ok(state.pendingRebootNotice, 'flag survives a transient inject failure');
});

test('reboot notice: a transient PARK error RETAINS the flag (retry next launch)', () => {
  const { m, state } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: false, persisted: { type: 'claude' }, parkThrows: true,
  });
  m.maybeDeliverRebootNotice();
  assert.ok(state.pendingRebootNotice, 'flag survives a transient park failure');
});

test('reboot notice: a stale (>7d) notice that errors is DROPPED, not retained forever', () => {
  const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const { m, state } = mkNotice({
    notice: { name: 'a', at: eightDays, reason: '' }, live: true, parkThrows: true, // live claude parks
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(state.pendingRebootNotice, null, 'stale-beyond-useful notice cleared on error');
});

test('reboot notice: a FAILED-restore seat is resumable, not gone → parked + cleared', () => {
  // A {failed:true} persisted entry still HAS a record — it's recoverable, so the
  // notice parks by name (drains on a successful retry) rather than being dropped.
  const { m, state, delivered, parks } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: false, persisted: { type: 'claude', failed: true },
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 0);
  assert.strictEqual(parks.length, 1, 'parked, not dropped — a failed restore is not gone');
  assert.strictEqual(state.pendingRebootNotice, null, 'flag cleared on a successful park');
});

test('reboot notice: the echoed reason is de-newlined and capped (~200 chars)', () => {
  // Live claude parks → read the parked text (the reason sanitize/cap is identical
  // on both the park and active-deliver paths; it happens before the body is built).
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'line one\nline two\t' + 'x'.repeat(400) }, live: true,
  });
  m.maybeDeliverRebootNotice();
  const text = parks[0].text; // "[agent:from reboot] notice: … (reboot requested at <ISO>: <reason>)."
  assert.doesNotMatch(text, /\n/, 'newlines collapsed');
  // Reason sits after the (space-free ISO) timestamp, inside the trailing parens:
  // "reboot requested at <ISO>: <reason>).". Anchor on the ISO so an earlier colon
  // can't swallow the capture.
  const reason = text.match(/reboot requested at \S+: (.*)\)\.$/)[1];
  assert.ok(reason.length <= 200, `reason capped (${reason.length})`);
  disarm();
});

// ── t229: the READ side of the notice — retry-with-a-ceiling ────────────────
// Nothing pinned this before, which is why the notice shipped undelivered seven
// times while the WRITE-side tests above stayed green. The failure was: park →
// clear() → a drain claims destructively → its pty.write evaporates into a
// booting CLI → no copy anywhere. So these pin the retention, the ceiling, and
// the presumed-delivered signal, not the parking.

// Drive the armed retry without waiting on the wall clock: grab the timer's
// callback off the session and invoke it. Asserting the timer EXISTS first is
// what keeps this from silently testing nothing if the arm is ever dropped.
function fireRebootRetry(m, name) {
  const s = m.sessions.get(name);
  assert.ok(s && s._rebootNoticeRetryTimer, 'a retry was armed to fire');
  clearTimeout(s._rebootNoticeRetryTimer);
  s._rebootNoticeRetryFire();
}

test('t229 reboot notice: a park does NOT clear the notice — the durable copy survives for a retry', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: the notice really was parked (otherwise retention proves nothing)');
  assert.ok(state.pendingRebootNotice, 'the settings copy survives the park');
  assert.strictEqual(state.pendingRebootNotice.name, 'a', 'and it is still the same notice');
  assert.strictEqual(state.pendingRebootNotice.attempts, 1, 'stamped as attempt 1');
  disarm();
});

test('t229 reboot notice: a seat that takes a TURN after the park is presumed delivered → cleared', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  assert.ok(state.pendingRebootNotice, 'ENTER: retained, so the clear below is the retry deciding');
  // A real wire turn stop, after the park. `seeded:false` matters — the spawn
  // seeds a synthetic stop, and treating that as a turn would clear every notice
  // instantly without anything having been delivered.
  m.sessions.get('a').lastMainStop = { isTurn: true, ts: Date.now() + 1000, seeded: false };
  fireRebootRetry(m, 'a');
  assert.strictEqual(state.pendingRebootNotice, null, 'cleared once the seat demonstrably processed input');
  assert.strictEqual(parks.length, 1, 'and NOT re-parked — one delivery, not two');
  disarm();   // the park armed the cap and t360's flush deadline; neither is cleared by the retry
});

test('t229 reboot notice: the SEEDED spawn stop is not a turn (it would clear every notice for free)', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  // create() seeds exactly this shape at spawn time; it predates any delivery.
  m.sessions.get('a').lastMainStop = { isTurn: true, ts: Date.now() + 1000, seeded: true };
  fireRebootRetry(m, 'a');
  assert.ok(state.pendingRebootNotice, 'a seeded stop proves nothing — the notice is re-offered, not cleared');
  assert.strictEqual(parks.length, 2, 're-parked for a second attempt');
  disarm();
});

test('t229 reboot notice: no turn since the park → re-offered WITHIN the launch (the primary path)', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: first park');
  assert.strictEqual(state.pendingRebootNotice.attempts, 1);
  fireRebootRetry(m, 'a');   // no lastMainStop at all — the seat never woke
  assert.strictEqual(parks.length, 2, 'the notice is parked AGAIN in the same launch');
  assert.strictEqual(state.pendingRebootNotice.attempts, 2, 'attempt count advanced');
  disarm();
});

test('t229 reboot notice: the ceiling ENDS it — 3 attempts, then cleared, never a 4th', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();          // attempt 1
  fireRebootRetry(m, 'a');               // → attempt 2
  assert.strictEqual(state.pendingRebootNotice.attempts, 2, 'ENTER: reached attempt 2 with the notice still live');
  fireRebootRetry(m, 'a');               // → attempt 3
  assert.strictEqual(parks.length, 3, 'three delivery attempts made');
  // Attempt 3 is the last: no further retry is armed, so the in-launch chain stops.
  assert.strictEqual(m.sessions.get('a')._rebootNoticeRetryTimer, null,
    'no 4th retry armed — the in-launch chain terminates at the ceiling');
  // The next LAUNCH finds attempts at the ceiling and gives up rather than
  // re-announcing forever. This is the bound that makes at-least-once safe.
  m.maybeDeliverRebootNotice();
  assert.strictEqual(state.pendingRebootNotice, null, 'given up and cleared at the ceiling');
  assert.strictEqual(parks.length, 3, 'and it did NOT park a fourth time');
  disarm();
});

test('t229 reboot notice: the retry delays clear the measured boot window, not a round number', () => {
  // Measured on the reboot that produced this ticket: a resumed seat emitted
  // nothing for 105s while a 41MB transcript re-rendered, and the two existing
  // margins (BOOT_DRAIN_SETTLE_MS 750ms, INJECT_BOOT_MAXWAIT 20s) both sit inside
  // that. A retry landing inside the window would be swallowed the same way the
  // original delivery was, so these are the ONE thing about the retry that must
  // not drift back to something tidy.
  const { m, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  const first = m.sessions.get('a')._rebootNoticeRetryDelay;
  assert.ok(first > 20_000, `first retry (${first}ms) must clear the 20s boot-readiness cap`);
  fireRebootRetry(m, 'a');
  const second = m.sessions.get('a')._rebootNoticeRetryDelay;
  assert.ok(second > 105_000, `second retry (${second}ms) must clear the measured 105s re-render`);
  disarm();
});

test('t229 reboot notice: a >7d notice is dropped BEFORE any attempt (age bound needs no throw)', () => {
  const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const { m, state, parks } = mkNotice({
    notice: { name: 'a', at: eightDays, reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 0, 'nothing parked — the stale notice never reached a delivery path');
  assert.strictEqual(state.pendingRebootNotice, null, 'dropped');
});

test('t229 reboot notice: retention is CLAUDE-park-specific — codex still clears on its active deliver', () => {
  // The codex branch delivers synchronously through _deliverMessage; there is no
  // park to lose, so retaining there would re-announce on a path that works.
  const { m, state, delivered } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: '' }, live: true,
  });
  m.sessions.get('a').agentType = 'codex';
  m.maybeDeliverRebootNotice();
  assert.strictEqual(delivered.length, 1, 'ENTER: actively delivered');
  assert.strictEqual(state.pendingRebootNotice, null, 'cleared — this path has a real delivery');
});

test('t229 reboot notice: the attempts stamp survives a REAL settings round-trip (else the ceiling is unbounded)', () => {
  // The counter is the ONLY durable bound on re-announcement, and it crosses a
  // sanitizer that rebuilds the notice field by field. A dropped `attempts` would
  // reset to 0 on every write, so the "capped at 3" guarantee would never be
  // reached and a permanently-undeliverable notice would announce forever. Driven
  // through the real store (not the private sanitizer) so the persisted shape is
  // what's asserted.
  const userData = mkTmpRoot('clodex-ui-');
  const registryDir = mkTmpRoot('clodex-reg-');
  const { uiSettings } = initStoresReal(userData, { log: { info() {}, warn() {}, error() {} }, registryDir });
  uiSettings.set({ pendingRebootNotice: { name: 'a', at: 123, reason: 'r', attempts: 2 } });
  assert.strictEqual(uiSettings.get().pendingRebootNotice.attempts, 2, 'the stamp survives the write');
  uiSettings.set({ pendingRebootNotice: { name: 'a', at: 123, reason: 'r' } });
  assert.strictEqual(uiSettings.get().pendingRebootNotice.attempts, 0,
    'a pre-upgrade notice with no stamp reads as 0, not NaN or undefined');
  fsReal.rmSync(userData, { recursive: true, force: true });
  fsReal.rmSync(registryDir, { recursive: true, force: true });
});

// ── t360: the notice's own drain deadline, and the duplicate-restore burn ────
// Two defects behind one symptom (the notice sat 5 minutes). The park inherited
// the generic INJECT_QUIET_MAXWAIT cap because both fast drains bail on an open
// draft; and restoreSessionsForWorkspace runs once PER WORKSPACE, so a
// multi-workspace launch stamped two attempts a fraction of a second apart.

test('t360 reboot notice: the park arms a SHORT dedicated flush deadline, not the 5-minute generic cap', () => {
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: the notice really was parked (otherwise there is no deadline to arm)');
  const s = m.sessions.get('a');
  assert.ok(s._rebootNoticeFlushTimer, 'a dedicated flush deadline is armed alongside the park');
  // The bound that matters to the operator: seconds, not minutes. 60s is well
  // under the generic cap this used to inherit and well over the boot window.
  assert.ok(s._rebootNoticeFlushDelay < 60_000,
    `the notice's flush deadline (${s._rebootNoticeFlushDelay}ms) must be seconds, not the 5-minute generic cap`);
  // Both derivation bounds, asserted rather than described: past the queue's 20s
  // readiness cap (so it cannot pre-empt a polite drain), and before the first
  // retry rung (so it never flushes two copies of the notice as one body).
  assert.ok(s._rebootNoticeFlushDelay > 20_000,
    `must clear INJECT_BOOT_MAXWAIT (20s), got ${s._rebootNoticeFlushDelay}ms`);
  assert.ok(s._rebootNoticeFlushDelay < 30_000,
    `must fire before the first retry re-parks, got ${s._rebootNoticeFlushDelay}ms`);
  // The staleness threshold's own bound, pinned directly rather than via the 1s /
  // 60s cases either side of it: those stay green if it drifts down to
  // INJECT_QUIET_MS, and that is precisely the value that reinstates the splice —
  // that gate is tuned not to cut mid-WORD, while this one has to clear a pause
  // mid-COMPOSITION. A drift guard on an already-correct constant, so unlike the
  // rest of this file it passes against the unfixed code too.
  assert.ok(s._rebootNoticeDraftStaleMs >= 5_000,
    `the draft-staleness threshold (${s._rebootNoticeDraftStaleMs}ms) must be COMFORTABLY over INJECT_QUIET_MS (2s), or a mid-composition pause is spliceable again`);
  disarm();
});

test('t360 reboot notice: the flush deadline FORCES the park out through the draft gate', () => {
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushed = null;
  m._flushParkedNow = (target, tag, kind) => { flushed = { name: target.name, tag, kind }; return { ok: true, count: 1 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked, so the fire below is the deadline acting on a real park');
  const s = m.sessions.get('a');
  assert.strictEqual(flushed, null, 'ENTER: nothing forced before the deadline fires');
  s._rebootNoticeFlushFire();
  // _flushParkedNow is the path that ignores isDraftOpen — the one that rescued
  // this notice by hand every time. Reaching it is the whole fix; the polite
  // drains cannot, because they bail on the open draft.
  assert.ok(flushed, 'the deadline forces the parked notice out');
  assert.strictEqual(flushed.name, 'a');
  assert.strictEqual(flushed.kind, 'park-flush', 'forced through the draft-ignoring flush path');
  disarm();
});

test('t360 reboot notice: a seat that already took a TURN is not spliced by the deadline', () => {
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushCalls = 0;
  m._flushParkedNow = () => { flushCalls += 1; return { ok: true, count: 0 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  const s = m.sessions.get('a');
  // A real turn after the park: a drain already ran and the seat processed input,
  // so forcing would splice for nothing. Same signal (and same seeded exclusion)
  // the retry ladder uses.
  s.lastMainStop = { isTurn: true, ts: Date.now() + 1000, seeded: false };
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 0, 'no forced flush — the seat demonstrably already drained');
  disarm();
});

test('t360 reboot notice: a FRESH draft defers the forced flush — it re-arms instead of eating live typing', () => {
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushCalls = 0;
  m._flushParkedNow = () => { flushCalls += 1; return { ok: true, count: 1 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked, so the deadline below is acting on a real park');
  const s = m.sessions.get('a');
  // The operator paused mid-composition. The forced flush is non-parkable, so
  // firing here would emit a bare Ctrl-U into that draft — the exact splice
  // INJECT_QUIET_MAXWAIT was raised to 5 minutes to avoid.
  s.lastUserInputTs = Date.now() - 1000;
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 0, 'no forced flush into a draft touched a second ago');
  // Deferred, NOT abandoned: a re-armed deadline is what keeps the notice bounded
  // rather than silently dropping it when the operator is at the keyboard.
  assert.ok(s._rebootNoticeFlushTimer, 're-armed for another round instead of flushing');
  disarm();
});

test('t360 reboot notice: a STALE draft still flushes — the deferral is not a permanent block', () => {
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushCalls = 0;
  m._flushParkedNow = () => { flushCalls += 1; return { ok: true, count: 1 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  const s = m.sessions.get('a');
  s.lastUserInputTs = Date.now() - 60_000;   // typed a minute ago, then walked away
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 1, 'an abandoned draft is flushed through — this is the walked-away case');
  disarm();
});

test('t360 reboot notice: a fresh RESTORED seat flushes at the FIRST deadline (the field case must stay fast)', () => {
  // The whole point of the ticket. A restored seat has never been typed into, so
  // lastUserInputTs is unset and Date.now() - 0 reads as stale. If the draft guard
  // ever makes THIS case re-arm, the notice is slow again and the fix is undone.
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushCalls = 0;
  m._flushParkedNow = () => { flushCalls += 1; return { ok: true, count: 1 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  const s = m.sessions.get('a');
  assert.ok(!s.lastUserInputTs, 'ENTER: a restored seat really has no recorded input, or this proves nothing');
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 1, 'flushed at the first deadline — no extra round for an untouched seat');
  assert.strictEqual(s._rebootNoticeFlushTimer, null, 'and nothing re-armed');
  disarm();
});

test('t360 reboot notice: a re-arm keeps the ORIGINAL park time, so a turn since the park still wins', async () => {
  // The re-arm passes parkedAt through rather than restamping it. Restamping would
  // move the line the turn check compares against on every round, so a seat that
  // woke during round 1 would read as never having woken.
  const { m, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  let flushCalls = 0;
  m._flushParkedNow = () => { flushCalls += 1; return { ok: true, count: 1 }; };
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: parked');
  const s = m.sessions.get('a');
  const parkTime = Date.now();
  s.lastUserInputTs = Date.now();          // fresh draft → round 1 defers
  // A MEASURABLE gap before the deferral, and it is the whole isolating power of
  // this test. Without it the re-arm lands in the same millisecond as the park, so
  // a restamped parkedAt still sits below stop.ts and the turn check trips anyway —
  // green with the restamping mutant alive. With the gap a restamp is ≥ parkTime+5,
  // stop.ts (parkTime+1) no longer clears it, and the notice is wrongly forced.
  await new Promise((r) => setTimeout(r, 5));
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 0, 'ENTER: round 1 really did defer, so round 2 is the re-armed one');
  // The seat wakes and drains on its own, just after the ORIGINAL park — before
  // the re-arm, which is precisely what a restamp would hide.
  s.lastMainStop = { isTurn: true, ts: parkTime + 1, seeded: false };
  s.lastUserInputTs = Date.now() - 60_000; // draft now stale, so only the turn check can stop it
  s._rebootNoticeFlushFire();
  assert.strictEqual(flushCalls, 0, 'the turn is still measured against the original park — nothing forced');
  disarm();
});

test('t360 reboot notice: a SECOND workspace restore does not burn an attempt', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();          // workspace 1 restores
  assert.strictEqual(parks.length, 1, 'ENTER: the first restore really did park and arm the ladder');
  assert.strictEqual(state.pendingRebootNotice.attempts, 1, 'ENTER: stamped as attempt 1');
  const firstDelay = m.sessions.get('a')._rebootNoticeRetryDelay;
  m.maybeDeliverRebootNotice();          // workspace 2 restores, ~0.4s later in the field
  assert.strictEqual(state.pendingRebootNotice.attempts, 1,
    'the duplicate restore does NOT stamp attempt 2 — the budget is per notice, not per workspace');
  assert.strictEqual(parks.length, 1, 'and it does not re-park a second copy');
  // The specific damage: the duplicate used to clearTimeout the 30s rung and
  // re-arm at 120s, so the first rung never ran as a retry.
  assert.strictEqual(m.sessions.get('a')._rebootNoticeRetryDelay, firstDelay,
    'the first rung survives — the duplicate did not replace it with the second');
  assert.strictEqual(firstDelay, 30_000, 'and that surviving rung is the 30s one');
  disarm();
});

// Note on what this does NOT prove: it does not isolate the `retry: true` flag.
// _armRebootNoticeRetry's fire nulls _rebootNoticeRetryTimer before re-offering,
// so the duplicate guard is already falsy by then and the flag is belt-and-braces
// — dropping it leaves this test green. It is kept because it states the intent
// and survives a reorder of fire(), but its protection here is structural, not
// asserted. Saying so beats a comment implying coverage that does not exist.
test('t360 reboot notice: the ladder\'s OWN re-offer still advances (the guard is not a freeze)', () => {
  const { m, state, parks, disarm } = mkNotice({
    notice: { name: 'a', at: Date.now(), reason: 'x' }, live: true,
  });
  m.maybeDeliverRebootNotice();
  assert.strictEqual(parks.length, 1, 'ENTER: first park, retry armed');
  // fireRebootRetry clears the timer then fires, exactly as the real timeout does;
  // the re-offer carries retry:true so the duplicate guard must let it through.
  fireRebootRetry(m, 'a');
  assert.strictEqual(parks.length, 2, 'the retry re-parks — suppressing duplicates must not suppress the ladder');
  assert.strictEqual(state.pendingRebootNotice.attempts, 2, 'and its attempt advances');
  disarm();
});

test('gate: exec enabled → passes the coarse gate, reaching the per-command grant', async () => {
  const { m, injected } = mkGate(['exec']);
  let seenCmd = null;
  m._handleExecIntent = (_s, cmd) => { seenCmd = cmd; }; // stub the fine gate
  await m._handleIntent('a', { type: 'exec', cmd: 'bridge-reply', body: '{}' });
  assert.strictEqual(seenCmd, 'bridge-reply'); // coarse gate let it through
  assert.strictEqual(injected.length, 0); // gate itself stayed silent
});

test('gate: a disabled intent from a sender with no live session is a silent no-op', async () => {
  const { m, injected } = mkGate(['dm']);
  m.sessions.delete('a'); // sender gone, but persistence still gates who off
  await m._handleIntent('a', { type: 'who' }); // must not throw
  assert.strictEqual(injected.length, 0);
});

test('gate: the allowlist is read FRESH per fire — a toggle applies without respawn', async () => {
  const injected = [];
  let intents = ['who']; // who enabled to start
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents } : null) }),
    registry: { listPeers: () => [] },
    getPeerManager: () => null,
    peerStatusLabel: () => 'idle',
  });
  m._injectText = (_s, t) => injected.push(t);
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', workspaceId: 'ws2' });

  await m._handleIntent('a', { type: 'who' });
  assert.match(injected[0], /^\[agent:peers\]/); // enabled → fires

  intents = ['dm']; // operator unchecks `who` mid-session (no respawn)
  await m._handleIntent('a', { type: 'who' });
  assert.strictEqual(injected[1], '[agent:who] the who intent is disabled for this session');
});

// --- exec dispatcher: machine-independent placeholder expansion (Task 10) ------
// The seeded exec-defs carry `${CLODEX_BIN}/clodex-team.js` (no absolute repo
// path), so the dispatcher must expand ${CLODEX_BIN} → <REGISTRY_DIR>/bin and
// ${CLODEX_HOME} → <REGISTRY_DIR> in argv BEFORE spawn. This drives the real
// _handleExecIntent with a fake childProcess capturing the argv/cwd it spawned.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { isFilenameToken, parseAndValidate } = require('../exec-schema');

test('exec dispatcher: ${CLODEX_BIN}/${CLODEX_HOME} in argv + cwd expand before spawn', async () => {
  const REGISTRY_DIR = mkTmpRoot('clodex-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  // A def mirroring the seeded shape: placeholder argv, and (to prove cwd is
  // expanded too) an explicit ${CLODEX_HOME} cwd.
  fs.writeFileSync(path.join(execDir, 'clodex-team.json'), JSON.stringify({
    argv: ['/usr/bin/env', 'node', '${CLODEX_BIN}/clodex-team.js', '--home=${CLODEX_HOME}'],
    cwd: '${CLODEX_HOME}/work',
    timeoutMs: 5000, maxBytes: 4096, replyStderr: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['action', 'agent'],
      properties: { action: { type: 'string', enum: ['roster'] }, agent: { type: 'string', maxLength: 64 } },
    },
  }));

  const spawned = [];
  const fakeChild = () => {
    const ee = new (require('node:events').EventEmitter)();
    ee.stdin = { write() {}, end() {} };
    ee.stderr = new (require('node:events').EventEmitter)();
    ee.kill = () => {};
    setImmediate(() => ee.emit('exit', 0, null));   // clean success, no re-bill
    return ee;
  };
  const m = mk({
    REGISTRY_DIR,
    isFilenameToken, parseAndValidate,
    os, fs, path,
    log: { warn() {}, info() {} },
    getPersistence: () => ({ list: () => [], get: () => ({ execCommands: ['clodex-team'] }) }),
    childProcess: { spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return fakeChild(); } },
  });
  m._injectText = () => {};
  m._broadcast = () => {};
  const session = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/some/session/cwd' };

  m._handleExecIntent(session, 'clodex-team', JSON.stringify({ action: 'roster', agent: 'a' }));
  // spawn is deferred via setImmediate inside the handler; let it run.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(spawned.length, 1, 'the command spawned once');
  const { cmd, args, opts } = spawned[0];
  const BIN = path.join(REGISTRY_DIR, 'bin');
  assert.strictEqual(cmd, '/usr/bin/env');
  assert.deepStrictEqual(args, ['node', `${BIN}/clodex-team.js`, `--home=${REGISTRY_DIR}`],
    '${CLODEX_BIN} and ${CLODEX_HOME} expanded in every argv element');
  assert.strictEqual(opts.cwd, `${REGISTRY_DIR}/work`, '${CLODEX_HOME} expanded in cwd too');
  assert.ok(!args.some((a) => a.includes('${')), 'no placeholder survives into the spawn');

  fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

// --- spawn with template: applies the template's config -----------------------
// [agent:spawn name:X template:Y] resolves the template by name and threads its
// config into create() (proxy/agents/tool+skill gating/extraArgs) plus the
// post-create strip/autocompact setters. Errors (missing / ambiguous / no cwd)
// reply synchronously before any spawn. create() is stubbed to capture args.
const AGENT_NAME_RE_T = /^[a-zA-Z0-9._-]{1,64}$/;
const tick = () => new Promise((r) => setTimeout(r, 10));

function mkSpawn(templatesList, persistedEntries = {}) {
  const stripCalls = [], acCalls = [];
  // Both setters resolve the entry BY NAME and no-op when it is absent, so the
  // fixture must too: a recorder that captured the call unconditionally would
  // record a write that the real store would have thrown away, and every
  // "the template's level reached the seat" assertion downstream would still
  // pass with the call moved BEFORE create(). `minted` is what create() makes.
  const minted = new Set(Object.keys(persistedEntries));
  const persistence = {
    list: () => [],
    get: (n) => persistedEntries[n] || null,
    setStripLevel: (n, l) => { if (minted.has(n)) stripCalls.push([n, l]); },
    setAutoCompact: (n, on) => { if (minted.has(n)) acCalls.push([n, on]); },
  };
  const m = mk({
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => templatesList }),
    AGENT_NAME_RE: AGENT_NAME_RE_T,
    DEFAULT_WORKSPACE_ID: 'default',
    ensureDir: () => {},
    fs: fsReal,
    path: pathReal,
    os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const created = [], replies = [];
  m._injectText = (_s, text) => replies.push(text);
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m.create = async (...args) => { created.push(args); minted.add(args[0]); };
  const spawner = { name: 'clodex', type: 'claude', workspaceId: 'default', proxy: null };
  return { m, created, replies, stripCalls, acCalls, spawner };
}

const TRADER_SEAT = {
  id: 'tpl-1', name: 'trader-seat', type: 'claude', cwd: '/proj/desk',
  extraArgs: ['--model', 'opus'],
  proxy: false, agents: ['reviewer'], denyBuiltins: ['WebSearch'],
  disabledTools: ['Edit', 'NotebookEdit'], disabledSkills: ['s1'],
  injectSkills: ['notes'], stripLevel: 2, autoCompact: false,
};

test('spawn template: threads config into create() + post-create strip/autocompact', async () => {
  const { m, created, replies, stripCalls, acCalls, spawner } = mkSpawn([TRADER_SEAT]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'trader-seat' });
  await tick();
  assert.strictEqual(created.length, 1, 'create called once');
  const a = created[0];
  // create(name, type, cwd, extraArgs, resumeId, workspaceId, sysBody, fork,
  //        proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, sysFile, appendFiles)
  assert.strictEqual(a[0], 't2');
  assert.strictEqual(a[1], 'claude');                  // type from template
  assert.strictEqual(a[2], pathReal.resolve('/proj/desk')); // cwd from template
  assert.deepStrictEqual(a[3], ['--model', 'opus']);   // extraArgs verbatim (model rides here)
  assert.strictEqual(a[8], false);                     // proxy from template
  assert.deepStrictEqual(a[9], ['reviewer']);          // agents
  assert.deepStrictEqual(a[10], ['WebSearch']);        // denyBuiltins
  assert.deepStrictEqual(a[11], ['Edit', 'NotebookEdit']); // disabledTools
  assert.deepStrictEqual(a[12], ['s1']);               // disabledSkills
  assert.deepStrictEqual(a[13], ['notes']);            // injectSkills
  // A template without prompt refs threads null/[] into params 15/16 (unchanged
  // from a plain spawn) — no prompt applied, back-compat preserved.
  assert.strictEqual(a[14], null);                     // systemPromptFile absent
  assert.deepStrictEqual(a[15], []);                   // appendPromptFiles absent
  // Opt-out fields applied post-create onto the entry.
  assert.deepStrictEqual(stripCalls, [['t2', 2]]);
  assert.deepStrictEqual(acCalls, [['t2', false]]);
  assert.match(replies.at(-1), /ok: spawned "t2".*via template "trader-seat"/);
});

test('spawn template: name match is case-insensitive', async () => {
  const { m, created, spawner } = mkSpawn([TRADER_SEAT]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'TRADER-SEAT' });
  await tick();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0][0], 't2');
});

test('spawn template: intent cwd overrides the template cwd', async () => {
  const { m, created, spawner } = mkSpawn([TRADER_SEAT]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/other/dir', template: 'trader-seat' });
  await tick();
  assert.strictEqual(created[0][2], pathReal.resolve('/other/dir'));
});

test('spawn template: missing template errors synchronously, listing available names', async () => {
  const { m, created, replies, spawner } = mkSpawn([TRADER_SEAT]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/tmp/x', template: 'nope' });
  // Error is synchronous — no setImmediate spawn scheduled.
  assert.match(replies.at(-1), /no template named "nope".*available: trader-seat/);
  await tick();
  assert.strictEqual(created.length, 0, 'no spawn on a missing template');
});

test('spawn template: ambiguous name errors, never silent-picks', async () => {
  const dupA = { ...TRADER_SEAT, id: 'a', name: 'dup' };
  const dupB = { ...TRADER_SEAT, id: 'b', name: 'DUP' };  // case-insensitive collision
  const { m, created, replies, spawner } = mkSpawn([dupA, dupB]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/tmp/x', template: 'dup' });
  assert.match(replies.at(-1), /ambiguous — 2 templates named "dup"/);
  await tick();
  assert.strictEqual(created.length, 0);
});

test('spawn template: no cwd from intent OR template errors', async () => {
  const noCwd = { ...TRADER_SEAT, cwd: null };
  const { m, created, replies, spawner } = mkSpawn([noCwd]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'trader-seat' });
  assert.match(replies.at(-1), /template "trader-seat" has no cwd/);
  await tick();
  assert.strictEqual(created.length, 0);
});

test('spawn template: empty template.extraArgs falls back to spawner permission posture (F5)', async () => {
  // Template carries no extraArgs; the spawner is persisted with yolo → the
  // child inherits ONLY that posture flag (not a full extraArgs copy).
  const bare = { ...TRADER_SEAT, extraArgs: [] };
  const { m, created, spawner } = mkSpawn([bare], {
    clodex: { extraArgs: ['--dangerously-skip-permissions'] },
  });
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'trader-seat' });
  await tick();
  assert.deepStrictEqual(created[0][3], ['--dangerously-skip-permissions']);
});

test('spawn template: prompt refs thread into create() params 15/16', async () => {
  // A template carrying library-file prompt refs (system replaces, appends
  // compose) reproduces a seat's prompts — the refs, never inline bodies.
  const withPrompts = {
    ...TRADER_SEAT,
    systemPromptFile: 'trader-seat',
    appendPromptFiles: ['00-house-rules', '50-wake'],
  };
  const { m, created, spawner } = mkSpawn([withPrompts]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'trader-seat' });
  await tick();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0][14], 'trader-seat');                    // systemPromptFile
  assert.deepStrictEqual(created[0][15], ['00-house-rules', '50-wake']); // appendPromptFiles
});

// --- spawn template from a JSON FILE path (second source, same apply seam) -----
// template:VALUE with a '/' or leading ~/. is a file path (resolved against the
// spawner cwd), read + parsed into the same template object the library lookup
// yields — so config application can't drift between the two sources.
const tmpTplDir = () => mkTmpRoot('clodex-tpl-');

test('spawn template: a JSON file path resolves + applies its config', async () => {
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'seat.json');
  fsReal.writeFileSync(file, JSON.stringify({
    type: 'claude', cwd: '/proj/desk', extraArgs: ['--model', 'opus'],
    disabledTools: ['Edit'], stripLevel: 1,
    systemPromptFile: 'trader-seat', appendPromptFiles: ['50-wake'],
  }));
  const { m, created, stripCalls, replies, spawner } = mkSpawn([]); // empty library
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: file });
  await tick();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0][1], 'claude');
  assert.strictEqual(created[0][2], pathReal.resolve('/proj/desk'));
  assert.deepStrictEqual(created[0][3], ['--model', 'opus']);
  assert.deepStrictEqual(created[0][11], ['Edit']);
  assert.strictEqual(created[0][14], 'trader-seat');   // prompt refs ride the file source too
  assert.deepStrictEqual(created[0][15], ['50-wake']);
  assert.deepStrictEqual(stripCalls, [['t2', 1]]);
  // A file template has no name → the log/reply label falls back to the path.
  assert.match(replies.at(-1), /ok: spawned "t2".*via template/);
});

test('spawn template: a ./relative file resolves against the spawner cwd', async () => {
  const dir = tmpTplDir();
  fsReal.writeFileSync(pathReal.join(dir, 'seat.json'), JSON.stringify({ type: 'claude', cwd: '/proj/x' }));
  const { m, created, spawner } = mkSpawn([]);
  spawner.cwd = dir;                                  // spawner fires from here
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: './seat.json' });
  await tick();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0][2], pathReal.resolve('/proj/x'));
});

test('spawn template: a missing file path errors, no spawn', async () => {
  const { m, created, replies, spawner } = mkSpawn([]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/tmp/x', template: '/no/such/seat.json' });
  assert.match(replies.at(-1), /template file \/no\/such\/seat\.json: not found/);
  await tick();
  assert.strictEqual(created.length, 0);
});

test('spawn template: malformed JSON file errors, no spawn', async () => {
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'bad.json');
  fsReal.writeFileSync(file, '{ not valid json ');
  const { m, created, replies, spawner } = mkSpawn([]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/tmp/x', template: file });
  assert.match(replies.at(-1), /invalid JSON/);
  await tick();
  assert.strictEqual(created.length, 0);
});

// t297: the spawn path had its own copy of the env filter and reported a bad
// VALUE TYPE as an out-of-allowlist key — sending the operator to ask for
// approval for a key they already have. The two reasons must stay apart on
// EVERY spawn path (review and ticket already split them), which is why this
// asserts the two reason phrases and not just that the key was named.
test('spawn template (t297): an allowed env key with a NON-STRING value is dropped for its OWN reason, not as an authority question', async () => {
  const { m, created, replies, spawner } = mkSpawn([{
    id: 'tpl-e', name: 'env-seat', type: 'claude', cwd: '/proj/desk',
    env: {
      CLODEX_DISABLE_IPC_PROMPT: '1',    // allowed, well-typed → crosses
      ANTHROPIC_BASE_URL: 'http://evil', // not allowed → authority question
      FORCE_PROMPT_CACHING_5M: 5,        // allowed KEY, bad value type
    },
  }]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'env-seat' });
  await tick();
  // ENTER: a spawn that never reached create() makes the env assertion below
  // read as "nothing crossed", which is also true of a total failure.
  assert.strictEqual(created.length, 1, 'ENTER: create() must have been reached');
  assert.deepStrictEqual(created[0][18], { CLODEX_DISABLE_IPC_PROMPT: '1' },
    'only the well-typed allowlisted key crosses');
  const reply = replies.at(-1);
  assert.match(reply, /env keys not allowed, dropped: ANTHROPIC_BASE_URL/,
    'the out-of-allowlist key keeps the authority reason');
  assert.ok(!/not allowed, dropped:[^—]*FORCE_PROMPT_CACHING_5M/.test(reply),
    'the badly-typed key must NOT ride the authority bucket');
  assert.match(reply, /FORCE_PROMPT_CACHING_5M/, 'but it must still be named');
  assert.match(reply, /values are not strings/, 'with its own reason');
});

test('spawn template (t297): a template whose env is entirely well-typed and allowed reports no drop at all', async () => {
  const { m, created, replies, spawner } = mkSpawn([{
    id: 'tpl-ok', name: 'ok-seat', type: 'claude', cwd: '/proj/desk',
    env: { CLODEX_DISABLE_IPC_PROMPT: '1', CLODEX_SPAWNER_HINT: 'off' },
  }]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: null, template: 'ok-seat' });
  await tick();
  assert.strictEqual(created.length, 1, 'ENTER: create() must have been reached');
  assert.deepStrictEqual(created[0][18], { CLODEX_DISABLE_IPC_PROMPT: '1', CLODEX_SPAWNER_HINT: 'off' });
  assert.ok(!/dropped/.test(replies.at(-1)), `clean env must not warn, got: ${replies.at(-1)}`);
});

// --- Mid-flight DM delivery: park-on-busy (piece 2) + idle-edge drain (piece 3) -
// A busy agent's DM parks to the on-disk pending store (where the out-of-process
// PostToolUse hook can drain it mid-loop) instead of the in-memory _injectQueue;
// the idle-edge Node drain is the turn-end fallback for a pure-text (no-tool)
// turn. Real pending-store fns + isDraftOpen injected over a temp PENDING_DIR;
// _injectText captured (no PTY). One atomic rename-claim = exactly-once.
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending: countPendingReal, parkIdInUse } = require('../pending-store');
const { isDraftOpen: isDraftOpenReal } = require('../proxy-util');

function mkPark(overrides = {}) {
  const PENDING_DIR = mkTmpRoot('clodex-pend-');
  const injected = [];
  const m = mk({
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen: isDraftOpenReal,
    INJECT_QUIET_MS: 4000, INJECT_QUIET_MAXWAIT: 3_600_000, // maxwait large: park cap won't fire mid-test
    // Same reason as the maxwait above, and NOT decorative: _deliverParkedActive
    // arms the parked-drain fallback with this, so leaving it undefined arms a 1ms
    // timer against a NaN deadline. Every test here empties the store before it
    // fires, so today that is invisible — which is exactly why it is pinned by
    // construction rather than by luck.
    INJECT_BOOT_MAXWAIT: 60_000,
    findProjectRoot: () => null, // teams: default = no project anywhere; retire tests override
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...overrides,
  });
  // Models the QUEUE: a producer is evaluated at WRITE time. The real queue
  // claims inside _drain, so a stub that pushed the placeholder text would record
  // '' for every produce-based drain and assert nothing about the payload.
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    // The queue WRITES NOTHING for a null/empty producer (inject-queue _drain
    // returns before the write), so recording one would invent an injection that
    // never happens — and every "nothing was delivered" assertion would see a
    // phantom entry. A producer returns null whenever its claim came up empty:
    // another drainer won, or every entry failed the born check.
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  return { m, PENDING_DIR, injected };
}

test('_maybeParkDelivery: a BUSY (thinking) target parks to pending, not the inject queue', () => {
  const { m, PENDING_DIR } = mkPark();
  const target = { name: 'a', agentType: 'claude', activityState: 'thinking' }; // busy, no recent input
  const parked = m._maybeParkDelivery(target, '[agent:from x] hi');
  assert.strictEqual(parked, true, 'busy DM is parked (caller must not inject)');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'the DM landed in the pending store');
  clearTimeout(target._parkCapTimer); // _armParkCap set a floor timer
});

test('_maybeParkDelivery: an IDLE, not-composing target does NOT park (falls through to inject)', () => {
  const { m, PENDING_DIR } = mkPark();
  const target = { name: 'a', agentType: 'claude', activityState: 'idle' };
  assert.strictEqual(m._maybeParkDelivery(target, 'hi'), false);
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false, 'nothing parked for an idle+quiet target');
});

test('_maybeParkDelivery: an operator-composing target still parks (typing branch intact)', () => {
  const { m, PENDING_DIR } = mkPark();
  const target = { name: 'a', agentType: 'claude', activityState: 'idle', lastUserInputTs: Date.now() };
  assert.strictEqual(m._maybeParkDelivery(target, 'hi'), true);
  assert.ok(hasPending(PENDING_DIR, 'a'));
  clearTimeout(target._parkCapTimer);
});

test('_drainPendingAtIdle: drains a parked DM via a parkable inject when no draft is open', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '1');
  const session = { name: 'a', agentType: 'claude' }; // no draft (no lastUserInputTs)
  m._drainPendingAtIdle(session);
  assert.deepStrictEqual(injected, ['[agent:from x] hi'], 'the parked DM stdin-injects at the idle edge');
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false, 'claimed + removed from the store');
});

test('_drainPendingAtIdle: does NOT drain while an operator draft is open (no splice)', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '1');
  const session = { name: 'a', agentType: 'claude', lastUserInputTs: Date.now(), lastUserSubmitTs: 0 };
  m._drainPendingAtIdle(session);
  assert.deepStrictEqual(injected, [], 'draft open → no inject');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'DM stays parked for a later drain');
});

test('_drainPendingAtIdle: exactly-once — a second drain (hook already claimed) is a no-op', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '1');
  const session = { name: 'a', agentType: 'claude' };
  m._drainPendingAtIdle(session);            // first claim wins
  m._drainPendingAtIdle(session);            // dir gone → ENOENT → [] → no-op
  assert.deepStrictEqual(injected, ['[agent:from x] hi'], 'delivered once, not twice');
});

// t229: the second drain above is the claim-without-delivery shape in miniature —
// the gate saw mail, the destructive claim came back empty because another drainer
// won. In the field that silence is what hid a lost reboot notice for seven
// restarts: nothing anywhere recorded that a claim had yielded nothing.
test('t229 _drainPendingAtIdle: an empty claim is LOGGED, not silent', () => {
  const debugs = [];
  const { m, PENDING_DIR, injected } = mkPark({
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: (_s, msg) => debugs.push(msg) },
  });
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '1');
  const session = { name: 'a', agentType: 'claude' };
  m._drainPendingAtIdle(session);
  assert.deepStrictEqual(injected, ['[agent:from x] hi'], 'ENTER: the first drain really delivered');
  assert.deepStrictEqual(debugs, [], 'ENTER: and said nothing, because it claimed something');
  // Re-park, then let a competitor claim it before this drain's producer runs.
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] second', '2');
  m._injectText = (_s, _t, opts) => {
    drainPending(PENDING_DIR, 'a', 'competitor');   // wins between gate and produce
    if (opts && typeof opts.produce === 'function') opts.produce();
  };
  m._drainPendingAtIdle(session);
  assert.ok(debugs.some((d) => /idle drain for a claimed nothing/.test(d)),
    'the empty claim is recorded — without it a lost delivery leaves no trace');
});

// Same claim-without-delivery shape on the BOOT-READY drain. It is a separate
// code path with its own copy of the guard (it enqueues on the InjectQueue
// directly rather than through _injectText), and a duplicated guard needs its
// own test — one copy's coverage says nothing about the other's.
test('t229 _drainPendingAtBootReady: an empty claim is LOGGED, not silent', () => {
  const debugs = [];
  const { m, PENDING_DIR } = mkPark({
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: (_s, msg) => debugs.push(msg) },
  });
  const session = { name: 'a', agentType: 'claude' };
  // Stand in for the real queue: run the producer at write time, which is where
  // the destructive claim happens — and let a competitor win first.
  const produced = [];
  m._injectQueueFor = () => ({ enqueue: (_t, opts) => {
    drainPending(PENDING_DIR, 'a', 'competitor');
    produced.push(opts && typeof opts.produce === 'function' ? opts.produce() : _t);
  } });
  parkDelivery(PENDING_DIR, 'a', '[agent:from reboot] notice: Clodex restarted', '1');
  assert.strictEqual(hasActivePending(PENDING_DIR, 'a'), true,
    'ENTER: active mail is parked, so the drain gets past its gate to the producer');
  m._drainPendingAtBootReady(session);
  assert.deepStrictEqual(produced, [null], 'ENTER: the producer ran and claimed nothing');
  assert.ok(debugs.some((d) => /boot-ready drain for a claimed nothing/.test(d)),
    'the empty claim is recorded — this is the exact silence that hid the lost notice');
});

test('_drainPendingAtIdle: a passive-only store is left parked (no turn generated)', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from monitor] tick', '1', null, true);
  m._drainPendingAtIdle({ name: 'a', agentType: 'claude' });
  assert.deepStrictEqual(injected, [], 'passive ticks do not earn an idle-edge inject');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'they stay parked for an organic hook drain');
});

test('_drainPendingAtIdle: a mixed store drains fully as ONE batched inject — passives ride along, in order', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from monitor] tick', '1', null, true);
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '2');
  m._drainPendingAtIdle({ name: 'a', agentType: 'claude' });
  // Batched: N parked texts become ONE injection (blank-line separator, park
  // order) — a sequential per-text drain stranded the tail in the TUI turn-start.
  assert.deepStrictEqual(injected, ['[agent:from monitor] tick\n\n[agent:from x] hi'],
    'the active DM justifies the turn; the passive rides with it in one body, in order');
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false);
});

test('_drainPendingAtIdle: a single parked DM injects unchanged (no stray separator)', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] solo', '1');
  m._drainPendingAtIdle({ name: 'a', agentType: 'claude' });
  assert.deepStrictEqual(injected, ['[agent:from x] solo'], 'one text → one body, no separator appended');
});

// _flushParkedNow: the operator ✉-click / park-cap forced drain. Must deliver the
// WHOLE parked pile as ONE injection — a forced flush is non-parkable (resend-
// recursion fix), so a text stranded by a sequential drain just SITS (the field
// bug: 2 parked, click ✉, one delivered + one stuck in stdin). Blank-line
// separator + park order, matching the hook drain (cli-hooks.js texts.join).
test('_flushParkedNow: 2+ parked texts → exactly ONE _injectText, both in park order, blank-line separated', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] first', '1');
  parkDelivery(PENDING_DIR, 'a', '[agent:from y] second', '2');
  const r = m._flushParkedNow({ name: 'a', agentType: 'claude' }, 'flush.test');
  assert.strictEqual(injected.length, 1, 'the whole drain is ONE injection, not N');
  assert.strictEqual(injected[0], '[agent:from x] first\n\n[agent:from y] second', 'both texts, park order, \\n\\n between');
  assert.deepStrictEqual(r, { ok: true, count: 2 }, 'reports the batched count');
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false, 'store drained');
});

test('_flushParkedNow: a single parked text flushes as one body with no stray separator', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] only', '1');
  const r = m._flushParkedNow({ name: 'a', agentType: 'claude' }, 'flush.test');
  assert.deepStrictEqual(injected, ['[agent:from x] only'], 'one text → one body, no separator');
  assert.strictEqual(r.count, 1);
});

test('_deliverPassive: parks passive for a live claude target, no inject, no wake', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  const target = { name: 'a', agentType: 'claude' };
  m.sessions.set('a', target);
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('a', { from: 'monitor', body: 'tick 1', type: 'dm', delivery: 'passive' });
  assert.deepStrictEqual(injected, [], 'no inject — passive never wakes');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'parked in the pending store');
  assert.strictEqual(hasActivePending(PENDING_DIR, 'a'), false, 'parked as PASSIVE');
  assert.deepStrictEqual(drainPending(PENDING_DIR, 'a', 't'), ['[agent:from monitor] tick 1']);
});

test('_deliverPassive: a codex target falls back to the normal wake path (never dropped)', () => {
  const { m, PENDING_DIR } = mkPark();
  const target = { name: 'c', agentType: 'codex' };
  m.sessions.set('c', target);
  const delivered = [];
  m._deliverMessage = (name, sender, body, mtype) => delivered.push({ name, sender, body, mtype });
  m._onIncoming('c', { from: 'monitor', body: 'tick', type: 'dm', delivery: 'passive' });
  assert.deepStrictEqual(delivered, [{ name: 'c', sender: 'monitor', body: 'tick', mtype: 'dm' }]);
  assert.strictEqual(hasPending(PENDING_DIR, 'c'), false, 'nothing parked for codex');
});

// --- generation stamps: _bornFor + the parks/drains that carry them ---
//
// pending-store's own tests pin the COMPARISON; these pin the plumbing — that
// the manager reads the right stamp for a name and actually hands it to the
// store. A stamp that is computed correctly and never passed is worth nothing,
// and a park that stamps a live seat but not an offline one silently drops the
// offline seat's mail on arrival.

test('_bornFor: prefers the LIVE session, falls back to persistence, null when neither knows', () => {
  const { m } = mkPark({ getPersistence: () => ({ list: () => [], get: (n) => (n === 'offline' ? { createdAt: 2222 } : null) }) });
  m.sessions.set('live', { name: 'live', agentType: 'claude', createdAt: 1111 });
  assert.strictEqual(m._bornFor('live'), 1111);
  // The offline fallback is the load-bearing one: a reboot notice or a reminder
  // fires at a name with NO process, and the value it stamps has to be the one
  // create() will hand that seat when its workspace restores it. That equality
  // is what phase 3a bought — before it, every kill()-based restart re-minted
  // createdAt and this comparison would have discarded live mail.
  assert.strictEqual(m._bornFor('offline'), 2222);
  assert.strictEqual(m._bornFor('never-heard-of'), null, 'unknown name = no expectation, never a bogus stamp');
});

test('_bornFor: a live session with no stamp falls through to persistence rather than returning undefined', () => {
  // Pre-stamp sessions restored into a newer build, and every non-create() test
  // harness, put session objects in the map without createdAt. Returning
  // undefined from here would flow into parkDelivery as a non-number (dropped
  // from the payload, fine) but ALSO into drainPending as a non-number — which
  // is the deliver-everything default, so the failure is silent either way.
  const { m } = mkPark({ getPersistence: () => ({ list: () => [], get: () => ({ createdAt: 3333 }) }) });
  m.sessions.set('a', { name: 'a', agentType: 'claude' });
  assert.strictEqual(m._bornFor('a'), 3333);
});

test('park→drain carries the stamp end to end: a successor is refused, the addressee is not', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  const dir = pathReal.join(PENDING_DIR, 'a');
  const park = (born) => {
    const t = { name: 'a', agentType: 'claude', activityState: 'thinking', createdAt: born };
    m.sessions.set('a', t);
    m._maybeParkDelivery(t, `[agent:from x] for the seat born at ${born}`);
    // _maybeParkDelivery arms the starvation cap (a 1h timer in this harness).
    // Two parks = two live handles = the runner never exits. Same teardown every
    // other park test here does; it just bites twice as hard when you park twice.
    clearTimeout(t._parkCapTimer);
    return t;
  };
  const drainAs = (born) => {
    const t = { name: 'a', agentType: 'claude', activityState: 'idle', createdAt: born };
    m.sessions.set('a', t);
    m._drainPendingAtIdle(t);
  };

  const first = park(5555);
  // The stamp really reached the PAYLOAD — read the file, not a return value.
  const entry = JSON.parse(fsReal.readFileSync(pathReal.join(dir, fsReal.readdirSync(dir)[0]), 'utf8'));
  assert.strictEqual(entry.born, 5555, 'the park must stamp the addressee\'s birth time');

  // Same name, next generation. This is the ticket: a fresh seat must not start
  // life reading a stranger's mail. Asserted through the MANAGER's drain, so the
  // stamp has to survive _bornFor → drainPending, not just exist on disk.
  drainAs(9999);
  assert.deepStrictEqual(injected, [], 'the successor must not be handed its predecessor\'s mail');
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false, 'and the stale mail is consumed, not left to be re-offered forever');

  // The other half, and it is what stops "refuse everything" from passing: mail
  // parked FOR this generation must still arrive. Both halves go through the
  // same two methods, so a manager that dropped the stamp anywhere in the chain
  // fails one or the other.
  park(9999);
  drainAs(9999);
  assert.deepStrictEqual(injected, ['[agent:from x] for the seat born at 9999']);
  assert.ok(first.createdAt !== 9999, 'sanity: the two generations really are different');
});

test('_cleanup does NOT delete the pending store — a restart must not destroy parked DMs', () => {
  const { m, PENDING_DIR } = mkPark({
    registry: { unregister: () => {} },
    cleanupClaudeHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    // `path` and a real `fs` are REQUIRED here, not decoration. The rm this test
    // pins the absence of was `fs.rmSync(path.join(PENDING_DIR, name), …)` inside
    // a bare `try {} catch {}`. The default harness injects no `path`, so a
    // restored rm would throw on path.join and its own catch would swallow it —
    // the test would pass whether the deletion was there or not. Verified by
    // reverting: with these two absent, re-adding the rm did NOT fail this test.
    // A guard that cannot see the thing it guards against is worse than none.
    path: pathReal, fs: fsReal,
  });
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] sent while it was restarting', '1');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'ENTER: the DM must be parked BEFORE _cleanup runs');
  // _userKilled is exactly the RESTART state (engine.restartSession and
  // applySessionArgs both route through kill(), which sets it). The rm this
  // replaces was gated on that flag and so destroyed a seat's undelivered mail
  // on the button labelled "restart".
  m.sessions.set('a', { name: 'a', agentType: 'claude', _userKilled: true });
  m._cleanup('a');
  assert.ok(hasPending(PENDING_DIR, 'a'),
    'parked DMs must survive _cleanup even with _userKilled set: restart routes through kill() too, so gating the rm on that flag deleted undelivered mail on an ordinary restart — the zero-loss violation this store exists to prevent. Stale mail for a RECREATED name is refused at drain time by the born stamp instead, which also covers the exits this rm never fired on.');
});

// A timer surviving _cleanup fires against a dead seat: its callback re-enters
// the manager with a session that is gone from the map, and the reboot-notice
// retry would re-park mail for a name that no longer has a reader. The list is
// asserted whole rather than one entry deep — a NEW timer added to the class and
// forgotten here is exactly the leak this catches, and per-timer assertions all
// pass while saying nothing about the one nobody added.
test('_cleanup disarms every timer the session owns (a fired timer on a dead seat re-enters the manager)', () => {
  const { m } = mkPark({
    registry: { unregister: () => {} },
    cleanupClaudeHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    path: pathReal, fs: fsReal,
  });
  const TIMER_FIELDS = [
    '_injectHoldTimer', '_injectFlushRetry', '_compactValveTimer', '_postClearValveTimer',
    '_parkCapTimer', '_bootSettleTimer', '_bootDrainTimer', '_replayFallbackTimer',
    // _specConfirmTimer predates t360 and was missing: the list is asserted whole,
    // so every field it omits is a leak this test promises to catch and does not.
    '_parkedDrainFallbackTimer', '_rebootNoticeRetryTimer', '_rebootNoticeFlushTimer',
    '_specConfirmTimer',
    // t357's displaced-spec drain is a second NEW field for the same reason, and
    // its callback redelivers a whole spec — firing on a dead seat would write a
    // ticket body at a PTY that is gone.
    '_specOwedTimer',
    // t388's dm latch owns a NEW field rather than borrowing _specConfirmTimer,
    // so it inherits this defence by nothing but the line that adds it.
    '_dmConfirmTimer',
  ];
  const fired = [];
  const s = { name: 'a', agentType: 'claude' };
  for (const f of TIMER_FIELDS) s[f] = setTimeout(() => fired.push(f), 5);
  m.sessions.set('a', s);
  // ENTER: every field really holds a live timer, or the absence below is vacuous.
  assert.strictEqual(TIMER_FIELDS.filter((f) => s[f]).length, TIMER_FIELDS.length,
    'ENTER: all timers armed before _cleanup');
  m._cleanup('a');
  return new Promise((resolve) => setTimeout(() => {
    assert.deepStrictEqual(fired, [], 'no timer survived _cleanup to fire against the dead seat');
    resolve();
  }, 40));
});

test('_onIncoming: an unknown delivery value falls through to the normal path (old-core compat shape)', () => {
  const { m } = mkPark();
  const delivered = [];
  m._deliverMessage = (name, sender, body) => delivered.push(body);
  m._onIncoming('a', { from: 'x', body: 'hi', type: 'dm', delivery: 'someday-class' });
  assert.deepStrictEqual(delivered, ['hi']);
});

test('_deliverParkedActive: parks ACTIVE (turn-earning) for a live claude target — no spawn-time inject', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  const target = { name: 'a', agentType: 'claude' };
  m.sessions.set('a', target);
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._deliverParkedActive('a', 'lead', 'review the fix', 'dm');
  assert.deepStrictEqual(injected, [], 'active PARK still writes nothing at spawn time (T40/T42 race stays fixed)');
  assert.ok(hasPending(PENDING_DIR, 'a'), 'parked in the pending store');
  assert.strictEqual(hasActivePending(PENDING_DIR, 'a'), true, 'parked as ACTIVE — hasActivePending sees it, so an idle/boot edge drains it');
  assert.deepStrictEqual(drainPending(PENDING_DIR, 'a', 't'), ['[agent:from lead] review the fix']);
});

test('_deliverParkedActive: a codex target falls back to the normal wake path (never dropped)', () => {
  const { m, PENDING_DIR } = mkPark();
  m.sessions.set('c', { name: 'c', agentType: 'codex' });
  const delivered = [];
  m._deliverMessage = (name, sender, body, mtype) => delivered.push({ name, sender, body, mtype });
  m._deliverParkedActive('c', 'lead', 'scope', 'dm');
  assert.deepStrictEqual(delivered, [{ name: 'c', sender: 'lead', body: 'scope', mtype: 'dm' }]);
  assert.strictEqual(hasPending(PENDING_DIR, 'c'), false, 'nothing parked for codex');
});

test('_deliverParkedActive: park failure falls back to a normal delivery (degraded-but-not-dropped)', () => {
  const { m } = mkPark({ parkDelivery: () => { throw new Error('disk full'); } });
  m.sessions.set('a', { name: 'a', agentType: 'claude' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  const delivered = [];
  m._deliverMessage = (name, sender, body, mtype) => delivered.push({ name, sender, body, mtype });
  m._deliverParkedActive('a', 'lead', 'scope', 'dm');
  assert.deepStrictEqual(delivered, [{ name: 'a', sender: 'lead', body: 'scope', mtype: 'dm' }], 'park throw → normal delivery, not dropped');
});

test('T54 end-to-end: an active-parked scope is SILENT at spawn time, then the idle/boot edge drains it', () => {
  // The whole T54 fix in one flow against the REAL pending store: park the scope
  // active (no spawn-time PTY write — T40/T42 stance), then an idle-class edge
  // (the boot-ready rising edge calls the SAME _drainPendingAtIdle) delivers it.
  const { m, PENDING_DIR, injected } = mkPark();
  const session = { name: 'team-reviewer-1', agentType: 'claude' };  // no draft, boot-silent
  m.sessions.set(session.name, session);
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  // 1. scope parked active — nothing injected yet (T40/T42: no draft-racing write).
  m._deliverParkedActive(session.name, 'lead', 'review the boot-race fix', 'dm');
  assert.deepStrictEqual(injected, [], 'NO direct PTY write of the scope at spawn time');
  assert.strictEqual(hasActivePending(PENDING_DIR, session.name), true, 'held as active pending, awaiting an edge');
  // 2. the idle/boot-ready edge fires the drain — the scope reaches the inject path.
  m._drainPendingAtIdle(session);
  assert.deepStrictEqual(injected, ['[agent:from lead] review the boot-race fix'],
    'the idle/boot edge drained the active scope — no human ✉-click needed');
  assert.strictEqual(hasPending(PENDING_DIR, session.name), false, 'claimed + removed from the store');
});

test('T54: a PASSIVE park still does NOT earn the boot/idle edge (only the active scope class does)', () => {
  // Guards the class boundary: the fix flips ONLY the scope to active. A passive
  // ride-along (roster/team delta) parked on the same seat must still wait for an
  // organic carrier — the boot-ready edge drains actives, not passives.
  const { m, PENDING_DIR, injected } = mkPark();
  const session = { name: 'team-reviewer-1', agentType: 'claude' };
  parkDelivery(PENDING_DIR, session.name, '[agent:from team] roster delta', '1', null, true); // passive
  m._drainPendingAtIdle(session);
  assert.deepStrictEqual(injected, [], 'a passive-only store does not earn a turn at the boot/idle edge');
  assert.ok(hasPending(PENDING_DIR, session.name), 'the passive delta stays parked for an organic hook drain');
});

// --- team-retire (teams-design.md [internal design doc, not in this repo]): socket envelope → archive|discard --

function mkRetire(rootByName, rolesByRoot, extraDeps) {
  // rootByName: cwd → project root map for the stub findProjectRoot.
  // rolesByRoot: root → { role: def } map for the stub resolveTeam. The manifest
  // now answers only "is this seat the team's at all"; ephemerality comes from
  // the persistence record, so a test that wants the discard path stubs
  // getPersistence().get to return { ephemeral: true } rather than marking a role.
  const roles = (root) => rolesByRoot?.[root] ?? { lead: {}, dev: {} };
  const normalize = (defs) => Object.fromEntries(
    Object.entries(defs).map(([r, d]) => [r, { template: d.template ?? null, prompt: d.prompt ?? null, brief: d.brief ?? null, dispatch: d.dispatch ?? 'standing' }]),
  );
  const { m, PENDING_DIR, injected } = mkPark({
    findProjectRoot: (cwd) => rootByName[cwd] ?? null,
    resolveTeam: (cwd) => {
      const root = rootByName[cwd];
      if (!root) return null;
      return { name: 'team', root, lead: 'lead', roles: normalize(roles(root)), file: `${root}/team.json` };
    },
    ...(extraDeps || {}),
  });
  const archived = [];
  const killed = [];
  const contextActions = [];
  const delivered = [];
  m.archive = async (name) => { archived.push(name); };
  m.kill = async (name) => { killed.push(name); };
  m._sendToSession = (name, channel, payload) => contextActions.push({ name, channel, payload });
  m._deliverMessage = (name, sender, body, mtype) => delivered.push({ name, sender, body });
  return { m, PENDING_DIR, injected, archived, killed, contextActions, delivered };
}

test('team-retire: persistent role → archives, signals the window first, confirms passively', async () => {
  // 'team-dev' binds (role-keyed) to the persistent (ephemeral:false default)
  // 'dev' role via the <team>-<role> convention → archive path.
  const { m, PENDING_DIR, archived, killed, contextActions, delivered } = mkRetire({ '/proj/a': '/proj', '/proj/b': '/proj' });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-dev', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(archived, ['team-dev'], 'persistent role archives');
  assert.deepStrictEqual(killed, [], 'never killed on the archive path');
  assert.deepStrictEqual(contextActions.map((c) => [c.name, c.payload.action, c.payload.disposition]),
    [['team-dev', 'retired', 'archive']], 'window signalled archive before the kill');
  assert.deepStrictEqual(delivered, [], 'no waking DM on success');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.match(parked[0], /resumable from the sidebar/, 'archive confirmation wording');
});

test('team-retire: an ephemeral RECORD → kill (discard), drops the record, no archived row', async () => {
  // 'team-runner' matches the 'runner' role, so it IS the team's seat — but its
  // persistence record carries ephemeral:true (stamped at spawn by the ticket-seat
  // and review paths), which is the one source of that fact now. Discard path:
  // kill() (drops the record), the window is signalled disposition:discard so the
  // row vanishes like a delete.
  const { m, PENDING_DIR, archived, killed, contextActions, delivered } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner' ? { name: n, ephemeral: true } : null),
      }),
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(killed, ['team-runner'], 'a seat whose RECORD says ephemeral is killed (record dropped)');
  assert.deepStrictEqual(archived, [], 'never archived on the discard path');
  assert.deepStrictEqual(contextActions.map((c) => [c.name, c.payload.action, c.payload.disposition]),
    [['team-runner', 'retired', 'discard']], 'window signalled discard → row removed like a delete');
  assert.deepStrictEqual(delivered, [], 'no waking DM on success');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.match(parked[0], /discarded — state lives in its task artifact/, 'discard confirmation wording');
});

// Every other retire test stubs m.kill and gives its seats no worktree, so the
// discard path could orphan a checkout with all of them green — and it did.
// This one lets destroy() actually run and gives the seat a tree.
test('team-retire: a discarded seat takes its worktree with it', async () => {
  const removed = [];
  const { m, archived } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async (p) => { removed.push(p); return { ok: true }; },
        // CLEAN, explicitly: discard only proceeds on a tree with nothing to
        // lose, so this stub is what keeps the test on the discard path at all.
        isDirty: async () => ({ ok: true, dirty: false }),
      },
    },
  );
  // destroy() is the unit under test, so it must NOT be stubbed — only what it
  // reaches for. mkRetire stubbed kill(); restore a minimal one that just drops
  // the session, which is what makes _waitForExit's poll terminate.
  m.kill = async (name) => { m.sessions.delete(name); };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(removed, ['/wt/t900'],
    'a discarded seat\'s worktree must be removed: kill() drops the persistence record, which is the ONLY pointer to the checkout, so a tree not removed here is orphaned forever along with any unmerged commits on its branch');
  assert.deepStrictEqual(archived, [], 'discard path never archives');
});

// The honesty half. "State lives in its task artifact" is true only of what the
// seat COMMITTED or wrote out; the confirmation must name the tree it deleted,
// or a lead reads a reassuring line over a destructive act.
test('team-retire: the discard confirmation names the removed worktree', async () => {
  const { m, PENDING_DIR } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async () => ({ ok: true }),
        isDirty: async () => ({ ok: true, dirty: false }),
      },
    },
  );
  m.kill = async (name) => { m.sessions.delete(name); };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.strictEqual(parked.length, 1, 'ENTER: the confirmation was delivered');
  assert.match(parked[0], /worktree was removed/, 'the confirmation says the tree is gone');
  assert.match(parked[0], /committed work survives on the branch/,
    'and bounds the loss the way _taskAssign already words it, so the lead knows what it still has');
});

// The safety half, and the reason it is in scope: moving the discard decision to
// the persistence record made EVERY ticket seat ephemeral, so a routine retire
// began force-deleting trees that used to be archived. A dirty tree downgrades.
test('team-retire: a DIRTY worktree downgrades the discard to an archive', async () => {
  const removed = [];
  const { m, PENDING_DIR, archived, killed, contextActions } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async (p) => { removed.push(p); return { ok: true }; },
        isDirty: async () => ({ ok: true, dirty: true }),
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(archived, ['team-runner'],
    'an ephemeral seat holding uncommitted work is ARCHIVED, not discarded — the recoverable direction');
  assert.deepStrictEqual(killed, [], 'and never killed');
  assert.deepStrictEqual(removed, [], 'so the tree with the work in it is not touched');
  assert.deepStrictEqual(contextActions.map((c) => c.payload.disposition), ['archive'],
    'the window is told archive, so the row stays instead of vanishing like a delete');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.strictEqual(parked.length, 1, 'ENTER: the confirmation was delivered');
  assert.match(parked[0], /ARCHIVED, not discarded/, 'the lead is told the disposition changed');
  assert.match(parked[0], /\/wt\/t900/, 'and which tree caused it');
  // The exit must route through RESUME. The seat is archived, so its pty is dead
  // and it has left this.sessions — a second team-retire returns at `if (!target)`
  // and does nothing at all (pinned below), so an exit that says only "retire
  // again" instructs a silent no-op and reads as the tool ignoring the lead.
  assert.match(parked[0], /Resume it from the sidebar/,
    'the exit names the resume step, without which "retire again" is a no-op against a dead session');
  assert.match(parked[0], /retire again/, 'and then the retry');
});

// UNKNOWN is not clean. If git cannot answer, discarding would be a guess in the
// destructive direction.
test('team-retire: an UNREADABLE worktree also downgrades to an archive', async () => {
  const removed = [];
  const { m, archived, killed } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async (p) => { removed.push(p); return { ok: true }; },
        isDirty: async () => ({ ok: false, error: 'git unavailable' }),
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(archived, ['team-runner'], 'an unanswerable tree is preserved, not deleted on a guess');
  assert.deepStrictEqual(killed, [], 'and never killed');
  assert.deepStrictEqual(removed, [], 'nor its tree removed');
});

// t305 ruling 3. The dirty-check conflates "git says there are changes" with
// "git could not look", and the confirmation then asserted the first as FACT:
// "<path> has uncommitted work … commit or clear that tree". Observed live three
// times in one session, always against a tree the lead had ALREADY REMOVED after
// merging — which is the correct cleanup order, so this is the normal path.
// Telling the operator to go commit in a directory that does not exist is the
// defect; both cases still archive.
//
// The tree is really removed here rather than mocked: a stubbed `{ok:false}`
// tests the branch but not the condition that produces it in the field.
test('team-retire: a tree that is GONE says so, and never claims uncommitted work', async () => {
  const repoDir = mkTmpRoot('clodex-retire-');
  const runGit = (...a) => require('child_process').execFileSync('git', ['-C', repoDir, ...a], { stdio: 'ignore' });
  runGit('init', '-q');
  runGit('config', 'user.email', 't@example.com');
  runGit('config', 'user.name', 'Test');
  fsReal.writeFileSync(pathReal.join(repoDir, 'a.txt'), 'hi\n');
  runGit('add', '-A');
  runGit('commit', '-qm', 'init');
  const realWt = require('../git-worktree');
  const made = await realWt.createWorktree(repoDir, 't904');
  assert.strictEqual(made.ok, true, made.error);
  // The lead's correct cleanup order: merge, then remove the tree, then retire.
  await realWt.removeWorktree(made.path);
  // ENTER: the tree really is gone and the REAL isDirty really cannot answer.
  // Without this the test could be asserting the new wording against a readable
  // tree that simply happens to be clean.
  assert.ok(!fsReal.existsSync(made.path), 'ENTER: the worktree directory is actually gone');
  const probe = await realWt.isDirty(made.path);
  assert.strictEqual(probe.ok, false, 'ENTER: the real isDirty returns ok:false for it — the observed condition');

  const removed = [];
  const { m, PENDING_DIR, archived, killed } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: made.path, branch: 't904' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async (p) => { removed.push(p); return { ok: true }; },
        isDirty: realWt.isDirty,     // the real probe against the real absent tree
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 100));

  assert.deepStrictEqual(archived, ['team-runner'], 'behaviour is unchanged: still the conservative archive');
  assert.deepStrictEqual(killed, [], 'and never killed');
  assert.deepStrictEqual(removed, [], 'nothing removed');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.strictEqual(parked.length, 1, 'ENTER: the confirmation was delivered');
  assert.doesNotMatch(parked[0], /has uncommitted work/,
    'the sentence that lied: this tree does not exist, so it cannot have uncommitted work');
  assert.doesNotMatch(parked[0], /commit or clear that tree/,
    'and it must not send the operator to commit inside a directory that is gone');
  assert.match(parked[0], /could not be inspected/, 'it names what actually happened');
  assert.match(parked[0], new RegExp(made.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and which path');

  fsReal.rmSync(repoDir, { recursive: true, force: true });
});

// The dirty case must keep saying "commit", or fixing the lie above would have
// removed the one instruction that IS correct when the tree is really dirty.
test('team-retire: a genuinely DIRTY tree still tells the operator to commit it', async () => {
  const { m, PENDING_DIR } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t905', branch: 't905' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async () => ({ ok: true }),
        isDirty: async () => ({ ok: true, dirty: true }),
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.strictEqual(parked.length, 1, 'ENTER: the confirmation was delivered');
  assert.match(parked[0], /has uncommitted work/, 'a real dirty tree is still reported as such');
  assert.match(parked[0], /commit or clear that tree/, 'with the instruction that is correct for it');
  assert.doesNotMatch(parked[0], /could not be inspected/, 'and not the could-not-check wording');
});

// A removal failure must name the tree the operator has to clean up by hand.
// removeWorktree's error strings carry no path, so interpolating only the error
// produced "remove it by hand" with no "it" — and the record that held the path
// is already gone by then, because kill() drops it.
test('team-retire: a failed worktree removal names the path to remove by hand', async () => {
  const { m, PENDING_DIR } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async () => ({ ok: false, error: 'Refusing to remove the main working tree' }),
        isDirty: async () => ({ ok: true, dirty: false }),
      },
    },
  );
  m.kill = async (name) => { m.sessions.delete(name); };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.strictEqual(parked.length, 1, 'ENTER: the confirmation was delivered');
  assert.match(parked[0], /could NOT be removed/, 'ENTER: the failure branch is the one under test');
  assert.match(parked[0], /remove \/wt\/t900 by hand/,
    'the confirmation names the tree; the error string alone carries no path, and the record holding it is dropped by kill()');
});

// A throw in the sync prelude must reach the REQUESTER. A main-process warn the
// lead cannot see leaves it waiting on a confirmation that never comes.
test('team-retire: a handler throw DMs the requester, not just the log', async () => {
  const { m, delivered } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner'
          ? { name: n, ephemeral: true, worktree: { path: '/wt/t900', branch: 't900' } } : null),
      }),
      gitWorktree: {
        removeWorktree: async () => ({ ok: true }),
        isDirty: async () => { throw new Error('git exploded'); },
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  // The probe's own .catch handles a rejected promise, so force the throw where
  // nothing local catches it: the sync prelude.
  m._sendToSession = () => { throw new Error('window gone'); };
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(delivered.length, 1, 'ENTER: the requester was told something');
  assert.match(delivered[0].body, /retire team-runner failed: window gone/,
    'a throw reaches the lead as a DM — silence here is a lead waiting forever on a retire that never happened');
});

// A seat with NO worktree keeps discarding: the probe is about the tree, not a
// blanket softening of retire. Without this the fix above could be "never
// discard" and stay green.
test('team-retire: a treeless ephemeral seat still discards', async () => {
  const { m, archived, killed, contextActions } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: {} } },
    {
      getPersistence: () => ({
        list: () => [],
        get: (n) => (n === 'team-runner' ? { name: n, ephemeral: true } : null),
      }),
      gitWorktree: {
        removeWorktree: async () => ({ ok: true }),
        // Would report dirty if it were ever consulted — it must not be, because
        // there is no tree to consult about.
        isDirty: async () => ({ ok: true, dirty: true }),
      },
    },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(killed, ['team-runner'], 'ENTER: the discard path ran');
  assert.deepStrictEqual(archived, [], 'no tree, nothing to protect, still a discard');
  assert.deepStrictEqual(contextActions.map((c) => c.payload.disposition), ['discard']);
});

// The companion absence: the archive path must KEEP the tree. Without this, the
// fix above could be "remove the worktree on every retire" and stay green while
// deleting the checkout a resumable seat resumes into.
test('team-retire: an ARCHIVED seat keeps its worktree', async () => {
  const removed = [];
  const { m, archived } = mkRetire({ '/proj/a': '/proj', '/proj/b': '/proj' }, undefined, {
    getPersistence: () => ({
      list: () => [],
      get: () => ({ name: 'team-dev', worktree: { path: '/wt/keep', branch: 'keep' } }),
    }),
    gitWorktree: { removeWorktree: async (p) => { removed.push(p); return { ok: true }; } },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-dev', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(archived, ['team-dev'], 'ENTER: the archive path ran');
  assert.deepStrictEqual(removed, [],
    'an archived seat is resumable and its checkout is what it resumes into — removing the tree here deletes the work the archive exists to preserve');
});

test('team-retire: an OFF-manifest seat (matches no role) → kill (discard)', async () => {
  // 'stray' shares the project cwd but matches no manifest role → discard.
  const { m, PENDING_DIR, archived, killed, contextActions } = mkRetire(
    { '/proj/a': '/proj', '/proj/s': '/proj' },
    { '/proj': { lead: {}, dev: {} } },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('stray', { name: 'stray', agentType: 'claude', cwd: '/proj/s' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('stray', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(killed, ['stray'], 'off-manifest seat is killed (record dropped)');
  assert.deepStrictEqual(archived, [], 'never archived');
  assert.strictEqual(contextActions[0].payload.disposition, 'discard');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.match(parked[0], /discarded/, 'discard confirmation wording');
});

test('team-retire: refusals wake the requester and never archive', async () => {
  // different projects
  {
    const { m, archived, delivered } = mkRetire({ '/p1/x': '/p1', '/p2/y': '/p2' });
    m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/p1/x' });
    m.sessions.set('dev', { name: 'dev', agentType: 'claude', cwd: '/p2/y' });
    m._onIncoming('dev', { from: 'lead', body: '', type: 'team-retire' });
    assert.deepStrictEqual(archived, []);
    assert.match(delivered[0].body, /not in the same project/);
  }
  // requester not running
  {
    const { m, archived, delivered } = mkRetire({ '/p/x': '/p' });
    m.sessions.set('dev', { name: 'dev', agentType: 'claude', cwd: '/p/x' });
    m._onIncoming('dev', { from: 'ghost', body: '', type: 'team-retire' });
    assert.deepStrictEqual(archived, []);
    assert.match(delivered[0].body, /not a running session/);
  }
  // self-retire
  {
    const { m, archived, delivered } = mkRetire({ '/p/x': '/p' });
    m.sessions.set('dev', { name: 'dev', agentType: 'claude', cwd: '/p/x' });
    m._onIncoming('dev', { from: 'dev', body: '', type: 'team-retire' });
    assert.deepStrictEqual(archived, []);
    assert.match(delivered[0].body, /self-retire/);
  }
  // no project root at all (bare sessions, no team.json anywhere)
  {
    const { m, archived, delivered } = mkRetire({});
    m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/a' });
    m.sessions.set('dev', { name: 'dev', agentType: 'claude', cwd: '/b' });
    m._onIncoming('dev', { from: 'lead', body: '', type: 'team-retire' });
    assert.deepStrictEqual(archived, []);
    assert.match(delivered[0].body, /not in the same project/);
  }
});

test('team-retire: absent target is a silent no-op (socket outlived the session)', () => {
  const { m, archived, delivered } = mkRetire({ '/p/x': '/p' });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/p/x' });
  m._onIncoming('gone', { from: 'lead', body: '', type: 'team-retire' });
  assert.deepStrictEqual(archived, []);
  assert.deepStrictEqual(delivered, []);
});

// --- teams composition wiring: initial roster + passive deltas ---------------
// The context architecture (teams-design.md [internal design doc, not in this repo]): a seat's composition rides as
// DATA, never the system prompt. _injectRoster delivers the one-time initial
// roster (sender `team`); _notifyComposition fans a passive delta to the OTHER
// live seats on spawn / archive / retire. Both funnel every seat-lifecycle
// event, so testing them directly covers the spawn/archive/retire chokepoints.

const teamStub = { name: 'team', root: '/proj', lead: 'lead',
  roles: { lead: { instantiate: 'session', brief: 'the lead' }, dev: { instantiate: 'session', brief: 'the dev' } } };
const teamDeps = {
  resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? teamStub : null),
  findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj'
    : (cwd && cwd.startsWith('/other') ? '/other' : null)),
};

// The project/agentType filters, pinned on a delta that DOES deliver. `outsider`
// and `shell` are the rows that must not survive the loop; the lead is here as
// the one legitimate recipient, so a regression that dropped every delivery is
// distinguishable from one that merely narrowed correctly.
test('_notifyComposition: passive delta skips other projects and bash seats, and lands on the lead', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('outsider', { name: 'outsider', agentType: 'claude', cwd: '/other/x' }); // other team
  m.sessions.set('shell', { name: 'shell', agentType: null, cwd: '/proj/c' });            // bash — excluded
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'retired');
  assert.strictEqual(passive.length, 1, 'exactly one delivery — the lead');
  assert.strictEqual(passive[0].t, 'lead');
  assert.strictEqual(passive[0].s, 'team', 'sender is the team channel');
  assert.match(passive[0].b, /\[team team\] seat team-dev retired \(role: dev\)/);
});

// Boot-race coalesce (task 20 + task-22 rework): _notifyComposition shares the
// codex active-fallback that task 11 fixed for the initial roster. A target codex
// seat still inside its boot-settle window (_bootSettling) would get the delta
// ACTIVE-typed into its unsubmitted TUI. We coalesce — DROP it — keying on the
// boot-settle FLAG (armed for every codex seat at create), NOT on a stashed
// roster: a resumed/stamped seat has no roster to stash yet still boots (MUST-FIX
// 1). No second timer.
// The boot-settle guard protects the RECIPIENT, and since the 2026-08-12 ruling
// the only recipient is the lead — so a lead-as-codex-seat is the fixture that
// still exercises it. Notifying ABOUT the lead is the case that now reaches
// nobody (self-skip, no other eligible recipient), which is why the subject here
// is a teammate.
test('_notifyComposition: a still-booting codex LEAD coalesces — delta dropped, not typed', () => {
  const { m } = mkPark(teamDeps);
  // the lead is the codex seat mid-boot: boot window open (a fresh mint also stashed its roster).
  m.sessions.set('lead', { name: 'lead', agentType: 'codex', cwd: '/proj/a',
    _bootSettling: true, _pendingRoster: teamStub });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' }); // subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.deepStrictEqual(passive, [], 'no delta delivered to a lead still in its boot-settle window');
});

// MUST-FIX 1 (task 22 reopened task 20's window for RESUMED seats): a resumed
// codex seat skips its roster (stamped → no _pendingRoster) yet still boots and
// would ACTIVE-type a delta into its booting TUI. The boot-settle flag guards it
// regardless of roster. Contract: DROP (the seat's resumed context + on-demand
// roster pull is ground truth; a missed one-line delta is harmless).
test('_notifyComposition: a RESUMED-stamped codex LEAD mid-boot (no stashed roster) still coalesces', () => {
  const { m } = mkPark(teamDeps);
  // resumed lead: booting, but its roster was skipped (stamped) → NO _pendingRoster.
  m.sessions.set('lead', { name: 'lead', agentType: 'codex', cwd: '/proj/a', _bootSettling: true });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' }); // subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.deepStrictEqual(passive, [], 'delta dropped while the resumed lead is still booting (nothing typed)');
  // Once its boot settles (_bootSettling cleared), a later delta lands normally.
  m.sessions.get('lead')._bootSettling = false;
  m._notifyComposition(m.sessions.get('team-dev'), 'archived');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'], 'after settle the delta delivers on the normal path');
});

test('_notifyComposition: over a mixed set the lead gets exactly one delta, never twice', () => {
  // A single fan over a mixed set. Before the lead-only ruling this pinned that
  // the boot-skip was selective across two RECIPIENTS; with one eligible
  // recipient the surviving property is arity — exactly one delivery per fan,
  // and a booted bystander adds none. cx-live is here precisely because it WOULD
  // have received under the old fan, so a revert shows up as a second row.
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'codex', cwd: '/proj/a', _bootSettling: true, _pendingRoster: teamStub });
  m.sessions.set('cx-live', { name: 'cx-live', agentType: 'codex', cwd: '/proj/c' });          // booted bystander
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });       // subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.deepStrictEqual(passive, [],
    'the booting lead coalesces, and the booted bystander is not a recipient at all');
  // Once the lead settles (_bootSettling cleared), a later delta lands — once.
  m.sessions.get('lead')._bootSettling = false;
  m._notifyComposition(m.sessions.get('team-dev'), 'archived');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'],
    'after boot the once-coalesced lead takes the delta promptly, still exactly one delivery');
});

test('_notifyComposition: a LIVE codex LEAD (no stashed roster) is delivered promptly', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'codex', cwd: '/proj/a' }); // booted: no _pendingRoster
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' }); // subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.strictEqual(passive.length, 1, 'a booted codex lead gets the delta on the normal (passive) path');
  assert.strictEqual(passive[0].t, 'lead');
  assert.match(passive[0].b, /\[team team\] seat team-dev spawned \(role: dev\)/);
});

test('_notifyComposition: a Claude LEAD still parks passively even mid-boot (boot-safe regardless)', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' }); // claude: never stashes a roster
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' }); // subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.strictEqual(passive.length, 1, 'claude lead parks passively (no active PTY write to race)');
  assert.strictEqual(passive[0].t, 'lead');
});

// --- T34: an EPHEMERAL subject seat's delta fans to the LEAD only ------------
// A reviewer spawning/archiving is lead↔seat business; other seats (a hand)
// shouldn't burn wakeups on it. The subject is ephemeral when its role DEF says so
// OR its persistence record does — and for a real reviewer only the persistence
// record holds (the reviewer role def carries no ephemeral:true; _handleTeamReview
// seeds ephemeral:true onto the seat's record at spawn). Persistent seats keep the
// full fan. A team with a reviewer role (no ephemeral flag on the def, mirroring
// team.json) so the persistence-marker path is what's exercised.
const teamStubReviewer = { name: 'team', root: '/proj', lead: 'lead',
  roles: {
    lead: { instantiate: 'session', brief: 'the lead' },
    dev: { instantiate: 'session', brief: 'the dev' },
    reviewer: { instantiate: 'subagent', brief: 'the reviewer', ephemeral: false }, // NOT ephemeral on the def (mirrors team.json)
  } };
const teamReviewerDeps = {
  resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? teamStubReviewer : null),
  findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj'
    : (cwd && cwd.startsWith('/other') ? '/other' : null)),
};

test('_notifyComposition (T34): an ephemeral reviewer seat delta reaches ONLY the lead, not a bystander hand', () => {
  // The persistence record carries ephemeral:true (the reviewer marker that
  // actually holds — the role def does NOT). Delta must skip the hand bystander.
  const { m } = mkPark({
    ...teamReviewerDeps,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'team-reviewer-1' ? { name: n, ephemeral: true, reviewFor: 'lead' } : null) }),
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-hand', { name: 'team-hand', agentType: 'claude', cwd: '/proj/b' });        // bystander
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj/c' }); // the subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-reviewer-1'), 'archived');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'],
    'ephemeral subject delta fans to the lead only — the hand is spared the noise');
  assert.match(passive[0].b, /\[team team\] seat team-reviewer-1 archived \(role: reviewer\)/);
});

// Operator ruling (2026-08-12): a composition delta is LEAD-ONLY, whatever the
// subject was. T34 restricted the fan for ephemeral subjects only, which keyed
// on the wrong end of the delivery — a hand cannot act on the news that a dev
// restarted any more than on the news that a reviewer did, so both are pure
// interruption. Relevance is a property of the RECIPIENT, not of the subject.
test('_notifyComposition: a PERSISTENT seat delta is lead-only too — bystanders are never woken', () => {
  const { m } = mkPark({
    ...teamReviewerDeps,
    getPersistence: () => ({ list: () => [], get: () => null }), // no ephemeral record for anyone
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-hand', { name: 'team-hand', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/c' }); // the persistent subject
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'],
    'a persistent subject fans to the lead alone — the hand bystander is spared');
});

// The re-bake is the half that must NOT narrow with the DM, and it is invisible
// from the delivery assertions above: it carries the changed composition into
// every seat's NEXT boot. Folding it into the lead-only branch would leave every
// other seat booting a stale roster, and nothing reads that back to catch it.
test('_notifyComposition: the digest re-bake still runs for EVERY seat, not just the lead', () => {
  const { m } = mkPark({
    ...teamReviewerDeps,
    getPersistence: () => ({ list: () => [], get: () => null }),
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-hand', { name: 'team-hand', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/c' }); // the subject
  const passive = [];
  const rebaked = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._rebakeDigest = (n) => rebaked.push(n);
  m._notifyComposition(m.sessions.get('team-dev'), 'spawned');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'], 'DM narrowed to the lead');
  assert.deepStrictEqual(rebaked.sort(), ['lead', 'team-hand'],
    'both surviving seats re-bake — the subject self-skips, the bystander does NOT');
});

test('_notifyComposition (T34): an ephemeral subject is still self-skipped even when it IS the lead-eligible loop', () => {
  // Belt-and-braces: the subject seat never notifies itself, and the ephemeral
  // lead-only restriction composes with the existing self-skip. Here the ONLY
  // other same-project seat is the lead, so exactly one delivery, never to self.
  const { m } = mkPark({
    ...teamReviewerDeps,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'team-reviewer-1' ? { name: n, ephemeral: true } : null) }),
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj/c' });
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-reviewer-1'), 'spawned');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'], 'delivered to the lead, never to the subject itself');
});

// t292 cut `ephemeral` from role defs: it was a SECOND source for a fact the
// persistence record already carried, and two stores for one word is how they
// came to disagree. The fan is now lead-only unconditionally, so a stale marker
// on a v1 def cannot change WHO is notified — this pins that the def is inert
// here, which is what stops a future reader from reviving it as a delivery input.
test('_notifyComposition: a stale role-def `ephemeral` changes nothing — the fan is lead-only regardless', () => {
  const teamStubEphRole = { name: 'team', root: '/proj', lead: 'lead',
    roles: {
      lead: { brief: 'the lead' },
      runner: { brief: 'the runner', ephemeral: true }, // stale marker on the def
    } };
  const { m } = mkPark({
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? teamStubEphRole : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    getPersistence: () => ({ list: () => [], get: () => null }), // no record → NOT ephemeral
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-hand', { name: 'team-hand', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('team-runner-1', { name: 'team-runner-1', agentType: 'claude', cwd: '/proj/c' });
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-runner-1'), 'retired');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'],
    'lead-only, whatever the def still says — the stale marker is inert for delivery');
});

// Task 22: the one-time team wiring (initial roster + the seat's own 'spawned'
// delta) fires ONLY on a genuine first spawn, gated by a persisted rosterSentAt
// stamp read PRE-upsert (existingEntry). A resume/restart already carries the
// roster in its restored context; reinjecting is noise and N seats each re-
// announcing at app relaunch is N×N delta spam for an unchanged team. The stamp
// is written at DELIVERY so a crash-before-delivery seat retries (self-heal).
test('_maybeInjectComposition: FRESH mint (no rosterSentAt) → injects roster + fires spawned delta', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'lead', agentType: 'claude', cwd: '/proj/a' };
  m.sessions.set('lead', s);
  const injected = [];
  const deltas = [];
  m._injectRoster = (sess, team) => injected.push({ sess, team });
  m._notifyComposition = (sess, verb) => deltas.push({ sess, verb });
  m._maybeInjectComposition(s, teamStub, null);   // no persisted entry at all
  assert.strictEqual(injected.length, 1, 'roster injected on a genuine first spawn');
  assert.strictEqual(injected[0].team, teamStub);
  assert.deepStrictEqual(deltas, [{ sess: s, verb: 'spawned' }], 'and the seat is announced to teammates');
});

test('_maybeInjectComposition: RESUME (record carries rosterSentAt) → NO roster, NO spawned delta', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'lead', agentType: 'claude', cwd: '/proj/a' };
  m.sessions.set('lead', s);
  const injected = [];
  const deltas = [];
  m._injectRoster = (...a) => injected.push(a);
  m._notifyComposition = (...a) => deltas.push(a);
  m._maybeInjectComposition(s, teamStub, { name: 'lead', rosterSentAt: 123 });
  assert.deepStrictEqual(injected, [], 'a restore never re-injects the roster');
  assert.deepStrictEqual(deltas, [], 'a restore never re-announces the seat to teammates');
});

test('_maybeInjectComposition: crashed-before-delivery (entry, NO stamp) → retries next spawn', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'cx', agentType: 'codex', cwd: '/proj/b' };
  m.sessions.set('cx', s);
  const injected = [];
  m._injectRoster = (...a) => injected.push(a);
  m._notifyComposition = () => {};
  // Persisted record exists (prior spawn) but roster never landed → no stamp.
  m._maybeInjectComposition(s, teamStub, { name: 'cx' });
  assert.strictEqual(injected.length, 1, 'a seat that never received its roster retries');
});

test('_injectRoster: a claude delivery STAMPS rosterSent (so a later restart skips re-inject)', () => {
  const stamped = [];
  const { m } = mkPark({ ...teamDeps,
    getPersistence: () => ({ list: () => [], get: () => null, setRosterSent: (n) => stamped.push(n) }) });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m._deliverPassive = () => {};
  m._injectRoster(m.sessions.get('lead'), teamStub);
  assert.deepStrictEqual(stamped, ['lead'], 'the claude roster park stamps rosterSent at delivery');
});

test('_injectRoster/_settleBoot: a codex seat stamps only at the settle (delivery), not the stash', () => {
  const stamped = [];
  const { m } = mkPark({ ...teamDeps,
    getPersistence: () => ({ list: () => [], get: () => null, setRosterSent: (n) => stamped.push(n) }) });
  const s = { name: 'cx', agentType: 'codex', cwd: '/proj/b' };
  m.sessions.set('cx', s);
  m._injectRoster(s, teamStub);   // stashes the team ref — must NOT stamp yet
  assert.deepStrictEqual(stamped, [], 'the stash does not stamp — a seat dying pre-settle retries');
  // The stamp now rides _deliverMessage's onWrite (6th arg), fired when the text is
  // DURABLE — so the stub must invoke it or it is modelling a delivery that never
  // wrote. That is the next test, which pins the other half.
  m._deliverMessage = (_n, _s, _b, _t, _tag, onWrite) => { if (onWrite) onWrite(); };
  m._settleBoot(s);               // actual delivery at boot-settle
  assert.deepStrictEqual(stamped, ['cx'], 'the settle stamps rosterSent');
});

test('_settleBoot: a delivery that never reaches the write does NOT stamp rosterSent', () => {
  // The t168 property, and the reason the stamp moved off the enqueue: enqueue
  // returns while the bytes are still in the queue's ready loop, INSIDE the boot
  // window this runs in. A stamp taken from the return suppresses the roster for
  // the seat's whole life (_maybeInjectComposition reads rosterSentAt) on the
  // strength of a write the boot re-render may have wiped. Modelled by a delivery
  // that never fires onWrite; the seat must stay un-stamped so it retries.
  const stamped = [];
  const { m } = mkPark({ ...teamDeps,
    getPersistence: () => ({ list: () => [], get: () => null, setRosterSent: (n) => stamped.push(n) }) });
  const s = { name: 'cx', agentType: 'codex', cwd: '/proj/b' };
  m.sessions.set('cx', s);
  m._injectRoster(s, teamStub);
  m._deliverMessage = () => {};   // enqueued, never written
  m._settleBoot(s);
  assert.deepStrictEqual(stamped, [], 'no write → no stamp → the roster is retried, not suppressed forever');
});

test('_notifyComposition: teamless / dep-less session is a no-op, never throws into teardown', () => {
  const { m } = mkPark(); // no resolveTeam dep at all (archive/kill call this)
  m.sessions.set('a', { name: 'a', agentType: 'claude', cwd: '/x' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', cwd: '/x' });
  const passive = [];
  m._deliverPassive = (...args) => passive.push(args);
  assert.doesNotThrow(() => m._notifyComposition(m.sessions.get('a'), 'spawned'));
  assert.deepStrictEqual(passive, [], 'no team dep → no deltas, no throw');
});

test('_injectRoster: rides PASSIVELY (parked for organic drain, no active PTY typing at boot)', () => {
  const { m } = mkPark({ ...teamDeps, peerStatusLabel: () => 'idle 12m, warm' });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  const passive = [];
  const active = [];
  m._deliverPassive = (t, s, b, mt) => passive.push({ t, s, b, mt });
  m._deliverMessage = (t, s, b, mt) => active.push({ t, s, b, mt });
  m._injectRoster(m.sessions.get('lead'), teamStub);
  // The initial roster must NOT be actively typed — the trailing Enter got eaten
  // by the still-booting TUI (field bug). It rides the seat's first hook drain.
  assert.deepStrictEqual(active, [], 'roster is never delivered on the active path');
  assert.strictEqual(passive.length, 1);
  assert.strictEqual(passive[0].t, 'lead');
  assert.strictEqual(passive[0].s, 'team');
  assert.strictEqual(passive[0].mt, 'dm');
  assert.match(passive[0].b, /\[team team\] roster \(lead: lead\)/);
  // Anchored past the name: an unanchored `live: lead` matches `live: lead (you)`
  // equally, so it pins neither the seat arg nor the label seam.
  assert.match(passive[0].b, /- lead \(session\) — the lead · live: lead \(you\)/,
    'the reading seat is marked — proves the call site passes { seat: session.name }');
  assert.match(passive[0].b, /- dev \(session\) — the dev · live: team-dev \(idle 12m, warm\)/,
    'a live seat carries the label _teamLiveSeats computed via peerStatusLabel');
  assert.match(passive[0].b, /"agent":"lead"/,
    'the exec line names the reading seat — without the seat arg it reverts to the always-bouncing placeholder');
});

// Codex has no passive park store, so _deliverPassive there falls back to an
// ACTIVE PTY write — which at spawn types the roster into the still-booting TUI
// and the Enter gets eaten (the field bug, scoped to codex). A codex seat DEFERS:
// the roster is stashed and flushed on the seat's first observed output settle.
test('_injectRoster: a CODEX seat DEFERS — no active AND no passive delivery at spawn, roster stashed', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('team-cx', { name: 'team-cx', agentType: 'codex', cwd: '/proj/b' });
  const passive = [];
  const active = [];
  m._deliverPassive = (t, s, b, mt) => passive.push({ t, s, b, mt });
  m._deliverMessage = (t, s, b, mt) => active.push({ t, s, b, mt });
  m._injectRoster(m.sessions.get('team-cx'), teamStub);
  // Nothing hits EITHER delivery path before the seat's first observed activity —
  // a passive fallback here would be an active PTY write into a booting TUI.
  assert.deepStrictEqual(active, [], 'codex roster is never actively typed at boot');
  assert.deepStrictEqual(passive, [], 'and never passive (no park store) — it is stashed');
  // The stash holds the TEAM REF, not a pre-rendered body: the roster is recomputed
  // FRESH at flush so a teammate spawning during boot still appears (task 20b).
  assert.strictEqual(m.sessions.get('team-cx')._pendingRoster, teamStub, 'team ref stashed for a fresh-at-flush render');
});

test('_settleBoot: recomputes the roster FRESH at delivery — a boot-time-spawned seat is listed', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'team-cx', agentType: 'codex', cwd: '/proj/b', _bootSettling: true, _pendingRoster: teamStub };
  m.sessions.set('team-cx', s);
  // A teammate that spawned AFTER team-cx's roster was stashed (i.e. during its
  // boot). A spawn-time snapshot would omit it; the fresh render must include it.
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'codex', cwd: '/proj/c' });
  const active = [];
  m._deliverMessage = (t, sn, b, mt) => active.push({ t, sn, b, mt });
  m._settleBoot(s);
  assert.strictEqual(active.length, 1, 'delivered via the active (normal) path once the TUI is up');
  assert.strictEqual(active[0].t, 'team-cx');
  assert.strictEqual(active[0].sn, 'team');
  assert.strictEqual(active[0].mt, 'dm');
  assert.match(active[0].b, /\[team team\] roster \(lead: lead\)/);
  assert.match(active[0].b, /- dev \(session\) — the dev · live: team-dev/,
    'the teammate that spawned during boot appears in the fresh-at-delivery roster');
  assert.match(active[0].b, /"agent":"team-cx"/,
    'this call site passes the seat too — a roster reaching a seat under a placeholder name is the bug the concrete exec line exists to close');
  assert.strictEqual(s._pendingRoster, null, 'pending cleared');
  assert.strictEqual(s._bootSettling, false, 'boot window closed');
  m._settleBoot(s);                         // a late/second settle
  assert.strictEqual(active.length, 1, 'once-only');
  const dead = { name: 'd', agentType: 'codex', _dead: true, _bootSettling: true, _pendingRoster: teamStub };
  m._settleBoot(dead);
  assert.strictEqual(active.length, 1, 'no delivery into a dead session');
  assert.strictEqual(dead._bootSettling, false, 'a dead seat still has its window closed (state clean)');
});

// composeRosterFor is the DIGEST path (t111): it renders the roster baked into
// every context reset, for a seat that may not be in the map yet. It is the
// third formatRoster call site and the longest-lived one — a placeholder name
// here is served to a seat on every compact, forever.
test('composeRosterFor: renders for the NAMED seat, live or persistence-only', () => {
  const { m } = mkPark({
    ...teamDeps,
    peerStatusLabel: () => 'idle 12m, warm',
    getPersistence: () => ({ get: (n) => (n === 'team-gone' ? { cwd: '/proj/z' } : null) }),
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });

  const forLead = m.composeRosterFor('lead');
  assert.match(forLead, /"agent":"lead"/, 'the exec line names the seat the digest is for');
  assert.match(forLead, /live: lead \(you\)/, 'the reading seat is marked in its own digest');
  assert.match(forLead, /live: team-dev \(idle 12m, warm\)/, 'teammates carry their warmth label');
  assert.match(forLead, /Dispatch: TWO steps\. \[agent:task add <role>\]/, 'the lead seat gets the action line');

  // Not in the map: the cwd comes from persistence, and the seat name must
  // still reach formatRoster.
  const forGone = m.composeRosterFor('team-gone');
  assert.match(forGone, /"agent":"team-gone"/, 'a persistence-only seat is still named in its own digest');
  assert.ok(!/Dispatch:/.test(forGone), 'a non-lead seat gets no action line');
  assert.strictEqual(m.composeRosterFor('nowhere'), null, 'no cwd anywhere → no roster');
});

// MUST-FIX 1: a RESUMED codex seat has no stashed roster — _settleBoot just closes
// the boot window (re-opening the seat to deltas), delivering nothing.
test('_settleBoot: a resumed seat (no stashed roster) closes the window, delivers nothing', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'cx-resumed', agentType: 'codex', cwd: '/proj/b', _bootSettling: true };
  m.sessions.set('cx-resumed', s);
  const active = [];
  m._deliverMessage = (...a) => active.push(a);
  m._settleBoot(s);
  assert.strictEqual(s._bootSettling, false, 'boot window closed so later deltas deliver');
  assert.deepStrictEqual(active, [], 'no roster to deliver for a resumed seat');
});

// NIT (task 22 rework): _settleBoot runs from a setTimeout callback, so a throw
// in the render/deliver path would be an uncaughtException in main. It must be
// swallowed — and the boot window still closed (state stays clean).
test('_settleBoot: a throw in the render/deliver path is swallowed, window still closes', () => {
  const { m } = mkPark(teamDeps);
  const s = { name: 'team-cx', agentType: 'codex', cwd: '/proj/b', _bootSettling: true, _pendingRoster: teamStub };
  m.sessions.set('team-cx', s);
  m._deliverMessage = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => m._settleBoot(s), 'never throws out of the settle callback');
  assert.strictEqual(s._bootSettling, false, 'boot window still closed despite the throw');
});

test('_armBootSettle: output-gated settle re-arms on each chunk, closes only after the LAST one', async () => {
  const { m } = mkPark({ ...teamDeps, rosterSettleMs: 30, rosterMaxWaitMs: 10000 });
  const s = { name: 'team-cx', agentType: 'codex', cwd: '/proj/b',
    _bootSettling: true, _bootSettleSince: Date.now(), _pendingRoster: teamStub };
  m.sessions.set('team-cx', s);
  const active = [];
  m._deliverMessage = (t, sn, b, mt) => active.push({ t, sn, b, mt });
  m._armBootSettle(s);                      // first output chunk (deadline ~30ms)
  await new Promise((r) => setTimeout(r, 10));
  m._armBootSettle(s);                      // a later chunk before the settle → re-arm (deadline pushed out)
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(active, [], 'not yet — the boot burst has not gone quiet');
  await new Promise((r) => setTimeout(r, 45));
  assert.strictEqual(active.length, 1, 'delivered once the output settled');
  assert.strictEqual(active[0].t, 'team-cx');
});

test('_armBootSettle: absolute-wait cap closes despite continuous sub-settle repaints (no starvation)', async () => {
  // settle 30ms, cap 60ms — a chunk every 10ms never lets the settle timer fire,
  // so ONLY the cap can close it. Without the cap this would starve the roster
  // forever (a codex spinner/clock repaint loop is exactly this shape).
  const { m } = mkPark({ ...teamDeps, rosterSettleMs: 30, rosterMaxWaitMs: 60 });
  const s = { name: 'team-cx', agentType: 'codex', cwd: '/proj/b',
    _bootSettling: true, _bootSettleSince: Date.now(), _pendingRoster: teamStub };
  m.sessions.set('team-cx', s);
  const active = [];
  m._deliverMessage = (t, sn, b, mt) => active.push({ t, sn, b, mt });
  // Repaint faster than the settle interval, past the cap.
  for (let i = 0; i < 9; i++) { m._armBootSettle(s); await new Promise((r) => setTimeout(r, 10)); }
  assert.strictEqual(active.length, 1, 'the cap forced a close even though the settle never went quiet');
  assert.strictEqual(s._pendingRoster, null, 'pending cleared by the capped settle');
  assert.strictEqual(s._bootSettling, false, 'boot window closed by the cap');
});

// MUST-FIX 2 (task 22, generalized in task 24): an in-place restart routes through
// kill() (drops the persistence record), so create()'s existingEntry would be null
// and re-inject the roster / lose a reviewer seat's identity. _preserveAcrossRestart
// (called by engine.restartSession / applySessionArgs after kill, before create)
// re-seeds JUST the requested fields present on the prior entry so create's read sees them.
test('_preserveAcrossRestart: re-seeds requested fields across the kill+create restart seam', () => {
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
  };
  const { m } = mkPark({ ...teamDeps, getPersistence: () => persistence });
  // kill() has already dropped the record; the store is empty for this name.
  // A reviewer seat carries the roster stamp AND its ephemeral/reviewFor identity,
  // plus createdAt (t71) — birth time is true of the SESSION, so it carries too.
  // This test previously passed createdAt:1 WITHOUT requesting it and without
  // asserting it survived, which encoded the bug: the field was dropped on every
  // kill-based restart and the test read as though that were intended.
  m._preserveAcrossRestart('cx', { name: 'cx', rosterSentAt: 999, ephemeral: true, reviewFor: 'lead', createdAt: 1 },
    ['rosterSentAt', 'ephemeral', 'reviewFor', 'createdAt']);
  assert.strictEqual(persistence.get('cx').rosterSentAt, 999, 'the stamp is re-seeded so create() skips re-inject');
  assert.strictEqual(persistence.get('cx').ephemeral, true, 'ephemeral identity re-seeded');
  assert.strictEqual(persistence.get('cx').reviewFor, 'lead', 'reviewFor identity re-seeded');
  assert.strictEqual(persistence.get('cx').createdAt, 1, 'birth stamp re-seeded so create() does not re-mint it');
  // create()'s own upsert then spread-merges the full record over the stub, keeping
  // the fields. This upsert is a HAND-WRITTEN model of create()'s rebuild, which is
  // why it can only carry fields create() does NOT itself write: rosterSentAt and
  // reviewFor survive here because the rebuild never mentions them, and that is a
  // real claim about the spread-merge. createdAt is deliberately NOT asserted past
  // this line — create() DOES write it, so any value written here would be one I
  // chose rather than one the product computed, and the assertion would pass with
  // create()'s stamping line deleted. Proven, not assumed: reverting
  // `(existingEntry && existingEntry.createdAt) ||` left this file entirely green.
  // The survives-create() half is pinned against the REAL create() in
  // test/createdat-restart.test.js instead.
  persistence.upsert({ name: 'cx', type: 'codex', cwd: '/proj/b', createdAt: 1 });
  assert.strictEqual(persistence.get('cx').rosterSentAt, 999, 'survives create()\'s rebuild upsert');
  assert.strictEqual(persistence.get('cx').reviewFor, 'lead', 'reviewFor survives create()\'s rebuild upsert');
  // Only the REQUESTED fields carry: a prior entry lacking a requested field seeds nothing for it.
  m._preserveAcrossRestart('fresh', { name: 'fresh' }, ['rosterSentAt', 'ephemeral', 'reviewFor']);
  assert.strictEqual(persistence.get('fresh'), null, 'a fresh seat with none of the fields is not seeded');
  // A FRESH restart drops rosterSentAt from the field list (new conversation) but
  // still carries the seat's identity — request only ephemeral/reviewFor.
  m._preserveAcrossRestart('rv', { name: 'rv', rosterSentAt: 5, ephemeral: true, reviewFor: 'lead' },
    ['ephemeral', 'reviewFor']);
  assert.strictEqual(persistence.get('rv').rosterSentAt, undefined, 'rosterSentAt NOT carried on a fresh restart');
  assert.strictEqual(persistence.get('rv').ephemeral, true, 'identity still carried on a fresh restart');
});

// --- [agent:team-review] / [agent:review-done] — ephemeral cold-review seats (Task 24) ---
// A team LEAD writes only the review scope; clodex spawns an ephemeral reviewer
// seat from the `reviewer` role, briefs it, injects the scope; the seat returns a
// verdict via [agent:review-done], which routes to the lead and archives the seat.

// A team whose reviewer role carries a Read/Grep/Glob-only tools allowlist. The
// stub resolveTeam returns it for any /proj cwd; a Map-backed persistence gives
// get/upsert so the ephemeral+reviewFor seed round-trips. The seat name matches
// the role KEY (`reviewer`), so create()'s own name-driven auto role-prompt path
// binds the briefing — the handler passes no inline system body.
// The shipped default reviewer template (resources/library/templates/
// clodex-team-reviewer.json), the DATA _handleTeamReview consumes. mkReview seeds
// getTemplates().list() with exactly this by default so the primary spawn test
// proves the TEMPLATE path (not just the fallback). A test may pass `reviewTemplate`
// to override its contents, or `reviewTemplates` for the whole list (e.g. [] to
// force the missing-template fallback).
const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

function mkReview(extra = {}) {
  const roleOverride = extra.reviewerRole;
  delete extra.reviewerRole;
  const acCalls = [];
  // Template seed: `reviewTemplates` (the full list) wins; else `reviewTemplate`
  // (single, overriding the shipped default's fields); else the shipped default.
  const templatesList = Array.isArray(extra.reviewTemplates)
    ? extra.reviewTemplates
    : [extra.reviewTemplate ? { ...SHIPPED_REVIEWER_TEMPLATE, ...extra.reviewTemplate } : SHIPPED_REVIEWER_TEMPLATE];
  delete extra.reviewTemplates;
  delete extra.reviewTemplate;
  const reviewerRole = roleOverride || { instantiate: 'subagent', prompt: 'clodex-team-reviewer',
    brief: 'the reviewer', tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false };
  const team = { name: 'team', root: '/proj', lead: 'lead', file: '/proj/team.json',
    roles: { lead: { instantiate: 'session', brief: 'the lead' }, reviewer: reviewerRole } };
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    // Resolves the entry BY NAME and no-ops when it is absent — same shape as
    // the real store, which is why the call has to land after create().
    setStripLevel: (n, level) => {
      const e = store.find((x) => x.name === n);
      if (!e) return;
      if (level === 1 || level === 2) e.stripLevel = level; else delete e.stripLevel;
    },
    // Same by-name, no-op-when-absent shape as setStripLevel, and for the same
    // reason: a fixture that wrote unconditionally would make a call moved
    // BEFORE create() look like it worked.
    // acCalls records the CALL, which the resulting record cannot: `on !== false`
    // deletes the key, so an unconditional setAutoCompact(name, true) leaves a
    // record indistinguishable from one the guard skipped entirely.
    setAutoCompact: (n, on) => {
      acCalls.push([n, on]);
      const e = store.find((x) => x.name === n);
      if (!e) return;
      if (on === false) e.autoCompact = false; else delete e.autoCompact;
    },
  };
  // Both real, and the SEED is half the fix: the promptWarn preflight is
  // path.join + existsSync, so wiring `path` without a registry only swaps which
  // TypeError is thrown. Unwire either and the branch silently stops running —
  // it did, for two tickets, taking every `path` consumer (_roleCwdRel) with it.
  // The prompt is INSTALLED because that leaves the default reply shape
  // unchanged; `extra` still overrides all three, as four tests rely on.
  const REGISTRY_DIR = mkTmpRoot('clodex-review-fx-');
  const promptDir = pathReal.join(REGISTRY_DIR, 'library', 'prompts', 'system');
  fsReal.mkdirSync(promptDir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(promptDir, `${SHIPPED_REVIEWER_TEMPLATE.systemPromptFile}.md`), 'you are the reviewer');
  const overrides = {
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => templatesList }),
    REGISTRY_DIR,
    path: pathReal,
    ...extra,
  };
  const { m, injected } = mkPark(overrides);
  const created = [];
  const delivered = [];
  const gated = [];
  const archived = [];
  const killed = [];
  const contextActions = [];
  const order = []; // shared recorder — proves deliver happens BEFORE the discard (NIT 4)
  m.create = async (...args) => { created.push(args); };
  m._deliverMessage = (name, sender, body, mtype) => delivered.push({ name, sender, body, mtype });
  // Scope delivery is an ACTIVE-CLASS PARK (T54): parked (no spawn-time PTY
  // write — the T40/T42 boot-race stays fixed) but turn-earning, drained by the
  // boot-ready rising edge. _deliverPassive (roster/team deltas) is captured
  // separately so a test can prove the scope no longer rides the passive path.
  const passive = [];
  const parkedActive = [];
  m._deliverPassive = (name, sender, body, mtype) => passive.push({ name, sender, body, mtype });
  m._deliverParkedActive = (name, sender, body, mtype) => parkedActive.push({ name, sender, body, mtype });
  // Default: delivery succeeds. A test can reassign m._gatedDeliver to return
  // { error } (dead/absent lead) to drive MUST-FIX 3's bounce-and-keep-live arm.
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); order.push('deliver'); return { queued: true }; };
  m.archive = async (name) => { archived.push(name); order.push('archive'); };
  // T31: review-done now DISCARDS (kill) instead of archiving. kill() drops the
  // persistence record — mirror that here so the sweep/record assertions see it.
  m.kill = async (name) => { killed.push(name); persistence.remove(name); order.push('discard'); };
  m._sendToSession = (name, channel, payload) => { contextActions.push({ name, channel, payload }); order.push('context-action'); };
  return { m, injected, created, delivered, passive, parkedActive, gated, archived, killed, contextActions, order, persistence, acCalls, team, REGISTRY_DIR, promptDir };
}

test('team-review: lead spawns an ephemeral reviewer seat — bumped name, inverted tools, ephemeral+reviewFor, scope delivered as an active-class park', async () => {
  const { m, injected, created, delivered, passive, parkedActive, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'check the boot-race fix');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'one reviewer seat spawned');
  // Full positional shape of the reviewer create() call (create() sig at
  // session-manager.js:763): …, systemPromptFile(15), appendPromptFiles(16),
  // execCommands(17), intents(18), sessionEnv(19) — 1-indexed positions.
  const [name, type, cwd, extraArgs, resumeId, ws, sysBody, fork, proxy, agents, denyB, disabledTools,
    disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, execCommands, intents, sessionEnv] = created[0];
  assert.strictEqual(name, 'team-reviewer-1', 'first reviewer name matches the role key');
  assert.strictEqual(type, 'claude', 'the cold reviewer ALWAYS spawns claude — code-side, so the tools cap is enforceable');
  assert.strictEqual(cwd, '/proj', 'cwd defaults to team root');
  // T5: the SCOPE rides the inline system body. The role brief still arrives as
  // the replacement system prompt (systemPromptFile below) — that is the seat's
  // standing "how to review"; this is the per-ticket "what to review", and the two
  // are different channels on purpose. It was a dm until six seats in one day were
  // measured alive at zero tokens with the scope gone: a park drained into the
  // CLI's boot re-render is wiped, and the t194 fallback then sees the park
  // claimed and correctly concludes nothing is owed. Pinned end-to-end in
  // test/review-scope-in-prompt.test.js, which asserts the BAKED bytes.
  assert.ok(sysBody && sysBody.includes('check the boot-race fix'),
    'the scope must ride the constructed prompt — a dm is written at a turn the wedged seat never takes');
  // T51 lean-reviewer: the role prompt (def.prompt) is passed as the REPLACEMENT
  // system prompt (--system-prompt-file), and create()'s auto role-prompt append
  // dedupes itself against it, so the briefing lands once as the system prompt.
  assert.strictEqual(systemPromptFile, 'clodex-team-reviewer', 'role prompt is THE system prompt (replacement)');
  // T51: intents [] gates every catalog intent (only the uncatalogued review-done
  // fires); execCommands [] grants nothing; sessionEnv is the template's env map.
  assert.deepStrictEqual(intents, [], 'every catalog intent gated (buildIpcPrompt([]) sheds grammar + MEMORY)');
  assert.deepStrictEqual(execCommands, [], 'no exec grant');
  assert.deepStrictEqual(sessionEnv, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  }, 'lean-reviewer env: CLAUDE.md loader off, 5m cache pin, IPC-prompt skip, spawn-directive block off, raised Read cap');
  // The Read/Grep/Glob allowlist inverts to a denylist of every OTHER catalog tool
  // (create() auto-binds the role PROMPT but not its TOOLS — the handler owns this).
  assert.ok(disabledTools.includes('Bash') && disabledTools.includes('Edit') && disabledTools.includes('Write'),
    'non-allowed tools are disabled');
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'allowlisted tools are NOT disabled');
  // Seat identity reserved synchronously (MUST-FIX 1) — persisted before spawn.
  const rec = persistence.get('team-reviewer-1');
  assert.strictEqual(rec.ephemeral, true);
  assert.strictEqual(rec.reviewFor, 'lead');
  // An ACTIVE-CLASS PARK still fires (T54): parked rather than written at spawn —
  // the mode-2004 boot-race that ate the T40/T42 scopes stays fixed — but
  // turn-earning, so the boot-ready rising edge drains it WITHOUT a human ✉-click.
  // T5 emptied its BODY: a system prompt alone never makes the CLI take a turn, so
  // this is now the start signal and nothing more. Losing it costs a start, which
  // the t194 fallback re-drains; losing it when it carried the scope cost the
  // review. The body must NOT restate the scope — two copies disagree the moment
  // one is edited, and this is the copy that can be wiped.
  assert.strictEqual(parkedActive.length, 1, 'exactly one nudge, on the active (turn-earning) path');
  assert.strictEqual(parkedActive[0].name, 'team-reviewer-1');
  assert.strictEqual(parkedActive[0].sender, 'lead');
  assert.strictEqual(parkedActive[0].mtype, 'dm');
  assert.ok(!parkedActive[0].body.includes('check the boot-race fix'),
    'the nudge must not carry the scope — that is the losable channel this change moved off');
  assert.deepStrictEqual(passive, [], 'scope no longer rides the passive (never-earns-a-turn) path');
  assert.deepStrictEqual(delivered, [], 'no active inject for the scope');
  assert.ok(injected.some((t) => /spawned team-reviewer-1/.test(t)), 'lead gets a confirmation naming the seat');
});

// --- t151: CLODEX_SPAWNER_HINT — the spawner-hint lever, generic over sessions ---
//
// Replaces the T51/T52 reviewer-only tests that lived here. The hint suppresses
// (or forces) wirescope's `[wirescope]` spawn-directive block for one ROUTE, and
// it used to be readable from exactly one place: the cold-reviewer template field
// `spawnerHint`, POSTed by _handleTeamReview after create() returned. Any other
// template could declare the field and nothing read it. The env var is now the
// only reader, so every session type reaches the lever and the reviewer branch is
// gone.
//
// ORDERING. The old test asserted "AFTER create(), BEFORE the scope handover" —
// the requirement being pre-first-request, since the hint rides the marked system
// prefix and a mid-session flip busts the warm cache. Firing INSIDE create() ahead
// of the PTY spawn subsumes that claim: there is no seat, so there is no first
// turn it could be racing. The tests below pin it against the pty.spawn call
// instead, which is the stronger statement.
//
// These drive the REAL create() claude arm — the branch under test reads
// mergedEnv, which only exists inside create(). A stubbed create() (what the old
// tests used, appropriate when the POST was in the handler) would assert nothing
// here.
function mkHintProbe({ proxyBase = 'http://127.0.0.1:7811', ProxyClient, ptySpawn, registry, transportStart, socketLive = false, lastTranscriptWrite = () => null } = {}) {
  const root = mkTmpRoot('clodex-hint-');
  const hints = [];
  const order = [];
  const warns = [];
  // The upserted entries, in order — create()'s record is what the exits that run
  // WITHOUT a session (forget, reviewer sweep) read the hint flag back out of.
  const upserts = [];
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    MSG_DIR: pathReal.join(root, 'messages'),
    PENDING_DIR: pathReal.join(root, 'pending'),
    fs: fsReal, path: pathReal, os: osReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: (d) => fsReal.mkdirSync(d, { recursive: true }),
    // The real hook creates run/<name>/ as a side effect and the bake writes into
    // it — a stub that skips the mkdir ENOENTs before the assertions.
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
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    writeSkillPlugin: () => null,
    effectiveInjectedSkills: () => [],
    getPersistence: () => ({ list: () => [], get: () => null, upsert: (e) => upserts.push(e), setSessionId: () => {} }),
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    resolveProxyBase: () => proxyBase,
    resolveProxyAgentId: ({ name }) => `clodex-${name}-rt`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite,
    ProxyClient: ProxyClient || {
      spawnerHint: (base, agent, opts) => {
        hints.push({ base, agent, opts }); order.push('hint'); return Promise.resolve({ status: 200 });
      },
    },
    registry: registry || { register: () => {}, unregister: () => {} },
    Transport: class {
      static async isSocketLive() { return socketLive; }
      async start() { if (transportStart) return transportStart(); }
      stop() {}
    },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => {
        order.push('spawn');
        if (ptySpawn) return ptySpawn();
        return { onData() {}, onExit() {}, pid: 999 };
      },
    },
    notifyOS: () => {},
    // Only reached on the pty.spawn failure path, which the abandon-clear tests
    // drive; without them the real ENOENT is masked by a TypeError.
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    log: { info() {}, warn: (scope, msg) => warns.push(msg), error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  // A real create() leaves an fs.watch handle open that keeps the loop alive —
  // the whole file would hang after reporting green. Same discipline as
  // test/ipc-prompt-cache-rework.test.js.
  const stopWatchers = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  const spawn = async (name, sessionEnv, type = 'claude') => {
    try {
      return await m.create(
        name, type, osReal.tmpdir(), [], null, 'ws', null, false, null,
        [], [], [], [], [], null, [], [], null, sessionEnv,
      );
    } finally { stopWatchers(name); }
  };
  return { m, hints, order, warns, upserts, spawn, root };
}

test('spawner-hint (t151): CLODEX_SPAWNER_HINT=off POSTs on:false on the seat route, BEFORE the PTY spawn', async () => {
  const { m, hints, order, spawn } = mkHintProbe();
  await spawn('seat', { CLODEX_SPAWNER_HINT: 'off' });
  assert.deepStrictEqual(hints, [{
    base: 'http://127.0.0.1:7811', agent: 'clodex-seat-rt', opts: { on: false },
  }], 'one POST keyed on the minted proxyAgent with on:false');
  assert.deepStrictEqual(order, ['hint', 'spawn'],
    'the POST precedes the PTY spawn — so it cannot land mid-session and bust the warm system prefix');
  assert.strictEqual(m.sessions.get('seat').spawnerHintSet, true,
    'the session records that IT set an override — kill() clears off this, not off the env');
});

test('spawner-hint (t151): CLODEX_SPAWNER_HINT=on POSTs on:true (the opt-IN mirror on a globally-off port)', async () => {
  const { hints, spawn } = mkHintProbe();
  await spawn('seat', { CLODEX_SPAWNER_HINT: 'on' });
  assert.deepStrictEqual(hints, [{
    base: 'http://127.0.0.1:7811', agent: 'clodex-seat-rt', opts: { on: true },
  }], '"on" is a real value, not a synonym for unset');
});

test('spawner-hint (t151): unset (and any other value) POSTs NOTHING — the common path gains no traffic', async () => {
  for (const [label, env] of [
    ['unset', null],
    ['empty string', { CLODEX_SPAWNER_HINT: '' }],
    ['garbage', { CLODEX_SPAWNER_HINT: 'yes' }],
    ['0 (not a synonym for off)', { CLODEX_SPAWNER_HINT: '0' }],
  ]) {
    const { m, hints, spawn } = mkHintProbe();
    await spawn('seat', env);
    assert.deepStrictEqual(hints, [], `${label} → no POST at all`);
    assert.strictEqual(m.sessions.get('seat').spawnerHintSet, false,
      `${label} → nothing recorded, so kill() posts no clear either`);
  }
});

// The strict match means the likely typos all fail by doing nothing, and the only
// symptom is a block reappearing in a prompt nobody reads. The warn is the whole
// difference between "misconfigured" and "silently ignored".
test('spawner-hint (t151): a set-but-unrecognized value WARNS; unset stays silent', async () => {
  for (const bad of ['0', 'OFF', ' off', 'yes', 'true']) {
    const { warns, hints, spawn } = mkHintProbe();
    await spawn('seat', { CLODEX_SPAWNER_HINT: bad });
    assert.deepStrictEqual(hints, [], `${bad} → still no POST; the warn does not loosen the match`);
    assert.ok(warns.some((w) => w.includes('spawner-hint') && w.includes(JSON.stringify(bad))),
      `${bad} → warned, with the offending value quoted so whitespace/case is visible: ${JSON.stringify(warns)}`);
  }

  for (const [label, env] of [['unset', null], ['empty string', { CLODEX_SPAWNER_HINT: '' }]]) {
    const { warns, spawn } = mkHintProbe();
    await spawn('seat', env);
    assert.deepStrictEqual(warns.filter((w) => w.includes('spawner-hint')), [],
      `${label} → silent; every session that never asked for the lever would otherwise warn`);
  }
});

// The POST lands before the session exists, so a create() that throws on the way
// to sessions.set leaves a row kill() can never reach — a TTL-less table, so it is
// permanent. Inert (each retry mints a fresh route), but create() already unwinds
// its other partial work, and spawnerHintSet makes this look accounted for.
test('spawner-hint (t151): a create() that throws AFTER the POST clears the route it orphaned', async () => {
  const { hints, spawn } = mkHintProbe({
    ptySpawn: () => { throw new Error('ENOENT: no claude on PATH'); },
  });
  await assert.rejects(() => spawn('seat', { CLODEX_SPAWNER_HINT: 'off' }),
    /ENOENT/, 'the spawn failure still propagates — the unwind does not swallow it');
  assert.deepStrictEqual(hints.map((h) => h.opts), [{ on: false }, { clear: true }],
    'the set is followed by a clear on the SAME route, so no orphan row survives the failed create()');
  assert.strictEqual(hints[1].agent, 'clodex-seat-rt', 'cleared by route id, not session name');
});

// Each throw site is its own edit, so one test per site — a single site left
// uncalled would otherwise hide behind the others.
test('spawner-hint (t151): the abandon-clear covers EVERY throw site past the POST, not just pty.spawn', async () => {
  const cases = [
    ['registry.register non-EEXIST rethrow', {
      registry: { register: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, unregister: () => {} },
    }, /EACCES/],
    ['transport.start() failure', {
      transportStart: () => { throw new Error('EADDRINUSE'); },
    }, /EADDRINUSE/],
    // The name is held by a blocker with a PROVEN-LIVE socket, so create() refuses
    // rather than force-cleaning. This site is reached only with a readable registry
    // record, hence the seed below.
    ['"already running elsewhere" refusal', {
      socketLive: true,
      registry: { register: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }, unregister: () => {} },
      seedRegistry: { pid: 999999, socket: '/tmp/clodex-blocker.sock' },
    }, /already running elsewhere/],
  ];
  for (const [label, opts, re] of cases) {
    const { hints, spawn, root } = mkHintProbe(opts);
    if (opts.seedRegistry) {
      fsReal.mkdirSync(runDirForReal(root, 'seat'), { recursive: true });
      fsReal.writeFileSync(pathForReal(root, 'seat', 'registry'), JSON.stringify(opts.seedRegistry));
    }
    await assert.rejects(() => spawn('seat', { CLODEX_SPAWNER_HINT: 'off' }), re, label);
    assert.deepStrictEqual(hints.map((h) => h.opts), [{ on: false }, { clear: true }],
      `${label} → the orphaned route is cleared on the way out`);
  }
});

test('spawner-hint (t151): the abandon-clear is silent when this seat set nothing', async () => {
  const { hints, spawn } = mkHintProbe({
    ptySpawn: () => { throw new Error('ENOENT: no claude on PATH'); },
  });
  await assert.rejects(() => spawn('seat', { CLODEX_SPAWNER_HINT: 'yes' }), /ENOENT/);
  assert.deepStrictEqual(hints, [],
    'no POST was made, so the unwind must not clear a row some OTHER seat owns');
});

test('spawner-hint (t151): set but no route to post to — BOTH guard conjuncts (no base, tee-blind base, no proxyAgent)', async () => {
  const noProxy = mkHintProbe({ proxyBase: null });
  await noProxy.spawn('seat', { CLODEX_SPAWNER_HINT: 'off' });
  assert.deepStrictEqual(noProxy.hints, [], 'no proxy base → nothing to tell');

  // A bash seat has agentType null, so no proxyAgent is ever minted — the second
  // half of the guard. Without it this POSTs agent=null, which is not a route.
  const bash = mkHintProbe();
  await bash.spawn('seat', { CLODEX_SPAWNER_HINT: 'off' }, 'bash');
  assert.deepStrictEqual(bash.hints, [],
    'no proxyAgent (bash) → no POST; a null route id would address nothing');
  assert.strictEqual(bash.m.sessions.get('seat').spawnerHintSet, false,
    'and nothing recorded, so kill() posts no clear for a route that never existed');

  // A Bedrock/Vertex seat resolves a base and then has it NULLED by the tee-blind
  // guard, which sits above the hint. Its bytes never reach the proxy, so a hint
  // row keyed on that route would be a permanent orphan in a TTL-less table.
  const teeBlind = mkHintProbe();
  await teeBlind.spawn('seat', { CLODEX_SPAWNER_HINT: 'off', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepStrictEqual(teeBlind.hints, [],
    'tee-blind backend nulls proxyBase before the hint reads it — no orphan row');
  assert.strictEqual(teeBlind.m.sessions.get('seat').spawnerHintSet, false,
    'and nothing is recorded, so the kill() clear stays silent too');
});

test('spawner-hint (t151): a hint failure NEVER fails the spawn (sync throw and rejected promise both)', async () => {
  const thrower = mkHintProbe({ ProxyClient: { spawnerHint: () => { throw new Error('proxy exploded'); } } });
  await thrower.spawn('seat', { CLODEX_SPAWNER_HINT: 'off' });
  assert.ok(thrower.m.sessions.get('seat'), 'a sync throw is swallowed — the seat still spawned');

  const rejecter = mkHintProbe({ ProxyClient: { spawnerHint: () => Promise.reject(new Error('timeout')) } });
  await rejecter.spawn('seat', { CLODEX_SPAWNER_HINT: 'off' });
  assert.ok(rejecter.m.sessions.get('seat'), 'a rejected promise is caught — the seat still spawned');
  // An uncaught rejection here would not fail this assertion, it would kill the
  // whole test PROCESS on the next tick. Give it that tick.
  await new Promise((r) => setImmediate(r));
});

test('spawner-hint (t151): kill() of a seat that SET the hint clears its route row', (t) => {
  // kill() arms a 5s SIGKILL-fallback timer — mock it so the test process doesn't
  // hold open on it (the timer is production-correct; we just don't want to wait).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hints = [];
  const { m, persistence } = mkReview({
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
  });
  persistence.upsert({ name: 'seat', workspaceId: 'default' });
  m.sessions.set('seat', { name: 'seat', agentType: 'claude', cwd: '/proj', spawnerHintSet: true,
    proxyBase: 'http://127.0.0.1:7811', proxyAgent: 'clodex-seat-z', pty: { pid: 123, kill: () => {} } });
  const RealSM = m.constructor.prototype;
  m.kill = RealSM.kill.bind(m);
  m._notifyComposition = () => {};
  m.kill('seat');
  assert.deepStrictEqual(hints, [{
    base: 'http://127.0.0.1:7811', agent: 'clodex-seat-z', opts: { clear: true },
  }], 'retiring a seat that set an override drops its row from the TTL-less hint table');
});

test('spawner-hint (t151): kill() of a seat that did NOT set it posts nothing — including an ephemeral reviewer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hints = [];
  const { m, persistence } = mkReview({
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
  });
  // ephemeral+reviewFor is deliberately present: that pair WAS the old gate, so a
  // clear firing here would mean the record is still driving the decision.
  persistence.upsert({ name: 'plain', workspaceId: 'default', ephemeral: true, reviewFor: 'lead' });
  m.sessions.set('plain', { name: 'plain', agentType: 'claude', cwd: '/proj',
    proxyBase: 'http://127.0.0.1:7811', proxyAgent: 'clodex-plain-q', pty: { pid: 1, kill: () => {} } });
  const RealSM = m.constructor.prototype;
  m.kill = RealSM.kill.bind(m);
  m._notifyComposition = () => {};
  m.kill('plain');
  assert.deepStrictEqual(hints, [],
    'no override set → no clear, whatever the persistence record says about the seat being a reviewer');
});

// kill() reads the flag off the live session, but the exits that DROP a record
// (session:forget, the reviewer sweep) have no session to read — so the flag is
// mirrored onto the record. Written unconditionally: upsert spread-merges, so a
// conditional omit would leave a stale `true` behind on a seat respawned without
// the env, and those exits would clear a row this seat never set.
test('spawner-hint (t158): create() persists spawnerHintSet on the record — false as deliberately as true', async () => {
  const set = mkHintProbe();
  await set.spawn('seat', { CLODEX_SPAWNER_HINT: 'off' });
  assert.strictEqual(set.upserts.at(-1).spawnerHintSet, true,
    'a seat that set an override records it where a session-less exit can read it');

  const unset = mkHintProbe();
  await unset.spawn('seat', null);
  assert.strictEqual(unset.upserts.at(-1).spawnerHintSet, false,
    'and one that did not writes `false` — absent would spread-merge over a stale true');
});

// The activityTs restore seed, driven through a REAL create() (mkHintProbe is the
// nearest fixture that spawns one; it takes lastTranscriptWrite as a param for
// this). Pre-t289 an out-of-range mtime — NFS, `rsync -t`, a clock step — was
// self-correcting, because the next transition assigned Date.now() over it. The
// clock only moves forward now, so an unclamped future seed is PERMANENT: idleMs
// stays negative, `idleMs < DM_HOLD_IDLE_MS` is trivially true, and that seat can
// never be held again.
test('create: a future-dated transcript mtime is clamped to now; a past one is still trusted', async () => {
  const future = mkHintProbe({ lastTranscriptWrite: () => Date.now() + 900000 });
  const before = Date.now();
  await future.spawn('ahead');
  const seeded = future.m.sessions.get('ahead').activityTs;
  assert.ok(seeded <= Date.now(), 'a future mtime must not seed the clock ahead of now');
  assert.ok(seeded >= before, 'ENTER: the clamp fell back to now — it did not zero or drop the field');

  // The other direction, and the reason this is a clamp and not `Date.now()`: a
  // genuine past mtime is the whole point of the seed (a resumed long-cold peer
  // must not read as fresh), so it has to survive untouched.
  const past = Date.now() - 3600000;
  const behind = mkHintProbe({ lastTranscriptWrite: () => past });
  await behind.spawn('cold');
  assert.strictEqual(behind.m.sessions.get('cold').activityTs, past,
    'a real past mtime is the seed and must pass through exactly');
});

test('spawner-hint (t158): the reviewer-graveyard sweep clears the route row before dropping the record', () => {
  const hints = [];
  const { m, persistence } = mkReview({
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
    getUiSettings: () => ({ get: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7811' }) }),
    // The real tri-state resolver, not a fake: `proxy: false` (never routed) vs
    // null (inherit the global pref) is exactly the distinction the guard leans on.
    resolveProxyBase: require('../statusline').resolveProxyBase,
  });
  persistence.upsert({ name: 'rev', ephemeral: true, reviewFor: 'lead', archivedAt: 1,
    proxy: null, proxyAgent: 'clodex-rev-k', spawnerHintSet: true });
  const swept = m.sweepReviewerGraveyard();
  assert.deepStrictEqual(swept, ['rev'], 'the corpse is still swept');
  assert.deepStrictEqual(hints, [{
    base: 'http://127.0.0.1:7811', agent: 'clodex-rev-k', opts: { clear: true },
  }], 'dropping the record is the last moment the route id is knowable, and the hint table has no TTL');
  assert.strictEqual(persistence.get('rev'), null, 'and the record is gone');
});

// The guard that keeps t152's rule ("clear only what this seat set") holding at
// the session-less sites too. A blind clear keyed on the record alone would also
// wipe an override an operator set out-of-band through /_hint, which is supported
// pre-launch arm config — a correctness failure, not a style preference.
test('spawner-hint (t158): a corpse that never set an override is swept WITHOUT a clear', () => {
  const hints = [];
  const { m, persistence } = mkReview({
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
    getUiSettings: () => ({ get: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7811' }) }),
    // The real tri-state resolver, not a fake: `proxy: false` (never routed) vs
    // null (inherit the global pref) is exactly the distinction the guard leans on.
    resolveProxyBase: require('../statusline').resolveProxyBase,
  });
  // Routed, so the ONLY thing withholding the clear is the flag.
  persistence.upsert({ name: 'plain', ephemeral: true, reviewFor: 'lead', archivedAt: 1,
    proxy: null, proxyAgent: 'clodex-plain-q' });
  // Flag set but no route to address: the other half of the guard.
  persistence.upsert({ name: 'unrouted', ephemeral: true, reviewFor: 'lead', archivedAt: 1,
    proxy: false, proxyAgent: 'clodex-unrouted-z', spawnerHintSet: true });
  assert.deepStrictEqual(m.sweepReviewerGraveyard().sort(), ['plain', 'unrouted']);
  assert.deepStrictEqual(hints, [],
    'neither a record-only inference nor a null base produces a POST');
});

test('team-review: reviewer inherits the lead permission posture (--dangerously-skip-permissions) so it never strands on a prompt', async () => {
  // A cold reviewer spawned WITHOUT the lead's skip-permissions posture blocks on
  // its first tool prompt; with no operator awake (the point of an overnight review)
  // that dialog strands the seat forever and no [agent:review-done] ever lands. Same
  // F5 inheritance the spawn path already does; the reviewer is tool-capped anyway.
  const { m, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  persistence.upsert({ name: 'lead', extraArgs: ['--dangerously-skip-permissions'] });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created[0][3], ['--dangerously-skip-permissions'],
    'reviewer carries ONLY the lead posture flag — not a full extraArgs copy');
});

test('team-review: a prompt-gated lead spawns a prompt-gated reviewer (no posture flag inherited)', async () => {
  const { m, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  persistence.upsert({ name: 'lead', extraArgs: ['--model', 'opus'] }); // no skip flag → nothing inherited
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created[0][3], [], 'only the skip flag is inheritable; absent → [] (F5 parity)');
});

test('team-review: name bumps past an existing team-reviewer-1 (live or persisted)', async () => {
  const { m, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  persistence.upsert({ name: 'team-reviewer-1', archivedAt: 1 }); // a prior review still reserves the slot
  m.sessions.set('team-reviewer-2', { name: 'team-reviewer-2', agentType: 'claude', cwd: '/proj' }); // live
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created[0][0], 'team-reviewer-3', 'bumps past both the persisted -1 and the live -2');
});

test('team-review: a NON-lead is bounced, nothing spawned', async () => {
  const { m, injected, created } = mkReview();
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('team-dev'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned for a non-lead');
  assert.ok(injected.some((t) => /only the team lead \(lead\)/.test(t)), 'bounced with the lead-only reason');
});

test('team-review: an empty scope is bounced, nothing spawned', async () => {
  const { m, injected, created } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), '   ');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned without a scope');
  assert.ok(injected.some((t) => /a review scope is required/.test(t)));
});

// The ticket path's twin is covered; this is the REVIEW path, where `cwdWarn` was
// built and interpolated with nothing exercising it. A silent fallback here is the
// worst-placed one in the system: the reviewer reads the right repo from the wrong
// directory and reports a verdict, and no other line in the run says so.
test('team-review: a role cwd the resolver refuses is NAMED in the reply, and the reviewer spawns at the team root', async () => {
  const { m, injected, created } = mkReview({
    // Absolute, so the refusal is lexical and needs no directory on disk — /proj
    // is a fixture path that does not exist.
    reviewerRole: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false, cwd: '/etc' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'check the thing');
  await new Promise((r) => setImmediate(r));

  // ENTER: the reviewer really spawned. Both assertions below are about a spawn
  // that happened — a refusal that BLOCKED the review would satisfy neither.
  assert.strictEqual(created.length, 1,
    `ENTER: exactly one reviewer seat spawned — the cwd is a warn, never a block; replies: ${JSON.stringify(injected)}`);
  assert.strictEqual(created[0][2], '/proj',
    'the reviewer boots at the team root, not at the refused directory');
  const reply = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(reply, `ENTER: the spawn reply must have landed, got: ${JSON.stringify(injected)}`);
  assert.match(reply, /NOTE: role cwd "\/etc" is absolute/,
    'and the lead is told the cwd was refused — the alternative is a reviewer working somewhere nobody knows');
});

test('team-review: a teamless sender is bounced', async () => {
  const { m, injected, created } = mkReview();
  m.sessions.set('solo', { name: 'solo', agentType: 'claude', cwd: '/elsewhere', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('solo'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, []);
  assert.ok(injected.some((t) => /not on a team/.test(t)));
});

test('review-done (T31): an ephemeral reviewer delivers its verdict to the lead, THEN discards (record removed, no archived row)', async () => {
  const { m, gated, archived, killed, contextActions, order, persistence } = mkReview();
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead' });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj' });
  m._handleReviewDone(m.sessions.get('team-reviewer-1'), 'VERDICT: ACCEPT');
  assert.deepStrictEqual(gated, [{ target: 'lead', sender: 'team-reviewer-1', body: 'VERDICT: ACCEPT' }],
    'verdict delivered to the reviewFor lead (dm-style, parking/spill)');
  assert.deepStrictEqual(killed, ['team-reviewer-1'], 'seat DISCARDED (kill), not archived');
  assert.deepStrictEqual(archived, [], 'never archived on the discard path');
  assert.strictEqual(persistence.get('team-reviewer-1'), null, 'record REMOVED — no archived corpse left behind');
  // The renderer must be told disposition:'discard' BEFORE teardown so it removes
  // the row like a delete instead of building an archived placeholder.
  const ca = contextActions.find((c) => c.channel === 'session:context-action');
  assert.deepStrictEqual(ca, { name: 'team-reviewer-1', channel: 'session:context-action',
    payload: { action: 'retired', name: 'team-reviewer-1', disposition: 'discard' } },
    'discard context-action broadcast to the owning window');
  // NIT 4: the ordering is load-bearing (onExit-before-cleanup) — assert it for real,
  // not just that both happened. Deliver must ENQUEUE before the discard kills the
  // seat, and the context-action must reach the window before the kill lands (the
  // choreography the code comment sells; pinned so a reorder can't pass silently).
  assert.deepStrictEqual(order, ['deliver', 'context-action', 'discard'],
    'verdict enqueued, THEN discard context-action, THEN the kill');
});

test('review-done: a NON-reviewer seat is bounced (no delivery, no teardown)', () => {
  const { m, injected, gated, archived, killed, persistence } = mkReview();
  persistence.upsert({ name: 'plain', workspaceId: 'default' }); // no ephemeral/reviewFor
  m.sessions.set('plain', { name: 'plain', agentType: 'claude', cwd: '/proj' });
  m._handleReviewDone(m.sessions.get('plain'), 'VERDICT: ACCEPT');
  assert.deepStrictEqual(gated, [], 'nothing delivered');
  assert.deepStrictEqual(archived, [], 'nothing archived');
  assert.deepStrictEqual(killed, [], 'nothing discarded');
  assert.ok(injected.some((t) => /only for an ephemeral reviewer seat/.test(t)));
});

test('review-done: an empty verdict is bounced', () => {
  const { m, injected, gated, archived, killed, persistence } = mkReview();
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead' });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj' });
  m._handleReviewDone(m.sessions.get('team-reviewer-1'), '  ');
  assert.deepStrictEqual(gated, []);
  assert.deepStrictEqual(archived, []);
  assert.deepStrictEqual(killed, [], 'nothing discarded');
  assert.ok(injected.some((t) => /a verdict is required/.test(t)));
});

// MUST-FIX 3: an absent/dead lead makes _gatedDeliver return { error }. The verdict
// went nowhere, so discarding would strand it — bounce to the reviewer and KEEP the
// seat live (record intact) so it can retry once the lead is back.
test('review-done (T31): a dead/absent lead ({error}) bounces and does NOT discard (seat kept live, record intact)', () => {
  const { m, injected, archived, killed, contextActions, persistence } = mkReview();
  m._gatedDeliver = () => ({ error: 'no such agent "lead"' });
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead' });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj' });
  m._handleReviewDone(m.sessions.get('team-reviewer-1'), 'VERDICT: ACCEPT');
  assert.deepStrictEqual(killed, [], 'seat NOT discarded — stays live for a retry');
  assert.deepStrictEqual(archived, [], 'seat NOT archived either');
  assert.ok(persistence.get('team-reviewer-1'), 'record intact — the discard did NOT happen');
  assert.deepStrictEqual(contextActions, [], 'no teardown context-action on the bounce path');
  assert.ok(injected.some((t) => /verdict NOT delivered, seat kept live/.test(t)), 'reviewer bounced with a retry hint');
});

// A HELD/parked delivery ({held}/{parked}) is a REAL lead just busy — accepted; the
// queue/park store carries the verdict, so the seat retires (discards) as normal.
test('review-done (T31): a HELD delivery is accepted and the seat still discards', () => {
  const { m, archived, killed, order, persistence } = mkReview();
  m._gatedDeliver = () => { order.push('deliver'); return { held: 'busy' }; };
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead' });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj' });
  m._handleReviewDone(m.sessions.get('team-reviewer-1'), 'VERDICT: ACCEPT');
  assert.deepStrictEqual(killed, ['team-reviewer-1'], 'a held (not errored) delivery still retires the seat');
  assert.deepStrictEqual(archived, [], 'never archived');
  assert.deepStrictEqual(order, ['deliver', 'context-action', 'discard'], 'held delivery still enqueues before the discard');
});

// t186 THE FUSE. Every review test above calls _handleReviewDone DIRECTLY, so
// none of them crosses the fire-time gate in _handleIntent — the one thing
// standing between the shipped reviewer and silence. This test goes through the
// gate on purpose.
//
// A reviewer ships `intents: []` from BOTH sources (the shipped template
// resources/library/templates/clodex-team-reviewer.json and the hardcoded
// REVIEWER_FALLBACK), and `[]` is a real value meaning EVERY catalogued intent
// is gated. `review-done` reaches its handler for exactly one reason:
// intent-catalog's intentEnabled returns true before consulting the list for any
// type outside GATEABLE_INTENTS, and review-done is not in that catalog. The
// seat's only egress survives on an omission.
//
// intentEnabledFor does NOT cover this: it fails closed only for PLUGIN rows,
// and review-done is a core registry row, so pluginRowFor returns null and it
// falls straight through to the catalog's return-true-by-omission.
//
// So adding `{ type: 'review-done', … }` to GATEABLE_INTENTS — one line, and it
// looks entirely reasonable — mutes EVERY reviewer that exists. Each still
// spawns, still runs, still composes a verdict, and has it swallowed at the
// gate; the lead waits forever on a seat that already reported. The catalog and
// prompt pins do fail on that edit, but both read as "you changed the catalog,
// update the pin" — which is exactly what the author making it would do. Nothing
// says *you just muted every reviewer*. This does.
//
// The `who` arm is not decoration: it proves the seat's `[]` is REAL and
// load-bearing on this very fixture. Without it a green test is consistent with
// gating being broken for everything, which would prove nothing about
// review-done's exemption.
test('t186: review-done survives the FIRE-TIME GATE on a seat with intents:[] (the uncatalogued-verb fuse)', async () => {
  const { m, injected, gated, killed, persistence } = mkReview();
  // Exactly what _handleTeamReview persists for a reviewer: identity markers plus
  // the shipped template's `intents: []`. Asserted below rather than trusted.
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead', intents: [] });
  m.sessions.set('team-reviewer-1', { name: 'team-reviewer-1', agentType: 'claude', cwd: '/proj' });

  // ENTER: the gate reads the PERSISTED list, so a fixture that failed to store
  // `[]` would exercise the all-enabled default and pass while testing nothing.
  assert.deepStrictEqual(persistence.get('team-reviewer-1').intents, [],
    'ENTER: the seat really is persisted with the everything-gated empty allowlist');

  // Control: a CATALOGUED verb on this same seat is denied by that same `[]`.
  await m._handleIntent('team-reviewer-1', { type: 'who' });
  assert.ok(injected.some((t) => /the who intent is disabled for this session/.test(t)),
    'the empty allowlist really does gate a catalogued intent on this seat');

  await m._handleIntent('team-reviewer-1', { type: 'review-done', body: 'VERDICT: ACCEPT' });

  assert.deepStrictEqual(gated, [{ target: 'lead', sender: 'team-reviewer-1', body: 'VERDICT: ACCEPT' }],
    'the verdict crossed the gate and reached the lead — catalog review-done and this is []');
  assert.deepStrictEqual(killed, ['team-reviewer-1'], 'the seat retired, so the lead is not left waiting on it');
  assert.ok(!injected.some((t) => /the review-done intent is disabled/.test(t)),
    'review-done was never bounced as a disabled intent');
});

// T31 launch-time sweep: drop persisted ephemeral+reviewFor+archivedAt corpses (the
// old ARCHIVE-retire graveyard). The three-marker guard is the doubt-guard — a
// record missing ANY marker stays.
test('sweepReviewerGraveyard (T31): drops archived ephemeral reviewer corpses, keeps everything else', () => {
  const { m, persistence } = mkReview();
  persistence.upsert({ name: 'team-reviewer-1', ephemeral: true, reviewFor: 'lead', archivedAt: 111 }); // swept
  persistence.upsert({ name: 'team-reviewer-2', ephemeral: true, reviewFor: 'lead', archivedAt: 222 }); // swept
  persistence.upsert({ name: 'team-reviewer-3', ephemeral: true, reviewFor: 'lead' });                  // kept — live reservation, not archived
  persistence.upsert({ name: 'plain-agent', archivedAt: 333 });                                          // kept — plain archived agent (no ephemeral)
  persistence.upsert({ name: 'odd', reviewFor: 'lead', archivedAt: 444 });                               // kept — no ephemeral marker
  const swept = m.sweepReviewerGraveyard();
  assert.deepStrictEqual(swept.sort(), ['team-reviewer-1', 'team-reviewer-2'], 'only the three-marker corpses are swept');
  assert.strictEqual(persistence.get('team-reviewer-1'), null, 'archived corpse removed');
  assert.strictEqual(persistence.get('team-reviewer-2'), null, 'archived corpse removed');
  assert.ok(persistence.get('team-reviewer-3'), 'a not-yet-archived ephemeral reservation stays');
  assert.ok(persistence.get('plain-agent'), 'a plain archived agent stays');
  assert.ok(persistence.get('odd'), 'an archived reviewFor record without ephemeral stays');
});

// MUST-FIX 1 (name-mint TOCTOU): two [agent:team-review] in one lead turn run their
// mint loops synchronously, before either deferred create() populates the map. The
// synchronous reservation must make the second mint a DISTINCT name.
test('team-review: two reviews in one lead turn mint DISTINCT names (no -1 collision)', async () => {
  const { m, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  const lead = m.sessions.get('lead');
  // Both handlers run synchronously (same turn) before either create() fires.
  m._handleTeamReview(lead, 'first scope');
  m._handleTeamReview(lead, 'second scope');
  await new Promise((r) => setImmediate(r));
  const names = created.map((c) => c[0]).sort();
  assert.deepStrictEqual(names, ['team-reviewer-1', 'team-reviewer-2'], 'distinct seat names, no collision');
  assert.strictEqual(persistence.get('team-reviewer-1').reviewFor, 'lead');
  assert.strictEqual(persistence.get('team-reviewer-2').reviewFor, 'lead');
});

// C2 (T29 Slice 2), and the half of it that SURVIVES t292: a cold reviewer always
// spawns as claude, because only create()'s claude arm consumes disabledTools —
// codex ignores the denylist, so a codex reviewer would spawn uncapped. That is
// CODE now, not a manifest field being overridden. A `type` still on disk in a
// version-1 team.json is dropped at load, so it cannot even ask.
test('team-review C2: a role def still carrying `type: codex` spawns as CLAUDE + capped', async () => {
  const { m, created } = mkReview({
    reviewerRole: { prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      type: 'codex', template: null, dispatch: 'standing' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  assert.strictEqual(created[0][1], 'claude',
    'a stale type field cannot steer the seat off the one runtime that can enforce the cap');
  const disabledTools = created[0][11];
  assert.ok(disabledTools.includes('Bash') && !disabledTools.includes('Read'),
    'the cap is live on the claude seat (Read/Grep/Glob kept, rest disabled)');
});

// The force is unconditional, so there is nothing left to warn ABOUT: the notice
// existed only to say a manifest field had been ignored, and the field is gone.
test('team-review C2: no force-claude notice is emitted any more', async () => {
  const { m, injected, created } = mkReview({
    reviewerRole: { prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      type: 'codex', template: null, dispatch: 'standing' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  assert.ok(!injected.some((t) => /always spawn as claude/.test(t)),
    'no notice about ignoring a field the schema no longer has');
});

// --- Task 29a → T52: `tools` is a NARROWING hint under REVIEWER_TOOL_CAP ---
// The template's stripLevel reaches the reviewer, and the ORDER is the whole
// mechanism: setStripLevel resolves the entry by name and no-ops when it isn't
// there, so a call placed before create() would leave the seat at level 0 while
// every visible signal — template on disk, spawn reply, tools — looked right.
// The spawn-intent path applies the level the same way; team-review skipped it
// entirely until 2026-08-05, so an operator who set L2 on the template got an
// unstripped reviewer with nothing anywhere saying so.
test('team-review: the template stripLevel lands on the seat, and only after create()', async () => {
  const { m, injected, created, persistence } = mkReview({
    reviewTemplate: { stripLevel: 2 },
  });
  // mkReview's default create() is a no-op, so the handler's identity seed sits
  // in the store from the start and setStripLevel would resolve an entry
  // wherever it was called — leaving this test's ordering claim untested.
  // setStripLevel is what carries the claim, so gate IT on create() having run:
  // before that, it must find nothing to write to, exactly as against the real
  // store, where the durable record does not exist until create() makes it.
  let createDone = false;
  const realSetStripLevel = persistence.setStripLevel;
  persistence.setStripLevel = (n, level) => {
    if (!createDone) return; // pre-create(): no record yet, so the write is lost
    realSetStripLevel(n, level);
  };
  m.create = async (...args) => { created.push(args); createDone = true; };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  // ENTER: no spawn means no entry to carry a level, and every assertion below
  // would be vacuously true of a handler that did nothing at all.
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  const name = created[0][0];
  const entry = persistence.get(name);
  assert.ok(entry, `ENTER: the seat ${name} has a persistence entry to carry the level`);
  assert.strictEqual(entry.stripLevel, 2,
    'the template asked for L2 and the seat runs at L2 — an unstripped reviewer is invisible from inside the seat');
  assert.ok(entry.ephemeral === true && entry.reviewFor === 'lead',
    'and the identity seed survived the later setStripLevel write');
  assert.ok(!injected.some((t) => /error/i.test(t)), 'no error surfaced to the lead');
});

// t297 Part B: `autoCompact: false` was inert on the review path — the site
// applied stripLevel only — so a reviewer template that opted out of
// auto-compact got compacted anyway, on exactly the seat type the template was
// written for. Same post-create() ordering claim as stripLevel above, driven
// through setAutoCompact because that is the setter this test's claim rides on.
test('team-review (t297): the template autoCompact:false lands on the seat, and only after create()', async () => {
  const { m, injected, created, persistence } = mkReview({
    reviewTemplate: { autoCompact: false },
  });
  let createDone = false;
  const realSetAutoCompact = persistence.setAutoCompact;
  persistence.setAutoCompact = (n, on) => {
    if (!createDone) return; // pre-create(): no record yet, so the write is lost
    realSetAutoCompact(n, on);
  };
  m.create = async (...args) => { created.push(args); createDone = true; };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  const entry = persistence.get(created[0][0]);
  assert.ok(entry, 'ENTER: the seat has a persistence entry to carry the opt-out');
  assert.strictEqual(entry.autoCompact, false,
    'the template opted out of auto-compact and the seat honors it');
  assert.ok(entry.ephemeral === true && entry.reviewFor === 'lead',
    'and the identity seed survived the later write');
  assert.ok(!injected.some((t) => /error/i.test(t)), 'no error surfaced to the lead');
});

// The opt-OUT is the only stored value: a template that says nothing must leave
// the key ABSENT, or it freezes "on" onto the record and autoCompactOf can no
// longer tell a deliberate choice from a default.
test('team-review (t297): a template with no autoCompact never calls the setter at all', async () => {
  const { m, created, persistence, acCalls } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  const entry = persistence.get(created[0][0]);
  assert.ok(entry, 'ENTER: the seat has a persistence entry');
  // The CALL, not the record: `on !== false` deletes the key, so an
  // unconditional setAutoCompact(name, true) leaves the record identical to
  // this one and the record assertion below cannot see the guard at all.
  assert.deepStrictEqual(acCalls, [], 'the guard skipped the setter entirely');
  assert.ok(!('autoCompact' in entry),
    'and the key stays absent, so the default applies');
});

// A template with no stripLevel must not write one: absent is a real value
// (level 0), and freezing an explicit 0 onto the record would defeat the
// global/default resolution in stripLevelOf.
test('team-review: a template with no stripLevel leaves the seat unset, not zeroed', async () => {
  const { m, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  const entry = persistence.get(created[0][0]);
  assert.ok(entry, 'ENTER: the seat has a persistence entry');
  assert.ok(!('stripLevel' in entry),
    'the shipped default carries no stripLevel, so the key stays ABSENT and resolution falls through');
});

// Both the reviewer TEMPLATE and the role manifest are agent-writable, so neither
// can WIDEN the cold reviewer past the code-level cap (Read/Grep/Glob). The
// template is the primary tools source (T52); it's capped exactly like the role
// manifest was (T29a). Effective = intersection.
// The exemplars are Edit and Write since t673: Bash is no longer a beyond-cap
// tool — a template listing it opts into the code-owned read-only shell, which
// is a grant this arm makes on purpose and does not warn about. Write tools
// carry the property this test is about and are the stronger exemplar for it.
test('team-review (T52): a TEMPLATE WIDER than the cap spawns CAPPED with a loud operator-approval line', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplate: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'a widened template still spawns — a capped review beats no review');
  const disabledTools = created[0][11];
  // The widening (Edit, Write) is disabled despite the template asking for it; the cap holds.
  assert.ok(disabledTools.includes('Edit') && disabledTools.includes('Write'),
    'tools beyond the cap are disabled even though the template requested them');
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the capped allowlist (Read/Grep/Glob) is NOT disabled');
  // Bash is absent from the request here, so it must be disabled too — the shell
  // is granted only on an explicit opt-in, never as a side effect of a widening.
  assert.ok(disabledTools.includes('Bash'), 'a template that did not ask for the shell does not get one');
  assert.ok(injected.some((t) => /requested \[Edit, Write\] beyond the reviewer cap \[Read, Grep, Glob\] — requires operator approval; spawned with \[Read, Grep, Glob\]/.test(t)),
    'the lead gets a loud line naming the beyond-cap tools and the operator-approval requirement');
});

test('team-review (t386): the template --model reaches the create() argv, merged with posture', async () => {
  // The end-to-end half of the carve-out: resolve-seat-shape.test.js pins the
  // SHAPE, and nothing pinned that the shape's extraArgs actually becomes the
  // argv create() is called with. A rewiring that dropped shape.extraArgs at
  // this call site passes every resolver test.
  const { m, created, persistence } = mkReview({
    reviewTemplate: { extraArgs: ['--model', 'fable', '--allowedTools', 'Bash'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  // The posture is derived from the LEAD's persisted args, so the merge only
  // has something to merge onto if the lead actually holds it.
  persistence.upsert({ name: 'lead', extraArgs: ['--dangerously-skip-permissions'] });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer must have spawned for the argv to mean anything');
  assert.deepStrictEqual(
    created[0][3], ['--dangerously-skip-permissions', '--model', 'fable'],
    'posture then the allowlisted model; --allowedTools from the same template does NOT ride',
  );
});

test('team-review (t386): a REFUSED template --model is reported, not silently defaulted', async () => {
  // The bug this ticket exists to end is "configured a model, silently got the
  // default". Fixing the drop while leaving the refusal silent reproduces it one
  // layer in, so the refusal is loud on the same reply chain as the env/cap warns.
  const { m, injected, created } = mkReview({
    reviewTemplate: { extraArgs: ['--model', '--allowedTools'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'a bad model line still spawns a reviewer — a default-model review beats none');
  assert.deepStrictEqual(created[0][3], [], 'the refused model reaches no argv');
  assert.ok(
    injected.some((t) => /reviewer template model "--model --allowedTools" is not a usable model name/.test(t)),
    'the lead is told which model spec was refused and that the seat took the default',
  );
});

test('team-review (t386): an HONORED --model produces no refusal line', async () => {
  // The absence half: a warning wired to "a --model was seen" rather than "one
  // was refused" fires on the working configuration, which trains the lead to
  // ignore it. This is the case that separates the two.
  const { m, injected } = mkReview({
    reviewTemplate: { extraArgs: ['--model', 'fable'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(injected.some((t) => /spawned team-reviewer-1/.test(t)), 'ENTER: the spawn reply is the line under test');
  assert.ok(!injected.some((t) => /is not a usable model name/.test(t)),
    'a model that was honored must not be reported as refused');
});

test('team-review (T52): a TEMPLATE NARROWER than the cap is honored (narrows, no warning)', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplate: { tools: ['Read'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'narrowed reviewer spawns');
  const disabledTools = created[0][11];
  assert.ok(!disabledTools.includes('Read'), 'the narrowed-to Read stays enabled');
  assert.ok(disabledTools.includes('Grep') && disabledTools.includes('Glob'),
    'cap tools the template dropped are disabled — narrowing below the cap is honored');
  assert.ok(!injected.some((t) => /beyond the reviewer cap/.test(t)), 'no operator-approval line when nothing exceeds the cap');
  // t299: a partial intersection is a NARROWING and must survive the
  // empty-intersection refusal. Named here rather than left to the spawn
  // assertion above, because a refusal that over-caught would take out every
  // narrowing template and this is the case that separates the two.
  assert.ok(!injected.some((t) => /none of which are within the reviewer cap/.test(t)),
    'a template that keeps ONE cap tool is honored, not refused');
});

// --- t299: a template whose `tools` misses the cap entirely is REFUSED ---
//
// `effectiveTools` = [] inverts to a denylist of every tool, so the seat spawns
// unable to read the diff it was spawned to review — a reviewer that can only
// make things up, at the cost of a full seat and the lead's wait. The template
// is agent-writable, so falling back to the FULL cap is the one repair that must
// never be automatic: it would grant more than the template asked for. Refuse.
//
// Since t674 the template editor writes `tools`, so this state is reachable from
// the GUI too — tick only tools the cap does not hold.
test('team-review (t299): a template whose tools miss the cap entirely is refused, and burns no reviewer name', async () => {
  // EXISTENCE FIRST. The absence assertion below is equally true of a fixture
  // that never mints anything, so prove the mint DOES happen on this fixture
  // before claiming its absence means something.
  const ok = mkReview({ reviewTemplate: { tools: ['Read'] } });
  ok.m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  ok.m._handleTeamReview(ok.m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(ok.persistence.get('team-reviewer-1'),
    'ENTER: an accepted template DOES mint team-reviewer-1 on this fixture');

  // Edit, not Bash: since t673 a lone `tools: ['Bash']` is an ADMITTED request
  // that resolves to cap+Bash, so it no longer empties the intersection and
  // would spawn rather than refuse.
  const { m, injected, created, persistence } = mkReview({ reviewTemplate: { tools: ['Edit'] } });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned — a reviewer with no tools is worse than no reviewer');
  // The name-mint loop's synchronous upsert IS the reservation, so a refusal
  // placed after it would leave this record behind and every later review would
  // number one higher, silently and forever.
  assert.strictEqual(persistence.get('team-reviewer-1'), null,
    'and no reviewer name was burned — the refusal lands BEFORE the name-mint loop');
  // Exact text, not a substring of it: the operator needs BOTH lists side by
  // side to see that the sets are disjoint, and a looser finder would pass
  // against a message naming only one of them.
  assert.deepStrictEqual(injected, [
    '[agent:team-review] error: reviewer template "clodex-team-reviewer" requests tools [Edit], '
    + 'none of which are within the reviewer cap [Read, Grep, Glob] — the seat would spawn with no '
    + 'tools at all and could not read the diff; no reviewer spawned (fix the template\'s "tools")',
  ], 'the lead is told what was asked, what is allowed, and that nothing spawned');
});

// The refusal keys on requestedTools, so the no-`tools` branch is the one it
// must not touch: absent asks for nothing and takes the full cap, which shares
// none of the broken state's symptoms but every one of a naive `!length` test's.
test('team-review (t299): a template with NO tools key still spawns with the full cap', async () => {
  const { m, injected, created, persistence } = mkReview({
    reviewTemplates: [{ name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [] }],
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  assert.ok(persistence.get('team-reviewer-1'), 'ENTER: and its name was minted');
  const disabledTools = created[0][11];
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the full cap is live — asking for nothing is not asking for nothing usable');
  assert.ok(!injected.some((t) => /none of which are within the reviewer cap/.test(t)),
    'and no refusal fires on the branch that never made a request');
});

// --- t300: a malformed `tools` must not silently WIDEN to the full cap ---
//
// `[]` and a non-array both used to collapse to the same null as absent, taking
// the full-cap fallback — so a typo GRANTED authority. Both refuse now, for one
// reason: the only fallback available is the full cap, which is more than either
// asked for, and templates are agent-writable. They get DIFFERENT messages
// because they have different remedies (fix the list vs. fix the type), which is
// the t297 rule about never merging two reasons into one operator-facing line.
//
// Reachability: `[]` is not writable from the editor (an empty control omits the
// key), so it arrives by hand-editing the JSON or from another writer. A
// malformed value no longer survives an ordinary GUI edit-in-place — `tools` is
// EDITOR_OWNED since t674, so saving the template replaces it with what the
// control holds.
test('team-review (t300): tools: [] is refused, not widened to the full cap', async () => {
  // EXISTENCE FIRST: prove this fixture DOES mint before reading anything into
  // the absence below.
  const ok = mkReview({ reviewTemplate: { tools: ['Read'] } });
  ok.m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  ok.m._handleTeamReview(ok.m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(ok.persistence.get('team-reviewer-1'),
    'ENTER: an accepted template DOES mint team-reviewer-1 on this fixture');

  const { m, injected, created, persistence } = mkReview({ reviewTemplate: { tools: [] } });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned — an empty list is not a licence to grant everything');
  assert.strictEqual(persistence.get('team-reviewer-1'), null,
    'and no reviewer name was burned — the refusal lands before the name-mint loop');
  // Routed into t299's EXISTING empty-intersection message, whose remedy ("fix
  // the template\'s tools") is the right one for an empty list. Exact text: a
  // substring finder could not tell this from the malformed message below.
  assert.deepStrictEqual(injected, [
    '[agent:team-review] error: reviewer template "clodex-team-reviewer" requests tools [], '
    + 'none of which are within the reviewer cap [Read, Grep, Glob] — the seat would spawn with no '
    + 'tools at all and could not read the diff; no reviewer spawned (fix the template\'s "tools")',
  ], 'the empty-list refusal reuses the empty-intersection message');
});

test('team-review (t300): a STRING tools is refused as a TYPE fault, with its own remedy', async () => {
  const ok = mkReview({ reviewTemplate: { tools: ['Read'] } });
  ok.m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  ok.m._handleTeamReview(ok.m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(ok.persistence.get('team-reviewer-1'), 'ENTER: this fixture DOES mint when the template is accepted');

  const { m, injected, created, persistence } = mkReview({ reviewTemplate: { tools: 'Read' } });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned — a malformed request must not resolve to the full cap');
  assert.strictEqual(persistence.get('team-reviewer-1'), null, 'and no reviewer name was burned');
  // The message must name the TYPE and ask for an array. Asserted as exact text
  // because the discriminating property is which of the two refusals fired, and
  // both contain the template name and the cap.
  assert.deepStrictEqual(injected, [
    '[agent:team-review] error: reviewer template "clodex-team-reviewer" has a "tools" that is not '
    + 'an array (string) — it cannot be intersected with the reviewer cap [Read, Grep, Glob], and '
    + 'falling back to the full cap would grant more than the template asked for; no reviewer '
    + 'spawned (make "tools" an array, or remove it to accept the full cap)',
  ], 'the type fault gets its own remedy, not the fix-the-list one');
});

// t674 inverted this arm, driven through the HANDLER rather than the resolver:
// with `tools` in EDITOR_OWNED a null is a written value, not an absence, so it
// takes the malformed refusal. `typeof null` is 'object', which is what the
// operator-facing text says — asserted as exact text because the discriminating
// property is WHICH refusal fired.
test('team-review (t674): an explicit tools: null is refused as a type fault, and burns no name', async () => {
  const ok = mkReview({ reviewTemplate: { tools: ['Read'] } });
  ok.m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  ok.m._handleTeamReview(ok.m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(ok.persistence.get('team-reviewer-1'), 'ENTER: this fixture DOES mint when the template is accepted');

  const { m, injected, created, persistence } = mkReview({ reviewTemplate: { tools: null } });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned — a null must not resolve to the full cap');
  assert.strictEqual(persistence.get('team-reviewer-1'), null, 'and no reviewer name was burned');
  assert.deepStrictEqual(injected, [
    '[agent:team-review] error: reviewer template "clodex-team-reviewer" has a "tools" that is not '
    + 'an array (object) — it cannot be intersected with the reviewer cap [Read, Grep, Glob], and '
    + 'falling back to the full cap would grant more than the template asked for; no reviewer '
    + 'spawned (make "tools" an array, or remove it to accept the full cap)',
  ], 'the type-fault refusal, whose remedy — remove the key — is the right one for a null');
});

// The branch the null move must NOT touch, through the same handler: an absent
// key still spawns with the full cap. Without this the assertions above are
// equally true of a guard that refuses every template.
test('team-review (t674): an ABSENT tools key still spawns with the full cap', async () => {
  const { m, injected, created, persistence } = mkReview({
    reviewTemplates: [{ name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [] }],
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  assert.ok(persistence.get('team-reviewer-1'), 'ENTER: and its name was minted');
  const disabledTools = created[0][11];
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the full cap is live — absent is the documented default');
  assert.ok(!injected.some((t) => /not an array|none of which are within/.test(t)),
    'and neither refusal fires');
});

// T52: template omits tools → the role manifest's tools drive (fallback), still
// capped. Proves template > role > built-in precedence for the tools field.
// t292: `tools` left the role schema. A def that still carries one (a version-1
// team.json on disk, hand-authored) must change NOTHING — the template is the
// only narrowing source now. The old behavior was a role field driving the cap
// on the one path that read it while being inert on every other role.
test('team-review: a role def still carrying `tools` does not narrow the cap', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplates: [{ name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [],
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', FORCE_PROMPT_CACHING_5M: '1', CLODEX_DISABLE_IPC_PROMPT: '1' } }],
    reviewerRole: { prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: ['Read', 'Bash'], template: null, dispatch: 'standing' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: the reviewer spawned');
  const disabledTools = created[0][11];
  // The full cap is live: the role asked to DROP Grep/Glob and to ADD Bash, and
  // neither happened. A stale field must not still be steering the one path that
  // ever read it.
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the whole cap stays enabled — the role def did not narrow it to [Read]');
  assert.ok(disabledTools.includes('Bash'),
    'and it certainly did not widen it: the cap is code, not a manifest field');
  assert.ok(!injected.some((t) => /beyond the reviewer cap/.test(t)),
    'no beyond-cap line, because the role def is no longer a request at all');
});

test('team-review: an ABSENT manifest tools list applies the cap as-is', async () => {
  const { m, injected, created } = mkReview({
    reviewerRole: { prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      template: null, dispatch: 'standing' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'a reviewer with no manifest tools spawns');
  const disabledTools = created[0][11];
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the cap (Read/Grep/Glob) is the effective allowlist when the manifest is silent');
  assert.ok(disabledTools.includes('Bash') && disabledTools.includes('Edit') && disabledTools.includes('Write'),
    'everything outside the cap is disabled');
  assert.ok(!injected.some((t) => /beyond the reviewer cap/.test(t)), 'no operator-approval line for a silent manifest');
});

// --- T52: env keys through REVIEWER_ENV_ALLOWLIST (a doctored template can't set
// an authority env key on a review seat) ---
test('team-review (T52): a template env key OUTSIDE the allowlist is DROPPED with a loud line; allowed keys pass', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplate: {
      env: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', // allowed
        FORCE_PROMPT_CACHING_5M: '1',        // allowed
        CLODEX_DISABLE_IPC_PROMPT: '1',      // allowed
        ANTHROPIC_BASE_URL: 'http://evil',   // NOT allowed — must be dropped
        CLODEX_REMOTE_TOKEN: 'secret',       // NOT allowed — must be dropped
      },
    },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'still spawns — a capped review beats no review');
  const sessionEnv = created[0][18]; // 0-indexed: intents(17), sessionEnv(18)
  assert.deepStrictEqual(sessionEnv, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
  }, 'only the three allowlisted keys survive; the authority keys are stripped');
  assert.ok(injected.some((t) => /ANTHROPIC_BASE_URL/.test(t) && /CLODEX_REMOTE_TOKEN/.test(t) && /outside the allowed set/.test(t) && /authority surface/.test(t)),
    'the lead gets a loud line naming the dropped keys + the authority-surface reason');
});

test('team-review: a resolver throw reaches the lead instead of becoming an unhandled rejection', async () => {
  // The resolver's purpose guard is fail-CLOSED, and this handler is reached
  // from an unawaited async _handleIntent — so an uncaught throw here would be
  // an unhandled rejection with the lead told nothing, and a future bad-purpose
  // literal would look like a review that simply never happened.
  // Fail-closed is only useful if it is also fail-visible.
  const { m, injected, created, persistence } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m.resolveSeatShape = () => { throw new Error('unknown purpose "reviewer"'); };
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 0, 'nothing spawns — the guard is the point');
  assert.ok(injected.some((t) => /unknown purpose/.test(t)),
    `the lead must be told why no reviewer appeared, got: ${JSON.stringify(injected)}`);
  // The name reservation must not survive the bail. Nothing leaks today (the
  // early return precedes the upsert), but reordering the reservation above the
  // resolver call would otherwise burn a seat name on every failed review —
  // silently, since each attempt would just number one higher.
  assert.strictEqual(persistence.get('team-reviewer-1'), null,
    'a failed review must not consume the seat name');
});

test('team-review: an ALLOWED key with a non-string value is reported as a type problem, not an authority one', async () => {
  // The two drop reasons must stay separate. Telling the operator that
  // CLODEX_DISABLE_IPC_PROMPT is "outside the allowed set" is false — the key is
  // allowed, the value is not a string — and sends them to request approval for
  // a key they already have instead of quoting the value in the template.
  const { m, injected, created } = mkReview({
    reviewTemplate: {
      env: {
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', // allowed, well-typed
        CLODEX_DISABLE_IPC_PROMPT: 1,        // allowed KEY, bad value type
      },
    },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'still spawns');
  assert.deepStrictEqual(created[0][18], { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    'the badly-typed value must not be coerced through');
  const line = injected.find((t) => /allowed but their values are not strings/.test(t));
  assert.ok(line, 'the type problem must be stated in its own words');
  assert.match(line, /CLODEX_DISABLE_IPC_PROMPT/, 'and must name the key');
  // The half that carries the finding. EVERY key in this fixture is allowlisted,
  // so the authority sentence must not appear at all — a merged warn clause
  // would emit it and send the operator to request approval for a key they have.
  // (Asserting on a prefix-slice would not work: the key name is printed BEFORE
  // the reason phrase, so it is in the prefix either way.)
  assert.ok(!/outside the allowed set/.test(line),
    `no key here is outside the allowlist, so that reason must not be given; got: ${line}`);
  // Asserted across EVERY injected message, not just the found line: today both
  // clauses concatenate into one reply, so a future split into two messages
  // would move the wrong clause out of `line`'s scope and the check above would
  // stop seeing it. True of this fixture by construction either way.
  assert.ok(!injected.some((t) => /outside the allowed set/.test(t)),
    'the authority reason must appear nowhere for an allowlisted key');
});

// --- T52: missing/unparseable template → fall back to the built-in constants
// (a review beats no review), loud NOTE line ---
test('team-review (T52): a MISSING template falls back to the built-in reviewer constants with a NOTE', async () => {
  const { m, injected, created } = mkReview({ reviewTemplates: [] }); // no reviewer template in the library
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'still spawns from the built-in fallback');
  const [ , , , , , , , , , , , disabledTools, , , systemPromptFile, , execCommands, intents, sessionEnv] = created[0];
  // Fallback values == the shipped default's payload byte-for-byte.
  assert.strictEqual(systemPromptFile, 'clodex-team-reviewer', 'fallback system prompt');
  assert.deepStrictEqual(intents, [], 'fallback intents []');
  assert.deepStrictEqual(execCommands, [], 'no exec grant');
  assert.deepStrictEqual(sessionEnv, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  }, 'fallback env == the shipped template env map');
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'), 'fallback tools = the cap');
  assert.ok(disabledTools.includes('Bash') && disabledTools.includes('Edit'), 'everything outside the cap disabled');
  assert.ok(injected.some((t) => /reviewer template "clodex-team-reviewer" not found/.test(t) && /built-in defaults/.test(t)),
    'the lead gets a loud NOTE that the template was missing and defaults were used');
});

// --- T52 MUST-FIX: template intents are stripped of PRIVILEGED intents at consume.
// The template is agent-writable, so a doctored one carrying `reboot` (or any
// privileged intent) must not self-grant it onto the review seat — withoutPrivilegedIntents
// (the real leaf, injected at the top of this file) runs at the consume point. Every
// other T52 test uses intents [], so without THIS pin a refactor that passed
// reviewTpl.intents raw would stay green. ---
test('team-review (T52): a template carrying a PRIVILEGED intent has it STRIPPED (reboot dropped; plain intents pass)', async () => {
  const { m, created } = mkReview({ reviewTemplate: { intents: ['reboot', 'dm', 'who'] } });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'spawns');
  const intents = created[0][17]; // 0-indexed: intents(17)
  assert.deepStrictEqual(intents, ['dm', 'who'],
    'the privileged `reboot` is stripped at the consume point; the non-privileged intents survive');
});

// --- t8 F1, second strip site: the same hole at the REVIEWER template consume
// point. `reboot` above is in intent-catalog's literal Set; a plugin verb is
// privileged via its registry row instead, so only the registry-aware strip sees
// it. The reviewer template is agent-writable, so this is a self-grant path. ---
test('t8 F1: a reviewer template carrying a PLUGIN verb has it STRIPPED (registry-aware, not just core privileged)', async () => {
  await withVerb({ type: 'fake-grant', parse: (c) => (c === '[agent:fake-grant]' ? {} : null) }, async () => {
    const { m, created } = mkReview({ reviewTemplate: { intents: ['fake-grant', 'dm', 'who'] } });
    m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
    m._handleTeamReview(m.sessions.get('lead'), 'scope');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(created.length, 1, 'spawns');
    assert.deepStrictEqual(created[0][17], ['dm', 'who'],
      'the plugin verb is dropped at the reviewer consume point; ordinary intents survive');
  });
});

// --- T52 NIT (defense-in-depth): a template systemPromptFile that could escape
// library/prompts/system (path separator or "..") is rejected AT THE REVIEWER
// CONSUME POINT and falls back to the shipped default, with a loud warn. ---
test('team-review (T52): a traversing systemPromptFile is rejected → falls back to the default prompt + loud warn', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplate: { systemPromptFile: '../../../../tmp/evil' },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'still spawns — the escape is neutralized, not fatal');
  const systemPromptFile = created[0][14]; // 0-indexed: systemPromptFile(14)
  assert.strictEqual(systemPromptFile, 'clodex-team-reviewer',
    'the traversing stem is dropped; the built-in default prompt is used instead');
  assert.ok(injected.some((t) => /contains a path separator or "\.\."/.test(t) && /could escape library\/prompts\/system/.test(t)),
    'the lead gets a loud NOTE naming the rejected stem and the reason');
});

// --- t151: the reviewer path itself no longer knows what a spawner hint IS ---
// It reached the lever through a bespoke `spawnerHint` template field read at one
// call site; it now reaches it the same way every other seat does, by threading
// CLODEX_SPAWNER_HINT through sessionEnv. Two claims, and the second is what stops
// the deleted branch growing back as a "harmless" synonym.
test('team-review (t151): the reviewer gets its hint through sessionEnv, and the handler POSTs nothing itself', async () => {
  const hints = [];
  const { m, created } = mkReview({
    resolveProxyBase: () => 'http://127.0.0.1:7811',
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created[0][18].CLODEX_SPAWNER_HINT, 'off',
    'the shipped template ships the key in env — create() reads it, so the behaviour is unchanged');
  assert.deepStrictEqual(hints, [],
    'the team-review handler makes NO hint POST of its own — create() owns the lever, single reader');
});

test('team-review (t151): a leftover `spawnerHint` template FIELD is inert (env is the only reader)', async () => {
  // A stale template on disk may still carry the deleted field. Honoring it as a
  // synonym would restore the two-reader shape this ticket removed — and quietly
  // route around REVIEWER_ENV_ALLOWLIST, which only screens `env`.
  const hints = [];
  const { m, created } = mkReview({
    reviewTemplates: [{ name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [],
      tools: ['Read', 'Grep', 'Glob'], env: {}, spawnerHint: 'off' }],
    resolveProxyBase: () => 'http://127.0.0.1:7811',
    ProxyClient: { spawnerHint: (base, agent, opts) => { hints.push({ base, agent, opts }); return Promise.resolve({}); } },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created[0][18], {}, 'the field does not become env — it is dead data');
  assert.deepStrictEqual(hints, [], 'and it drives no POST');
});

// t425. The preflight below had NEVER EXECUTED on the shared review fixture:
// mkReview wired no `path`, so `path.join` threw and the best-effort catch ate
// it — 33 swallowed TypeErrors across the suite, and a warning nothing could
// reach. These three pin the branch as REACHED, not merely as passing.
//
// This one takes NO dep overrides at all. That is the point: it drives the
// missing-prompt arm through the fixture every other review test uses, which is
// only expressible now that mkReview seeds `path` + a real REGISTRY_DIR.
test('team-review (t425): the prompt preflight RUNS on the shared fixture — no per-test dep overrides', async () => {
  const { m, injected, created, promptDir } = mkReview();
  // The fixture installs the prompt; remove it so the preflight has something to
  // FIND MISSING. A warn appearing without this would mean the branch was skipped
  // and the text came from somewhere else.
  const installed = pathReal.join(promptDir, 'clodex-team-reviewer.md');
  assert.ok(fsReal.existsSync(installed), 'ENTER: the fixture seeds the prompt, so removing it is what drives the arm');
  fsReal.rmSync(installed);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(created.length, 1, 'ENTER: the seat still spawned — the warn is advisory, never a block');
  const confirm = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(confirm, `ENTER: the confirm line must have landed, got: ${JSON.stringify(injected)}`);
  // The branch RAN: only a real path.join + a real existsSync over the fixture's
  // own registry can produce this. Under the old fixture the join threw and this
  // was unreachable — which is what made the whole preflight dead code here.
  assert.match(confirm, /boots UNBRIEFED/,
    'the preflight reached its stat and reported the missing prompt');
});

// The other half of the same proof, and the one that makes the first half mean
// something: with the file PRESENT the fixture's default reply carries no warn.
// A preflight that threw would also produce no warn, so this pins that the
// absence is a decision rather than a skipped branch — the arm above is what
// separates the two.
test('team-review (t425): the fixture default installs the prompt, so the preflight statted it and stayed quiet', async () => {
  const { m, injected, created, promptDir } = mkReview();
  assert.ok(fsReal.existsSync(pathReal.join(promptDir, 'clodex-team-reviewer.md')),
    'ENTER: the seeded registry really carries the prompt the template names');
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'ENTER: one seat spawned');
  const confirm = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(confirm, 'ENTER: the confirm line must have landed');
  assert.ok(!/UNBRIEFED/.test(confirm), 'no warn — the stat found the installed prompt');
});

// t425, the NON-NEGOTIABLE property of the catch: it exists so a STAT error is
// not a spawn blocker, and narrowing it must not have cost that. Driven with an
// fs whose existsSync THROWS — a disk that answered badly, which is the case the
// catch was written for and the one it must keep swallowing.
test('team-review (t425): a genuine existsSync failure is still swallowed — the reviewer spawns', async () => {
  const { m, injected, created } = mkReview({
    fs: { ...fsReal, existsSync: () => { throw new Error('EIO: disk said no'); } },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(created.length, 1,
    `ENTER: the seat spawned despite the stat throwing — a stat error is not a spawn blocker; replies: ${JSON.stringify(injected)}`);
  const confirm = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(confirm, 'the lead got its confirm line, not an error reply');
  assert.ok(!/UNBRIEFED/.test(confirm), 'and no warn was invented from a stat that never answered');
  assert.ok(!injected.some((t) => /EIO: disk said no/.test(t)), 'the stat error never reaches the lead');
});

// t425, the other side of the narrowing: a WIRING error is not a stat error and
// must NOT be swallowed. `path` unwired is a host that failed to inject a dep —
// with the join inside the try it vanished, taking the whole preflight with it.
// Now it surfaces. Nothing in production leaves this unwired (engine.js passes
// the real module); the fixture is the only place it has ever happened, and it
// hid there for two tickets.
test('team-review (t425): an UNWIRED path dep surfaces instead of silently skipping the preflight', async () => {
  const { m, persistence } = mkReview({ path: undefined });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  assert.strictEqual(persistence.list().length, 0, 'ENTER: no seat is reserved before the call');
  assert.throws(
    () => m._handleTeamReview(m.sessions.get('lead'), 'scope'),
    // Matched on the SHAPE, not V8's sentence: the wording changed once already
    // (`Cannot read property 'join' of undefined` before Node 16), and a pin on
    // the exact phrasing reds on an engine bump while claiming a real defect.
    (e) => e instanceof TypeError && /join/.test(e.message),
    'the missing dep reaches someone rather than being absorbed as a best-effort stat failure');
  // And it costs NOTHING that has to be cleaned up. The join sits above the name
  // reservation for exactly this reason: the only code that frees a reserved name
  // is the deferred spawn's catch, which a synchronous throw never reaches, so a
  // join below the upsert would strand `team-reviewer-1` on every wiring error.
  assert.deepStrictEqual(persistence.list(), [],
    'the throw burned no seat name — nothing survives it needing cleanup');
});

// NIT 3 (unbriefed-reviewer trap): create() silently skips a missing role prompt.
// Preflight it and warn on the lead's confirm line so a team that never installed
// the prompt gets a signal rather than a silently-unbriefed reviewer.
test('team-review: a missing role-prompt file appends an UNBRIEFED warning to the confirm line', async () => {
  const REGISTRY_DIR = mkTmpRoot('clodex-review-');
  // Empty registry — library/prompts/system/clodex-team-reviewer.md does NOT exist.
  const { m, injected, created } = mkReview({ REGISTRY_DIR, fs: fsReal, path: pathReal });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'still spawns — the warning is advisory, not a block');
  assert.ok(injected.some((t) => /boots UNBRIEFED/.test(t)), 'confirm line warns the prompt is missing');
});

// The prompt file PRESENT → no warning.
test('team-review: an installed role-prompt file yields NO unbriefed warning', async () => {
  const REGISTRY_DIR = mkTmpRoot('clodex-review-');
  const dir = pathReal.join(REGISTRY_DIR, 'library', 'prompts', 'system');
  fsReal.mkdirSync(dir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(dir, 'clodex-team-reviewer.md'), 'you are the reviewer');
  const { m, injected } = mkReview({ REGISTRY_DIR, fs: fsReal, path: pathReal });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.ok(injected.some((t) => /spawned team-reviewer-1/.test(t)), 'confirmed');
  assert.ok(!injected.some((t) => /UNBRIEFED/.test(t)), 'no warning when the prompt is installed');
});

// t414 nit 3, a lead ruling: the rule is "reported ONCE". A reviewer whose prompt
// rides as --system-prompt-file now fails BOTH the promptWarn above and create()'s
// own missingPrompt finding, both landing in this one reply to this one lead. The
// pre-existing warn wins; the relay stands down. Accepting the double-report is
// how a rule stops being one.
test('team-review (t414): a missing prompt reports ONCE — the spawn relay defers to the existing promptWarn', async () => {
  const REGISTRY_DIR = mkTmpRoot('clodex-review-');
  const { m, injected, created } = mkReview({ REGISTRY_DIR, fs: fsReal, path: pathReal });
  // create() would have found it too — this is the double-report shape, made
  // real rather than assumed: without the dedupe both texts land in one reply.
  m.create = async (...args) => {
    created.push(args);
    return { name: args[0], missingPrompt: 'role "reviewer" names system prompt "clodex-team-reviewer", which is not installed under library/prompts/system — team-reviewer-1 boots with NO system prompt' };
  };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  const confirm = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(confirm, 'ENTER: the confirm line must exist — every assertion below reduces to it');
  // ONE mention of the missing prompt, not two. Counted rather than matched:
  // the two texts are worded differently on purpose, so a `.match` on either
  // one alone passes while the other is also present.
  assert.strictEqual((confirm.match(/clodex-team-reviewer/g) || []).length, 1,
    'the missing prompt is named exactly once in the reply');
  assert.match(confirm, /boots UNBRIEFED/, 'and the surviving one is the pre-existing warn, which names the recovery');
  assert.ok(!/NO system prompt/.test(confirm), 'the new relay stood down rather than appending a second copy');
});

test('team-review (t414): with no promptWarn to defer to, the spawn finding DOES ride the reply', async () => {
  const REGISTRY_DIR = mkTmpRoot('clodex-review-');
  const dir = pathReal.join(REGISTRY_DIR, 'library', 'prompts', 'system');
  fsReal.mkdirSync(dir, { recursive: true });
  // Installed, so the pre-existing promptWarn stays empty and the dedupe above
  // does not fire — the arm that proves the relay is wired at all rather than
  // merely always suppressed.
  fsReal.writeFileSync(pathReal.join(dir, 'clodex-team-reviewer.md'), 'you are the reviewer');
  const { m, injected, created } = mkReview({ REGISTRY_DIR, fs: fsReal, path: pathReal });
  m.create = async (...args) => { created.push(args); return { name: args[0], missingPrompt: 'SOMETHING ELSE DID NOT RESOLVE' }; };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  const confirm = injected.find((t) => /spawned team-reviewer-1/.test(t));
  assert.ok(confirm, 'ENTER: the confirm line must exist');
  assert.match(confirm, /WARNING: SOMETHING ELSE DID NOT RESOLVE/);
});

// NIT 5: a team with no `reviewer` role bounces the lead, nothing spawned.
test('team-review: a team with no reviewer role bounces the lead', async () => {
  const { m, injected, created } = mkReview({
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj')
      ? { name: 'team', root: '/proj', lead: 'lead', file: '/proj/team.json',
          roles: { lead: { instantiate: 'session', brief: 'the lead' } } }
      : null),
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(created, [], 'no seat spawned without a reviewer role');
  assert.ok(injected.some((t) => /no "reviewer" role to spawn/.test(t)), 'bounced with the missing-role reason');
});

// --- [agent:task …] — team ticket protocol (Task 25) ------------------------
// A team LEAD opens/directs tickets; an ASSIGNEE closes them; clodex owns the
// registry (tickets.json), lifecycle, and stall watchdog. The fixture uses a REAL
// temp clodex HOME so the ticket store round-trips to disk (like the T24 prompt
// preflight); the board is the PROJECT's, so it resolves off `team.root` under
// that home and the manager must be given the same home as REGISTRY_DIR or the
// two halves of every assertion read different files. Seats are named per the
// <team>-<role> convention so matchSeatRole binds them; the lead seat is `lead`
// (team.lead).
const ticketsMod = require('../tickets-store');
// The two placement primitives the dispatch's TASK DIR line goes through.
// Required rather than restated: a test that hardcoded the `<leaf>-<hash8>`
// shape would keep passing if the shape changed under it, and pin nothing.
const clodexPaths = require('../clodex-paths');
const teamCost = require('../team-cost');

function mkTasks(extra = {}) {
  const home = mkTmpRoot('clodex-tk-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer' },
    },
  };
  const overrides = {
    fs: fsReal, path: pathReal, countPending: countPendingReal,
    REGISTRY_DIR: home,
    // Injected because the stall alarm reads the seat's transcript through it.
    // Left out, `pathFor` is undefined inside the manager and the evidence probe
    // throws into its own best-effort catch — the alarm still fires, so the only
    // symptom is a silently missing field. That is the exact failure shape the
    // evidence exists to prevent, reproduced in the fixture.
    pathFor: pathForReal,
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    ...extra,
  };
  const { m, injected } = mkPark(overrides);
  const gated = [];
  const broadcasts = [];
  // `urgent` rides a SEPARATE array on purpose: several tests below pin `gated`
  // with deepStrictEqual, and widening the recorded shape would force those
  // pins to be rewritten to accommodate a field they are not about.
  const urgents = [];
  // `tags` rides its own array for exactly the reason `urgents` does: the pins
  // below assert `gated` with deepStrictEqual. The tag is the ONLY thing a seat
  // sees when a body spills, and every ticket dispatch spills now, so it needs to
  // be observable — but not at the cost of rewriting those pins.
  const tags = [];
  // Fires `onWrite` (6th arg), because this stub models a delivery that REACHES
  // THE WRITE. A stub that took it and never called it would model a permanently
  // wiped write, so every caller that stamps from onWrite (the watchdog nudge)
  // would look permanently broken; a stub that ignored the arg would silently
  // certify the old stamp-on-return behaviour. Tests wanting the never-written
  // case override with a stub that omits the call.
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    gated.push({ target, sender, body }); urgents.push(urgent); tags.push(tag);
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._sendToSession = () => {};
  const seat = (name, cwd = '/proj', props = {}) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle', ...props });
    return m.sessions.get(name);
  };
  const load = () => tstore.load(team.root);
  const one = (id) => load().find((t) => t.id === id);
  // t431: dispatch refuses a ticket whose spec names no `tasks/…` path, since the
  // review step would have nowhere to write its diff. The specs in this file are
  // written to exercise DISPATCH, not artifact resolution, so the precondition is
  // supplied here rather than by editing a hundred spec strings.
  //
  // Stamped onto the RECORD after `add`, never appended to the spec text: a
  // large number of assertions in this file pin the delivered body byte-for-byte
  // through `specBody`, and widening the spec would break every one of them for
  // a reason that has nothing to do with what they test. Tests that want the
  // task-dir-less case set it back to undefined themselves — the gate's own
  // tests live in task-start.test.js.
  //
  // t453: and stamped ALREADY-RESOLVED, for the same byte-for-byte reason. A
  // RELATIVE pointer earns a `TASK DIR:` line in the delivered body; an absolute
  // one does not, and resolveTaskDir maps both to the same directory.
  const handleTask = m._handleTask.bind(m);
  m._handleTask = (session, intent) => {
    const isAdd = intent && intent.type === 'task' && intent.sub === 'add';
    const before = isAdd ? new Set(tstore.load(team.root).map((t) => t.id)) : null;
    const r = handleTask(session, intent);
    if (isAdd) {
      const ts = tstore.load(team.root);
      let touched = false;
      // Only the ids this `add` INTRODUCED. Stamping every task-dir-less ticket on
      // the board would resurrect state a test deliberately built: strip `taskDir`
      // from t1, file t2, and the loop silently puts t1's back.
      for (const t of ts) {
        if (!before.has(t.id) && !t.taskDir) {
          t.taskDir = pathReal.join(clodexPaths.projectDirFor(home, team.root), 'tasks', `${t.id}-fixture`, 'SPEC.md');
          touched = true;
        }
      }
      if (touched) tstore.save(team.root, ts);
    }
    return r;
  };
  return { m, injected, gated, urgents, tags, broadcasts, team, home, tstore, seat, load, one };
}

// t353: every dispatched spec carries the close verb. The literal lives here ONCE
// and is COPIED from _deliverTicketSpec rather than imported — that is the point:
// the many deepStrictEqual pins below assert the whole delivered body, so an edit
// to the production line fails them all until it is re-read here deliberately. Two
// beliefs cost three hands a closed ticket each ("closing needs an exec grant",
// "a dm with my report closes it"), so both denials are pinned by name below.
const CLOSE_LINE = (id) => `CLOSE WITH: [agent:task done ${id}] <your report> — one intent, at the end: it delivers the report to the lead AND marks the ticket done. `
  + `It is a line you emit yourself, like any [agent:…] intent — NOT an exec command, and nothing needs to be granted for it. `
  + `A dm carrying your report does NOT close the ticket: the ticket stays open, and everything downstream of the close (tree verify, review) never runs.\n`;
// The whole delivered body for an ordinary (non-worktree, non-replay) dispatch.
const specBody = (id, spec) => `[ticket ${id}] ${CLOSE_LINE(id)}${spec}`;

// t522. Copied from `_deliverTicketSpec` for the same reason CLOSE_LINE is: the
// pins here assert whole bodies, so a production edit reds them until it is
// re-read across. Rides ONLY a dispatch whose ticket was backlog (`!prev` at the
// assign) — every specBody() pin above is a case where it must be ABSENT, so an
// unconditional line would red them en masse rather than silently widening.
const BACKLOG_LINE = 'This ticket had no assignee until this dispatch, so its body was written while nobody was on it and may '
  + 'tell you it is blocked, parked, or awaiting someone\'s word before you start. On that ONE question — whether to '
  + 'begin — the board is current and the body is a filing-time snapshot: the board says start, so start. This '
  + 'discharges nothing else. Every other caveat, constraint, scope fence and hazard in the body stands exactly as '
  + 'written. And if the body gates on a specific condition you cannot confirm was met, report that rather than '
  + 'assuming it was discharged.\n';
const backlogSpecBody = (id, spec) => `[ticket ${id}] ${BACKLOG_LINE}${CLOSE_LINE(id)}${spec}`;

// t351: the ADVANCE delivers a spec the seat has already been sent once —
// `_openTicketsFor` only yields started tickets, and both dispatch verbs deliver
// on start — so every advance is a redelivery and carries the REPLAY head. Copied
// from `_deliverTicketSpec` for the same reason CLOSE_LINE is: the pins below
// assert whole bodies, so a production edit fails them until it is re-read here.
const REPLAY_HEAD = (id) => `[ticket ${id} REPLAY] this ticket was already open and assigned to you when this process `
  + `started, so an earlier incarnation of you may have already done some or all of it. `
  + `BEFORE you build, edit, or commit anything: run \`git status\` and \`git log\` and check the task `
  + `artifact. Then — if the work is DONE, close the ticket instead of redoing it; if NOTHING was `
  + `started, do the task as specified below; if it is PARTIALLY done, do NOT restart it — report what `
  + `you found and ask how to proceed.\n`;
const replayBody = (id, spec) => `${REPLAY_HEAD(id)}${CLOSE_LINE(id)}${spec}`;

// t353 r2. The close line put the head at 417 bytes (plain) / ~733 (worktree)
// against MSG_SPILL_THRESHOLD's 500, so a plain dispatch spills once its spec
// exceeds 83 chars and a worktree dispatch spills unconditionally. A spilled body
// is announced ONLY as "Message (N bytes) attached", so the pointer tag is the
// entire basis on which a seat decides to spend a Read turn — a tag naming neither
// the ticket nor the verb would put the close verb behind the very turn this
// ticket exists to save. The tag was unpinned before this.
//
// The 83-char boundary is asserted rather than assumed: an earlier draft of this
// test claimed EVERY dispatch spills and used an 8-char spec, which did not — its
// ENTER caught the overclaim. A spec that short does not occur in practice, but a
// test that states it does would be describing a system nobody runs.
test('t353: a realistic dispatch spills, so the POINTER carries the id and the close verb', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  const spec = 'rework the widget so it stops double-counting on the retry path, and pin the new count';
  // Derived, not hardcoded: the 83-char boundary is 500 minus the head, so an edit
  // to the close line moves it. A literal would silently stop meaning "long enough
  // to spill" and start meaning "83".
  assert.ok(spec.length > 500 - specBody('t1', '').length,
    'ENTER: the spec must be long enough to spill, or the tag is not what the seat sees');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.ok(f.gated[0].body.length > 500,
    `ENTER: the dispatch must actually spill (body was ${f.gated[0].body.length} bytes), or the tag is cosmetic`);
  assert.deepStrictEqual(f.tags, ['[ticket t1] close with [agent:task done t1]'],
    'the pointer names the ticket AND the verb — it is all a seat sees before deciding to open the file');
});

// The tag rides EVERY dispatch, spilled or not: whether a body spills is a
// function of spec length, which is not something the dispatch path should have
// to reason about. A tag applied only when it spills would be correct today and
// wrong the moment the threshold moves.
test('t353: the pointer tag rides even a dispatch too short to spill', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'tiny' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.ok(f.gated[0].body.length < 500,
    'ENTER: this one must NOT spill, or it is the same case as the test above');
  assert.deepStrictEqual(f.tags, ['[ticket t1] close with [agent:task done t1]'],
    'the tag does not depend on the spill decision');
});

test('t353: the close verb is never at column 1, in the body or the tag', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // The delivered text contains a COMPLETE, ready-to-fire intent. It is inert only
  // because parseIntent is ^-anchored and this never starts a line. A reflow that
  // moved it to column 1 would make a seat close its own ticket on receipt — the
  // spec text arrives, the scanner fires, the ticket is done before any work is.
  for (const line of f.gated[0].body.split('\n')) {
    assert.ok(!line.startsWith('[agent:'),
      `no delivered line may START with an intent — found: ${line.slice(0, 60)}`);
  }
  // The tag is prefixed with "[agent:from <sender>] " by _buildDeliveryText, so it
  // is not at column 1 either; asserted at the tag itself since that prefix is
  // applied downstream of this fixture.
  assert.ok(!f.tags[0].startsWith('[agent:'), 'the pointer tag does not open with a firing intent');
});

// t308 split this test's subject in two. It used to pin add's WHOLE job —
// mint, re-pin to the receiving seat, deliver, confirm — because add did all
// four. Add now writes only, so the record fields stay here and the re-pin and
// the delivery moved to the `start` half below (and to test/task-start.test.js,
// which owns that verb). The pair still covers every assertion the original had.
test('task add (assigned): mints t1 with the role as its durable assignee, and dispatches NOTHING', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  const t = f.one('t1');
  assert.ok(t, 'ticket persisted');
  // Still the ROLE, not the seat: the re-pin is a delivery-time act, and there
  // has been no delivery. `role` is unwritten for the same reason — it is the
  // marker a dispatch path leaves behind.
  assert.strictEqual(t.assignee, 'hand', 'filed against the role; nothing has received it yet');
  assert.strictEqual(t.role, undefined, 'no delivery-time pin, so no role marker');
  assert.strictEqual(t.state, 'open');
  assert.strictEqual(t.title, 'build the widget');
  assert.strictEqual(t.opener, 'lead');
  assert.deepStrictEqual(f.gated, [],
    'add DELIVERS NOTHING — the seam the whole ticket loop hangs on is that writing a ticket and running it are two acts');
  assert.ok(f.injected.some((x) => /ticket t1 → hand \(not started\)/.test(x)), 'lead confirmed, and told it is not started');
  assert.ok(f.injected.some((x) => /\[agent:task start t1\]/.test(x)), 'and told the verb that starts it');
});

test('task start (assigned): re-pins to the receiving seat and delivers the spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const t = f.one('t1');
  // Re-pinned at delivery: `role` is what the lead filed it under, `assignee` is
  // the seat that actually received it, so the close-time cost path reads a seat
  // instead of inferring one.
  assert.strictEqual(t.assignee, 'team-hand', 'pinned to the seat that received it');
  assert.strictEqual(t.role, 'hand', 'the filed role survives the pin');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'build the widget\ndetail') }],
    'spec delivered to the live seat holding the role, id-prefixed');
  assert.ok(f.injected.some((x) => /ticket t1 → hand/.test(x)), 'lead confirmed');
});

// _teamLiveSeats returns { name, label } for the roster's warmth column, while
// _resolveAssignee and _ticketAssigneeSeat match a SEAT NAME against that list
// through _teamLiveSeatNames. Two shapes over one walk: a consumer wired to the
// wrong one silently resolves nothing, and the role-addressed path above would
// stay green throughout. This is the name-addressed path, which nothing else
// covers.
test('task add/start (name-addressed): a live seat name resolves as an assignee and receives the spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'team-hand', id: null, body: 'name-addressed work' });
  const t = f.one('t1');
  assert.ok(t, 'ticket persisted');
  assert.strictEqual(t.assignee, 'team-hand', 'the seat NAME is stored as the assignee, not a role');
  // The delivery moved to `start` (t308); the RESOLUTION under test did not. A
  // name-addressed ticket carries no `role`, so it is the case where the two
  // resolvers (_teamLiveSeats vs _teamLiveSeatNames) can silently disagree —
  // which is what this test has always been for.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'name-addressed work') }],
    'the spec reaches the named seat — _ticketAssigneeSeat resolved it by name');
});

test('task add (name-addressed): a name that is neither a role nor a live seat is refused', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'team-ghost', id: null, body: 'work' });
  assert.strictEqual(f.load().length, 0, 'no ticket minted for an unresolvable assignee');
  assert.deepStrictEqual(f.gated, [], 'nothing delivered');
});

test('task add records a taskDir when the spec first line names one', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'work tasks/25-team-tickets/spec.md' });
  assert.strictEqual(f.one('t1').taskDir, 'tasks/25-team-tickets/spec.md');
});

test('task add (backlog): unassigned, no delivery, confirmed as backlog', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'someday task' });
  assert.strictEqual(f.one('t1').assignee, null);
  assert.deepStrictEqual(f.gated, [], 'nothing delivered for a backlog ticket');
  assert.ok(f.injected.some((x) => /ticket t1 \(backlog\)/.test(x)));
});

test('task start on a role with no live seat: kept on the role, and the lead is warned it was not delivered', () => {
  const f = mkTasks();
  f.seat('lead'); // no team-hand live
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'hand', 'role is the durable assignee even with no live seat');
  assert.deepStrictEqual(f.gated, [], 'no live seat → nothing delivered');
  // The warning belongs to the verb that TRIED to deliver. Under t308 that is
  // `start`: add no longer attempts a delivery, so it has nothing to warn about.
  assert.ok(f.injected.some((x) => /no live seat for "hand"/.test(x)), 'lead warned spec not delivered');
});

test('task assign: a backlog ticket gets an assignee and the spec is delivered', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'team-hand', 'pinned to the seat the spec reached');
  assert.strictEqual(f.one('t1').role, 'hand', 'filed under the role');
  // t522: this is the backlog→assigned dispatch, so the body carries the gate-
  // discharge line. Byte-asserted through backlogSpecBody rather than matched,
  // so the line's exact scope wording is pinned and not just its presence.
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: backlogSpecBody('t1', 'the spec') }]);
  assert.ok(f.injected.some((x) => /ticket t1 → hand/.test(x)));
});

// t522, the ABSENT direction. Presence alone passes if the line is
// unconditional, so the two halves are only meaningful as a pair. A REASSIGNMENT
// between two roles is the worked case: `prev` is the old role, so the ticket was
// never in the backlog and its body was written under an assignee.
test('t522: the backlog line is ABSENT when the ticket was reassigned, not released from backlog', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  assert.strictEqual(f.one('t1').assignee, 'hand', 'ENTER: filed WITH an assignee — never backlog, which is the arm under test');
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  const toNew = f.gated.filter((g) => g.target === 'team-reviewer-1');
  assert.deepStrictEqual(toNew, [{ target: 'team-reviewer-1', sender: 'lead', body: specBody('t1', 'the spec') }],
    'the reassigned body is the plain one — no backlog line');
  // Tied to the constant, never to a hardcoded phrase: the literal that used to sit
  // here (`sat in the BACKLOG`) outlived the production wording it was copied from and
  // went vacuously true — the review-round-1 fix updated BACKLOG_LINE and left this
  // behind. A sentinel that cannot fail reads as coverage while providing none.
  assert.ok(!toNew[0].body.includes(BACKLOG_LINE.trimEnd()), 'and the line is nowhere in it');
});

test('task reassign: TWO deliveries — old-assignee notice ORDERED BEFORE new-assignee spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'team-reviewer-1', 'reassigned, pinned to the new role\'s seat');
  assert.strictEqual(f.one('t1').role, 'reviewer', 'and filed under the new role');
  assert.strictEqual(f.gated.length, 2, 'exactly two deliveries');
  assert.strictEqual(f.gated[0].target, 'team-hand', 'OLD assignee notice first');
  assert.match(f.gated[0].body, /reassigned/);
  assert.strictEqual(f.gated[1].target, 'team-reviewer-1', 'NEW assignee spec second');
  assert.strictEqual(f.gated[1].body, specBody('t1', 'the spec'));
});

test('task reassign: a parked/dead OLD seat does not block the NEW delivery (independence)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  // Old assignee's delivery errors; the new one must still go through.
  let call = 0;
  f.m._gatedDeliver = (target, sender, body) => {
    call++; f.gated.push({ target, sender, body });
    return call === 1 ? { error: 'old seat gone' } : { queued: true };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  assert.strictEqual(f.gated.length, 2, 'both deliveries attempted despite the first erroring');
  assert.strictEqual(f.gated[1].target, 'team-reviewer-1', 'new assignee still got the spec');
});

// ---------------------------------------------------------------------------
// t82: a ticket is a WORK ASSIGNMENT, so dispatch/reassign wake the seat; the
// status notices stay passive. And the three non-error outcomes of
// _gatedDeliver must reach the lead DISTINCTLY — the old code flattened parked
// and held into "delivered", telling the lead the spec landed when it had not.
// ---------------------------------------------------------------------------

test('t82 dispatch WAKES the assignee: the spec delivery is urgent, because an assignment that never starts is worth nothing', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget' });
  // Dispatch is `start` since t308. The t82 property is about the DISPATCH, so
  // it follows the verb that dispatches — asserting urgency on add would now be
  // asserting it about nothing (add delivers nothing at all).
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery, so urgents[0] is the spec');
  assert.strictEqual(f.urgents[0], true,
    'the ticket spec must be dispatched urgent — parking a work assignment leaves the board saying "assigned" while nothing runs');
});

test('t82 reassign WAKES the new assignee, but the old-assignee notice stays passive', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0; f.urgents.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  assert.strictEqual(f.gated.length, 2, 'ENTER: the reassign fired both deliveries');
  assert.strictEqual(f.gated[0].target, 'team-hand', 'ENTER: [0] is the OLD-assignee notice');
  assert.strictEqual(f.urgents[0], false,
    'the "your ticket moved" notice is status traffic — waking a seat to tell it a ticket left carries nothing actionable');
  assert.strictEqual(f.gated[1].target, 'team-reviewer-1', 'ENTER: [1] is the NEW-assignee spec');
  assert.strictEqual(f.urgents[1], true, 'the reassigned spec is a work assignment and must wake');
});

// ── t93: the stale-host suffix on task replies ──────────────────────────────
// A task reply is where the wrong conclusion actually forms: the lead reads
// `ticket t91 → hand`, believes the merged behaviour is what just ran, and
// reasons from there. That is how a ticket got filed against correct source.
// Both outcomes are pinned because the design is QUIET-WHEN-FRESH — a suffix
// that appeared on every reply would be the t82 failure (a NOTE on every
// dispatch trains the lead to ignore the ones that matter), and one that never
// appeared would be the t79 failure (correct information nobody sees).

test('t93 a FRESH host adds nothing to a task reply — the happy path stays silent', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._staleHostSuffix = () => '';           // fresh: the real one returns '' here
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const note = f.injected.join('\n');
  assert.match(note, /ticket t1 → hand/, 'ENTER: the reply was produced');
  assert.doesNotMatch(note, /STALE|older code|restart/i,
    'a fresh host must say nothing: a restart notice on every reply is noise the lead learns to skip');
});

test('t93 a STALE host warns on the task reply, where the wrong conclusion gets made', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._staleHostSuffix = () => ' — NOTE: running host (pid 55910) booted 8h ago from OLDER code than is on disk'
    + ' — merged fixes are NOT live until the app is restarted';
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const note = f.injected.join('\n');
  assert.match(note, /ticket t1 → hand/, 'ENTER: the ordinary reply is still there — the warning rides ALONG, it does not replace');
  assert.match(note, /OLDER code than is on disk/,
    'the lead must learn the running host predates the code before reasoning about behaviour they just observed');
  assert.match(note, /restarted/, 'and what to do about it');
});

test('t93 the suffix rides EVERY task verb, not just add — a stale host is stale for all of them', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._staleHostSuffix = () => ' — NOTE: STALE-HOST-MARKER';
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, body: '' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });
  assert.match(f.injected.join('\n'), /STALE-HOST-MARKER/,
    'done replies carry it too — the assignee reading a close confirmation is reasoning about the same host');
});

test('t93 _staleHostSuffix is computed ONCE per intent, not per reply line', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  let calls = 0;
  f.m._staleHostSuffix = () => { calls += 1; return ''; };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  assert.strictEqual(calls, 1,
    'the check stats the whole module dir, so a per-reply call would put real IO on every task intent');
});

// A module dir and runRoot the real _staleHostSuffix reads as a quiet host: no
// stamp under runRoot, and the one watched module predates this process, so
// `changedSince` finds nothing and the method returns ''.
//
// WRONG CHANGE THIS PREVENTS: calling the real method with no seams. It then
// defaults `dir` to __dirname and scans the LIVE worktree, comparing every
// top-level *.js mtime against this process's start time — so any concurrent
// write to a source file (another seat's commit, an editor save, a
// byte-identical `cp` restore) appends a NOTE to every reply and turns its
// callers red. `git status` stays clean, the failure names the touched module
// rather than the cause, and it does not survive a re-run. Seams here are what
// keep those subjects independent of ambient mtimes.
function quietHostSeams() {
  const root = mkTmpRoot('clodex-quiet-host-');
  const dir = pathReal.join(root, 'src');
  const runRoot = pathReal.join(root, 'run');
  fsReal.mkdirSync(dir); fsReal.mkdirSync(runRoot);
  const mod = pathReal.join(dir, 'session-manager.js');
  fsReal.writeFileSync(mod, 'module.exports = {};');
  // A day old, not merely "now": a write landing in the same filesystem
  // timestamp tick as the process start would read as changed.
  const old = Date.now() - 86_400_000;
  fsReal.utimesSync(mod, new Date(old), new Date(old));
  return { runRoot, dir };
}

// ── t94: the in-host suffix on a host with no stamp ─────────────────────────
// t93's tests all stubbed _staleHostSuffix, so they pinned what _handleTask
// does with a suffix, never what the method itself computes. A revert that
// deleted the entire t94 wiring from it failed nothing. These drive the real
// method through its seams.

test('t94 the real suffix speaks when there is no stamp and modules changed under the host', () => {
  const f = mkTasks();
  const root = mkTmpRoot('clodex-t94-sm-');
  const dir = pathReal.join(root, 'src');
  const runRoot = pathReal.join(root, 'run');
  fsReal.mkdirSync(dir); fsReal.mkdirSync(runRoot);
  fsReal.writeFileSync(pathReal.join(dir, 'session-manager.js'), 'module.exports = {};');
  // Modified well after this process started — explicit mtime, so the write
  // cannot land in the same filesystem-timestamp tick and read as unchanged.
  fsReal.utimesSync(pathReal.join(dir, 'session-manager.js'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

  const suffix = Object.getPrototypeOf(f.m)._staleHostSuffix.call(f.m, Date.now(), { runRoot, dir });
  assert.match(suffix, /NOTE:/, 'a stamp-less host with changed modules must NOT be silent — that silence was the t94 bug');
  assert.match(suffix, /UNCONFIRMED/, 'and it reports evidence rather than asserting staleness');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('t94 the real suffix stays SILENT when nothing changed under the host', () => {
  const f = mkTasks();
  const root = mkTmpRoot('clodex-t94-sm2-');
  const dir = pathReal.join(root, 'src');
  const runRoot = pathReal.join(root, 'run');
  fsReal.mkdirSync(dir); fsReal.mkdirSync(runRoot);
  fsReal.writeFileSync(pathReal.join(dir, 'session-manager.js'), 'module.exports = {};');
  // Predates this process by a day: nothing has changed underneath it, so this
  // host is genuinely fresh. Without this half the test above would pass on a
  // suffix that fired unconditionally.
  const old = Date.now() - 86_400_000;
  fsReal.utimesSync(pathReal.join(dir, 'session-manager.js'), new Date(old), new Date(old));

  const suffix = Object.getPrototypeOf(f.m)._staleHostSuffix.call(f.m, Date.now(), { runRoot, dir });
  assert.strictEqual(suffix, '', 'a fresh host says nothing at all');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('t93 a throwing stale check never breaks the reply it rides on', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // Exercises the REAL method (not a stub). Pins the contract that
  // instrumentation cannot take down the ticket protocol: the worst a broken
  // stamp may do is say nothing.
  const realSuffix = Object.getPrototypeOf(f.m)._staleHostSuffix;
  assert.strictEqual(typeof realSuffix, 'function', 'ENTER: the real method exists to be exercised');
  assert.strictEqual(realSuffix.call(f.m, Date.now(), quietHostSeams()), '',
    'no stamp under runRoot and nothing changed under dir ⇒ silent');

  // And the whole ticket path still works while the check is throwing.
  f.m._staleHostSuffix = () => { throw new Error('stamp read exploded'); };
  assert.throws(() => f.m._staleHostSuffix(), /exploded/, 'ENTER: the stub really does throw');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  assert.ok(f.one('t1'), 'the ticket was still minted — instrumentation failure must not block work');
});

// ── t92: the ASSIGN path's honest reporting ─────────────────────────────────
// t82 fixed the false green (parked/held reported as delivered) and pinned it
// — but every one of those pins drives the ADD path (`sub: 'add'`). Assign
// builds its reply on a SEPARATE line with two wordings of its own (the
// backlog→assignee case and the reassign `prev → next` case), so nothing held
// the suffix there. The three tests below cover that gap on the branch the
// live incident actually took.
//
// Why it is worth pinning twice over: the failure mode is a lead reading
// `ticket t91 → clodex-hand` and believing work started. That belief is the
// damage — it is acted on, the board agrees with it, and nothing contradicts
// it until a watchdog fires. A test that cannot tell delivered from parked
// proves nothing here, so each of these asserts the DISTINCTION, not merely
// that some notice appeared.

test('t92 assign: a PARKED spec reads as parked on the assign reply too, not just on add', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  f.injected.length = 0;
  // Park only from here on, so the reply under test is the assign one.
  f.m._gatedDeliver = (target, sender, body, urgent) => {
    f.gated.push({ target, sender, body }); f.urgents.push(urgent);
    return { parked: 'pk-1', reason: 'idle 5h with a cold cache — waking it re-bills its full context' };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the assign attempted a delivery and the gate parked it');
  const note = f.injected.join('\n');
  assert.match(note, /ticket t1 → hand/, 'the assign confirmation still reads normally');
  assert.match(note, /parked/,
    'the lead must be able to tell parked from delivered — reading "t1 → hand" and believing work started is the whole defect');
  assert.doesNotMatch(note, /NOT delivered/, 'parked is not held: it drains on the seat next turn, so re-dispatching would duplicate');
});

test('t92 assign: a HELD spec tells the lead it did NOT land', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  f.injected.length = 0;
  f.m._gatedDeliver = (target, sender, body, urgent) => {
    f.gated.push({ target, sender, body }); f.urgents.push(urgent);
    return { held: 'blocked on a permission dialog — injecting now would answer the dialog' };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the delivery was attempted and the gate held it');
  const note = f.injected.join('\n');
  assert.match(note, /NOT delivered/, 'held means the seat never saw the spec — the lead must re-send, so it cannot read as success');
  assert.match(note, /permission dialog/, 'and is told why, since urgent cannot override a dialog hold');
});

test('t92 reassign: the prev → next reply carries the suffix too (its own wording, its own branch)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.injected.length = 0;
  f.m._gatedDeliver = (target, sender, body, urgent) => {
    f.gated.push({ target, sender, body }); f.urgents.push(urgent);
    // Park the NEW-assignee spec only; the old-assignee notice is fire-and-forget.
    return target === 'team-reviewer-1'
      ? { parked: 'pk-2', reason: 'idle 5h with a cold cache — waking it re-bills its full context' }
      : { queued: true };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  const note = f.injected.join('\n');
  // Reports the ROLE it moved off, not the seat it was pinned to: a seat→role
  // arrow would name a move the lead never made.
  assert.match(note, /ticket t1: hand → reviewer/, 'ENTER: this is the REASSIGN wording, a different reply line from the assign one above');
  assert.match(note, /parked/,
    'the reassign branch builds its own reply string, so the suffix has to be pinned on it separately');
});

// REJECT MOVED OUT OF THIS TEST BY t89, and that is a REVERSAL of a t82
// decision, not a drive-by edit — see the t89 test below for the replacement
// pin and the reasoning. t82 classed reject as a status notice; t89 establishes
// it is a work assignment (it REOPENS the ticket, on a seat that by
// construction just reported done and has gone idle — the exact state a
// non-urgent dm is held for). done and cancel are untouched and still pinned
// passive here.
test('t82 the status NOTICES stay passive: done and cancel must not wake a seat', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // done: assignee → lead.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.gated.length = 0; f.urgents.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: done delivered its report to the lead');
  assert.strictEqual(f.urgents[0], false, 'a done-report rides passively — it reaches the lead with their next turn');
  // cancel: lead → assignee.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec three' });
  f.gated.length = 0; f.urgents.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', body: 'never mind' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: cancel delivered to the assignee');
  assert.strictEqual(f.urgents[0], false,
    'a cancellation rides passively — waking a seat to tell it to stop re-bills a whole context to deliver nothing actionable');
});

test('t82 a HELD spec is NOT reported as delivered: un-parkable means the seat never saw it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // held = the gate refused AND the target could not be parked for (a Codex
  // seat or a dead target). This is a real drop, not a deferral.
  f.m._gatedDeliver = (target, sender, body, urgent) => {
    f.gated.push({ target, sender, body }); f.urgents.push(urgent);
    return { held: 'blocked on a permission dialog — injecting now would answer the dialog' };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the delivery was attempted and the gate held it');
  const note = f.injected.join('\n');
  assert.match(note, /NOT delivered/,
    'a held spec must tell the lead it did NOT land — the whole defect was reporting held as delivered, so the lead moves on believing work started');
  assert.match(note, /permission dialog/, 'the lead is told WHY it was held, so they know whether to re-send');
});

test('t82 a PARKED spec reads as parked, not delivered — it will arrive, but it has not yet', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._gatedDeliver = (target, sender, body, urgent) => {
    f.gated.push({ target, sender, body }); f.urgents.push(urgent);
    return { parked: 'pk-1', reason: 'idle 5h with a cold cache — waking it re-bills its full context' };
  };
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const note = f.injected.join('\n');
  assert.match(note, /parked/,
    'parked must be distinguishable from delivered: the spec is queued, so the lead should wait rather than re-send');
  assert.doesNotMatch(note, /NOT delivered/,
    'but parked is NOT the held wording — it drains on the seat`s next turn, and telling the lead it failed would provoke a duplicate dispatch');
});

test('t82 a DELIVERED spec still confirms cleanly, with no scary NOTE appended', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // _handleTask calls this internally with no arguments, so the seams cannot be
  // passed at the call site — they are bound here instead. This is NOT a stub:
  // the REAL method runs. Replacing it with `() => ''` would assert only that
  // the fixture is quiet.
  const realSuffix = Object.getPrototypeOf(f.m)._staleHostSuffix;
  const seams = quietHostSeams();
  f.m._staleHostSuffix = () => realSuffix.call(f.m, Date.now(), seams);
  assert.strictEqual(f.m._staleHostSuffix(), '',
    'ENTER: the real method, on these seams, is silent — so a NOTE below could only come from the reply path');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const note = f.injected.join('\n');
  assert.match(note, /ticket t1 → hand/, 'the ordinary confirmation still reads as before');
  assert.doesNotMatch(note, /NOTE:/,
    'the happy path must stay quiet — a NOTE on every dispatch would train the lead to ignore the ones that matter');
});

test('t82 a HELD watchdog nudge does not consume the one-per-episode nudge', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const past = Date.now() - (stallMs * 4);
  const ts = f.load();
  ts[0].lastActivityAt = past;
  f.tstore.save(f.team.root, ts);
  // Held: the lead is un-parkable, so it never sees the nudge.
  f.m._gatedDeliver = () => ({ held: 'blocked on a permission dialog' });
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'a held nudge reaches nobody, so it must not burn the single nudge this stall episode gets — otherwise the alarm is silently spent');
  // Parked, by contrast, DOES arrive on the lead's next turn and counts — a park is
  // durable, so the real _gatedDeliver fires onWrite on it (and never on a bare held).
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => {
    if (typeof onWrite === 'function') onWrite();
    return { parked: 'pk-9', reason: 'idle' };
  };
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.ok(typeof f.one('t1').nudgedAt === 'number',
    'a parked nudge DOES count — it drains on the lead`s next turn, so re-nudging would duplicate it');
});

test('t168 a nudge QUEUED but never written does not spend the stall episode', async () => {
  // The A3 half of t168. `nudgedAt` is read back to spend the one nudge a stall
  // episode gets, so stamping it from _gatedDeliver's synchronous return silences
  // the watchdog forever on exactly the ticket it exists to surface — the bytes sit
  // in the queue's ready loop and a boot re-render can wipe them. Modelled by a
  // stub that returns success WITHOUT firing onWrite: the ticket must stay
  // un-nudged, and the next sweep must try again.
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  f.tstore.save(f.team.root, ts);
  let calls = 0;
  f.m._gatedDeliver = () => { calls++; return { queued: true }; };  // accepted; never written
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(calls, 1, 'ENTER: the sweep must have attempted a nudge, or the assertion below is vacuous');
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'queued is not delivered — a nudge whose write never happened must leave the episode UNSPENT');
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(calls, 2, 'and the next sweep re-nudges, because the alarm was never actually raised');
});

// The rework half of A3. Moving the stamp to onWrite opens a window the
// synchronous stamp did not have: the write can land AFTER the seat has spoken.
// _touchTicketActivity clears `nudgedAt` on activity — that IS the end of the
// stall episode — so a stamp that only knows its ticket re-marks a fresh episode
// as already-nudged, and `:4197` then suppresses the next stall forever, since
// only activity clears the field and activity is precisely what a stall lacks.
// Both halves are required: the first alone proves a stamp was skipped, which a
// stamp that never happens also satisfies.
test('t168 rework: a nudge written AFTER the seat spoke does not spend the NEW episode', async () => {
  const f = mkTasks();
  f.seat('lead'); const hand = f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const stall = () => { const ts = f.load(); ts[0].lastActivityAt = Date.now() - (stallMs * 4); f.tstore.save(f.team.root, ts); };
  stall();
  let captured = null;
  let calls = 0;
  // Models the real gap: accepted by the queue, written some time later.
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => { calls++; captured = onWrite; return { queued: true }; };
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(calls, 1, 'ENTER: the sweep found the stall and enqueued a nudge');
  assert.strictEqual(typeof captured, 'function', 'ENTER: the stamp rides onWrite, so there is something to fire late');
  // The seat speaks while the nudge is still in the queue. Real path, not a poke
  // at the store: _reconcileTickets arms the watch map, _touchTicketActivity ends
  // the episode exactly as a PTY turn would.
  f.m._reconcileTickets(f.team);
  f.m._touchTicketActivity(hand.name);
  assert.strictEqual(f.one('t1').nudgedAt, null, 'ENTER: activity ended the episode');
  captured();
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'the write is about the episode that ENDED — stamping now marks a fresh episode as already-nudged');
  // And the alarm is still armed: the next stall must reach the lead.
  stall();
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => { calls++; if (typeof onWrite === 'function') onWrite(); return { queued: true }; };
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(calls, 2, 'the next stall nudges — a skipped stamp that also killed the alarm would be no better than stamping');
  assert.ok(typeof f.one('t1').nudgedAt === 'number', 'and THAT nudge, written in its own episode, spends it');
});

// t168: the success return is `queued`, never `delivered`. Nothing else in the
// suite pins it — every consumer branches on error/held/parked and falls through
// on success, so renaming the field back leaves the whole suite green while every
// caller silently reads a claim the queue cannot back. The name IS the fix here:
// the negative verdicts are decided synchronously and are exact, but success only
// means the inject queue accepted the text — the write follows within a poll of
// the seat's readiness latch.
test('t168 _gatedDeliver reports QUEUED, not delivered — the write happens later', () => {
  const { m } = mkPark({ shouldHoldDm: () => ({ hold: false }) });
  m.sessions.set('a', { name: 'a', agentType: 'claude', activityState: 'idle' });
  m._deliverMessage = () => {};
  const r = m._gatedDeliver('a', 'bob', 'hi', false);
  assert.deepStrictEqual(r, { queued: true },
    'success is a QUEUE acceptance; `delivered` would assert a write that has not happened');
  assert.strictEqual(r.delivered, undefined,
    'and the old key must be GONE — a caller left reading `.delivered` would silently see undefined and treat every success as a failure');
});

// t388: the sweep's stall body gains ONE cause sentence when the stalled seat has
// a live or recently-expired unconfirmed-dm latch. _dmLatchEvidence and
// formatStallBody are each pinned on their own elsewhere; what these two pin is
// the WIRING, which is the part that can be absent while both halves pass.
test('t388 a stall on a seat holding an unconfirmed dm names the swallow as the possible cause', async () => {
  const f = mkTasks();
  f.seat('lead'); const hand = f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  f.tstore.save(f.team.root, ts);
  // The seat was written to and never took a turn. Armed through the real arm at
  // the real disposition, so the evidence the sweep reads is the state the
  // production path produces rather than a hand-set field.
  f.m._armDmConfirm('team-hand', 'lead', 'injected');
  assert.strictEqual((hand._dmUnconfirmed || []).length, 1,
    'ENTER: the latch must be armed, or the clause below is absent for the trivial reason and this test pins nothing');
  f.gated.length = 0;
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(f.gated.length, 1, 'ENTER: the sweep found the stall and alarmed');
  const body = f.gated[0].body;
  assert.match(body, /stalled: hand quiet/,
    'ENTER: this is the STALL body — the orphan and loop-held arms are different bodies and the clause is '
    + 'deliberately not on either');
  assert.match(body, /may be a swallowed delivery rather than a stalled seat/,
    'the lead is told the seat may never have been spoken to. Without this the alarm reads as a stalled seat, '
    + 'and every action that follows from that reading is aimed at the wrong actor');
  clearTimeout(hand._dmConfirmTimer);
});

test('t388 a stall on a seat with no dm history carries no cause clause', async () => {
  const f = mkTasks();
  f.seat('lead'); const hand = f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  f.tstore.save(f.team.root, ts);
  assert.strictEqual((hand._dmUnconfirmed || []).length, 0,
    'ENTER: no latch on this seat — that is the whole difference from the test above');
  f.gated.length = 0;
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(f.gated.length, 1, 'ENTER: the sweep still alarmed — the clause is the only variable');
  assert.doesNotMatch(f.gated[0].body, /swallowed/,
    'an ordinary stall keeps its ordinary wording: a cause sentence on every alarm carries no information and '
    + 'teaches the lead to skip the line on the alarms where it does');
});

test('t82 the watchdog nudge itself stays passive (decision: alarm to the lead, but not a work assignment)', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  f.tstore.save(f.team.root, ts);
  f.gated.length = 0; f.urgents.length = 0;
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, Date.now());
  assert.strictEqual(f.gated.length, 1, 'ENTER: the sweep found the stalled ticket and nudged');
  assert.strictEqual(f.urgents[0], false,
    'the watchdog fires on a SCHEDULE against a possibly-idle lead; waking it every sweep re-bills a full context to report a ticket that has been quiet for hours');
});

test('task self-assign (assignee == lead): confirm only, NO spec echo', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'lead', id: null, body: 'i will do this' });
  assert.strictEqual(f.one('t1').assignee, 'lead');
  assert.deepStrictEqual(f.gated, [], 'the lead just wrote it — no echo back to itself');
  assert.ok(f.injected.some((x) => /ticket t1 → lead/.test(x)));
});

test('task done: assignee closes, report delivered to the lead BEFORE the state stamp', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });
  const t = f.one('t1');
  assert.strictEqual(t.state, 'done');
  assert.ok(typeof t.closedAt === 'number');
  assert.deepStrictEqual(f.gated, [{ target: 'lead', sender: 'team-hand', body: '[ticket t1 done] shipped it' }],
    'report delivered to the opener');
});

test('task done: a dead lead ({error}) keeps the ticket OPEN and bounces (MF3 parity)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._gatedDeliver = () => ({ error: 'no such agent "lead"' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });
  assert.strictEqual(f.one('t1').state, 'open', 'not closed — report went nowhere');
  assert.ok(f.injected.some((x) => /report NOT delivered, ticket kept open/.test(x)));
});

test('task done: a NON-assignee is bounced (no close, no delivery)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-reviewer-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'not mine' });
  assert.strictEqual(f.one('t1').state, 'open');
  assert.deepStrictEqual(f.gated, []);
  // The sentence names BOTH permitted actors since t52. Naming only the
  // assignee would send a lead that just hit this bounce looking for a seat to
  // chase, when it is itself the actor that can close the thing.
  assert.ok(f.injected.some((x) => /only ticket t1's assignee \(hand\) or the team lead \(lead\) can close it/.test(x)),
    `the bounce does not name the lead as a permitted closer: ${JSON.stringify(f.injected.filter((x) => /close it/.test(x)))}`);
});

// --- t166: a rejecting ticket verb must not destroy the sender's payload ------
//
// The body is composed in the sender's turn and exists NOWHERE else, so a
// validation error that merely returns is data loss. These tests read the spilled
// file back through the path the bounce advertises: asserting the reply merely
// MENTIONS a path would pass against a bounce that names a file nobody wrote.
// The spill is REAL here (a temp dir), unlike the rest of this file which stubs it
// away — a stub returning a fixed string cannot distinguish those two cases.
function mkSpillTasks(extra = {}) {
  const spillDir = mkTmpRoot('clodex-t166-');
  const spills = [];
  const f = mkTasks({
    spillToFile: (sender, body, recipient) => {
      const p = pathReal.join(spillDir, `msg-${recipient}-${spills.length}.txt`);
      fsReal.writeFileSync(p, `From: ${sender}\n\n${body}`);
      spills.push({ sender, recipient, path: p });
      return p;
    },
    ...extra,
  });
  const bounce = (re) => f.injected.filter((x) => re.test(x)).pop();
  // The path is read out of the REPLY, never off the recorded call: the sender has
  // nothing but the reply text, so a path the bounce fails to carry is unrecoverable
  // however well the file was written.
  const recovered = (re) => {
    const m = /minutes and then swept: (\S+)/.exec(bounce(re) || '');
    return m ? fsReal.readFileSync(m[1], 'utf8') : null;
  };
  // The bounce with the fixture's OWN temp directory masked out, for the
  // "renders fully" assertion below. mkdtempSync's suffix is random and mixed
  // case, so it can contain the literal `NaN` — a real run drew
  // `clodex-t166-0ENaNL` and failed a test about unwired deps. Only the directory
  // the FIXTURE chose is masked: the filename stays under the assertion, because
  // that half is production-interpolated (an unwired recipient renders
  // `msg-undefined-N.txt`) and is exactly what this is meant to catch.
  const bounceRendered = (re) => (bounce(re) || '').split(spillDir).join('<spilldir>');
  return { ...f, spills, spillDir, recovered, bounce, bounceRendered };
}

// THE priority case (spec's verification section): the longest payload in the
// system, rejected on the verb's first decision, with no re-send to fall back on.
test('t166 task add: a NON-LEAD sender is rejected, and the whole spec is recoverable at the advertised path', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  const spec = 'BUILD THE WIDGET\nstep one\nstep two';
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'add', who: null, id: null, body: spec });
  assert.deepStrictEqual(f.load(), [], 'still no ticket — the permission check is unchanged');
  const got = f.recovered(/can open a ticket/);
  assert.ok(got, `the bounce carries no readable path: ${JSON.stringify(f.bounce(/can open a ticket/))}`);
  assert.ok(got.includes(spec), 'the spec must survive VERBATIM — a truncated spill is still a loss');
  assert.strictEqual(f.spills[0].recipient, 'team-hand', 'spilled to the SENDER, who is the one that has to recover it');
});

test('t166 task add: an unknown assignee also spills — the spec is read by then and dropped just the same', () => {
  const f = mkSpillTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'ghost', id: null, body: 'the spec' });
  assert.ok((f.recovered(/neither a team role nor a live seat/) || '').includes('the spec'));
});

// The bounce that opened this ticket: a report fired at an already-closed ticket.
test('t166 task done: a report bounced off a non-open ticket is recoverable', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'first report' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'THE REWORK REPORT' });
  assert.ok((f.recovered(/is done, not open/) || '').includes('THE REWORK REPORT'));
});

// Spill-first exists FOR this case: no id resolves, so there is no ticket to
// reopen or attach to, and every recovery shape that needs one is unavailable.
test('t166 task done: a MALFORMED command (no ticket id) still preserves the report', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: null, who: null, body: 'a long report' });
  assert.ok((f.recovered(/done needs a ticket id/) || '').includes('a long report'));
});

test('t166 task done: a report aimed at an id that does not exist is recoverable', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't9', who: null, body: 'a whole report' });
  assert.ok((f.recovered(/no ticket t9/) || '').includes('a whole report'));
});

// `cancel`'s reason is OPTIONAL, so its rejects are the one place a reject site is
// reached with nothing to save. Without the empty-body guard this writes a
// zero-payload file and advertises it, teaching the sender to go read nothing.
test('t166 a rejection with an EMPTY body spills no file and advertises no path', () => {
  const f = mkSpillTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't9', who: null, body: '' });
  assert.deepStrictEqual(f.spills, [], 'nothing to save, so nothing is written');
  assert.doesNotMatch(f.bounce(/no ticket t9/), /is saved for|could NOT be saved/, 'and the bounce stays a plain error');
});

test('t166 task reject: a reason aimed at a ticket in the wrong state is recoverable', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'the must-fixes' });
  assert.ok((f.recovered(/reject reopens a DONE ticket/) || '').includes('the must-fixes'));
});

test('t166 task cancel: a reason aimed at a ticket that does not exist is recoverable', () => {
  const f = mkSpillTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't9', who: null, body: 'why it is dropped' });
  assert.ok((f.recovered(/no ticket t9/) || '').includes('why it is dropped'));
});

// EVERY spill site, including the ones the named tests above already reach. The
// suffixes are hand-placed per site, so any one of them can be dropped by a later
// edit with the suite still green — per-site coverage is what makes that visible.
// A site added without a suffix fails here only if this table is extended too; the
// invariant is stated at the helper for that reason.
const T166_SITES = [
  ['entry: no team', 'lead', { sub: 'done', id: 't1', body: 'PAYLOAD' }, /not on a team/, { noTeam: true }],
  ['add: non-lead', 'team-hand', { sub: 'add', who: null, id: null, body: 'PAYLOAD' }, /can open a ticket/],
  ['add: unknown assignee', 'lead', { sub: 'add', who: 'ghost', id: null, body: 'PAYLOAD' }, /neither a team role/],
  ['done: no id', 'team-hand', { sub: 'done', id: null, body: 'PAYLOAD' }, /done needs a ticket id/],
  ['done: no such ticket', 'team-hand', { sub: 'done', id: 't9', body: 'PAYLOAD' }, /no ticket t9/],
  ['done: not open', 'team-hand', { sub: 'done', id: 't1', body: 'PAYLOAD' }, /is done, not open/, { close: true }],
  ['done: not assignee nor lead', 'team-reviewer-1', { sub: 'done', id: 't1', body: 'PAYLOAD' }, /can close it/],
  ['done: report undeliverable', 'team-hand', { sub: 'done', id: 't1', body: 'PAYLOAD' }, /report NOT delivered/, { gateFails: true }],
  ['reject: non-lead', 'team-hand', { sub: 'reject', id: 't1', body: 'PAYLOAD' }, /can reject a ticket/],
  ['reject: no id', 'lead', { sub: 'reject', id: null, body: 'PAYLOAD' }, /reject needs a ticket id/],
  ['reject: no such ticket', 'lead', { sub: 'reject', id: 't9', body: 'PAYLOAD' }, /no ticket t9/],
  ['reject: not done', 'lead', { sub: 'reject', id: 't1', body: 'PAYLOAD' }, /reopens a DONE ticket/],
  ['cancel: non-lead', 'team-hand', { sub: 'cancel', id: 't1', body: 'PAYLOAD' }, /can cancel a ticket/],
  ['cancel: no id', 'lead', { sub: 'cancel', id: null, body: 'PAYLOAD' }, /cancel needs a ticket id/],
  ['cancel: no such ticket', 'lead', { sub: 'cancel', id: 't9', body: 'PAYLOAD' }, /no ticket t9/],
  ['cancel: not open', 'lead', { sub: 'cancel', id: 't1', body: 'PAYLOAD' }, /not open — cannot cancel/, { close: true }],
];

for (const [label, sender, intent, bounceRe, opts = {}] of T166_SITES) {
  test(`t166 site coverage — ${label}: the payload is recoverable at the advertised path`, () => {
    const f = mkSpillTasks(opts.noTeam ? { resolveTeam: () => null } : {});
    f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
    if (!opts.noTeam) {
      f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
      if (opts.close) f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'r' });
    }
    // Fails the delivery AFTER setup, so the ticket exists and only the report hop breaks.
    if (opts.gateFails) f.m._gatedDeliver = () => ({ error: 'lead is unreachable' });
    f.spills.length = 0;
    f.m._handleTask(f.seat(sender), { type: 'task', who: null, ...intent });
    const got = f.recovered(bounceRe);
    assert.ok(got, `no readable path on the bounce: ${JSON.stringify(f.bounce(bounceRe))}`);
    assert.ok(got.includes('PAYLOAD'), 'the spilled file must hold the sender body');
    // Every assertion above passes against "NaN minutes", because the deadline sits
    // before the path they read. An unrenderable number in an operator-facing string
    // means the fixture is not reaching the state it claims to model.
    //
    // Read through bounceRendered: the temp DIRECTORY is the fixture's own random
    // string and can spell `NaN` by coincidence, which is a flake and not a dep.
    // Everything the code renders — the deadline, the sender, the spill filename —
    // is still in the string being matched.
    assert.doesNotMatch(f.bounceRendered(bounceRe), /NaN|undefined/,
      'the bounce must render fully — an unset dep here yields a sentence no user sees');
  });
}

// The spilled file is swept MSG_MAX_AGE after it is written (only PARKED pointers
// are exempt, and a promptly-delivered bounce is never parked). A sender that drops
// its own copy on an unqualified "saved" loses the payload to a timer, so the
// deadline has to be in the sentence the sender reads — and derived from the real
// constant, since a hardcoded "30 minutes" would drift the moment the sweep changes.
test('t166 the success line names the sweep deadline, derived from MSG_MAX_AGE', () => {
  const f = mkSpillTasks({ MSG_MAX_AGE: 600 });
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  assert.match(f.bounce(/can open a ticket/), /saved for the next 10 minutes and then swept/,
    'the deadline must track the injected constant, not a number written into the string');

  // And the DEFAULT fixture must render the number a user actually sees: 30, from
  // engine.js's MSG_MAX_AGE = 1800. Pinned as a literal because engine.js does not
  // export it and cannot be required here. Without this, the fixture default could
  // be set to any token value and the 16 site rows would still pass, which is the
  // fixture-cannot-reach-the-modelled-state defect one level up.
  const d = mkSpillTasks();
  d.seat('lead'); d.seat('team-hand');
  d.m._handleTask(d.seat('team-hand'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  assert.match(d.bounce(/can open a ticket/), /saved for the next 30 minutes and then swept/,
    'the harness default must be the production MSG_MAX_AGE, or the site rows assert a sentence no user sees');
});

// A path named for a spill that did not happen is WORSE than admitting the loss:
// the sender stops holding the only copy on the strength of it.
test('t166 a FAILED spill reports the failure and names no path', () => {
  const f = mkSpillTasks({ spillToFile: () => { throw new Error('disk full'); } });
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  const b = f.bounce(/can open a ticket/);
  assert.match(b, /could NOT be saved \(disk full\)/, 'the sender is told the payload was not persisted, and why');
  assert.doesNotMatch(b, /is saved for/, 'and must NOT read as a successful spill — the two outcomes drive opposite actions');
});

// The verbs run constantly; an unconditional spill would drop an inbound-looking
// message into the seat's own inbox on every successful ticket op.
test('t166 a SUCCESSFUL ticket op spills nothing', () => {
  const f = mkSpillTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'the report' });
  assert.deepStrictEqual(f.spills, [], 'nothing spilled on the happy path');
});

// --- t52: the close path's actor ---------------------------------------------
//
// THE STALL PATH REQUIRES NO ACTOR, SO THE CLOSE PATH MUST HAVE ONE WHO ALWAYS
// EXISTS. Assignee-only left two legitimate tickets nobody could close — a
// backlog ticket, and one whose seat retired — while the watchdog kept nudging
// for both. The lead is that actor (team.lead is structural).
//
// The window question these tests have to answer, and the reason each asserts a
// precondition before acting: a test that closes a ticket the sender happens to
// be ASSIGNEE of proves nothing about the lead branch, because the old code
// passes it too. So each lead test first establishes that the sender would have
// FAILED the assignee check — the ticket's assignee is neither `lead` nor the
// lead seat's role — and only then closes.

test('task done: the LEAD closes a BACKLOG ticket — the case nobody could close', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'someday task' });
  assert.strictEqual(f.one('t1').assignee, null,
    'window: unassigned, so the assignee branch cannot be what admits this close');
  f.gated.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'did it myself' });

  const t = f.one('t1');
  assert.strictEqual(t.state, 'done',
    'a backlog ticket stayed open: no seat is its assignee, so under assignee-only NOTHING could close it while the watchdog nudged on');
  assert.strictEqual(t.closedBy, 'lead', 'recorded who ended it');
  assert.deepStrictEqual(f.gated, [],
    'the lead wrote the report — self-delivering it back is the echo {self} already refuses one verb earlier');
  assert.ok(f.injected.some((x) => /ticket t1 closed \(done\)/.test(x)));
  assert.ok(!f.injected.some((x) => /report delivered to/.test(x)),
    'and the reply must not claim a delivery that did not happen');
});

test('task done: the LEAD closes a ticket assigned to SOMEONE ELSE (retired seat)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // The seat retires with its ticket open — the other half of the hole.
  f.m.sessions.delete('team-hand');
  const t0 = f.one('t1');
  assert.strictEqual(t0.assignee, 'team-hand', 'window: pinned to a retired seat of a role the LEAD does not hold…');
  assert.strictEqual(t0.role, 'hand', '…filed under that role…');
  assert.notStrictEqual(t0.assignee, 'lead', '…so the sender is not the assignee by name…');
  assert.strictEqual(f.m.sessions.has('team-hand'), false, '…and no live seat holds that role either');
  f.gated.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'closing for a seat that is gone' });

  const t = f.one('t1');
  assert.strictEqual(t.state, 'done', 'the lead could not close a ticket whose assignee no longer exists');
  assert.strictEqual(t.closedBy, 'lead');
  assert.deepStrictEqual(f.gated, [], 'no self-dm to the lead');
});

test('task done: a non-assignee, non-lead seat is STILL bounced', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-reviewer-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'not mine' });

  assert.strictEqual(f.one('t1').state, 'open',
    'the gate widened to admit anyone, not just the lead — a third seat closed a ticket it has no part in');
  assert.strictEqual(f.one('t1').closedBy, undefined, 'and nothing was stamped');
  assert.deepStrictEqual(f.gated, []);
  assert.ok(f.injected.some((x) => /can close it/.test(x)), 'bounced');
});

test('task done: the ASSIGNEE path is unchanged — delivery, and the keep-open bounce', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  // The lead is unreachable. For an ASSIGNEE this must still keep the ticket
  // open — the report has a third party to strand, which is the whole reason
  // that bounce exists and exactly what the lead's skip must not have removed.
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { error: 'no such agent "lead"' }; };
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });

  assert.strictEqual(f.one('t1').state, 'open',
    'the assignee`s close no longer keeps the ticket open on an undelivered report — its report is stranded and the ticket reads done');
  assert.strictEqual(f.gated.length, 1, 'and it must still have ATTEMPTED the delivery');
  assert.ok(f.injected.some((x) => /report NOT delivered, ticket kept open/.test(x)));

  // Same sender, reachable lead: closes, delivers, and says so.
  f.gated.length = 0;
  f.m._gatedDeliver = (target, sender, body) => { f.gated.push({ target, sender, body }); return { queued: true }; };
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });
  assert.strictEqual(f.one('t1').state, 'done');
  assert.strictEqual(f.one('t1').closedBy, 'team-hand', 'the closer is the seat, not the role');
  assert.deepStrictEqual(f.gated, [{ target: 'lead', sender: 'team-hand', body: '[ticket t1 done] shipped it' }],
    'the assignee`s report still rides to the lead');
  assert.ok(f.injected.some((x) => /closed \(done\) — report delivered to lead/.test(x)));
});

test('task reject: lead reopens a DONE ticket, reason to the assignee, assignee kept', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done' });
  // Both arrays are cleared together and stay index-aligned: the same stub pushes
  // to each on every delivery, so clearing one alone would leave the tag pin
  // reading a row from the setup deliveries above.
  f.gated.length = 0; f.tags.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'fix the edge case' });
  const t = f.one('t1');
  assert.strictEqual(t.state, 'open', 'reopened');
  assert.strictEqual(t.assignee, 'team-hand', 'assignee kept — reject does not re-route the ticket');
  assert.strictEqual(t.role, 'hand', 'and its role is untouched');
  // Rework carries the close verb too — the seat is about to close a SECOND time,
  // and sourcing the verb from the seeded role prompt is the stale-file dependency
  // the dispatch line exists to remove.
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: `[ticket t1 rejected] ${CLOSE_LINE('t1')}fix the edge case` }]);
  // This site passed NO tag before t353. The tag rides regardless of whether the
  // body spills — a SHORT reason like this one does not (426-byte head + 17), and
  // the tag must not be a function of the reason's length.
  assert.ok(f.gated[0].body.length < 500,
    'ENTER: this reason is too short to spill — the point here is that the tag rides anyway');
  assert.deepStrictEqual(f.tags, ['[ticket t1 rejected] close with [agent:task done t1]'],
    'the rework pointer names the ticket and the verb');
});

// The case that actually ships. A real rejection reason is paragraphs, not a
// phrase — the head is 426 bytes, so anything past ~74 chars of reason spills and
// the pointer becomes the only text the seat reads. This site passed NO tag before
// t353, so dropping it degrades the pointer to a bare "Message (N bytes) attached"
// naming neither ticket nor verb: strictly worse than before this ticket existed.
test('t353: a realistic lead rejection spills, so its POINTER carries the id and the verb', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  const reason = 'the retry path still double-counts when the second attempt lands inside the window, '
    + 'and the new pin asserts the count without asserting the row it came from';
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done' });
  f.gated.length = 0; f.tags.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: reason });
  assert.ok(f.gated[0].body.length > 500,
    `ENTER: the rejection must actually spill (body was ${f.gated[0].body.length} bytes), or the tag is cosmetic`);
  assert.deepStrictEqual(f.tags, ['[ticket t1 rejected] close with [agent:task done t1]'],
    'a spilled rejection shows the seat nothing but this line');
});

test('task reject: rejecting a non-DONE ticket is bounced', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'reason' });
  assert.strictEqual(f.one('t1').state, 'open', 'unchanged');
  assert.ok(f.injected.some((x) => /reject reopens a DONE ticket; t1 is open/.test(x)));
});

test('task cancel: works on an assigned ticket (reason to assignee) and a backlog ticket', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'assigned one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'backlog one' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't1', who: null, body: 'not needed' });
  assert.strictEqual(f.one('t1').state, 'cancelled');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1 cancelled] not needed' }]);
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', who: null, body: '' });
  assert.strictEqual(f.one('t2').state, 'cancelled', 'backlog ticket cancels too');
  assert.deepStrictEqual(f.gated, [], 'no reason + no live assignee → no delivery');
});

// ---------------------------------------------------------------------------
// t305 `[agent:task accept]`: the ONLY verb that tears anything down, and every
// step of it is downstream of one fact — `merge-base --is-ancestor`. The tests
// that matter are the ones proving nothing is removed when that fact is absent
// or unknowable, since the failure is silent and irreversible.
// ---------------------------------------------------------------------------

// Records what accept did, so each test asserts the WHOLE set of destructive
// actions rather than the one it happens to care about — a step firing in the
// unmerged case is exactly the bug, and a partial assertion reads around it.
// `countAnswer` is what commitsOnBranch returns. It defaults to a NONZERO count
// — the ordinary "the hand committed something" case — so a test that says
// nothing about commits exercises the plain merged path.
// The seat record accept reads, in ONE place. The case-(a) fixture below differs
// from the default by exactly one field, and hand-typing a second copy is how a
// fixture silently stops matching production: `baseSha` itself was added here
// once, and a divergent copy would have gone on measuring the older shape.
// `ephemeral: true` is not decoration: t482 made every teardown below conditional
// on it, and _spawnTicketSeat stamps it UNCONDITIONALLY on each seat it mints —
// so a ticket seat without it is a shape production cannot produce. Omitted, this
// fixture would quietly describe the operator's standing seat, and every
// "the seat is retired" assertion here would be asserting against the arm that
// deliberately retires nothing.
function mkRecord({ baseSha = 'deadbeef' } = {}) {
  const worktree = { path: '/wt/t1', branch: 't1-build-the-widget' };
  if (baseSha !== null) worktree.baseSha = baseSha;
  return { name: 'team-hand', sessionId: 'sess-abc', ephemeral: true, worktree };
}

function mkAccept(mergedAnswer, extra = {}, countAnswer = { ok: true, count: 3, base: 'deadbeef' }) {
  const destroyed = [];
  const archived = [];
  const deleted = [];
  const asked = [];
  const counted = [];
  const f = mkTasks({
    getPersistence: () => ({
      list: () => [],
      get: (n) => (n === 'team-hand' ? mkRecord() : null),
    }),
    gitWorktree: {
      isMerged: async (root, branch) => { asked.push({ root, branch }); return mergedAnswer; },
      // Records the ORDER against the teardown, not just the arguments: the count
      // has to be taken while the branch ref still exists.
      commitsOnBranch: async (root, branch, base) => {
        counted.push({ root, branch, base, afterTeardown: destroyed.length > 0 || deleted.length > 0 });
        return countAnswer;
      },
      deleteBranch: async (root, branch) => { deleted.push(branch); return { ok: true }; },
      removeWorktree: async () => ({ ok: true }),
      // The ordinary merged path: a seat that committed its work leaves a clean
      // tree. t482 gates the merged arm's destroy on this, so the stub is
      // REQUIRED — but a missing one fails loudly rather than silently: the call
      // is `gitWorktree.isDirty(...)` on an object that lacks it, which throws a
      // synchronous TypeError that the arm's `.catch` cannot intercept, so the
      // whole accept rejects. Both downgrade directions — dirty, and unreadable
      // — are pinned against REAL trees in accept-standing-seat.test.js.
      isDirty: async () => ({ ok: true, dirty: false }),
    },
    ...extra,
  });
  f.m.destroy = async (name) => { destroyed.push(name); return { ok: true, worktreeRemoved: true }; };
  f.m.archive = async (name) => { archived.push(name); };
  return { ...f, destroyed, archived, deleted, asked, counted };
}

function openAndDone(f) {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget' });
  // t308: add writes, start dispatches. Accept's subject is the DONE ticket's
  // teardown, and a ticket that was never started never reaches done — so the
  // helper has to walk the real lifecycle, not a shortcut through it.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped' });
}

test('task accept: a MERGED branch retires the seat, removes the tree and deletes the branch', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' });
  openAndDone(f);
  // ENTER: the ticket really is DONE before accept runs. Accept refuses anything
  // else, so a fixture that never closed it would exercise the bounce and every
  // assertion below about teardown would be vacuous.
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its gate');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: 'good work' },
    (msg) => f.injected.push(msg));

  // The branch is read from the SEAT RECORD, never rebuilt from the ticket id:
  // the name carries a title slug the id cannot reconstruct.
  assert.deepStrictEqual(f.asked, [{ root: '/proj', branch: 't1-build-the-widget' }],
    'the gate is asked about the recorded branch, in the main checkout');
  // ENTER (t314): the branch carries commits, which is what makes "merged into
  // master" the TRUE sentence here. A fixture counting zero would take the
  // empty-branch arm and this test would be asserting the wrong claim.
  assert.deepStrictEqual(f.counted,
    [{ root: '/proj', branch: 't1-build-the-widget', base: 'deadbeef', afterTeardown: false }],
    'ENTER: the count ran and reported commits, so this really is the merged arm');
  assert.deepStrictEqual(f.destroyed, ['team-hand'], 'the seat is destroyed (tree goes with it)');
  assert.deepStrictEqual(f.archived, [], 'and not merely archived');
  assert.deepStrictEqual(f.deleted, ['t1-build-the-widget'], 'the branch ref is deleted');
  const t = f.one('t1');
  assert.strictEqual(t.acceptedBy, 'lead');
  assert.ok(t.acceptedAt > 0);
  assert.strictEqual(t.acceptNote, 'good work');
  assert.match(f.injected.join('\n'), /accepted — merged into master/);
});

// t314. `isMerged(root, branch)` with no base asks "is the branch an ancestor of
// the main checkout's HEAD" — and a branch that never committed is still AT its
// base, which IS an ancestor. So the gate answers merged for a branch carrying
// nothing, and the reply claimed a merge that never happened. Observed live on
// t310, which was closed without a commit and accepted with "merged into master".
//
// The teardown is NOT the bug and is asserted to survive: an empty branch has
// nothing to lose. Only the sentence is wrong.
test('task accept: a branch with ZERO commits is torn down but NOT reported as merged', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {}, { ok: true, count: 0, base: 'deadbeef' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its gate');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  // ENTER: the count was actually taken, against the RECORDED mint-time base,
  // and taken BEFORE the teardown removed the ref it needs. Without this the
  // wording assertions below could pass off a call that never happened.
  assert.deepStrictEqual(f.counted,
    [{ root: '/proj', branch: 't1-build-the-widget', base: 'deadbeef', afterTeardown: false }],
    'ENTER: the branch is counted against its mint-time base, before anything is destroyed');

  const msg = f.injected.join('\n');
  assert.ok(!/merged into/.test(msg), 'the reply must NOT claim a merge — nothing was merged');
  assert.match(msg, /has 0 commits beyond deadbeef/, "and reuses t309's wording for the same condition");
  assert.match(msg, /NOTHING was merged/);

  // The teardown is unchanged — this is a message fix, not a policy change.
  assert.deepStrictEqual(f.destroyed, ['team-hand'], 'the seat is still retired');
  assert.deepStrictEqual(f.archived, [], 'not merely archived — there is nothing to resume into');
  assert.deepStrictEqual(f.deleted, ['t1-build-the-widget'], 'and the empty branch is still deleted');
  assert.ok(f.one('t1').closedOut, 'terminal: an empty branch is finished work, and no accept is invited back');
});

// The MIRROR of the bug above, and the reason `measured` exists. A record with
// no baseSha is a supported production shape — createWorktree deliberately
// records none for a pre-existing branch — and commitsOnBranch then counts
// against merge-base(defaultBranch, branch). For a branch already fast-forwarded
// into master, that merge base IS the branch tip, so the count is 0 for work
// that genuinely landed. Reported as "NOTHING was merged", that is a true merge
// denied — the same false-report class, pointed the other way.
// Case (b): a fork point WAS recorded, but no longer resolves — commitsOnBranch
// drops a rebased or gc'd SHA and measures against the merge base instead. The
// reply must name that, because it is a different repair from case (a): the
// stamping worked, the commit it named is gone.
test('task accept: 0 commits off a fallback because the recorded base is GONE says so', async () => {
  // The count's base (99feed) is NOT the recorded fork point (deadbeef): the
  // signature of a fallback, which is exactly what the reply may not read as empty.
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {}, { ok: true, count: 0, base: '99feed' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its gate');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  // ENTER: the count really was requested against the RECORDED base and came
  // back reporting a different one — without that mismatch this measures nothing.
  assert.deepStrictEqual(f.counted,
    [{ root: '/proj', branch: 't1-build-the-widget', base: 'deadbeef', afterTeardown: false }],
    'ENTER: asked against the recorded fork point, which the answer did NOT use');

  const msg = f.injected.join('\n');
  assert.ok(!/NOTHING was merged/.test(msg), 'a fallback-based 0 must NOT be reported as an empty branch');
  assert.ok(!/has 0 commits beyond/.test(msg), "nor borrow t309's empty-branch wording");
  assert.match(msg, /UNKNOWN/, 'it is undecidable, and the reply says so');
  // The record HAS a fork point, so the reply must not claim none was recorded —
  // that misdirects the repair toward a stamping bug that is not there.
  assert.match(msg, /recorded fork point deadbeef no longer resolves/,
    'it names the recorded SHA and that it is gone, which is the actual condition');
  assert.ok(!/no fork point was recorded/.test(msg), 'and must NOT say none was recorded — one was');

  // Teardown unchanged here too — the merge gate is what licenses it.
  assert.deepStrictEqual(f.destroyed, ['team-hand'], 'the seat is still retired');
  assert.deepStrictEqual(f.deleted, ['t1-build-the-widget'], 'and the branch deleted');
  assert.ok(f.one('t1').closedOut, 'terminal: there is no tree left to accept against a second time');
});

// Case (a): no fork point recorded at all — the shape createWorktree leaves for a
// pre-existing branch. Same UNKNOWN verdict, different reason, different repair.
test('task accept: 0 commits off a fallback because NO base was recorded says that instead', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {
    // A record with a worktree but no baseSha — what createWorktree writes when
    // the branch already existed. `extra` spreads after the default, so this
    // replaces it wholesale.
    getPersistence: () => ({
      list: () => [],
      get: (n) => (n === 'team-hand' ? mkRecord({ baseSha: null }) : null),
    }),
  }, { ok: true, count: 0, base: '99feed' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its gate');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  // ENTER: the fixture really does carry no fork point, so `null` below is the
  // record's shape and not a lookup that silently failed.
  assert.deepStrictEqual(f.counted,
    [{ root: '/proj', branch: 't1-build-the-widget', base: null, afterTeardown: false }],
    'ENTER: nothing was recorded to count against, so the count was asked with null');

  const msg = f.injected.join('\n');
  assert.ok(!/NOTHING was merged/.test(msg), 'still not an empty branch');
  assert.match(msg, /UNKNOWN/, 'still undecidable');
  assert.match(msg, /no fork point was recorded/, 'and this time that IS the reason');
  assert.ok(!/no longer resolves/.test(msg), 'nothing was recorded, so nothing can have stopped resolving');

  assert.deepStrictEqual(f.destroyed, ['team-hand'], 'the seat is still retired');
  assert.deepStrictEqual(f.deleted, ['t1-build-the-widget'], 'and the branch deleted');
  assert.ok(f.one('t1').closedOut, 'terminal, like its sibling');
});

// A count that could not RUN is a THIRD case. Folding it into the empty one
// would state as fact ("0 commits, nothing merged") the very thing that could
// not be measured — the same false-confidence bug pointed a different way.
test('task accept: a commit count that could NOT be obtained is named, not guessed', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {}, { ok: false, count: null, error: 'rev-list failed' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its gate');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  // ENTER: the count was actually attempted — the failure under test is the
  // helper's, not a call that never happened.
  assert.deepStrictEqual(f.counted,
    [{ root: '/proj', branch: 't1-build-the-widget', base: 'deadbeef', afterTeardown: false }],
    'ENTER: the count ran and failed, which is the case this arm reports');

  const msg = f.injected.join('\n');
  assert.match(msg, /UNKNOWN/, 'the reply says the commit count is unknown');
  assert.match(msg, /rev-list failed/, 'and carries the reason, so the lead can act on it');
  assert.ok(!/has 0 commits/.test(msg), 'it must NOT be reported as the empty-branch case');
  assert.ok(!/accepted — merged into/.test(msg), 'nor as a plain merge');
  // Teardown still runs: the MERGE gate passed, and that is what licenses it.
  assert.deepStrictEqual(f.destroyed, ['team-hand'], 'the seat is retired on the merge fact, as before');
  assert.deepStrictEqual(f.deleted, ['t1-build-the-widget'], 'and the branch deleted');
  assert.ok(f.one('t1').closedOut, 'terminal: the tree is gone, so a second accept has nothing to act on');
});

// The destructive direction is the one that cannot be undone, so this is the
// test that matters most: an unmerged branch must lose NOTHING.
test('task accept: an UNMERGED branch removes nothing and says so', async () => {
  const f = mkAccept({ ok: true, merged: false, base: 'master' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: done, so the gate is reached');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.deepStrictEqual(f.destroyed, [], 'nothing destroyed');
  assert.deepStrictEqual(f.deleted, [], 'no branch deleted');
  assert.deepStrictEqual(f.archived, ['team-hand'], 'the seat is archived — resumable, tree kept');
  const msg = f.injected.join('\n');
  assert.match(msg, /is NOT merged into master/);
  assert.match(msg, /KEPT/, 'the reply states the tree and branch survive');
  assert.match(msg, /accept t1\] again/, 'and names the way to finish once it is merged');
});

// ok:false is absence of evidence. Reading it as merged would delete unmerged
// work on a failed git call.
test('task accept: a check that could NOT run is treated as not merged', async () => {
  const f = mkAccept({ ok: false, error: 'git unavailable' });
  openAndDone(f);
  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: done, so the gate is reached');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.deepStrictEqual([f.destroyed, f.deleted], [[], []], 'an unanswerable check destroys nothing');
  assert.deepStrictEqual(f.archived, ['team-hand']);
  const msg = f.injected.join('\n');
  assert.match(msg, /could NOT run/);
  assert.match(msg, /treated as NOT merged/);
  assert.match(msg, /Nothing was removed/);
});

test('task accept: lead-only, and only on a DONE ticket', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' });
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget' });

  // Non-lead: refused outright.
  f.injected.length = 0;
  await f.m._taskAccept(f.seat('team-hand'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));
  assert.match(f.injected.join('\n'), /only the team lead \(lead\) can accept/);
  assert.deepStrictEqual([f.destroyed, f.deleted, f.archived], [[], [], []], 'a non-lead tears nothing down');

  // Lead, but the ticket is still OPEN: accepting un-reported work is how a
  // half-finished branch gets its tree deleted.
  f.injected.length = 0;
  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));
  assert.match(f.injected.join('\n'), /t1 is open — it has not been reported yet/);
  assert.deepStrictEqual([f.destroyed, f.deleted, f.archived], [[], [], []], 'an open ticket tears nothing down');
  assert.deepStrictEqual(f.asked, [], 'and the merge gate is never even consulted');
});

// t305 ruling 4: the board is the durable index. `assignee` is a seat name and
// seat names recycle, so without this stamp nothing links a ticket to the
// session that did the work — and destroy() drops the record that holds it.
test('task accept: the revival link is stamped BEFORE teardown, so a discard cannot outrun it', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' });
  openAndDone(f);
  // The stamp must already be on disk when destroy runs: after it, the record
  // holding the session id is gone and the link is unrecoverable.
  let stampAtDestroy = null;
  f.m.destroy = async (name) => {
    stampAtDestroy = f.one('t1').revival || null;
    return { ok: true, worktreeRemoved: true };
  };
  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.ok(stampAtDestroy, 'ENTER: the stamp was already persisted when teardown began');
  assert.strictEqual(stampAtDestroy.sessionId, 'sess-abc', 'the session id a hotfix would revive');
  assert.strictEqual(stampAtDestroy.seat, 'team-hand');
  assert.strictEqual(stampAtDestroy.branch, 't1-build-the-widget');
  assert.strictEqual(stampAtDestroy.baseSha, 'deadbeef');
  assert.strictEqual(stampAtDestroy.worktree, '/wt/t1');
  // t314: the count here is nonzero and measured against the recorded fork
  // point, so a merge really is demonstrable and the stamp names it.
  assert.strictEqual(stampAtDestroy.mergedInto, 'master', 'a demonstrable merge is recorded as one');
  // And it survives the accept, which rewrites the row.
  assert.strictEqual(f.one('t1').revival.sessionId, 'sess-abc', 'the stamp survives the acceptance write');
});

// t314. The stamp is the durable half of the same claim the reply makes, and it
// must not outlive its evidence: an empty branch IS an ancestor of master, so a
// stamp written off the merge gate alone records a merge that never happened —
// exactly what the reply no longer says. No reader consumes `mergedInto` today,
// which is why this is pinned now rather than discovered by the first one.
test('task accept: an empty branch is NOT stamped as merged', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {}, { ok: true, count: 0, base: 'deadbeef' });
  openAndDone(f);
  let stampAtDestroy = null;
  f.m.destroy = async () => {
    stampAtDestroy = f.one('t1').revival || null;
    return { ok: true, worktreeRemoved: true };
  };
  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  // ENTER: the stamp was written at all, and before teardown — without this the
  // null below could be a stamp that never happened rather than an honest one.
  assert.ok(stampAtDestroy, 'ENTER: the stamp was persisted before teardown, as on the merged arm');
  assert.strictEqual(stampAtDestroy.seat, 'team-hand', 'ENTER: and it is this seat\'s stamp');
  assert.strictEqual(stampAtDestroy.mergedInto, null, 'nothing was merged, so nothing is recorded as merged');
  assert.strictEqual(f.one('t1').revival.mergedInto, null, 'and the acceptance write does not restore the claim');
});

// ── t535: a recovered merge failure must stop shouting, but only where it is
// actually over ────────────────────────────────────────────────────────────
// The canonical recovery from a failed auto-merge is: the loop stamps the
// failing step and escalates, the lead merges by hand, the lead accepts. Before
// this, `finish()` cleared `loopStep` and `verifyHold` and left `mergeError`
// standing, so that ticket's recently-closed row read `!! MERGE FAILED: …` for
// the whole 24h window — the one row that violated the premise t531 and t533
// were both built on, that a stamp on a board is read as current.
//
// Driven through `_stampMergeError` rather than a hand-written field, for the
// reason task-respec.test.js's t533 tests give: a hand-written one pins the
// clear against this test's belief about the field name, which is what a rename
// breaks invisibly. The BOARD is asserted, not just the record, because the
// board is where the staleness was actually costing the lead something.
test('t535: accepting a merged ticket clears the stale merge failure, on the record and the board', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' });
  openAndDone(f);
  f.m._stampMergeError(f.team, 't1', 'clean-tree');
  assert.strictEqual(f.one('t1').mergeError, 'clean-tree',
    'ENTER: the stamp really landed — otherwise the absence below is a stamp that never happened');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.injected[f.injected.length - 1], /MERGE FAILED: clean-tree/,
    'ENTER: and the board really renders it, or the board assertion below cannot fail');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.ok(!('mergeError' in f.one('t1')),
    'the stale failure is gone from the record the accept re-read and saved');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', who: null, id: null, body: '' });
  const board = f.injected[f.injected.length - 1];
  assert.match(board, /recently closed:/, 'ENTER: the row reached the recently-closed block, where the lead reads it');
  assert.match(board, /t1 \[done\].*closed/, 'ENTER: and t1 is the row in it, not some other ticket');
  assert.doesNotMatch(board, /MERGE FAILED/, 'and the board no longer sends the lead after a merge that has landed');
  // Which ARM cleared it, asserted rather than assumed. t536 added a veto that
  // also takes a stamped ticket, is also terminal, and therefore also clears the
  // mark — so the subject above now runs through the VETO and would keep passing
  // if the merged arm's clear were deleted outright. The teardown is what tells
  // the two apart: only the merged arm destroys.
  assert.deepStrictEqual(f.destroyed, [],
    'ENTER: a stamped ticket takes t536\'s veto, which clears the mark WITHOUT tearing down — so this subject alone no longer covers the merged arm');
});

// The MERGED arm's own clear. Split out of the subject above rather than
// replacing it: that one is the canonical recovery (loop stamps, lead merges by
// hand, lead accepts) and its path is worth keeping pinned, but after t536 it
// runs through the veto and no longer reaches the teardown the header describes.
//
// Reaching the merged arm with a stamp STILL SET takes the one shape t536 exempts
// from the veto: a branch measuring 0 against its recorded fork point. That is
// not a contrivance to satisfy this test — it is the whole exempted path (a hand
// that committed nothing leaves the loop nothing to merge, which is itself a
// stamped failure), and it is now the only way the merged arm's clear does any
// work at all. A subject on a stamp-free ticket would assert the absence of a
// field that was never present, which is true of a build with no clear in it.
test('t535: the MERGED arm clears the stale failure too, on the empty branch t536 exempts from the veto', async () => {
  // count 0 against the record's own baseSha — `measured && count === 0`, the
  // veto's exemption, so this reaches the teardown WITH the mark still standing.
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {}, { ok: true, count: 0, base: 'deadbeef' });
  openAndDone(f);
  f.m._stampMergeError(f.team, 't1', 'clean-tree');
  assert.strictEqual(f.one('t1').mergeError, 'clean-tree',
    'ENTER: the stamp is on the ticket when accept starts — otherwise the clear below is asserting an absence that was always there');

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.deepStrictEqual(f.destroyed, ['team-hand'],
    'ENTER: the teardown RAN, which is what identifies the merged arm rather than t536\'s veto');
  assert.ok(!('mergeError' in f.one('t1')),
    'and the merged arm cleared the stale failure it closed out over');
  assert.strictEqual(f.one('t1').closedOut, true, 'on the terminal arm');
});

// The other direction, and the one that costs more to get wrong. `finish()` runs
// on every accept arm, and two of the five do NOT close the ticket out: `!m.ok`,
// whose reply says the merge check could not run and nothing was removed, and
// `!m.merged` — this subject — whose reply ends "Merge it, then [agent:task
// accept <id>] again to clean up". `mergeError` is not loop state an accept can
// overrule — its only readers are the two board renderers, so it is a claim
// about the REPOSITORY, and on this arm the accept has just re-measured that
// claim and found it still true. Clearing here would blank the mark on the one
// ticket whose accept message says a human still owes the merge.
test('t535: accepting an UNMERGED ticket leaves the merge failure standing', async () => {
  const f = mkAccept({ ok: true, merged: false, base: 'master' });
  openAndDone(f);
  f.m._stampMergeError(f.team, 't1', 'clean-tree');
  assert.strictEqual(f.one('t1').mergeError, 'clean-tree', 'ENTER: a stamp is there to survive');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.match(f.injected.join('\n'), /accept t1\] again/,
    'ENTER: this arm really is the one that invites another accept — otherwise it is not the case under test');
  assert.strictEqual(f.one('t1').mergeError, 'clean-tree',
    'the stamp survives an accept that did not close the ticket out');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.injected[f.injected.length - 1], /MERGE FAILED: clean-tree/,
    'and the board still says a human owes this merge, which is still true');
});

// The no-branch arm, which closes out for a reason of its own: there is no
// branch, so there was never a merge for the stamp to be about. Separate from the
// merged arm above because it reaches `finish()` by a different route — an early
// `return` before `isMerged` is ever called — and a clear placed in the merged
// arm rather than in `finish()` would pass that test and fail this one.
test('t535: accepting a no-branch ticket clears it too — terminal by a different route', async () => {
  const f = mkAccept({ ok: true, merged: true, base: 'master' }, {
    getPersistence: () => ({
      list: () => [],
      get: (n) => (n === 'team-hand' ? { name: 'team-hand', sessionId: 'sess-abc', ephemeral: true } : null),
    }),
  });
  openAndDone(f);
  f.m._stampMergeError(f.team, 't1', 'on-master');
  assert.strictEqual(f.one('t1').mergeError, 'on-master', 'ENTER: a stamp is there to clear');
  f.injected.length = 0;

  await f.m._taskAccept(f.seat('lead'), f.team, { type: 'task', sub: 'accept', id: 't1', who: null, body: '' },
    (msg) => f.injected.push(msg));

  assert.match(f.injected.join('\n'), /no ticket branch recorded/,
    'ENTER: the no-branch arm is the one that ran, not the merged arm');
  assert.deepStrictEqual(f.asked, [],
    'ENTER: and it returned before the merge check, which is what makes this a distinct route to finish()');
  assert.ok(!('mergeError' in f.one('t1')), 'the stamp is cleared on this terminal arm as well');
});

// ---------------------------------------------------------------------------
// t89: the COMPLETION edge. t82 made ticket DISPATCH wake the assignee — the
// ARRIVAL edge — but a seat already holding a queue received those specs turns
// ago, so closing one left it idle holding work nobody re-triggered (observed
// three times in one session). Closing a ticket now hands the seat its next.
// ---------------------------------------------------------------------------

test('t89 done ADVANCES the seat: the next held ticket is delivered, urgently', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec two' });
  // t308: advance hands over STARTED tickets only, so the queued one needs its
  // dispatch step too. An added-but-unstarted ticket is deliberately invisible
  // to the advance — otherwise `add` still dispatches, just via a later edge.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });

  // ENTER: two deliveries — [0] the report to the lead, [1] the advance.
  assert.strictEqual(f.gated.length, 2, 'ENTER: the report AND an advance fired');
  assert.strictEqual(f.gated[0].target, 'lead', 'ENTER: [0] is the done-report');
  assert.deepStrictEqual(f.gated[1], { target: 'team-hand', sender: 'clodex-team', body: replayBody('t2', 'spec two') },
    'the seat is handed the next ticket it holds, id-prefixed like any dispatch — and MARKED, since `start` already sent this spec once');
  assert.strictEqual(f.urgents[1], true,
    'the advance must WAKE — a seat that just closed a ticket is at a turn boundary and about to go idle, the exact state a passive dm is held for');
  assert.ok(f.injected.some((x) => /next: t2 delivered to team-hand/.test(x)), 'the closer is told what it was handed');
});

test('t89 closing the LAST held ticket delivers NOTHING — a wake with no work is the cost t82 avoided', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the only spec' });
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });

  assert.strictEqual(f.gated.length, 1, 'ONLY the report — no advance, because there is nothing to advance to');
  assert.strictEqual(f.gated[0].target, 'lead');
  assert.ok(!f.injected.some((x) => /next:/.test(x)), 'and the reply promises no next ticket');
});

test('t89 _advanceSeat never hands back the ticket just closed, even before the state stamp lands', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the one being closed' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the genuine next' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  f.gated.length = 0;

  // Called DIRECTLY with t1 still open — the shape the helper would see if the
  // advance ever ran before the terminal state was saved. Both current callers
  // save first, so no caller can reach this; the guard is what keeps that an
  // ordering detail rather than a correctness dependency.
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: t1 is still open, so only the closed ticket`s id can exclude it');
  // t351: the helper takes the closed TICKET, not its id — it must read the
  // started-ness of what was closed, which an id cannot answer.
  assert.ok(f.one('t1').startedAt != null,
    'ENTER: t1 is STARTED, or the advance declines for the t351 reason and the exclusion below is never reached');
  const next = f.m._advanceSeat(f.team, 'team-hand', f.one('t1'));

  assert.strictEqual(next.id, 't2', 'the closed ticket must not be handed back as the seat`s next work');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'clodex-team', body: replayBody('t2', 'the genuine next') }]);
});

test('t89 the advance is FIFO, not id order — oldest first when the two disagree', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'closing this one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'minted second, but OLDER' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'minted third, but NEWER' });
  // t308: all three started — the advance only considers started tickets, and
  // leaving either candidate unstarted would decide the ordering question by
  // exclusion instead of by the comparator this test exists to pin.
  for (const id of ['t1', 't2', 't3']) f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id, body: '' });
  // Force openedAt to CONTRADICT id order: t3 is older than t2. Without this the
  // two orderings agree and the test cannot tell which one the product used.
  const tickets = f.tstore.load(f.team.root);
  tickets.find((t) => t.id === 't2').openedAt = 5000;
  tickets.find((t) => t.id === 't3').openedAt = 1000;
  f.tstore.save(f.team.root, tickets);
  // ENTER: the disagreement is real — lowest id (t2) is NOT the oldest (t3).
  assert.ok(f.one('t3').openedAt < f.one('t2').openedAt, 'ENTER: openedAt disagrees with id order');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.strictEqual(f.gated.length, 2, 'ENTER: the report AND an advance fired');
  assert.strictEqual(f.gated[1].body, replayBody('t3', 'minted third, but NEWER'),
    'FIFO means OLDEST first: t3 was opened before t2, so id order must not decide the advance');
});

test('t89 the advance skips closed tickets and other seats` work', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'closing this' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'already cancelled' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'reviewer', id: null, body: 'not mine' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't3', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'backlog, unassigned' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', body: 'never mind' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the real next one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't5', body: '' });
  // ENTER: the decoys are really in the states this test claims.
  assert.strictEqual(f.one('t2').state, 'cancelled', 'ENTER: t2 is closed');
  assert.strictEqual(f.one('t3').assignee, 'team-reviewer-1', 'ENTER: t3 belongs to another seat');
  assert.strictEqual(f.one('t4').assignee, null, 'ENTER: t4 is backlog');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.strictEqual(f.gated.length, 2, 'the report and exactly one advance');
  assert.strictEqual(f.gated[1].body, replayBody('t5', 'the real next one'),
    'a cancelled ticket, another seat`s ticket and a backlog ticket are all skipped');
});

test('t89 the advance follows the TICKET`s seat, so a lead closing over a silent seat restarts it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec two' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  f.gated.length = 0; f.urgents.length = 0;

  // The LEAD closes the hand's ticket (the permitted-actor path). The seat that
  // needs restarting is the hand, not the closer.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'done', id: 't1', body: 'closing for it' });

  assert.strictEqual(f.gated.length, 1, 'ENTER: a lead close sends no report to itself, so [0] is the advance');
  assert.deepStrictEqual(f.gated[0], { target: 'team-hand', sender: 'clodex-team', body: replayBody('t2', 'spec two') },
    'the advance is keyed on the ticket`s assignee seat — keying it on the closer would leave the silent seat idle, which is the whole defect');
  assert.strictEqual(f.urgents[0], true);
});

test('t89 cancel advances too — it frees the seat exactly as done does', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec two' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't1', body: 'never mind' });

  assert.strictEqual(f.gated.length, 2, 'ENTER: the cancellation notice AND an advance');
  assert.strictEqual(f.urgents[0], false, 'the cancellation notice itself still rides passively — stopping is not work');
  assert.deepStrictEqual(f.gated[1], { target: 'team-hand', sender: 'clodex-team', body: replayBody('t2', 'spec two') });
  assert.strictEqual(f.urgents[1], true, 'but what follows it is');
  assert.ok(f.injected.some((x) => /cancelled — next: t2 delivered to team-hand/.test(x)));
});

// ── t351: the advance must not fire on a close that freed nothing ──────────
// `_advanceSeat` resolves its seat from the ticket BEING CLOSED. A backlog ticket
// still sitting on its ROLE resolves to whichever seat holds that role — a seat
// that never had the closed ticket. Closing it is not a completion edge for that
// seat, and the head the advance would push is whatever the seat is already
// working. So the closes below must deliver NOTHING to the working seat.

test('t351: cancelling an UNSTARTED backlog ticket delivers nothing to a seat mid-work', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'in flight' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'filed for later' });
  // ENTER: the two tickets are really in the states this test names. Without
  // these the close below could be cancelling a started ticket, or the seat could
  // hold no in-flight work at all — and an EMPTY delivery list is true of both.
  assert.ok(f.one('t1').startedAt != null, 'ENTER: t1 is started, so the seat has work in flight to be interrupted');
  assert.strictEqual(f.one('t2').startedAt, null, 'ENTER: t2 is UNSTARTED, which is the arm under test');
  assert.strictEqual(f.one('t2').assignee, 'hand', 'ENTER: t2 is on the ROLE, so it resolves to the working seat');
  f.gated.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', body: 'never mind' });

  assert.deepStrictEqual(f.gated.filter((g) => /in flight/.test(g.body)), [],
    'the seat`s own in-flight spec must not come back at it — a hand reading a fresh dispatch compacts and starts over, discarding the work');
  assert.deepStrictEqual(f.gated.map((g) => [g.target, g.body]), [['team-hand', '[ticket t2 cancelled] never mind']],
    'only the cancellation notice goes out');
  assert.ok(!f.injected.some((x) => /next:/.test(x)), 'and the lead is not told a hand-off happened');
});

test('t351: a hand closing an UNSTARTED backlog ticket does not get its own work back', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'in flight' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'filed for later' });
  assert.ok(f.one('t1').startedAt != null, 'ENTER: t1 is started — the work that must survive the close');
  assert.strictEqual(f.one('t2').startedAt, null, 'ENTER: t2 is unstarted');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't2', body: 'the report' });

  assert.strictEqual(f.one('t2').state, 'done', 'ENTER: the close really landed, so the absence below is the advance declining');
  assert.deepStrictEqual(f.gated.map((g) => [g.target, g.body]), [['lead', '[ticket t2 done] the report']],
    'the report reaches the lead and nothing is pushed back at the seat');
});

// The other direction, and the reason the fix is a GATE rather than a deletion:
// the advance exists because the completion edge has no other trigger. Break it
// and a seat holding a queue goes idle until a human notices.
test('t351: the genuine advance survives — closing a STARTED ticket still hands over the next one', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  assert.ok(f.one('t1').startedAt != null, 'ENTER: the CLOSED ticket is started, which is what lets the advance run');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand').map((g) => g.body),
    [replayBody('t2', 'second')], 'exactly one hand-off, and it is the queued ticket');
});

// An unstarted ticket sitting at the HEAD of the FIFO must not swallow the
// advance: it is dropped from the queue (task-start.test.js pins that term), so
// the started ticket behind it is the head and must still arrive. The gate this
// ticket adds is on the CLOSED ticket, and that discrimination is carried by the
// two absence tests above — moving the gate onto the candidate leaves THIS test
// green and reds those, which is how the two claims stay separable.
test('t351: an unstarted ticket ahead in FIFO does not block the advance — the started one behind it still arrives', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'closing this' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'never started' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'genuinely queued' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't3', body: '' });
  assert.strictEqual(f.one('t2').startedAt, null, 'ENTER: t2 is the unstarted candidate, and it is OLDER than t3');
  assert.ok(f.one('t3').startedAt != null, 'ENTER: t3 is started, so it is the only legitimate head');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand').map((g) => g.body),
    [replayBody('t3', 'genuinely queued')],
    'the started close advances, skipping the unstarted candidate that sits ahead of it in FIFO order');
});

// The surviving residual, pinned so a reader can tell "deliberately left, made
// safe by the marker" from "missed". Closing a STARTED sibling DOES free the
// seat, so the advance correctly runs — and its head may be the very ticket the
// seat is still working. That redelivery is intended; what makes it safe is the
// REPLAY head, not suppression. Counting, not measuring growth: the claim is
// "exactly one, and marked", and a growth check passes on two.
test('t351: closing a STARTED sibling still advances, and the redelivery is marked', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'in flight' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the sibling' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  // ENTER: t2 is STARTED — that is the whole difference from the two absence
  // tests above, and without it this asserts the case they already cover.
  assert.ok(f.one('t2').startedAt != null, 'ENTER: the sibling being closed is started, so the advance is legitimate');
  assert.ok(f.one('t1').startedAt != null, 'ENTER: and t1 is the seat`s in-flight work, which is what comes back');
  f.gated.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', body: 'drop it' });

  // Exhaustive rather than filtered-and-counted: a filter on the REPLAY head is
  // blind to an EXTRA UNMARKED spec landing on the same seat, which is precisely
  // the regression the marker exists to make visible.
  assert.deepStrictEqual(f.gated.filter((g) => g.target === 'team-hand').map((g) => g.body),
    ['[ticket t2 cancelled] drop it', replayBody('t1', 'in flight')],
    'exactly one spec comes back, it is the seat`s own in-flight ticket, and it is MARKED — the advance is NOT '
    + 'suppressed on this arm, which is the deliberate residual; unmarked this is the t351 near-miss, where a hand '
    + 'compacts and restarts over live work');
});

// The separable half. Every ticket the advance can reach has started, and both
// dispatch verbs deliver on start — so the advance is ALWAYS a redelivery. Left
// unmarked it is byte-identical in shape to a fresh dispatch, and over the spill
// threshold the seat sees only "Message (N bytes) attached".
test('t351: the advance is MARKED as a replay, so a seat cannot read it as a fresh dispatch', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  // ENTER: `start` already delivered t2's spec once. That is what makes the
  // advance below a REdelivery rather than this ticket's first sight of it.
  assert.strictEqual(f.gated.filter((g) => /^\[ticket t2\] /.test(g.body)).length, 1,
    'ENTER: t2 was dispatched once, unmarked, by start');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  const adv = f.gated.filter((g) => g.target === 'team-hand');
  assert.strictEqual(adv.length, 1, 'ENTER: exactly one advance, so the assertion below is about it');
  assert.match(adv[0].body, /^\[ticket t2 REPLAY\]/,
    'the marker is the seat`s only way to tell this from a first dispatch, and it decides whether the seat starts clean or resumes');
  assert.match(adv[0].body, /do NOT restart it/,
    'and the head must carry the instruction, not just the tag — the tag alone is satisfied by a body that still reads as "begin"');
});

test('t89 reject WAKES the assignee: reopening a ticket is a work assignment, not a status notice', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', body: 'fix the edge case' });

  // ENTER: the reject really did reopen — otherwise this pins the urgency of a
  // delivery about a ticket nobody has to act on.
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: reject reopened the ticket');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery, so urgents[0] is the rejection');
  assert.strictEqual(f.urgents[0], true,
    'a rejected ticket returns to open on a seat that already reported done and gone idle — at passive it sits parked while the board says open');
});

test('task: role-addressed ticket survives seat respawn (assignee stays the role)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  // The seat instance churns: kill team-hand, respawn a DIFFERENT collision-suffixed
  // instance of the same role. The stored assignee is the ROLE, so it still resolves.
  f.m.sessions.delete('team-hand');
  f.seat('team-hand-2');
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-hand-2'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done by the new instance' });
  assert.strictEqual(f.one('t1').state, 'done', 'the new instance of the role can close it');
  assert.deepStrictEqual(f.gated, [{ target: 'lead', sender: 'team-hand-2', body: '[ticket t1 done] done by the new instance' }]);
});

// The pin is a RECORD of who received the work, never the only route back to the
// ticket. Without the degradation this pins, a seat that dies holding a pin takes
// its whole queue with it: both tickets name a seat nothing answers for, and the
// sibling that replaced it sees an EMPTY queue — measured, before the fix.
test('t295: a dead seat does not take its pinned role tickets with it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  // ENTER: both must actually be pinned to the seat, or the recovery below is
  // about ordinary role tickets and proves nothing.
  assert.deepStrictEqual(f.load().map((t) => [t.id, t.assignee, t.role]),
    [['t1', 'team-hand', 'hand'], ['t2', 'team-hand', 'hand']],
    'ENTER: both tickets must be seat-pinned first');

  f.m.sessions.delete('team-hand');
  f.seat('team-hand-2');
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand-2').map((t) => t.id),
    ['t1', 't2'], 'the sibling holding the role picks up the dead seat\'s queue');

  // VISIBILITY IS NOT DELIVERY. Listing the ticket while the resolver refuses it
  // is the defect this test previously could not see: `_advanceSeat` logs a
  // hand-off, delivers nothing, and the reply claims the sibling got its next
  // ticket. So drive a real close→advance and assert the spec ARRIVES.
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-hand-2'), { type: 'task', sub: 'done', id: 't1', body: 'inherited and finished' });
  assert.strictEqual(f.one('t1').state, 'done', 'the sibling can close what it inherited');
  assert.deepStrictEqual(f.gated.map((g) => [g.target, g.body]),
    [['lead', '[ticket t1 done] inherited and finished'],
      ['team-hand-2', replayBody('t2', 'second')]],
    'the report goes to the lead and the NEXT ticket is actually delivered to the sibling');
  // And the advance re-pins, so the record stops naming a seat that never worked it.
  assert.strictEqual(f.one('t2').assignee, 'team-hand-2', 'the advanced ticket re-pins to its new seat');
  assert.strictEqual(f.one('t2').role, 'hand', 'and keeps the role it was filed under');

  // While the pinned seat is LIVE the pin still binds: a sibling must not be able
  // to reach into another live seat's work.
  const g = mkTasks();
  g.seat('lead'); g.seat('team-hand'); g.seat('team-hand-2');
  g.m._handleTask(g.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'held' });
  // `g` is a SECOND fixture with its own board, so its first ticket is t1 — the
  // ids above belong to `f` and do not continue into it.
  g.m._handleTask(g.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(g.one('t1').assignee, 'team-hand', 'ENTER: pinned to the first live seat');
  assert.deepStrictEqual(g.m._openTicketsFor(g.team, 'team-hand-2').map((t) => t.id),
    [], 'a live seat\'s pinned ticket stays its own');
});

test('task guards: non-lead add/assign/cancel bounce; unknown id and assign-on-closed bounce', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // non-lead add
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'add', who: null, id: null, body: 'x' });
  assert.ok(f.injected.some((x) => /only the team lead \(lead\) can open a ticket/.test(x)));
  assert.deepStrictEqual(f.load(), [], 'no ticket minted by a non-lead');
  // unknown id
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't9', who: 'hand', body: '' });
  assert.ok(f.injected.some((x) => /no ticket t9 on team/.test(x)));
  // assign on a closed ticket
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 's' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'd' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  assert.ok(f.injected.some((x) => /ticket t1 is done, not open — cannot assign/.test(x)));
  // non-lead cancel
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 's2' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'cancel', id: 't2', who: null, body: '' });
  assert.ok(f.injected.some((x) => /only the team lead \(lead\) can cancel a ticket/.test(x)));
  assert.strictEqual(f.one('t2').state, 'open', 'unchanged by the non-lead cancel');
});

test('task list: one line per ticket (id, state, assignee, age, title), sorted by id', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first task' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'second task' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  const out = f.injected.find((x) => /tickets on team/.test(x));
  assert.ok(out, 'a list summary was returned to the sender');
  assert.match(out, /t1 \[open\] hand \d+\w+ — first task/);
  assert.match(out, /t2 \[open\] — \d+\w+ — second task/, 'unassigned shows — for the assignee');
  assert.ok(out.indexOf('t1') < out.indexOf('t2'), 'sorted by id');
  // t80: both tickets are OPEN here, so the default view hides nothing and the
  // count line must not appear at all (a "(0 done, 0 cancelled …)" line would
  // be noise). t100 UPDATED THE PATTERN: the old `closed —` no longer occurs in
  // any tail, so leaving it here would have been a check that passes whatever
  // the code does. Match the shape the code actually emits.
  assert.ok(!/\d+ done, \d+ cancelled/.test(out), 'no hidden-count line when nothing is hidden');
  assert.ok(!/recently closed:/.test(out), 'and no recent section when nothing is closed');
});

test('task list: an empty registry says so', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  assert.ok(f.injected.some((x) => /no tickets on team/.test(x)));
});

// ── t80: the board defaults to OPEN, closed tickets on request ───────────────
// Fixture helper: open three tickets and close two, leaving t1 open, t2 done,
// t3 cancelled — one of each real state.
function mkBoard() {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'still going' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'finished work' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'dropped work' });
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't2', who: null, body: 'report' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't3', who: null, body: 'nvm' });
  // ENTER check: the window this suite names only exists if the states really
  // differ — assert the board shape before testing how it is rendered.
  assert.strictEqual(f.one('t1').state, 'open');
  assert.strictEqual(f.one('t2').state, 'done');
  assert.strictEqual(f.one('t3').state, 'cancelled');
  f.injected.length = 0;
  return f;
}

test('t80 task list: the DEFAULT view hides closed tickets (t100: except a capped recent window)', () => {
  const f = mkBoard();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  const out = f.injected.find((x) => /tickets on team/.test(x));
  assert.ok(out, 'a list summary was returned');
  assert.match(out, /t1 \[open\]/, 'the open ticket is shown');
  // t80 asserted the done ticket was hidden OUTRIGHT. t100 narrows that: the
  // done PILE is still hidden, but the last 24h of it (capped) is shown on
  // purpose. mkBoard closes t2 a millisecond ago, so it is inside the window
  // and this assertion was inverted deliberately, not repaired to pass — the
  // property t80 owns (the board is not a wall of closed tickets) is pinned by
  // the cap and window tests below, and by the cancelled line here.
  assert.match(out, /t2 \[done\]/, 'a just-closed done ticket rides the recent section');
  assert.ok(!/t2 \[done\] hand \d+\w+ —/.test(out),
    'but NOT as an ordinary open-list row — it is in the recent block, closed-age formatted');
  assert.ok(!/t3 \[cancelled\]/.test(out), 'the cancelled ticket is hidden, recent or not');
});

test('t80 task list: the count line states how many are hidden AND how to see them', () => {
  const f = mkBoard();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  const out = f.injected.find((x) => /tickets on team/.test(x));
  // t100 split the single "2 closed" into its two real numbers. The PROPERTY
  // t80 pinned is unchanged — the count of what is hidden is stated — only its
  // shape moved, so this still asserts a count and not merely a word.
  assert.match(out, /\(1 done, 1 cancelled —/, 'the counts of hidden tickets, split by state');
  // The query must be spelled out: a reader who has to guess the syntax has
  // been told the tickets exist and nothing more.
  assert.match(out, /\[agent:task list done\]/, 'names the done query');
  assert.match(out, /\[agent:task list all\]/, 'names the all query');
});

test('t80 task list: each filter shows exactly its own state', () => {
  for (const [filter, want, notWant] of [
    ['done', /t2 \[done\]/, /t1 \[open\]/],
    ['cancelled', /t3 \[cancelled\]/, /t1 \[open\]/],
  ]) {
    const f = mkBoard();
    f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter, body: '' });
    const out = f.injected.find((x) => /tickets on team/.test(x));
    assert.ok(out, `${filter}: a summary was returned`);
    assert.match(out, want, `${filter}: shows its own state`);
    assert.ok(!notWant.test(out), `${filter}: does not show other states`);
    // An explicit filter is a chosen slice — no hidden-count line. Pattern
    // updated with the tail's shape (t100), same reason as above.
    assert.ok(!/\d+ done, \d+ cancelled/.test(out), `${filter}: no count line on an explicit filter`);
  }
});

test('t80 task list: `all` shows every state', () => {
  const f = mkBoard();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: 'all', body: '' });
  const out = f.injected.find((x) => /tickets on team/.test(x));
  assert.match(out, /t1 \[open\]/);
  assert.match(out, /t2 \[done\]/);
  assert.match(out, /t3 \[cancelled\]/);
});

test('t80 task list: an unknown filter BOUNCES with the valid set', () => {
  const f = mkBoard();
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: 'rejected', body: '' });
  const out = f.injected.find((x) => /unknown filter/.test(x));
  assert.ok(out, 'a typoed filter bounces loudly');
  assert.match(out, /open, done, cancelled, all/, 'and names the whole valid set');
  // Load-bearing: silently falling back to the default would tell a caller who
  // typoed that nothing is there. `rejected` is the likeliest typo precisely
  // because reject is a verb — but it reopens a ticket, so it is not a state.
  assert.ok(!f.injected.some((x) => /tickets on team/.test(x)),
    'a bad filter must NOT also render the default board');
});

test('t80 task list: a board with everything closed says so and still points on', () => {
  const f = mkBoard();
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done too' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  const out = f.injected.find((x) => /no open tickets/.test(x));
  assert.ok(out, 'an all-closed board reports no OPEN tickets, not "no tickets"');
  assert.match(out, /\(2 done, 1 cancelled —/, 'and still names the counts + query');
  // t100: the empty-board branch is the one place a reader has NOTHING else to
  // look at, so it is where the recent section earns its keep most.
  assert.match(out, /recently closed:/, 'the recent section rides the no-open branch too');
});

// ── t100: the default board keeps a capped day of closes ─────────────────────
// The board is written DIRECTLY here rather than driven through _handleTask,
// because every property below is about closedAt and the close verbs stamp it
// with Date.now(). A test that cannot place a ticket 25h in the past cannot
// test the window at all.
const HOUR = 60 * 60 * 1000;

// The window constant, read from the module source rather than restated here.
// A literal 24h in this file would keep passing if the product's constant moved,
// which is the one change the boundary test exists to catch.
const RECENT_DONE_MS = (() => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'team-tickets.js'), 'utf-8');
  const m = src.match(/const RECENT_DONE_MS = ([^;]+);/);
  assert.ok(m, 'ENTER: found RECENT_DONE_MS in team-tickets.js');
  return Function(`return (${m[1]})`)();
})();

// `agoH` places a close in hours; `agoMs` places one exactly, for the boundary.
function mkAged(rows) {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  const now = Date.now();
  f.tstore.save(f.team.root, rows.map((r, i) => ({
    id: `t${i + 1}`,
    title: r.title || `ticket ${i + 1}`,
    assignee: 'hand',
    state: r.state,
    openedAt: now - 30 * HOUR,
    closedAt: r.state === 'open' ? null : now - (r.agoMs != null ? r.agoMs : r.agoH * HOUR),
  })));
  f.injected.length = 0;
  return f;
}

const board = (f, filter = null) => {
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter, body: '' });
  return f.injected.find((x) => /tickets on team|no open tickets|no \w+ tickets/.test(x)) || '';
};

test('t100 task list: recently-closed done tickets ride the DEFAULT view, newest first', () => {
  const f = mkAged([
    { state: 'open', title: 'still going' },
    { state: 'done', agoH: 5, title: 'closed five hours ago' },
    { state: 'done', agoH: 1, title: 'closed one hour ago' },
  ]);
  const out = board(f);
  assert.match(out, /recently closed:/, 'the section is present');
  assert.match(out, /t2 \[done\] hand closed \d+h ago — closed five hours ago/);
  assert.match(out, /t3 \[done\] hand closed \d+h ago — closed one hour ago/);
  // Newest first: the point of the section is "what just happened", and id
  // order would answer a different question.
  assert.ok(out.indexOf('t3 [done]') < out.indexOf('t2 [done]'), 'sorted by closedAt descending');
  // The open ticket keeps its own row above the section, unchanged.
  assert.match(out, /t1 \[open\] hand \d+\w+ — still going/);
  assert.ok(out.indexOf('t1 [open]') < out.indexOf('recently closed:'), 'open tickets come first');
});

test('t100 task list: the 24h window EXCLUDES an older close but still COUNTS it', () => {
  const f = mkAged([
    { state: 'open' },
    { state: 'done', agoH: 25, title: 'yesterday-plus' },
    { state: 'done', agoH: 2, title: 'today' },
  ]);
  const out = board(f);
  // The discriminating pair: both are done, they differ ONLY in age, and they
  // must land in different places. Either assertion alone would pass for a
  // scanner that drops every done ticket or keeps every one.
  assert.ok(!/yesterday-plus/.test(out), 'a close 25h old is NOT in the recent section');
  assert.match(out, /today/, 'a close 2h old IS');
  assert.match(out, /\(2 done, 0 cancelled —/, 'but the tail counts BOTH — the older one is hidden, not forgotten');
});

test('t100 task list: the window is pinned AT its own boundary, not somewhere inside it', () => {
  // The other window test uses 2h and 25h — so far either side that any cutoff
  // between them passes it. If RECENT_DONE_MS became 6h or 20h the suite would
  // stay green, and the parity tests cannot help: both implementations carry
  // their own copy of the constant and would move together.
  //
  // Expressed against the constant itself, so this pins the BOUNDARY rather
  // than a number that happens to equal it today.
  const f = mkAged([
    { state: 'open' },
    { state: 'done', agoMs: RECENT_DONE_MS - 60_000, title: 'just inside' },
    { state: 'done', agoMs: RECENT_DONE_MS + 60_000, title: 'just outside' },
  ]);
  const out = board(f);
  // One minute apart and on opposite sides — the tightest pair that still
  // clears clock jitter between fixture construction and the render.
  assert.match(out, /just inside/, 'a close one minute inside the window is shown');
  assert.ok(!/just outside/.test(out), 'a close one minute outside it is not');
  assert.match(out, /\(2 done, 0 cancelled —/, 'both are still counted');
});

test('t100 task list: the recent section is CAPPED and the overflow folds into the count', () => {
  // 13 recent closes: 3 over the cap of 10. Uncapped, this is the bloat the
  // open-only default was introduced to remove.
  const rows = [{ state: 'open' }];
  for (let i = 0; i < 13; i++) rows.push({ state: 'done', agoH: i + 1, title: `recent ${i}` });
  const f = mkAged(rows);
  const out = board(f);
  const shown = (out.match(/\[done\]/g) || []).length;
  assert.strictEqual(shown, 10, 'exactly the cap is rendered, not all 13');
  // Built from the scraped constant, not written as `24h`: a literal here would
  // keep passing if RECENT_DONE_MS moved, which is the same false green this
  // file's own policy comment warns about two tests up.
  assert.match(out, new RegExp(`\\+3 more done in the last ${RECENT_DONE_MS / (60 * 60 * 1000)}h`),
    'the overflow is stated, with the window it actually used');
  assert.match(out, /13 done, 0 cancelled/, 'and the full done count is still there');
  // Which 10: the NEWEST. Dropping the newest and keeping the oldest would
  // satisfy a bare count check while inverting the section's purpose.
  assert.match(out, /recent 0/, 'the newest close survives the cap');
  assert.ok(!/recent 12/.test(out), 'the oldest of the 13 is the one cut');
});

test('t100 task list: cancelled is COUNTED separately and never enters the recent section', () => {
  const f = mkAged([
    { state: 'open' },
    { state: 'done', agoH: 1, title: 'shipped' },
    { state: 'cancelled', agoH: 1, title: 'dropped' },
  ]);
  const out = board(f);
  assert.match(out, /\(1 done, 1 cancelled —/, 'the two numbers are separate');
  assert.ok(!/2 closed/.test(out), 'and not lumped into one');
  // A cancellation is a non-event: recent-done only. This is the assertion
  // that distinguishes "recent closes" from "recent done", and the cancelled
  // ticket here is the same age as the done one so age cannot explain it.
  assert.match(out, /shipped/, 'the recent done ticket is shown');
  assert.ok(!/dropped/.test(out), 'the equally-recent cancelled one is not');
});

test('t100 task list: "cancelled" counts the cancelled state, not everything that is not done', () => {
  // The tail counted `closed.length - doneAll.length`, which labels EVERY
  // non-open non-done ticket a cancellation. There is no fourth state today, so
  // nothing else in the suite can catch this — the fixture has to invent one.
  // Written directly rather than through _taskCancel for exactly that reason.
  const f = mkAged([
    { state: 'open' },
    { state: 'done', agoH: 1 },
    { state: 'cancelled', agoH: 1 },
    { state: 'superseded', agoH: 1 },
  ]);
  const out = board(f);
  assert.match(out, /\(1 done, 1 cancelled —/,
    'one cancellation, not two — a state the counter has never heard of is not a drop');
  assert.ok(!/2 cancelled/.test(out), 'the unknown state is not silently folded into the cancelled count');
});

test('t100 task list: EXPLICIT filters get neither the recent section nor the split tail', () => {
  const f = mkAged([
    { state: 'open' },
    { state: 'done', agoH: 1 },
    { state: 'cancelled', agoH: 1 },
  ]);
  for (const filter of ['done', 'cancelled', 'all']) {
    const out = board(f, filter);
    assert.ok(out, `${filter}: a summary was returned`);
    assert.ok(!/recently closed:/.test(out), `${filter}: no recent section — the caller chose the slice`);
    assert.ok(!/\d+ done, \d+ cancelled/.test(out), `${filter}: no count tail either`);
  }
  // ENTER check: the default view over this same board DOES have both, so the
  // four assertions above are about the filter and not about an empty fixture.
  const dflt = board(f);
  assert.match(dflt, /recently closed:/, 'ENTER: the default view has the section');
  assert.match(dflt, /1 done, 1 cancelled/, 'ENTER: and the split tail');
});

test('t100 task list: an open-only board gets no section and no tail', () => {
  const f = mkAged([{ state: 'open' }, { state: 'open' }]);
  const out = board(f);
  assert.ok(!/recently closed:/.test(out), 'nothing closed — no empty section header');
  assert.ok(!/0 done, 0 cancelled/.test(out), 'and no zero-count tail');
});

test('list(): the assignee seat carries its open ticket id (sidebar badge seed)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const rows = Object.fromEntries(f.m.list().map((r) => [r.name, r]));
  assert.strictEqual(rows['team-hand'].ticket, 't1', 'the role seat shows its open ticket');
  assert.strictEqual(rows['lead'].ticket, null, 'a seat with no ticket shows null');
});

// --- watchdog: stall nudges the lead once per episode; backlog exempt ---------

test('watchdog: a stalled ASSIGNED ticket nudges the lead ONCE; a second sweep is silent', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // Age the ticket well past the default stall window.
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000; // 1h ago
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());
  const nudges = f.gated.filter((g) => g.target === 'lead' && /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'exactly one nudge to the lead');
  assert.ok(typeof f.one('t1').nudgedAt === 'number', 'ticket marked nudged');
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 0, 'no second nudge in the same episode');
});

test('watchdog: activity resets the stall episode (nudge fires again after a re-stall)', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  let arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  await f.m._sweepTickets(Date.now());
  assert.ok(f.one('t1').nudgedAt, 'nudged');
  // A turn on the assignee seat resets the episode.
  f.m._emitActivity('team-hand', 'thinking', false);
  assert.strictEqual(f.one('t1').nudgedAt, null, 'activity cleared the nudge episode');
  assert.ok(f.one('t1').lastActivityAt > Date.now() - 5000, 'lastActivityAt bumped to ~now');
  // Re-stall and sweep → nudges again.
  arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1, 're-nudged after the reset');
});

// --- t174: `parked` — filing WHO a ticket is for without dispatching it ------
// The defect: a ticket whose BODY said "BACKLOG, do not start" was dispatched
// anyway, because nothing reads the body. These pin the field the mechanism
// reads instead. `parked` is orthogonal to `state` on purpose — a parked ticket
// IS open — so every test here asserts both.

test('task add park: records the assignee and does NOT deliver the spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'later work' });
  const t = f.one('t1');
  assert.strictEqual(t.parked, true, 'the flag is on the record, not in the prose');
  assert.strictEqual(t.state, 'open', 'parked is NOT a state — the ticket is open');
  assert.strictEqual(t.assignee, 'hand', 'the assignee IS recorded — that is the whole point');
  assert.deepStrictEqual(f.gated, [], 'the seat was told nothing');
  assert.ok(f.injected.some((x) => /ticket t1 parked for hand/.test(x)), 'the lead is told it was parked');
});

test('task add without park writes NO parked key, so old records read identically', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'now' });
  // Absence, not `false`: every record predating t174 has no key, and a stored
  // `false` would be a second spelling of the same state for readers to get wrong.
  assert.ok(!('parked' in f.one('t1')), 'no parked key on an ordinary add');
  // t308: the contrast this pins is parked-vs-not, and since add stopped
  // dispatching, the observable difference is whether START is refused. An
  // unparked ticket starts; the parked test above asserts add delivered nothing
  // for BOTH, which is why the discriminator had to move here.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'and it still dispatches when started');
});

test('a parked ticket is invisible to _openTicketsFor, so advance SKIPS it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // t1 live, t2 parked, t3 live — t2 is minted BETWEEN them so it would sit at
  // the head of the FIFO after t1 closes. This is t119's "real dispatches queue
  // behind parked ones", and the fix must skip t2 without reordering t3.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'parked one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'third' });
  // t308: all three are STARTED, and t2 is parked AFTER the fact rather than at
  // add. Both halves are deliberate. `start` unparks, so a park-at-add t2 could
  // not also be started — and an UNSTARTED t2 would be dropped by the new
  // started-ness term, which would leave this test green while proving nothing
  // about `parked`. Parking a started ticket is the shape `[agent:task park]`
  // produces anyway, and it keeps t2's openedAt between its siblings.
  for (const id of ['t1', 't2', 't3']) f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id, body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't2', who: null, body: '' });
  assert.strictEqual(f.one('t2').parked, true, 'ENTER: t2 really is parked');
  assert.ok(f.one('t2').startedAt != null,
    'ENTER: and it is STARTED — so `parked` is the only term that can exclude it below, '
    + 'which is the property this test is here to pin');
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand').map((t) => t.id), ['t1', 't3'],
    'the parked ticket is dropped from the queue entirely');
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done' });
  const specs = f.gated.filter((g) => g.target === 'team-hand').map((g) => g.body);
  assert.ok(specs.some((b) => /^\[ticket t3 REPLAY\]/.test(b)), 'advance jumped to t3');
  assert.ok(!specs.some((b) => /^\[ticket t2\b/.test(b)), 'and never delivered the parked t2');
});

test('a parked ticket is never replayed to a respawned seat', () => {
  const f = mkTasks();
  f.seat('lead');
  const s = f.seat('team-hand', '/proj', { incarnation: 7 });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'parked' });
  f.gated.length = 0;
  assert.strictEqual(f.m._replayOpenTickets(s), true, 'the pass finishes — nothing is held');
  assert.deepStrictEqual(f.gated, [], 'a respawn does not resurrect a parked dispatch');
});

test('task assign UNPARKS: assign is the dispatch, so the flag cannot survive it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  const t = f.one('t1');
  // The key is REMOVED, not set false — same reason add omits it.
  assert.ok(!('parked' in t), 'the flag is gone from the record');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'the spec') }],
    'and the spec finally goes out');
  assert.ok(f.injected.some((x) => /unparked/.test(x)), 'the lead is told it was released');
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand').map((x) => x.id), ['t1'],
    'and it is back in the queue');
});

test('[agent:task park] toggles an already-open ticket both ways', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: dispatched on START — add wrote the ticket and delivered nothing');
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  assert.strictEqual(f.one('t1').parked, true, 'parked after the fact');
  assert.strictEqual(f.one('t1').state, 'open', 'still open');
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand'), [], 'out of the queue');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  assert.ok(!('parked' in f.one('t1')), 'the second call unparks');
  assert.deepStrictEqual(f.m._openTicketsFor(f.team, 'team-hand').map((t) => t.id), ['t1'], 'back in the queue');
  // Unpark deliberately does NOT re-send: assign owns delivery, and a second
  // delivery path would let the two disagree about what the seat was told.
  assert.deepStrictEqual(f.gated, [], 'neither direction delivers a spec');
});

test('task park: lead-gated, open-only, and bounces an unknown id', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  assert.ok(f.injected.some((x) => /only the team lead/.test(x)), 'a non-lead cannot park');
  assert.ok(!('parked' in f.one('t1')), 'and nothing was written');
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't9', who: null, body: '' });
  assert.ok(f.injected.some((x) => /no ticket t9/.test(x)), 'unknown id bounces');
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'report' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  assert.ok(f.injected.some((x) => /is done, not open/.test(x)), 'a closed ticket cannot be parked');
});

// ── t632: the park reply must not name an assign target that bounces ────────
//
// The same defect t629 fixed on `_taskStart`'s two refusals. `park`'s reply
// interpolated `ticket.role || ticket.assignee || '<role|name>'`, and that tail
// placeholder covers only the EMPTY case. `_resolveAssignee` accepts exactly a
// key of `team.roles` or a live seat name, and neither field is constrained to
// be either — `team role-remove` deletes the roles key while tickets still
// carry it — so a stale role key produced an `assign` command that then
// bounces, in the one clause whose whole job is to name the release route.
//
// Both subjects run the emitted target back through `_resolveAssignee` instead
// of matching its spelling, so a rewording that reintroduces a bouncing target
// reds however it is phrased.

// Scoped to the `[agent:task assign <id> …]` bracket, not a whole-reply scan:
// the unpark reply names the role legitimately outside any bracket, so a loose
// match would be satisfied by a bouncing command and an honest one alike.
function parkAssignTarget(said, id) {
  const m = said.match(new RegExp(`\\[agent:task assign ${id} ([^\\]]+)\\]`));
  assert.ok(m, `the park reply should name an assign command for ${id} — got: ${said}`);
  return m[1];
}

// STARTED, not parked — each subject parks it itself. `start` is what records
// `role` alongside the seat pin, and a park-at-add ticket carries only the bare
// role key in `assignee`, which could not tell the two legs of the helper's
// fallback chain apart.
function startedTicket(f) {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const t = f.one('t1');
  assert.strictEqual(t.role, 'hand', 'ENTER: start recorded the role the ticket was filed under');
  assert.strictEqual(t.assignee, 'team-hand', 'ENTER: and re-pinned the assignee to the live seat');
  assert.ok(t.startedAt != null, 'ENTER: started, so the PARK direction below is the one that runs');
  f.injected.length = 0;
  return t;
}

test('t632: park on a ticket carrying a REMOVED role key names a target that resolves', () => {
  const f = mkTasks();
  startedTicket(f);

  // `team role-remove` deletes the key outright (team-manifest.js), so a ticket
  // outliving its role needs no fixture surgery to reach.
  delete f.team.roles.hand;
  assert.strictEqual(f.m._resolveAssignee(f.team, 'hand'), null,
    'ENTER: `assign t1 hand` now bounces — exactly the state the old raw `ticket.role` walked into');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  const said = f.injected.join('\n');
  assert.match(said, /parked — held out of dispatch/, 'ENTER: the PARK arm, not the unpark one');
  const target = parkAssignTarget(said, 't1');
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  assert.strictEqual(target, 'team-hand', 'the live pin is what remains recoverable once the role key is gone');
});

test('t632: park still names the ROLE when it resolves, so "always emit the placeholder" reds', () => {
  const f = mkTasks();
  startedTicket(f);
  assert.strictEqual(f.m._resolveAssignee(f.team, 'hand'), 'hand', 'ENTER: the role is intact here — the anti-degenerate half');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  const target = parkAssignTarget(f.injected.join('\n'), 't1');
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  // A lead handed `<role|name>` for a ticket whose role is right there has to go
  // look it up, so degrading to the placeholder is not a safe universal answer.
  assert.strictEqual(target, 'hand', 'and it is the role the ticket was filed under, not the placeholder');
});

test('parking clears nudgedAt, so the unpark starts a fresh stall episode', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  await f.m._sweepTickets(Date.now());
  assert.ok(f.one('t1').nudgedAt, 'ENTER: stamped by the watchdog');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  // A stamp left behind would spend the one nudge of the episode that begins
  // when this unparks — and only activity clears it, which never comes while
  // the ticket is parked.
  assert.strictEqual(f.one('t1').nudgedAt, null, 'the stale stamp is cleared');
});

test('watchdog: a PARKED stalled ticket is EXEMPT even though it is started and assigned', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // STARTED, then parked — not parked at add. t328 made this distinction
  // load-bearing: a park-at-add ticket is also UNSTARTED, so the started-ness
  // term short-circuits before `t.parked` is ever evaluated and the whole test
  // passes without measuring the term it names. Same reasoning, and the same
  // fixture shape, as the _openTicketsFor pin above.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  const t = f.one('t1');
  assert.strictEqual(t.parked, true, 'ENTER: really parked');
  assert.ok(t.startedAt != null,
    'ENTER: and STARTED — so neither the unassigned nor the unstarted term can exempt it, '
    + 'which leaves `parked` as the only one that can. This is its only pin in the suite.');
  assert.ok(t.assignee != null, 'ENTER: and assigned');
  await f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [],
    'the lead parked it deliberately, so quiet is the expected state and an alarm reports its own decision back');
  assert.strictEqual(f.one('t1').nudgedAt, null);
});

test('a parked ticket is not the seat badge, on reconcile and on list()', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'parked' });
  const badge = f.broadcasts.filter((b) => b.channel === 'session-ticket' && b.msg.name === 'team-hand').pop();
  assert.ok(badge, 'ENTER: a badge was broadcast for the seat');
  assert.strictEqual(badge.msg.ticket, null, 'reconcile shows no ticket');
  // list() is first paint and reconcile is every change; a term in one and not
  // the other shows the badge until the next reconcile and then drops it.
  const row = f.m.list().find((s) => s.name === 'team-hand');
  assert.strictEqual(row.ticket, null, 'and first paint agrees');
});

test('task list marks a parked row, so an open list cannot read as work in flight', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'parked one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'live one' });
  f.injected.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  const out = f.injected.join('\n');
  assert.match(out, /t1 \[open parked\] hand/, 'the parked row says so');
  assert.match(out, /t2 \[open\] hand/, 'and the live row is unchanged');
});

test('watchdog: a BACKLOG (unassigned) stalled ticket is EXEMPT', async () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'backlog' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [], 'backlog tickets never nudge');
  assert.strictEqual(f.one('t1').nudgedAt, null);
});

// --- t328: the exemption is UNSTARTED, not unassigned -----------------------
//
// Measured: seven backlog tickets alarmed in one burst (t313, t319-t321, t323,
// t324, t326), every one filed by the lead and deliberately never started. The
// gate read `assignee == null`, but `add` writes the ROLE NAME there, so a
// filed-but-undispatched ticket was indistinguishable from a live one. Under the
// t322 ladder each would have gone on repeating at 30m/60m/120m/240m forever,
// because a ticket with no seat has nothing that can come back.
//
// The three tests below are one unit and must stay together: a gate that exempts
// EVERYTHING passes the first and is worthless, so the started case pins the
// other direction and the legacy case pins the arm the fix must not break.

test('t328 watchdog: an ASSIGNED but unstarted backlog ticket is exempt', async () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  // `add` with no `start` — exactly how the seven were filed.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'backlog' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  // ENTER: the record really is the defect's shape. Without this the test could
  // be exempting an unassigned ticket and pass for the pre-fix reason.
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'hand', 'ENTER: assignee is populated, so the old unassigned term cannot be what exempts it');
  assert.strictEqual(t.startedAt, null, 'ENTER: and it was never started');
  assert.ok(!t.parked, 'ENTER: nor parked — unstarted is the only term that can exempt it');
  await f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [],
    'no seat holds it, so there is nothing that could go quiet and nothing to alarm about');
  assert.strictEqual(f.one('t1').nudgedAt, null, 'and no stamp, so a later dispatch starts a clean episode');
});

test('t328 watchdog: a STARTED ticket whose seat goes quiet still alarms', async () => {
  // The other direction, in the same unit as the exemption above. An exemption
  // test alone is green under a gate that skips every ticket.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  assert.ok(f.one('t1').startedAt != null, 'ENTER: dispatched, so the exemption must not reach it');
  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1,
    'a dispatched seat that went quiet is the case the watchdog exists for');
});

test('t328 watchdog: a legacy record with no startedAt key still alarms', async () => {
  // ticketStarted reads an ABSENT `startedAt` as started — those records predate
  // the key and were dispatched by the old `add`, which delivered on write. If
  // the fix read them as unstarted, every pre-upgrade ticket in flight would go
  // silently unwatched, which is the failure the watchdog cannot have.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const arr = f.load();
  delete arr[0].startedAt;            // the pre-upgrade shape
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  assert.ok(!('startedAt' in f.one('t1')), 'ENTER: the key is absent on disk, not merely null');
  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1,
    'the legacy arm is preserved — an old in-flight ticket is still watched');
});

test('t328 watchdog: a legacy UNASSIGNED record is exempt though it reads as started', async () => {
  // This is the case that justifies keeping BOTH `t.assignee == null` and
  // `!ticketStarted(t)` in the gate, and it is the only thing defending that
  // decision. The shape: `startedAt` key absent, so ticketStarted returns TRUE
  // via the legacy arm — but no assignee, so no seat can be resolved and an
  // alarm would name nobody.
  //
  // Collapse the two terms into the obvious `!ticketStarted(t)` simplification
  // and THIS is the test that goes red. Nothing else covers it: the other
  // legacy pin above is assigned, and the backlog pin below is unstarted.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'legacy backlog' });
  const arr = f.load();
  delete arr[0].startedAt;            // pre-upgrade record: no such key
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  const t = f.one('t1');
  assert.ok(!('startedAt' in t), 'ENTER: the key is absent on disk, not merely null');
  assert.strictEqual(ticketsMod.ticketStarted(t), true,
    'ENTER: so the started-ness term reads it as STARTED and cannot be what exempts it');
  assert.strictEqual(t.assignee, null, 'ENTER: leaving the unassigned term as the only one that can');
  await f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [],
    'no assignee means no seat to resolve, so the alarm would name nobody');
  assert.strictEqual(f.one('t1').nudgedAt, null);
});

// --- t331: the exemption is PER-TICKET, not a sweep abort -------------------

test('t331 watchdog: an exempt ticket skips itself, not the rest of the board', async () => {
  // The exemption is a `continue`. Every other fixture that reaches it has a
  // SINGLE-ELEMENT board, where `continue` and `break` are indistinguishable —
  // so mutating it to `break` killed nothing in the suite. This is the pin.
  //
  // ORDER IS LOAD-BEARING AND MUST NOT BE TIDIED: the exempt ticket has to come
  // FIRST in array order. Put it second and a `break` still lets t1 alarm, the
  // test passes, and the pin is itself vacuous — which is the exact defect
  // class it was written to close. Both tickets are stale past the window, so
  // the exemption is the only thing that can skip t1; a fresh t1 would exit at
  // the age gate instead and pin a different `continue`.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  // t1: assigned, never started — exempt. Filed first, so the sweep meets it first.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'backlog, never dispatched' });
  // t2: started and then quiet — the case the watchdog exists for.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  const arr = f.load();
  arr.forEach((t) => { t.lastActivityAt = Date.now() - stallMs * 2; });
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  const board = f.load();
  assert.deepStrictEqual(board.map((t) => t.id), ['t1', 't2'],
    'ENTER: the exempt ticket is FIRST on the board, or a `break` would still let the stalled one alarm');
  const [t1, t2] = board;
  assert.strictEqual(t1.startedAt, null, 'ENTER: t1 is unstarted, so it reaches the exemption');
  assert.strictEqual(t1.assignee, 'hand', 'ENTER: and assigned, so the unassigned term is not what skips it');
  assert.ok(t2.startedAt != null, 'ENTER: t2 is started, so nothing exempts it');
  assert.ok(Date.now() - t2.lastActivityAt > stallMs, 'ENTER: and stale past the window, so only the sweep reaching it decides');

  await f.m._sweepTickets(Date.now());

  const alarms = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(alarms.length, 1, 'exactly one alarm: the exemption skipped t1 only, and the sweep carried on to t2');
  assert.match(alarms[0].body, /\[ticket t2\]/, 'and it names t2 — the started ticket BEHIND the exempt one in array order');
  assert.strictEqual(f.one('t1').nudgedAt, null, 'the exempt ticket is still unstamped');
});

// --- t377: a stall alarm about a seat that does not exist -------------------
//
// Measured on t376: the seat was retired, and the watchdog alarmed
// `stalled: hand quiet 31m (no commits)`, then `STILL stalled (repeat 1): hand
// quiet 1h` after the ticket had already been cancelled. There was no quiet
// hand; there was no hand. The repeat is the expensive half — a stall alarm the
// lead learns to dismiss is worse than no alarm, and the case where it most
// needs to be trusted is a genuinely silent seat.
//
// The three tests below are ONE UNIT. The orphan test alone is green under a
// gate that classifies every ticket as orphaned, so the live-but-quiet test
// pins the other direction, and the repeat test pins the half that cost the
// most. `mkTasks` gives the reviewer role `instantiate: 'subagent'`, so `hand`
// is the role these use.

// A worktree ticket whose seat is gone. Worktree, because that is the measured
// shape AND the only one that stays orphaned: `_ticketAssigneeSeat` refuses to
// degrade a worktree pin back to its role (a sibling would be sent into another
// branch's checkout), so a retired worktree seat resolves to null permanently.
function orphanedTicket(f, { stallMs }) {
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  // The retirement, expressed on the record: pinned to a concrete seat name that
  // is not in `sessions`, and carrying a tree so the pin cannot degrade.
  arr[0].assignee = 'team-hand-1';
  arr[0].role = 'hand';
  arr[0].worktree = { path: '/proj/wt-t1', branch: 't1-thing' };
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  return f.one('t1');
}

test('t377 watchdog: a ticket whose seat no longer exists is UNASSIGNED, not stalled', async () => {
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');                       // the lead only — no hand seat anywhere
  const t = orphanedTicket(f, { stallMs });
  // ENTER: every OTHER exemption must be unable to explain the outcome, or this
  // test passes for one of t328's reasons and measures nothing new.
  assert.ok(t.startedAt != null, 'ENTER: started, so the unstarted exemption cannot reach it');
  assert.strictEqual(t.assignee, 'team-hand-1', 'ENTER: assigned, so the unassigned term cannot either');
  assert.ok(!t.parked, 'ENTER: not parked');
  assert.strictEqual(t.state, 'open', 'ENTER: still in flight');
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, t), null,
    'ENTER: and it really resolves to no live seat — the whole premise');

  await f.m._sweepTickets(Date.now());

  // It still ALARMS — going silent would be a different bug, and a worse one:
  // a ticket nobody holds is exactly what the lead needs told.
  assert.strictEqual(f.gated.length, 1, 'ENTER: the sweep spoke once, so the assertions below are about a real body');
  const body = f.gated[0].body;
  assert.ok(!/stalled: /.test(body),
    'it must NOT read as a stall — "hand quiet 31m" sends the lead looking at a seat that is not there');
  assert.match(body, /not a live seat/, 'it names the actual fact');
  assert.match(body, /reassign/i, 'and an exit, since waiting is not one');
});

test('t377 watchdog: a LIVE seat that goes quiet still gets the ordinary stall alarm', async () => {
  // The other direction, in the same unit. Identical fixture except that the
  // pinned seat exists — so a gate that called everything an orphan turns this
  // red, and only this.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  f.seat('team-hand-1');                // the ONLY difference from the test above
  const t = orphanedTicket(f, { stallMs });
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, t), 'team-hand-1',
    'ENTER: the seat resolves, so this is the genuine stall the watchdog exists for');

  await f.m._sweepTickets(Date.now());

  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one alarm to inspect');
  const body = f.gated[0].body;
  assert.match(body, /stalled: /, 'a live-but-quiet seat keeps the stall wording');
  assert.ok(!/not a live seat|UNASSIGNED/.test(body), 'and is never reported as unassigned');
});

test('t377 watchdog: an orphaned ticket alarms ONCE and never climbs the repeat ladder', async () => {
  // The half that actually cost: t376 was re-alarmed at 1h, marked `repeat 1`,
  // about a seat retired an hour earlier and a ticket already cancelled. A stall
  // repeats because a seat can come back; an orphan cannot resolve itself, so
  // every repeat carries identical information.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  orphanedTicket(f, { stallMs });
  const t0 = Date.now();

  await f.m._sweepTickets(t0);
  assert.strictEqual(f.gated.length, 1, 'ENTER: the first alarm fired, so the silence below is a second sweep`s and not the first`s');
  assert.ok(f.one('t1').nudgedAt, 'ENTER: and it stamped — the stamp is what the suppression reads');

  // The clock moves, NOT `lastActivityAt`. That distinction is what makes this
  // test able to fail: the geometric gate re-alarms when the quiet has DOUBLED
  // since the last alarm, and it reads `nudgedAt - lastActivityAt` as the age it
  // fired at. Pushing `lastActivityAt` further back inflates that stamp too, so
  // the ratio never reaches 2 and the LADDER suppresses the second alarm — a
  // fixture built that way is green with the orphan gate deleted entirely.
  // Measured: it survived exactly that mutant before this was rewritten.
  //
  // First alarm fired at age 2*stallMs, so the ladder's next rung is 4*stallMs.
  const later = t0 + stallMs * 3;   // age is now 5*stallMs — past the rung
  const t = f.one('t1');
  assert.ok((later - t.lastActivityAt) >= (t.nudgedAt - t.lastActivityAt) * 2,
    'ENTER: a STALL would re-escalate at this instant, so only the orphan rule can be what silences it');
  f.gated.length = 0;
  await f.m._sweepTickets(later);
  assert.deepStrictEqual(f.gated, [],
    'nothing changed and nothing can change on its own, so a second alarm is pure noise');
});

test('t377 watchdog: a ticket that goes live -> orphaned crosses the boundary and alarms AGAIN', async () => {
  // THE case the ticket was written from, and the one the first round of these
  // tests missed entirely: every other fixture here enters with the seat already
  // gone or already live, so none of them crosses the transition — and the
  // transition IS the feature. t376 was alarmed about as a live-but-quiet stall
  // FIRST, and only retired afterwards.
  //
  // The first alarm stamps `nudgedAt`. A suppression that keys off `nudgedAt`
  // alone therefore silences the orphan alarm that should follow, permanently:
  // `nudgedAt` clears only on activity (impossible — the seat is gone), assign,
  // respec, park or verdict. Net effect is the lead hearing "hand quiet 31m" and
  // then nothing, ever — message 2 DELETED rather than upgraded, which is worse
  // than the noise it replaced.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  f.seat('team-hand-1');                 // LIVE for the first sweep
  orphanedTicket(f, { stallMs });
  const t0 = Date.now();

  await f.m._sweepTickets(t0);
  assert.strictEqual(f.gated.length, 1, 'ENTER: the live-but-quiet stall alarmed');
  assert.match(f.gated[0].body, /stalled: /,
    'ENTER: and as a STALL — so the orphan path has not run yet and cannot be what stamps');
  const stamped = f.one('t1').nudgedAt;
  assert.ok(stamped, 'ENTER: the stall alarm stamped nudgedAt — the state that suppresses what follows');

  // The retirement. Nothing else changes: the ticket stays open, stays assigned,
  // and no activity can ever clear the stamp, because there is no seat to act.
  f.m.sessions.delete('team-hand-1');
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), null,
    'ENTER: it now resolves to nobody — the boundary has been crossed');
  assert.strictEqual(f.one('t1').nudgedAt, stamped,
    'ENTER: and the stamp survived the retirement, since only activity/assign clears it');

  f.gated.length = 0;
  // Past the ladder rung too, so a stall would also have spoken here — the point
  // is not that SOMETHING fires but that what fires is the orphan message.
  await f.m._sweepTickets(t0 + stallMs * 3);

  assert.strictEqual(f.gated.length, 1,
    'the lead must be told the seat is gone — a live->orphan ticket that goes permanently silent is '
    + 'strictly worse than the repeating noise this ticket set out to remove');
  assert.match(f.gated[0].body, /not a live seat/, 'and it is the ORPHAN body, not a second stall');
  assert.ok(!/stalled: /.test(f.gated[0].body), 'the stall wording is gone, per the ticket');
});

test('t377 watchdog: reassigning an orphaned ticket re-opens it to alarming', async () => {
  // The suppression above is scoped to the UNCHANGED situation, not to the
  // ticket forever. Without this, an orphan that was reassigned to a seat which
  // then genuinely stalled would be silent for the rest of its life — trading
  // t376's noise for a much more expensive silence.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  orphanedTicket(f, { stallMs });
  await f.m._sweepTickets(Date.now());
  assert.ok(f.one('t1').nudgedAt, 'ENTER: stamped by the orphan alarm — the state the suppression depends on');

  // What a reassignment does to the record. `task assign` clears `nudgedAt` for
  // exactly this reason; the seat now exists, so the ticket is a live stall.
  f.seat('team-hand-1');
  const arr = f.load();
  arr[0].nudgedAt = null;
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.length, 1, 'the reassigned ticket is watched again');
  assert.match(f.gated[0].body, /stalled: /, 'and as an ordinary stall, since a seat holds it now');
});

test('t377 watchdog: a ticket orphaned, reassigned, then orphaned AGAIN alarms both times', async () => {
  // The stamp is per-EPISODE, not once per ticket lifetime. A ticket reassigned to
  // a seat that then also dies is a second, genuinely new orphaning, and the lead
  // has heard nothing about it. Leaving the first round's `orphanNudgedAt` in place
  // suppresses it — the must-fix's own failure mode, one lap later.
  //
  // This is what makes the `delete` on the stall arm load-bearing rather than
  // tidiness: the reassignment's stall alarm is what clears the old stamp.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  orphanedTicket(f, { stallMs });
  const t0 = Date.now();

  await f.m._sweepTickets(t0);
  assert.match(f.gated[0].body, /not a live seat/, 'ENTER: round one orphaned and said so');
  assert.ok(f.one('t1').orphanNudgedAt, 'ENTER: and stamped the orphan marker');

  // Reassigned to a live seat, which then goes quiet: an ordinary stall, and the
  // alarm that clears the orphan stamp.
  f.seat('team-hand-1');
  let arr = f.load();
  arr[0].nudgedAt = null;                 // what `task assign` does
  arr[0].lastActivityAt = t0 - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(t0);
  assert.match(f.gated[0].body, /stalled: /, 'ENTER: round two is a live stall');
  assert.strictEqual(f.one('t1').orphanNudgedAt, undefined,
    'ENTER: and the stall arm cleared the stale orphan stamp — the state the third round depends on');

  // The second seat dies too. Nothing clears `nudgedAt` this time either.
  f.m.sessions.delete('team-hand-1');
  f.gated.length = 0;
  await f.m._sweepTickets(t0 + stallMs * 3);

  assert.strictEqual(f.gated.length, 1, 'the second orphaning is news, and must be reported');
  assert.match(f.gated[0].body, /not a live seat/, 'and reported as an orphan, not a stall');
});

test('t377 watchdog: a seat that comes up DURING the git probe is not reported as orphaned', async () => {
  // `orphan` is decided before `_stallEvidence` is awaited, and the post-await
  // re-read checks `lastActivityAt` — which a seat that just spawned has not
  // touched. So the record is byte-identical while the classification has
  // flipped, and only re-resolving the seat can catch it.
  //
  // The stakes are higher than a mis-worded alarm: the orphan arm is one-shot, so
  // stamping `orphanNudgedAt` here would suppress the REAL alarm afterwards.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  orphanedTicket(f, { stallMs });        // no hand seat — orphaned as the sweep begins
  // The seat arrives while git is running. Hooking the probe is what puts the
  // spawn INSIDE the await window; doing it before the sweep would test nothing.
  // The seat appears while the probe is awaited. It is added BEFORE the yield and
  // the yield is explicit, rather than wrapping the real `_stallEvidence`: that one
  // throws in this fixture (no gitWorktree dep) and the sweep swallows the throw,
  // so a wrapper would never reach its own spawn — an instrumented run showed the
  // hook entering and never completing.
  //
  // The returned shape is the REAL one for this fixture, not a convenient blank:
  // every other orphan test here gets all-null evidence for the same reason, so
  // nothing the assertions read is being faked away.
  f.m._stallEvidence = async () => {
    f.seat('team-hand-1');
    await Promise.resolve();
    return { tool: null, commits: null, dirty: null };
  };

  await f.m._sweepTickets(Date.now());

  assert.strictEqual(f.gated.length, 1, 'ENTER: one alarm to inspect');
  assert.ok(!/not a live seat/.test(f.gated[0].body),
    'the seat is live by the time the body is built, so it must not be called absent');
  assert.strictEqual(f.one('t1').orphanNudgedAt, undefined,
    'and no orphan stamp is left behind, which would have suppressed the real alarm later');
});

test('t377 watchdog: another team`s ticket is never classified as orphaned', async () => {
  // Two teams rooted at one project: the stall sweep dedups per BOARD, so team A
  // resolves team B's ticket against A's `roles`. B's role key is not a role of
  // A, so the pin fails isRoleKey, the seat name is absent from A's live set, and
  // a ticket with a live B seat reads as orphaned.
  //
  // Wording alone was survivable. Classification is not: the orphan arm is
  // one-shot, so B's genuinely stalled ticket would be alarmed about once, in the
  // wrong words, and then never again.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].role = 'shipwright';           // a role of the OTHER team, unknown to this one
  arr[0].assignee = 'other-shipwright-1';
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  assert.ok(!Object.prototype.hasOwnProperty.call(f.team.roles, 'shipwright'),
    'ENTER: the role really is foreign to the sweeping team');
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), null,
    'ENTER: and it resolves to nothing HERE — so only the foreign-role guard can stop the orphan reading');

  await f.m._sweepTickets(Date.now());

  assert.strictEqual(f.gated.length, 1, 'ENTER: it still alarms — going silent would be the worse bug');
  assert.ok(!/not a live seat/.test(f.gated[0].body),
    'this sweep cannot see the other team`s roster, so it must not assert the seat is gone');
  assert.match(f.gated[0].body, /stalled: /, 'it falls back to the stall body, which keeps its ladder');
  assert.strictEqual(f.one('t1').orphanNudgedAt, undefined,
    'and takes no one-shot stamp, so the ticket keeps escalating');
});

test('watchdog: a per-team watchdogMs override tightens the stall window', async () => {
  const f = mkTasks();
  f.team.watchdogMs = 1000; // 1s
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 5000; // 5s ago — past 1s, well within the 30m default
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1, 'the tighter override fires the nudge');
});

// --- t322: the alarm re-escalates, and it carries evidence ------------------
//
// Both halves come from one measured incident. On t312 the watchdog fired at 30m
// with "hand quiet 30m", the lead dismissed it as benign after seeing a dirty
// worktree, and the remaining 28 minutes of a 55.7m stall raised NOTHING —
// `nudgedAt` is cleared only by seat activity, which never comes during a stall.

test('t322 a stall that keeps stalling speaks again once the quiet has DOUBLED', async () => {
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - stallMs;          // t0: the seat's last activity
  const arr = f.load();
  arr[0].lastActivityAt = quiet;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  const at = (mins) => quiet + mins * 60 * 1000;
  await f.m._sweepTickets(at(30));
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1, 'the first alarm fires at the window');

  // The measured regression: after the lead dismissed the 30m alarm, nothing
  // spoke again for the rest of the stall.
  await f.m._sweepTickets(at(31));
  await f.m._sweepTickets(at(45));
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1,
    'it does not re-alarm every sweep — that is the flood the one-shot rule existed to prevent');

  await f.m._sweepTickets(at(60));
  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 2, 'but at DOUBLE the quiet it speaks again');
  assert.match(nudges[1].body, /STILL stalled \(repeat 1\)/, 'and the repeat says it is one');
  assert.match(nudges[1].body, /quiet 1h/, 'carrying the updated idle time, not the first alarm`s');

  await f.m._sweepTickets(at(90));
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 2, 'quiet again until the next doubling');
  await f.m._sweepTickets(at(120));
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 3, 'which lands at 2h — 30m, 1h, 2h');
});

test('t327 the repeat number is the ladder RUNG, distinct on every one of them', async () => {
  // `prevAge > 0 ? 1 : 0` printed "repeat 1" at 60m, 120m AND 240m, so the field
  // that exists to tell a half-hour stall from an all-night one said the same
  // thing on all three. A single-rung pin cannot see that: it is the SECOND and
  // later rungs that were wrong, and 1 is right by accident on the first.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - stallMs;
  const arr = f.load();
  arr[0].lastActivityAt = quiet;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  const at = (mins) => quiet + mins * 60 * 1000;
  for (const mins of [30, 60, 120, 240]) await f.m._sweepTickets(at(mins));

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 4, 'ENTER: all four rungs of the ladder alarmed — 30m, 1h, 2h, 4h');
  // The heads, in order. Asserted as the whole set rather than rung by rung: the
  // defect was that three of them were IDENTICAL, which only a comparison across
  // rungs can catch.
  assert.deepStrictEqual(
    nudges.map((n) => n.body.match(/^\[ticket t1\] (?:STILL stalled \(repeat \d+\)|stalled)/)[0]),
    [
      '[ticket t1] stalled',
      '[ticket t1] STILL stalled (repeat 1)',
      '[ticket t1] STILL stalled (repeat 2)',
      '[ticket t1] STILL stalled (repeat 3)',
    ],
    'the first is not a repeat, and each later rung carries its own ordinal');
  // The ordinal tracks the AGE it is meant to summarise, not just some counter.
  assert.match(nudges[3].body, /quiet 4h/, 'rung 3 is the 4h alarm');
});

// --- t400: rung 2, the automated wake ---------------------------------------
//
// The gate is a two-signal probe over CONSECUTIVE sweeps, so every test here
// drives at least three: sweep 1 has no baseline and answers `unknown`, sweep 2
// classifies `wedged` for the first time and is deliberately not trusted, and
// sweep 3 is the confirm that may wake. A fixture driving ONE sweep would
// measure the deferral and mistake it for the gate.
const WAKE_STALL_MS = 30 * 60 * 1000;
const WAKE_GRACE_MS = 5 * 60 * 1000;
const WAKE_CONFIRM_MS = 90 * 1000;

function mkWake(seatProps = {}, extra = {}, agoMs = WAKE_STALL_MS) {
  const f = mkTasks(extra);
  f.seat('lead');
  const hand = f.seat('team-hand', '/proj', seatProps);
  // A READABLE transcript, which is a precondition rather than scenery:
  // `_seatTranscriptSize` answers -1 when it cannot read, `didGrow` refuses -1
  // in either direction, and the seat would then classify wedged on CPU alone —
  // the one-signal read the gate refuses. Without this file every test below
  // would measure the refusal instead of the case it names.
  const target = pathReal.join(f.home, 'hand-transcript.jsonl');
  fsReal.writeFileSync(target, '');
  fsReal.mkdirSync(runDirForReal(f.home, 'team-hand'), { recursive: true });
  fsReal.symlinkSync(target, pathForReal(f.home, 'team-hand', 'transcript'));
  assert.strictEqual(f.m._seatTranscriptSize('team-hand'), 0,
    'ENTER: the probe must READ the transcript, or every wake below is refused for the wrong reason');
  // Flat by default: the wedge shape. `_samplePtyTreeCpuMs` shells out to `ps`,
  // which would measure this test runner's own tree.
  let cpu = 5000;
  f.m._samplePtyTreeCpuMs = () => Promise.resolve(cpu);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - agoMs;
  const arr = f.load();
  arr[0].lastActivityAt = quiet;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0; f.injected.length = 0;
  const at = (mins) => quiet + Math.round(mins * 60 * 1000);
  const sweep = (mins) => f.m._sweepTeamTickets({ ...f.team, watchdogMs: WAKE_STALL_MS }, at(mins));
  return {
    f, hand, quiet, at, sweep, target,
    setCpu: (v) => { cpu = v; },
    grow: (n) => fsReal.writeFileSync(target, 'x'.repeat(n)),
    alarms: () => f.gated.filter((g) => /stalled/.test(g.body)),
    wakes: () => f.injected.filter((x) => /wake\]/.test(x)),
  };
}

test('t400 the wake needs a CONFIRMED wedge: the first wedged sweep defers, the second wakes', async () => {
  const w = mkWake();
  await w.sweep(30);
  assert.deepStrictEqual(w.wakes(), [], 'sweep 1 has no baseline — `unknown` is not a reading');
  await w.sweep(31);
  assert.deepStrictEqual(w.wakes(), [],
    'sweep 2 is the FIRST wedged verdict, and one is never enough: whole-second CPU resolution and the '
    + 'tree sum`s one non-monotonic step both produce a single false wedge');
  assert.deepStrictEqual(w.alarms(), [], 'ENTER: and nothing has alarmed yet, so the wake below is rung 2 and not a late rung 3');
  await w.sweep(32);
  assert.strictEqual(w.wakes().length, 1, 'the confirming sweep wakes the seat');
  assert.match(w.wakes()[0], /automated wake — nothing new is being asked/,
    'the text says it asks for nothing: a seat that IS working must be able to ignore it');
  assert.match(w.wakes()[0], /never received the ticket`s spec|never received the ticket's spec/,
    'and it carries the no-spec exit — the eaten draft may have BEEN the spec, with the latch`s one retry spent');
  assert.deepStrictEqual(w.alarms(), [], 'the wake DEFERS the lead`s alarm — that is the whole point of a middle rung');
  assert.ok(typeof w.f.one('t1').wakeAt === 'number', 'and it stamps the attempt on the record');
});

test('t400 a seat with CPU accruing is never woken — the tree-CPU signal is what keeps a working seat safe', async () => {
  const w = mkWake();
  await w.sweep(30);
  w.setCpu(5000 + 60_000);   // a minute of CPU across a minute of gap: unmistakably alive
  await w.sweep(31);
  w.setCpu(5000 + 120_000);
  await w.sweep(32);
  assert.deepStrictEqual(w.wakes(), [],
    'a seat burning CPU inside a tool call reads idle and writes nothing to its transcript — the tree sum is '
    + 'the ONLY signal that separates it from a wedge, and waking it splices into live work');
});

test('t400 a seat whose transcript is GROWING is never woken', async () => {
  const w = mkWake();
  await w.sweep(30);
  w.grow(100);
  await w.sweep(31);
  w.grow(200);
  await w.sweep(32);
  assert.deepStrictEqual(w.wakes(), [], 'transcript growth is `moving` — the seat is demonstrably producing');
});

// The §5 structural exclusions, as one table. Each row is a seat state that is
// wedged-confirmed by the PROBE and must still never be written to, so the probe
// is held constant and the seat state is the only variable — a row that refused
// for a probe reason would pass while measuring nothing.
//
// Every row also asserts the ALARM still fires, which is the half that makes
// these refusals safe rather than silent: a gate that refused the wake AND
// swallowed rung 3 would leave the seat unreported, which is strictly worse than
// the pre-rung-2 behaviour it replaces.
for (const [what, props, why] of [
  ['a permission dialog', { needsAttention: { kind: 'permission' } },
    'injection ends with Enter, which would ANSWER the dialog'],
  ['a live spec latch', { _specUnconfirmed: { at: Date.now() } },
    'the latch IS the recovery mechanism and redelivers the real content; the wake`s induced turn would clear it as if consumed'],
  ['a live dm-unconfirmed fifo', { _dmUnconfirmed: [{ at: Date.now(), from: 'x' }] },
    'the induced turn clears the fifo before its 90s report ever tells the senders'],
  ['an open operator draft', { lastUserInputTs: Date.now(), lastUserSubmitTs: 0 },
    'Ctrl-U destroys whatever is sitting unsubmitted — the operator`s own text'],
  ['a seat mid-turn', { activityState: 'thinking' },
    'a write queues behind the turn and can only add noise'],
  ['a codex seat', { agentType: 'codex' },
    'the transcript probe is claude-only, so the wedge would rest on CPU alone'],
]) {
  test(`t400 gate: ${what} refuses the wake, and the ALARM still fires`, async () => {
    const w = mkWake(props);
    for (const m of [30, 31, 32, 33]) await w.sweep(m);
    assert.deepStrictEqual(w.wakes(), [], `${what} must never be written to: ${why}`);
    assert.strictEqual(w.alarms().length, 1,
      'and the lead is still told — a refusal that also swallowed rung 3 would be silent alarm deletion');
    assert.strictEqual(w.f.one('t1').wakeAt, undefined, 'nothing was attempted, so nothing is stamped');
  });
}

// The lead is rung 3's RECIPIENT, so a self-assigned ticket has no rung above the
// wake to catch a mistake. Its own row because the exclusion is by NAME, not by
// seat state — every gate above would pass.
test('t400 gate: the LEAD`s own seat is never woken, even wedged-confirmed', async () => {
  const f = mkTasks();
  const lead = f.seat('lead');
  const target = pathReal.join(f.home, 'lead-transcript.jsonl');
  fsReal.writeFileSync(target, '');
  fsReal.mkdirSync(runDirForReal(f.home, 'lead'), { recursive: true });
  fsReal.symlinkSync(target, pathForReal(f.home, 'lead', 'transcript'));
  assert.strictEqual(f.m._seatTranscriptSize('lead'), 0,
    'ENTER: the lead`s transcript reads, so only the name check can refuse this');
  f.m._samplePtyTreeCpuMs = () => Promise.resolve(5000);
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'lead', id: null, body: 'i will do this' });
  f.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - WAKE_STALL_MS;
  const arr = f.load(); arr[0].lastActivityAt = quiet; f.tstore.save(f.team.root, arr);
  f.injected.length = 0;
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), 'lead',
    'ENTER: the ticket really does resolve to the lead — otherwise this refuses for want of a seat');
  for (const m of [30, 31, 32, 33]) {
    await f.m._sweepTeamTickets({ ...f.team, watchdogMs: WAKE_STALL_MS }, quiet + m * 60 * 1000);
  }
  assert.deepStrictEqual(f.injected.filter((x) => /wake\]/.test(x)), [],
    'an automated write into the operator-facing session has no rung above it');
});

// PRODUCE ABORT. The sweep's decision and the queue's write are separated by the
// boot-ready gate, the quiet gate and queue depth, so everything the gate checked
// can change in between — and the Ctrl-U that leads every injection is
// destructive, so a late write is not merely noise. `produce` is the only hook
// that runs at the last instant.
//
// mkPark's _injectText models the queue by calling produce at write time, so
// mutating state BEFORE the sweep returns reaches the producer exactly as a real
// gap would. Each row asserts BOTH halves: no bytes AND no stamp — a stamp
// without bytes spends the episode's one wake on a write that never happened.
for (const [what, mutate] of [
  ['the seat starts a turn on its own', (w) => { w.hand.activityState = 'thinking'; }],
  ['an operator draft opens', (w) => { w.hand.lastUserInputTs = Date.now(); w.hand.lastUserSubmitTs = 0; }],
  ['a permission dialog appears', (w) => { w.hand.needsAttention = { kind: 'permission' }; }],
  ['the seat dies', (w) => { w.hand._dead = true; }],
  ['the ticket closes', (w) => {
    const a = w.f.load(); a[0].state = 'done'; a[0].closedAt = Date.now(); w.f.tstore.save(w.f.team.root, a);
  }],
  ['the seat speaks, moving activity', (w) => {
    const a = w.f.load(); a[0].lastActivityAt = Date.now(); w.f.tstore.save(w.f.team.root, a);
  }],
]) {
  test(`t400 produce abort: ${what} between the decision and the write — no bytes, no stamp`, async () => {
    const w = mkWake();
    await w.sweep(30);
    await w.sweep(31);
    // Armed on the CONFIRMING sweep only, so the mutation lands in the real gap
    // rather than suppressing the decision itself.
    let reached = false;
    const realInject = w.f.m._injectText;
    w.f.m._injectText = (s, text, opts) => {
      reached = true;
      mutate(w);
      return realInject.call(w.f.m, s, text, opts);
    };
    await w.sweep(32);
    assert.ok(reached, 'ENTER: the sweep must have DECIDED to wake, or this pins the gate and not the abort');
    assert.deepStrictEqual(w.wakes(), [], 'the producer returned null, so the Ctrl-U itself never happened');
    assert.strictEqual(w.f.one('t1').wakeAt, undefined,
      'and nothing was stamped: an aborted produce must leave the episode`s one wake unspent');
  });
}

// EPISODE SEMANTICS. `wakeAt` is read episode-relative (`wakeAt - last`), exactly
// as `prevAge` reads `nudgedAt`, which is what lets it need no clearing site.
test('t400 a wake that TAKES ends the episode with no alarm at all', async () => {
  const w = mkWake();
  for (const m of [30, 31, 32]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, 1, 'ENTER: the wake fired, or there is nothing for the seat to answer');
  // The seat takes a turn — the real path, through the activity stamp a PTY turn
  // fires, not a poke at the store.
  w.f.m._reconcileTickets(w.f.team);
  w.f.m._touchTicketActivity('team-hand');
  await w.sweep(34);
  assert.deepStrictEqual(w.alarms(), [],
    'the wake WORKED, so the lead is never told: "took" is a signal that changed, not a timeout that elapsed');
});

test('t400 a wake that does NOT take alarms at the confirm window, naming the wake', async () => {
  const w = mkWake();
  for (const m of [30, 31, 32]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, 1, 'ENTER: a wake was injected at 32m');
  const wakeAt = w.f.one('t1').wakeAt;
  assert.strictEqual(wakeAt, w.at(32), 'ENTER: stamped with the instant the sweep JUDGED, not when the queue wrote');
  // Inside the take-window: the seat may still answer.
  await w.sweep(32 + (WAKE_CONFIRM_MS / 60000) - 0.25);
  assert.deepStrictEqual(w.alarms(), [], 'the take-window is still open — alarming here would not have waited for the answer');
  await w.sweep(32 + (WAKE_CONFIRM_MS / 60000) + 0.25);
  assert.strictEqual(w.alarms().length, 1, 'past the window, rung 3 fires');
  assert.match(w.alarms()[0].body, /an automated wake was injected .* ago and produced no turn/,
    'and it names the attempt: the lead must know rung 2 already spent the cheap option');
  assert.doesNotMatch(w.alarms()[0].body, /cannot be recovered|cannot recover|dead|beyond recovery/,
    'the fact ONLY, never a verdict — a wake fired at a seat blocked on I/O produces a turn later, so any '
    + '"a write cannot help this seat" claim would be an inference the measurement does not support');
});

// The clause is episode-scoped too, not just the wake decision. Reading the raw
// `wakeAt` here would tell the lead "a wake was injected 3h ago and produced no
// turn" about an episode that ENDED — the seat did answer, worked, and went quiet
// again. That is the confidently-wrong field this module exists to prevent, and
// it points the lead away from the seat exactly when the seat is the problem.
//
// Added after a surviving mutant: swapping `wakeAge > 0` for `after.wakeAt` left
// the whole file green, because every other test either has no stale stamp or
// never reaches the alarm while carrying one.
test('t400 a PRIOR episode`s wake is not reported as evidence about THIS one', async () => {
  // Codex, so the wake gate refuses and the alarm is reached at the window while
  // a stale stamp sits on the record — the shape where the two readings diverge.
  const w = mkWake({ agentType: 'codex' });
  const arr = w.f.load();
  arr[0].wakeAt = w.at(-60);          // an hour before this episode even began
  w.f.tstore.save(w.f.team.root, arr);
  const rec = w.f.one('t1');
  assert.ok(rec.wakeAt < rec.lastActivityAt,
    'ENTER: the stamp predates this episode`s activity, which is what makes `wakeAge` non-positive');
  for (const m of [30, 31, 32, 33, 34, 35, 36]) await w.sweep(m);
  assert.strictEqual(w.alarms().length, 1, 'ENTER: an alarm was reached WHILE the stale stamp was on the record');
  assert.doesNotMatch(w.alarms()[0].body, /automated wake/,
    'the previous episode`s wake says nothing about this one: the seat answered it, worked, and went quiet again — '
    + 'reporting it would point the lead at a wake that already succeeded');
});

test('t400 a stale wakeAt from a PRIOR episode reads as not-attempted, and the new episode gets its own wake', async () => {
  const w = mkWake();
  for (const m of [30, 31, 32]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, 1, 'ENTER: episode 1 spent its wake');
  const firstWakeAt = w.f.one('t1').wakeAt;
  // The seat speaks — episode 1 ends — and then goes quiet again. `wakeAt` is
  // deliberately NOT cleared by anything: the arithmetic is what invalidates it.
  const a = w.f.load();
  a[0].lastActivityAt = w.at(100);
  w.f.tstore.save(w.f.team.root, a);
  assert.strictEqual(w.f.one('t1').wakeAt, firstWakeAt,
    'ENTER: the stale stamp is STILL on the record — this pins the arithmetic, not a clearing site');
  assert.ok(firstWakeAt < w.at(100),
    'ENTER: and it predates the new episode, which is exactly what makes `wakeAt - last` non-positive');
  for (const m of [130, 131, 132]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, 2, 'the new episode gets its OWN wake — a stale stamp must not deny it one');
  // Deliberately a RANGE, not an instant. `_stallWedgedOnce` is a session field
  // that survives the episode boundary (only a moving/idle-alive verdict clears
  // it), so a continuously-wedged seat enters its second episode with the confirm
  // already satisfied and wakes a sweep earlier than a fresh seat would. Benign —
  // the confirm exists to reject a single BAD SAMPLE, and this seat has produced
  // several consistent ones — but pinning the exact sweep would freeze that
  // incidental coupling into a requirement.
  assert.ok(w.f.one('t1').wakeAt > w.at(100),
    'and the stamp is re-taken inside the episode it belongs to, so `wakeAt - lastActivityAt` reads positive again');
});

// The deferral must be BOUNDED. A probe that can never produce a reading is the
// shape that would otherwise defer forever, and silent alarm deletion is the
// failure class this file has been burned by three times.
test('t400 a verdict stuck at `unknown` alarms at the grace bound, not never', async () => {
  const w = mkWake();
  // The probe is stubbed rather than starved, and the difference matters. Closing
  // the sweeps below MIN_GAP_MS does NOT produce a permanent `unknown`:
  // `_sampleSeatLiveness` keeps the older baseline on an unreadable gap precisely
  // so the gap GROWS until it qualifies — the coupling enforces itself instead of
  // resting on a comment. So that route self-heals and would pin nothing. What
  // this test is about is the sweep's own contract: whatever the reason a reading
  // never arrives, the deferral is bounded.
  let probes = 0;
  w.f.m._sampleSeatLiveness = () => { probes += 1; return Promise.resolve({ verdict: 'unknown', cpuRead: false }); };
  for (let i = 0; i <= 24; i += 1) await w.sweep(30 + i * 0.5);
  assert.ok(probes > 0, 'ENTER: the sweep really did reach the probe — otherwise this pins an earlier gate');
  assert.deepStrictEqual(w.wakes(), [], 'ENTER: no reading was ever obtained, so no wake could fire');
  assert.strictEqual(w.alarms().length, 1,
    'the alarm still arrives: a deferral that can become permanent is the alarm DELETED, which is the failure class '
    + 'this file has been burned by three times');
  // And it arrives AT the bound rather than merely eventually — an unbounded
  // deferral that happens to end is not what the grace window promises.
  assert.match(w.alarms()[0].body, /quiet 35m/,
    'at the grace bound, not a sweep later: `stallMs + WAKE_GRACE_MS` is 35m here');
});

// (b) THE HONEST BOUND. The ticket offered "gate the wake so `stallMs + GRACE`
// holds" or "restate the invariant with the confirm term". The first cannot
// deliver what it claims — a wake fired just inside the grace window still opens
// a full take-window behind it — so BOTH are done: the gate is kept (it closes a
// real hole, below), and the invariant is stated with the confirm term. This test
// pins the number that is actually true.
test('t400 (b) the lead-visibility bound is stallMs + GRACE + CONFIRM, and it is TIGHT', async () => {
  const w = mkWake();
  // A wake fired as late as the grace window permits is the worst case for the
  // bound, so it is the one worth pinning. Sweeps land just under the bound.
  const graceMins = WAKE_GRACE_MS / 60000;
  await w.sweep(30);
  await w.sweep(30 + graceMins - 1.5);
  await w.sweep(30 + graceMins - 0.5);
  assert.strictEqual(w.wakes().length, 1, 'ENTER: a wake fired LATE in the grace window — the worst case for the bound');
  // Measured from the WAKE, which is what the take-window is relative to — not
  // from the bound's worst case. The wake landed at 34.5m, so its window closes
  // at 34.5m + 90s = 36m, and it is that instant the sweep is checked against.
  // An earlier draft compared against `30 + grace + confirm` (36.5m) and read the
  // 36m alarm as a violation; the bound is an upper limit on the first alarm, not
  // a prediction of it.
  const wakeMins = w.f.one('t1').wakeAt === w.at(30 + graceMins - 0.5) ? 30 + graceMins - 0.5 : null;
  assert.ok(wakeMins != null, 'ENTER: the wake was stamped at the sweep that fired it, which anchors the window');
  await w.sweep(wakeMins + (WAKE_CONFIRM_MS / 60000) - 0.25);
  assert.deepStrictEqual(w.alarms(), [],
    'inside the take-window the seat may still answer — so `stallMs + GRACE` alone is NOT the true bound, '
    + 'and stating it would be a promise the code does not keep');
  await w.sweep(wakeMins + (WAKE_CONFIRM_MS / 60000) + 0.25);
  assert.strictEqual(w.alarms().length, 1, 'the alarm arrives once the window closes');
  // The bound itself: the worst case above is still under it, which is the claim
  // the code's comment makes and the only one worth pinning.
  const boundMins = 30 + graceMins + (WAKE_CONFIRM_MS / 60000);
  assert.ok(wakeMins + (WAKE_CONFIRM_MS / 60000) + 0.25 <= boundMins,
    `the first alarm lands no later than stallMs + GRACE + CONFIRM (${boundMins}m) — the honest number, `
    + 'and one a gate on the grace window alone could not deliver');
});

// §5.13. Once rung 3 has spoken the lead OWNS the recovery, and a late automated
// write can collide with what the lead is doing about it — a reassign
// re-delivers the spec, a respawn mints a new seat while the queued wake still
// targets the old name. The wake belongs strictly BEFORE the episode's first
// alarm. Added after a surviving mutant: dropping the `prevAge` term from the
// sweep's condition left every other test in this file green.
test('t400 once the LEAD has been told, the wake is over: no write after rung 3 has spoken', async () => {
  const w = mkWake();
  // The stamp is placed as if the alarm had fired under a TIGHTER `watchdogMs`
  // than the sweep now runs with, and that is the whole construction rather than
  // a convenience. Under a steady window the guard is unreachable: the doubling
  // gate above needs `age >= 2*prevAge` (>= 60m) while the grace gate needs
  // `age < stallMs + GRACE` (< 35m), and the two cannot both hold. A stamp taken
  // at a 5m window makes the doubling gate open at 10m, so the wake block is
  // genuinely reached with `prevAge > 0` — which is the only state in which this
  // guard is the thing doing the refusing.
  //
  // Verified by mutant: with `prevAge <= 0` dropped from the sweep's condition
  // this test fails and every other test in the file stays green.
  const arr = w.f.load();
  arr[0].nudgedAt = w.at(5);
  w.f.tstore.save(w.f.team.root, arr);
  const rec = w.f.one('t1');
  const prevAge = rec.nudgedAt - rec.lastActivityAt;
  assert.ok(prevAge > 0, 'ENTER: `prevAge` is positive — that is what "the lead has been told" means');
  assert.ok(2 * prevAge < WAKE_STALL_MS + WAKE_GRACE_MS,
    'ENTER: and the doubling gate opens BEFORE the grace window closes, so the wake block is actually reached — '
    + 'without this the test would pass on an unreachable branch and pin nothing');
  for (const m of [30, 31, 32, 33, 34]) await w.sweep(m);
  assert.deepStrictEqual(w.wakes(), [],
    'the lead owns recovery from here: a late wake races the lead`s own reassign or respawn, and the queued '
    + 'write would land on a seat the lead may already have replaced');
});

test('t400 (b) the grace GATE holds even when rung 3 never spoke: no wake hours into a stall', async () => {
  // Why the gate is kept despite not delivering the bound on its own. `prevAge`
  // reads `nudgedAt`, which is stamped only by a delivery that REACHED THE WRITE
  // — so a held alarm leaves it null and `prevAge <= 0` holds forever. Ungated,
  // the wake would still fire hours in, long after the §5.13 point where the lead
  // owns recovery.
  const w = mkWake();
  w.f.m._gatedDeliver = () => ({ held: 'blocked on a permission dialog' });
  for (const m of [30, 31, 32]) await w.sweep(m);
  assert.strictEqual(w.f.one('t1').nudgedAt, null,
    'ENTER: the alarm was HELD, so nothing stamped `nudgedAt` — this is the state that defeats the prevAge guard');
  const woken = w.wakes().length;
  for (const m of [200, 201, 202, 400, 401, 402]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, woken,
    'no wake hours into the stall: past the grace window the episode belongs to the lead, whether or not the alarm landed');
});

// (c) TWO STALLED TICKETS, ONE SEAT — designed explicitly, not left emergent.
//
// The ticket suggested the shared `_stallLiveSample` already defers the second
// ticket forever (gap 0 → `unknown` every sweep). It does NOT, and this test is
// what showed it: the second ticket's gap is unreadable only while the FIRST
// keeps probing, and the first stops the moment it wakes — its take-window
// `continue`s before reaching the probe. The second then sees a readable 60s gap
// AND an already-true `_stallWedgedOnce` (a seat field, never cleared by the
// `unknown` branch), so it wakes one sweep later with no confirm of its own.
// Two Ctrl-U writes into one composer, which is the t357 hazard exactly.
//
// The fix is a per-SEAT wake budget (`_stallWakeAt`), because the composer is
// per-seat. Per-ticket `wakeAt` stamps cannot express it: two records know
// nothing of each other.
test('t400 (c) two stalled tickets on ONE seat produce ONE wake, and the second still alarms', async () => {
  const w = mkWake();
  w.f.m._handleTask(w.f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the second spec' });
  w.f.m._handleTask(w.f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  const arr = w.f.load();
  for (const t of arr) t.lastActivityAt = w.quiet;
  w.f.tstore.save(w.f.team.root, arr);
  w.f.gated.length = 0; w.f.injected.length = 0;
  assert.strictEqual(w.f.load().length, 2, 'ENTER: two tickets');
  assert.strictEqual(w.f.m._ticketAssigneeSeat(w.f.team, w.f.one('t2')), 'team-hand',
    'ENTER: and BOTH resolve to the same seat — that is the whole shape');
  // Swept well past the first wake's take-window, which is exactly where the
  // second wake appeared before the per-seat budget existed.
  for (const m of [30, 31, 32, 33, 34, 35, 36, 37]) await w.sweep(m);
  assert.strictEqual(w.wakes().length, 1,
    'ONE wake, not two: the seat has one composer, and the second Ctrl-U would destroy whatever the first produced');
  assert.match(w.wakes()[0], /ticket t1 wake/, 'and it is the FIRST ticket that spent it — whichever the sweep reaches first');
  assert.ok(typeof w.hand._stallWakeAt === 'number',
    'the budget lives on the SEAT, not the record: two ticket records know nothing of each other, so a per-ticket '
    + 'stamp cannot express "this terminal has been written to"');
  const alarmed = w.alarms().map((g) => g.body.match(/\[ticket (t\d+)\]/)[1]);
  assert.ok(alarmed.includes('t2'),
    'ENTER + the safety half: the un-woken ticket still ALARMS at the grace bound. Riding the deferral forever '
    + 'would make one seat`s second ticket permanently invisible to the lead');
});

// Rung 2's blast radius on the ladder must be zero: the doubling gate reads only
// `nudgedAt`, and rung 2 never writes it.
//
// Asserted against a CONTROL run rather than against literal rungs. The wake
// defers the FIRST alarm by its take-window, which shifts `prevAge` and therefore
// every later rung's absolute time — so a literal 30/60/120/240 pin fails for a
// reason that is not the ladder breaking. What must be invariant is the ordinal
// SEQUENCE: none skipped, none repeated, none identical. An earlier draft pinned
// the literals and mistook the shift for a defect.
test('t400 the doubling ladder is UNCHANGED by a seat that gets woken', async () => {
  const ordinals = async (w) => {
    for (let m = 30; m <= 300; m += 1) await w.sweep(m);
    return w.alarms().map((n) => {
      const hit = n.body.match(/STILL stalled \(repeat (\d+)\)/);
      return hit ? Number(hit[1]) : 0;
    });
  };
  const woken = mkWake();
  const got = await ordinals(woken);
  assert.strictEqual(woken.wakes().length, 1,
    'ENTER: a wake really did fire in this episode, or the ladder was never at risk and this test is vacuous');
  // The control differs in ONE way: a codex seat is refused by the gate, so no
  // wake is ever attempted. Everything else — schedule, stall window, evidence —
  // is identical.
  const control = mkWake({ agentType: 'codex' });
  const want = await ordinals(control);
  assert.deepStrictEqual(control.wakes(), [], 'ENTER: the control was never woken — that is the only variable');
  assert.deepStrictEqual(got, want,
    'the rungs and their ordinals are exactly what they are with rung 2 absent: the doubling gate keys off '
    + '`nudgedAt`, which the wake never writes');
  assert.deepStrictEqual(got, [...new Set(got)],
    'ENTER + the t327 defect restated: every ordinal is DISTINCT, so a ladder collapsed to "repeat 1" forever '
    + 'cannot pass by matching an equally-collapsed control');
  assert.ok(got.length >= 3, 'ENTER: several rungs were reached, or an equality over one element proves nothing');
});

// §8: reviewers are NOT woken. A never-started reviewer already has its own
// purpose-built rung 2 (_armReviewStartCheck), and a quiet reviewer may be a
// FINISHED one whose verdict was lost — waking it produces a second, possibly
// contradictory verdict on a loop that may have moved on.
test('t400 a wedged-confirmed REVIEW seat is never written to by the sweep', async () => {
  const w = mkWake();
  const arr = w.f.load();
  arr[0].state = 'done';
  arr[0].loopStep = 'review';
  arr[0].closedAt = w.quiet;
  arr[0].lastActivityAt = w.quiet;
  w.f.tstore.save(w.f.team.root, arr);
  w.f.gated.length = 0; w.f.injected.length = 0;
  assert.strictEqual(w.f.one('t1').loopStep, 'review', 'ENTER: the ticket is loop-held at review, which is the excluded arm');
  for (const m of [30, 31, 32, 33, 34]) await w.sweep(m);
  assert.deepStrictEqual(w.f.injected.filter((x) => /wake\]/.test(x)), [],
    'the loop owns its reviewer: a second waker racing _armReviewStartCheck into one composer is the t357 shape');
});

// THE CLEARING-SITE AUDIT, over all ELEVEN `nudgedAt = null` writers.
//
// `wakeAt` self-invalidates by arithmetic (`wakeAt - lastActivityAt <= 0` reads
// as not-attempted), which needs no clearing site — but ONLY where the writer
// that clears `nudgedAt` also MOVES `lastActivityAt`. A writer that cleared
// `nudgedAt` alone would carry the old episode's `wakeAt` into the new one and
// silently deny the new seat its one wake.
//
// Eleven, not the eight an older inventory listed: dispatch, assign and respec
// were omitted there. All three are correct as written — so the count is stated
// here explicitly, because a reader who greps and finds eleven against a
// documented eight cannot tell a gap from a deliberate exclusion.
//
// Scanned from SOURCE rather than driven through eleven handlers: the property
// is "no site anywhere clears the stamp without moving the clock", and a
// behavioural test can only cover the sites someone remembered to write.
test('t400 all TWELVE `nudgedAt = null` sites also move lastActivityAt, so `wakeAt` needs no clearing site', () => {
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'team-tickets.js'), 'utf-8');
  const lines = src.split('\n');
  const sites = [];
  // Every CLEAR, wherever it sits on the line and whatever the receiver is
  // called. Two narrower patterns were tried and both let a mutant through: one
  // restricted to the three names in use today (`ticket`, `rec`, `t`), and one
  // anchored to the start of the line, which misses a clear nested inside a brace
  // block. A scan that silently stops counting leaves the new site unaudited AND
  // invisible, which is worse than not scanning at all — so the pattern is the
  // loosest thing that still means "an assignment of null to a nudgedAt field",
  // with comment lines excluded because this file discusses the sites in prose.
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    if (/\.nudgedAt\s*=\s*null\s*;/.test(line)) sites.push(i + 1);
  });
  // TWELFTH site added by t345, and audited here as this ratchet requires: it is
  // `_stampVerifyHold`'s escalation arm, which stamps `lastActivityAt` on the line
  // immediately above the clear (a new escalation is a new stall episode, so the
  // ladder must time from the moment the lead was told).
  assert.strictEqual(sites.length, 12,
    `ENTER: exactly TWELVE clearing sites (found ${sites.length} at ${sites.join(', ')}). A different count means a `
    + 'site was added or removed, and the new one has NOT been audited — that is what this test is for');
  // Scoped to the ENCLOSING METHOD, not a fixed line count. A fixed window has to
  // be tuned to the widest real gap (23 lines, at the `_taskDone` loop-eligible
  // site, where a long comment sits between the stamp and the clear) — and a
  // window that wide is then loose enough to certify a genuinely broken site from
  // an unrelated branch above it. The method boundary is the honest scope: it is
  // where "this writer stamps the clock" is actually decidable.
  const methodStart = (ln) => {
    for (let i = ln - 1; i >= 0; i -= 1) {
      if (/^    (?:async )?_?\w+\(/.test(lines[i])) return i;
    }
    return 0;
  };
  const missing = sites.filter((ln) => !lines.slice(methodStart(ln), ln)
    .some((l) => !l.trim().startsWith('//') && /\.lastActivityAt = /.test(l)));
  assert.deepStrictEqual(missing, [],
    'a site that clears `nudgedAt` WITHOUT moving `lastActivityAt` carries the previous episode`s `wakeAt` across '
    + 'the boundary, so the new episode reads as already-woken and the fresh seat never gets its one wake. '
    + 'Fix such a site by adding `delete rec.wakeAt` beside it');
});

// The behavioural half of the audit, on the two paths where a fresh wake budget
// matters most: assign and respec are the RECOVERY paths, so a new seat arriving
// on a ticket that was already woken must get its own wake.
test('t400 a REASSIGNED ticket carrying a stale wakeAt still gets the new seat its own wake', async () => {
  // Aged so the SIMULATED sweep clock stays in the past: the sweeps below stamp
  // `wakeAt` from their own `now`, while `assign` stamps `lastActivityAt` from
  // the real `Date.now()`. With the default age the wake lands in the future
  // relative to the assign, and the comparison below inverts for a reason that is
  // the fixture's clock and not the code's behaviour.
  const w = mkWake({}, {}, 3 * WAKE_STALL_MS);
  for (const m of [30, 31, 32]) await w.sweep(m);
  assert.ok(typeof w.f.one('t1').wakeAt === 'number', 'ENTER: episode 1 was woken, so there IS a stale stamp to carry');
  w.f.m._handleTask(w.f.seat('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  const rec = w.f.one('t1');
  assert.ok(typeof rec.wakeAt === 'number',
    'ENTER: assign does NOT clear `wakeAt` — this pins the arithmetic, not a clearing site');
  assert.strictEqual(rec.nudgedAt, null, 'ENTER: assign cleared `nudgedAt`, which is the site being audited');
  assert.ok(rec.lastActivityAt > rec.wakeAt,
    'and it moved `lastActivityAt` PAST the stale stamp — that is precisely what makes `wakeAt - last` non-positive '
    + 'and the new episode wakeable');
});

test('t327 an off-ladder previous alarm still yields a sane rung, never 0 or a fraction', async () => {
  // The ordinal is derived (log2 of prevAge/stallMs), so it has to be judged off
  // the happy path too: sweeps run every 60s and the app can be shut when a rung
  // falls due, so a repeat's `prevAge` need not be an exact power-of-two multiple
  // of the window. What must hold is that the label is a positive integer that
  // grows with the stall — not 0 (which would print no repeat marker at all on a
  // ticket that has already alarmed) and not a fraction.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - stallMs;
  const arr = f.load();
  arr[0].lastActivityAt = quiet;
  // A previous alarm at 47m — no rung sits there; the app was closed at 30m and a
  // sweep reached the ticket only once it reopened.
  arr[0].nudgedAt = quiet + 47 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  // 94m = double of 47m, so the doubling gate passes on the first sweep here.
  await f.m._sweepTickets(quiet + 94 * 60 * 1000);
  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: the off-ladder repeat fired, so its label is under test');
  const n = nudges[0].body.match(/STILL stalled \(repeat (\d+)\)/);
  assert.ok(n, 'it is marked as a repeat — an already-alarmed ticket must never read as a first alarm');
  assert.strictEqual(n[1], '2', 'log2(47/30) rounds to 1, so this is rung 2 — the integer above, not 1.65');
});

test('t327 a stamp from a tighter watchdogMs clamps to 1 rather than going negative', async () => {
  // `watchdogMs` is per-team and editable, so a repeat can be judged against a
  // window WIDER than the one the previous alarm fired under. prevAge/stallMs is
  // then < 1 and its log negative: unclamped the label reads "repeat 0" or worse
  // "repeat -1" on a ticket that has demonstrably already spoken.
  const f = mkTasks();
  f.team.watchdogMs = 30 * 60 * 1000;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const quiet = Date.now() - 60 * 60 * 1000;
  const arr = f.load();
  arr[0].lastActivityAt = quiet;
  // Alarmed 2m in, under a 1-minute window that has since been widened to 30m.
  arr[0].nudgedAt = quiet + 2 * 60 * 1000;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;

  await f.m._sweepTickets(quiet + 60 * 60 * 1000);
  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: it alarmed, so the clamp is what this asserts');
  assert.match(nudges[0].body, /STILL stalled \(repeat 1\)/,
    'clamped to the lowest repeat, not 0 and not negative');
});

test('t322 a FIRST alarm is never labelled a repeat, even with a stale nudgedAt', async () => {
  // `_stampTicketRevival` writes `lastActivityAt` without clearing `nudgedAt` —
  // the one `lastActivityAt` writer that does not. So a ticket can enter a fresh
  // stall episode carrying a stamp older than its own last activity. The gate
  // treats that as "this episode has not spoken yet" and alarms; reading the raw
  // field for the label then calls that first alarm a repeat.
  //
  // It self-heals after one alarm (the next stamp is current), which is why it
  // needs a pin: the window is one message wide and the message is the lie —
  // telling the lead it already answered something it never saw.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  const quiet = Date.now() - stallMs * 2;
  arr[0].lastActivityAt = quiet;
  arr[0].nudgedAt = quiet - 60_000;   // stamped BEFORE the activity: a previous episode's
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: the stale stamp does not suppress the alarm — it still fires');
  assert.doesNotMatch(nudges[0].body, /STILL stalled|repeat/,
    'and it is the first alarm of this episode, so it must not claim to be a repeat');
});

test('t322 the alarm carries the seat`s last tool, and never dirty on its own', async () => {
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });

  // A transcript ending in a tool_use with NO tool_result: the t312 shape, where
  // a SIGKILL ended the turn holding the call.
  const runDir = pathReal.join(f.home, 'run', 'team-hand');
  fsReal.mkdirSync(runDir, { recursive: true });
  const real = pathReal.join(runDir, 'real.jsonl');
  fsReal.writeFileSync(real, [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', id: 'x1' }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: false }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x2' }] } }),
  ].join('\n') + '\n');
  fsReal.symlinkSync(real, pathReal.join(runDir, 'transcript.jsonl'));

  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  // ENTER: the alarm under test survived the reduction. Every assertion below is
  // about the CONTENT of a nudge, and all of them are vacuously true of none.
  assert.strictEqual(nudges.length, 1, 'ENTER: the stalled ticket produced exactly one alarm');
  assert.match(nudges[0].body, /last tool Bash never returned/,
    'the discriminator the lead lacked on t312 — a call that never came back');
  assert.doesNotMatch(nudges[0].body, /last tool Read/, 'the completed call before it is not the story');
});

test('t389 the alarm names the API error the seat stopped on, read from its real transcript', async () => {
  // END TO END, because the formatter unit tests pass whether or not anything
  // WIRES them: `_stallEvidence` must read the record off the seat's actual
  // transcript symlink and the alarm must carry it. Same fixture shape as the
  // t322 last-tool test one above, so the only new thing is the error record.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });

  const runDir = pathReal.join(f.home, 'run', 'team-hand');
  fsReal.mkdirSync(runDir, { recursive: true });
  const real = pathReal.join(runDir, 'real.jsonl');
  fsReal.writeFileSync(real, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'x1' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: false }] } }),
    // The real shape: an ordinary assistant record carrying the marker, then the
    // bookkeeping entries that follow it in every measured transcript.
    JSON.stringify({
      type: 'assistant', isApiErrorMessage: true,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.' }] },
    }),
    JSON.stringify({ type: 'last-prompt', prompt: 'continue' }),
  ].join('\n') + '\n');
  fsReal.symlinkSync(real, pathReal.join(runDir, 'transcript.jsonl'));

  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: the stalled ticket produced exactly one alarm');
  assert.match(nudges[0].body, /ends on an API error: "API Error: 529 Overloaded/,
    'the cause the seat itself reported, not just the silence the sweep measured');
});

test('t389 a transcript with NO error record leaves the alarm exactly as it was', async () => {
  // The negative half, wired: the same fixture as the t322 last-tool alarm, and
  // the body must carry no cause clause at all. Without this, a helper that
  // returned a truthy value on every transcript would still pass the positive.
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });

  const runDir = pathReal.join(f.home, 'run', 'team-hand');
  fsReal.mkdirSync(runDir, { recursive: true });
  const real = pathReal.join(runDir, 'real.jsonl');
  fsReal.writeFileSync(real, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x2' }] } }),
    // The over-match bait, on the wire: <synthetic> with no marker is a healthy
    // seat, and 95 of 127 measured <synthetic> records are exactly this.
    //
    // NOT `isSidechain` — that would make this vacuous. The sidechain skip runs
    // BEFORE the keying discriminator, so a sidechain bait is suppressed by a
    // rule that has nothing to do with what this test claims to pin, and a
    // <synthetic>-keyed helper would still pass here.
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
  ].join('\n') + '\n');
  fsReal.symlinkSync(real, pathReal.join(runDir, 'transcript.jsonl'));

  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  await f.m._sweepTickets(Date.now());

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: the alarm fired, so the absence below is about its content');
  assert.match(nudges[0].body, /last tool Bash never returned/,
    'ENTER: and the evidence probe really did read this transcript');
  assert.doesNotMatch(nudges[0].body, /API error/, 'nothing stopped on an error, so nothing claims one did');
});

test('t322 an unreadable transcript drops the field rather than guessing', async () => {
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  // No transcript symlink exists at all for this seat.
  await f.m._sweepTickets(Date.now());

  const nudges = f.gated.filter((g) => /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'ENTER: the alarm still fires without evidence — evidence is an enrichment, not a gate');
  assert.doesNotMatch(nudges[0].body, /last tool/, 'and it claims nothing about a tool it could not read');
});

test('t322 a seat that wakes while the git probe runs is not alarmed about', async () => {
  const f = mkTasks();
  const stallMs = 30 * 60 * 1000;
  f.team.watchdogMs = stallMs;
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - stallMs * 2;
  f.tstore.save(f.team.root, arr);
  f.gated.length = 0;
  // The probe is async, so the seat can speak inside it. _touchTicketActivity is
  // what would really do this; the write is equivalent and does not need a wire.
  f.m._stallEvidence = async () => {
    const live = f.load();
    live[0].lastActivityAt = Date.now();
    f.tstore.save(f.team.root, live);
    return { tool: null, commits: null, dirty: null };
  };
  await f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [],
    'a seat that came back mid-probe is working, and an alarm about it is the false positive this ticket is about');
});

// --- [agent:team <verb>] — T29 Layer A Slice 2 metadata mutation ------------
// Lead-gated (D2) role/watchdog edits. The pure mutators (setRole/removeRole/
// renameRole/setTeamWatchdog) are STUBBED here (capturing calls) — their JSON
// behavior + C1/C4/C6 guards are covered in team-manifest.test.js; this exercises
// _handleTeam's orchestration (lead-gate, verb routing, the C5 seat/ticket
// fail-close, mutator-error surfacing). Uses a real temp teamDir so _roleInUse's
// ticketsStore.load round-trips.
function mkTeamMut(extra = {}) {
  // Same home-not-team-dir shape as mkTasks: _roleInUse reads the PROJECT board.
  const home = mkTmpRoot('clodex-teammut-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer' },
      runner: { instantiate: 'session', brief: 'the runner' },
    },
  };
  const calls = [];
  const overrides = {
    fs: fsReal, path: pathReal,
    REGISTRY_DIR: home,
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    // VARIADIC, not (t, r, def): the mutators grew a trailing operator opt-in
    // (t421) that the intent path must never pass, and a fixed arity would drop
    // it silently — the deepStrictEqual pins below would keep passing while an
    // agent quietly gained the operator's reach.
    addRole: (...args) => { calls.push(['addRole', ...args]); return team; },
    setRole: (...args) => { calls.push(['setRole', ...args]); return team; },
    removeRole: (...args) => { calls.push(['removeRole', ...args]); return team; },
    renameRole: (t, f, to) => { calls.push(['renameRole', t, f, to]); return team; },
    setTeamWatchdog: (t, ms) => {
      calls.push(['setTeamWatchdog', t, ms]);
      return { ...team, watchdogMs: Math.max(300000, Math.min(604800000, ms)) };
    },
    ...extra,
  };
  const { m, injected } = mkPark(overrides);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const seat = (name, cwd = '/proj', props = {}) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, activityState: 'idle', ...props });
    return m.sessions.get(name);
  };
  return { m, injected, calls, team, home, tstore, seat };
}

test('team: lead role-add / role-set call the mutators with the parsed def/patch', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-add', name: 'builder', prompt: 'p1', template: 't1', body: 'builds things' });
  assert.deepStrictEqual(f.calls[0], ['addRole', 'team', 'builder',
    { prompt: 'p1', template: 't1', brief: 'builds things' }], 'role-add → addRole with the def');
  f.calls.length = 0;
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-set', name: 'runner', prompt: 'p2', body: 'new brief' });
  assert.deepStrictEqual(f.calls[0], ['setRole', 'team', 'runner', { brief: 'new brief', prompt: 'p2' }], 'role-set → setRole with only the present fields');
  assert.ok(f.injected.some((t) => /role "runner" updated/.test(t)), 'confirm line');
});

test('team: a NON-lead is bounced for every verb (D2 lead-gate)', () => {
  const f = mkTeamMut();
  f.seat('team-hand');
  f.m._handleTeam(f.seat('team-hand'), { type: 'team', sub: 'role-add', name: 'x', body: 'b' });
  assert.deepStrictEqual(f.calls, [], 'no mutator called for a non-lead');
  assert.ok(f.injected.some((t) => /only the team lead \(lead\) can edit team metadata/.test(t)), 'bounced with the lead-only reason');
});

test('team: a teamless sender is bounced', () => {
  const f = mkTeamMut();
  const solo = f.seat('solo', '/elsewhere');
  f.m._handleTeam(solo, { type: 'team', sub: 'watchdog', ms: 600000 });
  assert.deepStrictEqual(f.calls, []);
  assert.ok(f.injected.some((t) => /not on a team/.test(t)));
});

test('team: role-rm of a free role removes it; a role with a LIVE seat fails closed (C5)', () => {
  const f = mkTeamMut();
  f.seat('lead');
  // No runner seat → free to remove.
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rm', name: 'runner' });
  assert.deepStrictEqual(f.calls[0], ['removeRole', 'team', 'runner'], 'free role removed');
  // A live runner seat blocks the removal (C5) — mutator NOT called.
  f.calls.length = 0; f.injected.length = 0;
  f.seat('team-runner-1');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rm', name: 'runner' });
  assert.deepStrictEqual(f.calls, [], 'blocked — removeRole not called');
  assert.ok(f.injected.some((t) => /role "runner" is in use.*seat\(s\): team-runner-1/.test(t)), 'names the blocking seat');
});

test('team: role-rename fails closed on a PERSISTED (archived) seat of the from-role (C5)', () => {
  const persisted = [{ name: 'team-runner-1', archivedAt: 1 }]; // archived seat still encodes the role
  const f = mkTeamMut({ getPersistence: () => ({ list: () => persisted, get: (n) => persisted.find((e) => e.name === n) || null }) });
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rename', name: 'runner', to: 'builder' });
  assert.deepStrictEqual(f.calls, [], 'blocked — renameRole not called');
  assert.ok(f.injected.some((t) => /role "runner" is in use.*team-runner-1/.test(t)), 'archived seat blocks the rename');
});

test('team: role-rename of a free role calls renameRole', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rename', name: 'runner', to: 'builder' });
  assert.deepStrictEqual(f.calls[0], ['renameRole', 'team', 'runner', 'builder']);
  assert.ok(f.injected.some((t) => /renamed to "builder"/.test(t)));
});

// t421 made removal of `reviewer` possible — for the OPERATOR. The intent path
// is the half that must not move, and the pins above are `deepStrictEqual` on the
// whole call so a fourth argument appearing here fails rather than passing
// unnoticed. Asserted on its own so the reason is stated where a future edit to
// _handleTeam will read it.
test('team: the role-rm/role-add intents pass NO operator opt-in to the mutators (t421)', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rm', name: 'runner' });
  assert.deepStrictEqual(f.calls[0], ['removeRole', 'team', 'runner'],
    'removeRole reached with exactly (team, role) — an opt-in here would hand an agent the operator door');
  assert.strictEqual(f.calls[0].length, 3, 'no trailing argument at all, truthy or not');
  f.calls.length = 0;
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-add', name: 'builder', body: 'b' });
  assert.deepStrictEqual(f.calls[0], ['addRole', 'team', 'builder',
    { prompt: null, template: null, brief: 'b' }], 'addRole reached with exactly (team, role, def)');
  assert.strictEqual(f.calls[0].length, 4, 'no trailing opt-in on the mint path either');
});

test('team: role-rm reviewer surfaces the mutator operator-owned error verbatim (C1)', () => {
  const f = mkTeamMut({
    removeRole: () => { throw new Error('the "reviewer" role is operator-owned topology; remove it via the app, not an intent/mutator (/x/team.json)'); },
  });
  f.seat('lead');
  // reviewer has no live/persisted seat here, so C5 passes and the mutator's C1 throws.
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-rm', name: 'reviewer' });
  assert.ok(f.injected.some((t) => /operator-owned topology/.test(t)), 'mutator error surfaced verbatim');
});

test('team: watchdog writes via setTeamWatchdog and reports the clamped value', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'watchdog', ms: 1 });
  assert.deepStrictEqual(f.calls[0], ['setTeamWatchdog', 'team', 1]);
  assert.ok(f.injected.some((t) => /watchdog set to 300000ms/.test(t)), 'reports the clamped value (1 → 5min floor)');
});

test('team: a bad watchdog ms is bounced without calling the mutator', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'watchdog', ms: null });
  assert.deepStrictEqual(f.calls, []);
  assert.ok(f.injected.some((t) => /watchdog needs a millisecond number/.test(t)));
});

test('_roleInUse: matches live + persisted seats and role-addressed open tickets, ignores unrelated', () => {
  const persisted = [{ name: 'team-runner-1', archivedAt: 1 }, { name: 'team-hand', archivedAt: 2 }];
  const f = mkTeamMut({ getPersistence: () => ({ list: () => persisted, get: (n) => persisted.find((e) => e.name === n) || null }) });
  f.seat('team-runner-2');   // live runner seat
  f.seat('team-hand-1');     // live hand seat (unrelated to `runner`)
  // Role-addressed to runner: an OPEN ticket (blocks) + a done one (NON-blocking,
  // kept for history) + a cancelled one (NON-blocking) + a hand ticket (unrelated).
  f.tstore.save(f.team.root, [
    { id: 't1', assignee: 'runner', state: 'open' },
    { id: 't2', assignee: 'runner', state: 'cancelled' },
    { id: 't3', assignee: 'hand', state: 'open' },
    { id: 't4', assignee: 'runner', state: 'done' },
  ]);
  const used = f.m._roleInUse(f.team, 'runner');
  assert.deepStrictEqual(used.seats.sort(), ['team-runner-1', 'team-runner-2'], 'live + persisted runner seats');
  assert.deepStrictEqual(used.tickets, ['t1'], 'ONLY the OPEN role-addressed ticket blocks (done + cancelled + other-role ignored)');
  // An unrelated role with no seats/tickets is free.
  const free = f.m._roleInUse(f.team, 'builder');
  assert.deepStrictEqual(free, { seats: [], tickets: [] }, 'a role with nothing referencing it is free');
});

test('_roleInUse: an unhyphenated numbered seat (team-runner2) BLOCKS the role — the fail-close guard must see it (F008)', () => {
  // The blast radius of the seat-name defect, at the guard that exists to fail
  // closed. `team-runner2` is a seat filling `runner`; while matchSeatRole
  // derived `runner2` from it, the role read as FREE and could be removed or
  // renamed out from under a live seat — the opposite of what this guard is for.
  const persisted = [{ name: 'team-runner3', archivedAt: 1 }];
  const f = mkTeamMut({ getPersistence: () => ({ list: () => persisted, get: (n) => persisted.find((e) => e.name === n) || null }) });
  f.seat('team-runner2');
  const used = f.m._roleInUse(f.team, 'runner');
  assert.deepStrictEqual(used.seats.sort(), ['team-runner2', 'team-runner3'], 'live AND persisted unhyphenated seats block');
});

test('_roleInUse: a persistence read error FAILS CLOSED — blocks with a reason (C5)', () => {
  const f = mkTeamMut({ getPersistence: () => ({ list: () => { throw new Error('store unreadable'); } }) });
  const used = f.m._roleInUse(f.team, 'runner');
  // Can't prove the role is free → a sentinel seat blocks the mutation rather
  // than the old fail-OPEN (which returned an empty set and let it through).
  assert.ok(used.seats.includes('<persisted-seat check unavailable>'), 'unreadable persistence blocks');
  assert.ok(used.seats.length > 0, 'blocked, not waved through');
});

// --- list(): team field (sidebar group-by-project reflects team identity) ---
// list() rows carry a `team` name (the injected resolveTeam by cwd, or null),
// which the renderer groups by. A fake session shape is enough — list() only
// reads name/type/pty.pid/cwd/workspaceId/backend/activity/attention/agentType.

function fakeSession(name, cwd) {
  return { name, type: 'codex', agentType: 'codex', pty: { pid: 1 }, cwd,
    workspaceId: 'w', backend: null, activityState: 'idle', needsAttention: null };
}

test('list: each row carries the team name for a cwd-in-team, null otherwise', () => {
  const m = mk({ resolveTeam: (cwd) => (cwd === '/proj/sub' ? { name: 'shop' } : null) });
  m.sessions.set('a', fakeSession('a', '/proj/sub'));
  m.sessions.set('b', fakeSession('b', '/elsewhere'));
  const byName = Object.fromEntries(m.list().map((r) => [r.name, r]));
  assert.strictEqual(byName.a.team, 'shop', 'a cwd inside a team root gets the team name');
  assert.strictEqual(byName.b.team, null, 'a teamless cwd gets null');
});

test('list: resolveTeam is memoized per cwd within one call (seats sharing a dir share one scan)', () => {
  let calls = 0;
  const m = mk({ resolveTeam: (cwd) => { calls++; return cwd.startsWith('/proj') ? { name: 'shop' } : null; } });
  m.sessions.set('a', fakeSession('a', '/proj/x'));
  m.sessions.set('b', fakeSession('b', '/proj/x')); // same cwd as a
  m.sessions.set('c', fakeSession('c', '/proj/y')); // distinct cwd
  const rows = m.list();
  assert.ok(rows.every((r) => r.team === 'shop'), 'all three resolve to the team');
  assert.strictEqual(calls, 2, 'resolveTeam runs once per DISTINCT cwd, not once per session');
});

test('list: a resolveTeam throw degrades to team:null, never breaks the list', () => {
  const m = mk({ resolveTeam: () => { throw new Error('teams dir unreadable'); } });
  m.sessions.set('a', fakeSession('a', '/proj/x'));
  const rows = m.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].team, null, 'best-effort — a resolve failure is null, not a throw');
});

test('_drainPendingAtIdle: a non-claude target is skipped (pending is a Claude-hook store)', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', 'hi', '1');  // (wouldn't happen, but assert the guard)
  m._drainPendingAtIdle({ name: 'a', agentType: 'codex' });
  assert.deepStrictEqual(injected, []);
  assert.ok(hasPending(PENDING_DIR, 'a'), 'left untouched for a non-claude target');
});

test('spawn template: a file missing "type" errors, no spawn', async () => {
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'notype.json');
  fsReal.writeFileSync(file, JSON.stringify({ cwd: '/x', disabledTools: ['Edit'] }));
  const { m, created, replies, spawner } = mkSpawn([]);
  m._handleSpawnIntent(spawner, { name: 't2', cwd: '/tmp/x', template: file });
  assert.match(replies.at(-1), /not a template object \(needs a "type"\)/);
  await tick();
  assert.strictEqual(created.length, 0);
});

// ---------------------------------------------------------------------------
// _handleExecIntent — [agent:exec <cmd>] {json}: registered-only command run.
// Real temp registry (~/.clodex/library/exec/<cmd>.json) + real child_process
// (short /bin/sh scripts) + captured _injectText/_broadcast (no PTY). Exercises
// all three failure classes (unknown/ungranted, schema, nonzero/timeout), the
// silent-success asymmetry, stdin payload delivery, and the argv-injection
// invariant (payload never contributes to argv).
const cpReal = require('child_process');
const {
  isFilenameToken: isFilenameTokenReal,
  parseAndValidate: parseAndValidateReal,
  clampReplyBody: clampReplyBodyReal,
} = require('../exec-schema');

function mkExec({ grants = [], entry = null, cmd = 'bridge-reply' } = {}) {
  const REGISTRY_DIR = mkTmpRoot('clodex-exec-');
  const execDir = pathReal.join(REGISTRY_DIR, 'library', 'exec');
  fsReal.mkdirSync(execDir, { recursive: true });
  if (entry) fsReal.writeFileSync(pathReal.join(execDir, `${cmd}.json`), JSON.stringify(entry));
  const persistence = { list: () => [], get: (n) => (n === 't2' ? { execCommands: grants } : null) };
  const m = mk({
    REGISTRY_DIR, fs: fsReal, path: pathReal, os: osReal,
    childProcess: cpReal, isFilenameToken: isFilenameTokenReal, parseAndValidate: parseAndValidateReal,
    clampReplyBody: clampReplyBodyReal,
    getPersistence: () => persistence,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const replies = [], ipc = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = (_c, msg) => ipc.push(msg);
  const session = { name: 't2', agentType: 'claude', cwd: REGISTRY_DIR };
  return { m, session, replies, ipc, REGISTRY_DIR, execDir };
}
const waitFor = async (pred, ms = 2000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error('waitFor timed out');
};

test('_handleExecIntent: ungranted cmd is refused, nothing runs', () => {
  const { m, session, replies, ipc } = mkExec({ grants: [], entry: { argv: ['/bin/true'], schema: { type: 'object' } } });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  assert.match(replies.at(-1), /not granted/);
  assert.strictEqual(ipc.at(-1).body.startsWith('err'), true);
});

test('_handleExecIntent: unknown cmd id (not in registry) bounces', () => {
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'] }); // no entry file written
  m._handleExecIntent(session, 'bridge-reply', '{}');
  assert.match(replies.at(-1), /no such registered command/);
});

test('_handleExecIntent: malformed cmd id rejected (filename-token guard)', () => {
  const { m, session, replies } = mkExec({ grants: ['../etc/passwd'] });
  m._handleExecIntent(session, '../etc/passwd', '{}');
  assert.match(replies.at(-1), /invalid command id/);
});

test('_handleExecIntent: schema-invalid payload bounces with the field error, no run', () => {
  const entry = { argv: ['/bin/true'], schema: { type: 'object', required: ['id'], properties: { id: { type: 'filename' } } } };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{"id":"../escape"}');
  assert.match(replies.at(-1), /filename token/);
});

test('_handleExecIntent: traversal id in payload rejected by the filename type', () => {
  const entry = { argv: ['/bin/true'], schema: { type: 'object', required: ['id'], properties: { id: { type: 'filename' } } } };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{"id":"../../../tmp/pwned"}');
  assert.match(replies.at(-1), /filename token/);
});

test('_handleExecIntent: valid payload → command runs, silent success + stdin delivery', async () => {
  const { m, session, replies, ipc, execDir } = mkExec({ grants: ['bridge-reply'] });
  const outPath = pathReal.join(execDir, 'stdin.out');
  // argv comes WHOLLY from the registry; the command just copies stdin to a file.
  const entry = {
    argv: ['/bin/sh', '-c', `cat > "${outPath}"`],
    schema: { type: 'object', required: ['id'], properties: { id: { type: 'filename' }, note: { type: 'string' } } },
  };
  fsReal.writeFileSync(pathReal.join(execDir, 'bridge-reply.json'), JSON.stringify(entry));
  m._handleExecIntent(session, 'bridge-reply', '{"id":"r1.json","note":"hi"}');
  await waitFor(() => ipc.some((x) => x.body === 'ok'));
  assert.deepStrictEqual(replies, [], 'clean exit is silent — no re-bill');
  assert.strictEqual(ipc.at(-1).body, 'ok');
  assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(outPath, 'utf8')), { id: 'r1.json', note: 'hi' });
});

test('_handleExecIntent: payload NEVER contributes to argv (injection is structural)', async () => {
  const { m, session, ipc, execDir } = mkExec({ grants: ['bridge-reply'] });
  const canary = pathReal.join(execDir, 'PWNED');
  const outPath = pathReal.join(execDir, 'stdin.out');
  // A hostile string field: if it reached argv/shell it would touch the canary.
  const entry = {
    argv: ['/bin/sh', '-c', `cat > "${outPath}"`],
    schema: { type: 'object', properties: { note: { type: 'string', maxLength: 200 } } },
  };
  fsReal.writeFileSync(pathReal.join(execDir, 'bridge-reply.json'), JSON.stringify(entry));
  m._handleExecIntent(session, 'bridge-reply', `{"note":"; touch ${canary}; echo "}`);
  await waitFor(() => ipc.some((x) => x.body === 'ok'));
  assert.strictEqual(fsReal.existsSync(canary), false, 'no shell splice — canary untouched');
  // The metacharacter string arrived intact via stdin, as DATA.
  assert.strictEqual(JSON.parse(fsReal.readFileSync(outPath, 'utf8')).note, `; touch ${canary}; echo `);
});

test('_handleExecIntent: replyStderr:true → clean exit + stderr injects the tail back', async () => {
  const entry = {
    argv: ['/bin/sh', '-c', 'cat >/dev/null; echo "ignored line" 1>&2; echo "811/811 green" 1>&2'],
    replyStderr: true, schema: { type: 'object' },
  };
  const { m, session, replies, ipc } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  // Failure-path tail discipline: LAST stderr line, prefixed with the cmd.
  assert.strictEqual(replies.at(-1), '[agent:exec] bridge-reply: 811/811 green');
  // The broadcast reflects that a reply was sent (not the bare silent 'ok').
  assert.strictEqual(ipc.at(-1).body, 'ok: 811/811 green');
});

// A multi-line listing (ticket board, one error per file) cannot survive the
// default last-line reply: what arrives is the footer, and a footer reads like
// a complete answer. These pin the widened channel and, just as importantly,
// that opting in is the ONLY way to get it.
test('_handleExecIntent: replyMaxBytes widens the reply to the whole listing', async () => {
  const board = ['team x tickets:', 't1 [open] a', 't2 [open] b', '(2 open)'];
  const entry = {
    argv: ['/bin/sh', '-c', `cat >/dev/null; printf '%s\\n' ${board.map((l) => `'${l}'`).join(' ')} 1>&2`],
    replyStderr: true, replyMaxBytes: 4000, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  // ENTER: without the fix this is the footer alone, which still matches a
  // loose /2 open/ — so assert the WHOLE body, head row included.
  assert.strictEqual(replies.at(-1), `[agent:exec] bridge-reply: ${board.join('\n')}`);
});

test('_handleExecIntent: a def WITHOUT replyMaxBytes still gets the last line only', async () => {
  const entry = {
    argv: ['/bin/sh', '-c', "cat >/dev/null; printf 'head\\nmiddle\\n811/811 green\\n' 1>&2"],
    replyStderr: true, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  assert.strictEqual(replies.at(-1), '[agent:exec] bridge-reply: 811/811 green',
    'widening must be opt-in per def — every existing command keeps its one-line digest');
});

test('_handleExecIntent: replyMaxBytes overflow is clamped at a line break and SAYS so', async () => {
  // 40 rows of 20 bytes against a 200-byte cap: the cut lands mid-listing.
  const rows = Array.from({ length: 40 }, (_, i) => `t${String(i).padStart(3, '0')} [open] row${i}`);
  const entry = {
    argv: ['/bin/sh', '-c', `cat >/dev/null; printf '%s\\n' ${rows.map((l) => `'${l}'`).join(' ')} 1>&2`],
    replyStderr: true, replyMaxBytes: 200, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  const body = replies.at(-1).replace('[agent:exec] bridge-reply: ', '');
  const lines = body.split('\n');
  assert.strictEqual(lines[0], rows[0], 'ENTER: kept from the TOP — the first row is the answer');
  // Note second-to-last, final line retained: head rows, the loss, the footer.
  assert.match(lines.at(-2), /^\(\+\d+ more lines dropped at the 200-byte reply cap\)$/,
    'a silent cut would read as a complete board');
  assert.strictEqual(lines.at(-1), rows.at(-1), 'the last rendered line survives the clamp');
  // Every retained row is whole: a mid-line cut yields a truncated row that is
  // indistinguishable from a real one.
  for (const l of [...lines.slice(0, -2), lines.at(-1)]) {
    assert.ok(rows.includes(l), `whole row: ${JSON.stringify(l)}`);
  }
});

test('_handleExecIntent: the stderr COLLECTOR cap clears the widened reply budget', async () => {
  // The collector keeps the head of stderr and drops the rest. A def asking for
  // more than the collector holds would be cut at collection, before clamping,
  // and get a short answer with no dropped-lines note — silently truncated.
  // Sized to land BETWEEN the budget and the collector cap (5000 < ~5460 <
  // 6024): the clamp must do the trimming, the collector must not have gotten
  // there first. If the cap did not clear the budget, the reply would come back
  // far short of what was asked for.
  const rows = Array.from({ length: 260 }, (_, i) => `row-${String(i).padStart(4, '0')}-xxxxxxxxxx`);
  const entry = {
    argv: ['/bin/sh', '-c', `cat >/dev/null; printf '%s\\n' "$@" 1>&2`, 'sh', ...rows],
    replyStderr: true, replyMaxBytes: 5000, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  const body = replies.at(-1).replace('[agent:exec] bridge-reply: ', '');
  assert.ok(body.length > 4000, `reply got ${body.length}B of the 5000B asked for — collector cut it short`);
  // The BUDGET note, not the truncation one: reaching the "or more" wording here
  // would mean the collector clipped the input and the cap failed its job.
  assert.match(body.split('\n').at(-2), /^\(\+\d+ more lines dropped at the 5000-byte reply cap\)$/);
});

test('_handleExecIntent: a count computed over TRUNCATED stderr says "or more"', async () => {
  // The clamp counts what survived COLLECTION, not what the command printed. On
  // output that outruns the collector, a bare count is not merely imprecise — it
  // is a completeness claim that is wrong by an unbounded factor, which is the
  // exact failure this whole feature exists to fix, one layer down. Measured on
  // the real path before the fix: 2000 rows reported as 347 dropped when 1800
  // were.
  const rows = Array.from({ length: 2000 }, (_, i) => `row-${String(i).padStart(4, '0')}-${'x'.repeat(20)}`);
  const entry = {
    argv: ['/bin/sh', '-c', `cat >/dev/null; printf '%s\\n' "$@" 1>&2`, 'sh', ...rows],
    replyStderr: true, replyMaxBytes: 6000, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  const lines = replies.at(-1).replace('[agent:exec] bridge-reply: ', '').split('\n');
  const note = lines.at(-1);
  assert.match(note, /or more lines dropped — output also outran the collector/,
    `a bare count here would be a false accounting; got ${JSON.stringify(note)}`);
  // ENTER: the collector really was outrun — otherwise this asserts the wording
  // of a branch the test never entered.
  const kept = lines.length - 1;
  assert.ok(kept > 0 && kept < rows.length / 2,
    `ENTER: kept ${kept} of ${rows.length} — the run must have overflowed both cap and collector`);
  // No retained footer on a truncated body: the last line held is the tail of a
  // fragment, and presenting it as the command's footer would invent one.
  assert.strictEqual(note, lines.at(-1));
});

test('_handleExecIntent: a clamp that fits keeps the listing FOOTER, not just the head', async () => {
  // A listing's accounting is its last line — counts, a stale-host notice. A
  // pure head-clamp always drops exactly that half.
  const rows = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(3, '0')} [open] row`);
  const footer = '(200 done, 33 cancelled — ask for another filter)';
  const all = [...rows, footer];
  const entry = {
    argv: ['/bin/sh', '-c', `cat >/dev/null; printf '%s\\n' "$@" 1>&2`, 'sh', ...all],
    replyStderr: true, replyMaxBytes: 400, schema: { type: 'object' },
  };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  const lines = replies.at(-1).replace('[agent:exec] bridge-reply: ', '').split('\n');
  assert.strictEqual(lines[0], rows[0], 'the answer still leads');
  assert.strictEqual(lines.at(-1), footer, 'the footer survives the clamp');
  assert.match(lines.at(-2), /^\(\+\d+ more lines dropped at the 400-byte reply cap\)$/);
  // ENTER: rows really were dropped between the head and the footer.
  assert.ok(lines.length < all.length, `ENTER: clamped ${lines.length} of ${all.length + 1}`);
  const dropped = Number(lines.at(-2).match(/\+(\d+)/)[1]);
  assert.strictEqual(dropped, rows.length - (lines.length - 2),
    'the count must equal the rows actually withheld');
});

test('_handleExecIntent: replyStderr:true + EMPTY stderr → still silent success', async () => {
  const entry = { argv: ['/bin/sh', '-c', 'cat >/dev/null'], replyStderr: true, schema: { type: 'object' } };
  const { m, session, replies, ipc } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => ipc.some((x) => x.body === 'ok'));
  assert.deepStrictEqual(replies, [], 'nothing to say — no re-bill');
});

test('_handleExecIntent: UNGATED entry with stderr stays byte-identically silent on success', async () => {
  // The bridge-reply commands rely on silent success; only replyStderr: true
  // (strict boolean) flips a command chatty — absence or a truthy non-boolean
  // must not.
  for (const extra of [{}, { replyStderr: 'true' }, { replyStderr: 1 }]) {
    const entry = {
      argv: ['/bin/sh', '-c', 'cat >/dev/null; echo noise 1>&2'],
      schema: { type: 'object' }, ...extra,
    };
    const { m, session, replies, ipc } = mkExec({ grants: ['bridge-reply'], entry });
    m._handleExecIntent(session, 'bridge-reply', '{}');
    await waitFor(() => ipc.some((x) => x.body === 'ok'));
    assert.deepStrictEqual(replies, [], `silent success (extra=${JSON.stringify(extra)})`);
    assert.strictEqual(ipc.at(-1).body, 'ok');
  }
});

test('_handleExecIntent: replyStderr:true leaves the FAILURE path unchanged', async () => {
  const entry = {
    argv: ['/bin/sh', '-c', 'cat >/dev/null; echo boom 1>&2; exit 3'],
    replyStderr: true, schema: { type: 'object' },
  };
  const { m, session, replies, ipc } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  assert.match(replies.at(-1), /exit 3/);
  assert.match(replies.at(-1), /boom/);
  assert.strictEqual(ipc.at(-1).body.startsWith('err'), true);
});

test('_handleExecIntent: nonzero exit bounces loudly with the stderr tail', async () => {
  const entry = { argv: ['/bin/sh', '-c', 'cat >/dev/null; echo boom 1>&2; exit 3'], schema: { type: 'object' } };
  const { m, session, replies, ipc } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  assert.match(replies.at(-1), /exit 3/);
  assert.match(replies.at(-1), /boom/);
  assert.strictEqual(ipc.at(-1).body.startsWith('err'), true);
});

test('_handleExecIntent: a slow command is timeout-killed and bounces', async () => {
  const entry = { argv: ['/bin/sh', '-c', 'cat >/dev/null; sleep 5'], timeoutMs: 150, schema: { type: 'object' } };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0, 3000);
  assert.match(replies.at(-1), /TIMED OUT/);
});

test('_handleExecIntent: a TIMEOUT is told apart from a failure, in seconds and by name', async () => {
  // t440. Both used to arrive as a bare `fail(...)`, and the correct response
  // differs: a command that exited nonzero has ANSWERED, so read the answer; a
  // command SIGKILLed at its ceiling has not, so the work may have completed and
  // lost only its report, or may still be running. `clodex-run-tests` is exactly
  // that shape — its digest exists only on the wrapper's stderr, and the suite
  // keeps holding the box-wide lock after the wrapper dies. A caller that read
  // the kill as "the suite failed" would be wrong twice over, and a caller that
  // re-fired the command would queue a second run behind the first.
  const entry = { argv: ['/bin/sh', '-c', 'cat >/dev/null; sleep 5'], timeoutMs: 150, schema: { type: 'object' } };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0, 3000);
  const body = replies.at(-1);

  assert.match(body, /TIMED OUT/, 'ENTER: this is the timeout arm, not some other bounce');
  assert.match(body, /no result was returned/,
    'the absence of an answer is the fact, and it is stated rather than left to be inferred from a duration');
  assert.match(body, /not a failure report/,
    'and it says so in the words that keep a caller from reading the kill as a red result');
  assert.match(body, /may still be running/,
    'the load-bearing half: without it the natural next move is a re-fire, which for a '
    + 'lock-taking command queues a second run behind the first');
  // Seconds AND ms. The ceiling is chosen against wall-clock budgets, and
  // "420000ms" is not a duration a reader parses at a glance.
  // 150ms is below the seconds threshold, so the ceiling is given in ms ALONE.
  // The refutation is the point: rounding a sub-second ceiling would print `0s`,
  // and a subject that asserted that zero would pass on the degenerate render.
  assert.doesNotMatch(body, /\b0s\b/, 'a sub-second ceiling is never rendered as a rounded-down zero');
  assert.match(body, /150ms/, 'the exact configured ceiling is there to match against the def');
});

test('_handleExecIntent: a nonzero exit is NOT dressed up as a timeout', async () => {
  // The other side of the distinction, and the one that decays silently: a
  // wording change that made every bounce say TIMED OUT would satisfy the
  // subject above on its own, and would tell a caller to wait for a command that
  // has already answered.
  //
  // This one PASSES against the pre-t440 code, necessarily: it asserts an
  // absence that was true when NEITHER arm said TIMED OUT. It is not falsifiable
  // against the old shape and is not meant to be — what it guards is the new
  // wording leaking onto the arm it does not belong on.
  const entry = { argv: ['/bin/sh', '-c', 'cat >/dev/null; echo boom 1>&2; exit 3'], timeoutMs: 5000, schema: { type: 'object' } };
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  await waitFor(() => replies.length > 0);
  const body = replies.at(-1);

  assert.match(body, /exit 3/, 'ENTER: the command really did answer with a nonzero exit');
  assert.ok(!/TIMED OUT/.test(body), 'an answered command must not be reported as one that never answered');
  assert.ok(!/may still be running/.test(body), 'and nothing is still running to wait for');
});

test('_handleExecIntent: malformed registry entry (no argv) bounces', () => {
  const { m, session, replies } = mkExec({ grants: ['bridge-reply'], entry: { schema: { type: 'object' } } });
  m._handleExecIntent(session, 'bridge-reply', '{}');
  assert.match(replies.at(-1), /malformed registry entry/);
});

test('_handleExecIntent: execCommands grant flows from template into create() on spawn', async () => {
  // Formerly asserted a POST-CREATE seed; execCommands is now a create() PARAM,
  // so the grant is THREADED into create()'s args (EXEC_ARG) rather than upserted
  // after — which is what makes it survive kill()+recreate. (create()'s own upsert
  // persisting it is pinned separately in the restart-survival block below.)
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'degen-seat.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', execCommands: ['bridge-reply', 'other'] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'degen', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  assert.deepStrictEqual(created[0][EXEC_ARG], ['bridge-reply', 'other']);
});

// --- intent-gate allowlist threaded through create() on template spawn --------
// U5a promoted `intents` from a post-create seed to a create() PARAM (it bakes
// into the injected IPC prompt, so it must be spawn-time config that survives
// restart). So the template path now threads `tpl.intents` into create() rather
// than upserting after — these tests capture create()'s args and assert the
// intents param (index 16, the 17th positional). Two distinguishing semantics:
// an EMPTY array is a real "everything gated" value that MUST apply (no `.length`
// guard), and an ABSENT key passes `null` so create() omits it (stays all-enabled).
// create(...,systemPromptFile[14], appendPromptFiles[15], execCommands[16], intents[17])
const EXEC_ARG = 16;
const INTENTS_ARG = 17;
function mkSpawnCreateProbe() {
  const created = [];
  const persistence = {
    list: () => [],
    get: () => null,
    setStripLevel: () => {},
    setAutoCompact: () => {},
    upsert: () => {},
  };
  const m = mk({
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    AGENT_NAME_RE: AGENT_NAME_RE_T, DEFAULT_WORKSPACE_ID: 'default',
    ensureDir: () => {}, fs: fsReal, path: pathReal, os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  m._injectText = () => {}; m._sendToSession = () => {}; m._broadcast = () => {};
  m.create = async (...args) => { created.push(args); };
  return { m, created };
}

test('spawn template: a restricted `intents` allowlist is threaded into create()', async () => {
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'trader-seat.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', intents: ['dm', 'exec', 'remind'] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'trader', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  assert.deepStrictEqual(created[0][INTENTS_ARG], ['dm', 'exec', 'remind']);
});

test('spawn template: an EMPTY `intents` array (fully gated) is threaded — no .length guard', async () => {
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'locked.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', intents: [] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'locked', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  // The empty allowlist is a real value ("everything gated"), distinct from absent.
  assert.ok(Array.isArray(created[0][INTENTS_ARG]));
  assert.strictEqual(created[0][INTENTS_ARG].length, 0);
});

test('spawn template: a template WITHOUT `intents` threads null (absent = all enabled)', async () => {
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'open.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', execCommands: ['x'] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'open', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  // An all-enabled seat carries no `intents` — create() gets null so the field
  // stays absent (future intents light up by default, never frozen to []).
  assert.strictEqual(created[0][INTENTS_ARG], null);
});

// --- exec-command grant threaded through create() on template spawn -----------
// Twin of the intents promotion: `execCommands` was a post-create seed (dropped
// on restart) and is now a create() PARAM threaded from the template. Unlike
// intents, an empty grant is NOT distinct from absent — both mean "nothing
// granted" — so the template threads `[]` for a grant-less template and the
// non-empty allowlist otherwise.
test('spawn template: a captured `execCommands` grant is threaded into create()', async () => {
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'trader-seat.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', execCommands: ['trade-buy', 'trade-sell'] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'trader', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  assert.deepStrictEqual(created[0][EXEC_ARG], ['trade-buy', 'trade-sell']);
});

test('spawn template: a template WITHOUT execCommands threads [] (no grant)', async () => {
  const { m, created } = mkSpawnCreateProbe();
  const dir = tmpTplDir();
  const file = pathReal.join(dir, 'open.json');
  fsReal.writeFileSync(file, JSON.stringify({ type: 'claude', cwd: '/proj/desk', intents: ['dm'] }));
  m._handleSpawnIntent({ name: 'clodex', type: 'claude', workspaceId: 'default' },
    { name: 'open', cwd: '/proj/desk', template: file });
  await waitFor(() => created.length, 1000);
  assert.deepStrictEqual(created[0][EXEC_ARG], []);
});

// --- restart-survival: create()'s OWN upsert persists the intents param -------
// The regression that bit stripLevel: kill() drops the record, then a recreate
// rebuilds it from spawn args ONLY. Because `intents` is now a create() param
// persisted by create()'s own upsert, threading `entry.intents` back in on the
// recreate re-establishes it. This pins that write directly by driving a real
// create() on a bash session (agentType null → no PTY hooks/wire; a fake pty is
// enough), since the upsert is type-agnostic. Absent→omitted, array/[]→written.
function mkBashCreateProbe() {
  const persisted = {};
  const fakePty = { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) };
  const m = mk({
    getPersistence: () => ({
      list: () => [],
      get: () => null,
      upsert: (e) => { persisted[e.name] = { ...(persisted[e.name] || {}), ...e }; },
      setSessionId: () => {},
    }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: fakePty,
    os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  m._sendToSession = () => {};
  return { m, persisted };
}
// create(name,type,cwd,extraArgs,resumeId,workspaceId,systemPromptBody,fork,proxy,
//        agents,denyBuiltins,disabledTools,disabledSkills,injectSkills,
//        systemPromptFile,appendPromptFiles,execCommands,intents)
const bashCreate = (m, name, intents, execCommands = []) => m.create(
  name, 'bash', osReal.tmpdir(), [], null, 'ws', null, false, null,
  [], [], [], [], [], null, [], execCommands, intents,
);

test('create: a restricted intents param is persisted by create()\'s own upsert (survives restart)', async () => {
  const { m, persisted } = mkBashCreateProbe();
  await bashCreate(m, 'b-restricted', ['dm', 'exec']);
  assert.deepStrictEqual(persisted['b-restricted'].intents, ['dm', 'exec']);
});

test('create: an EMPTY intents param persists as [] (everything gated, a real value)', async () => {
  const { m, persisted } = mkBashCreateProbe();
  await bashCreate(m, 'b-locked', []);
  assert.ok(Array.isArray(persisted['b-locked'].intents));
  assert.strictEqual(persisted['b-locked'].intents.length, 0);
});

test('create: a null intents param writes NO key (absent = all-enabled default stays absent)', async () => {
  const { m, persisted } = mkBashCreateProbe();
  await bashCreate(m, 'b-open', null);
  assert.ok(persisted['b-open'], 'the record was written');
  assert.strictEqual('intents' in persisted['b-open'], false);
});

// --- restart-survival: create()'s OWN upsert persists the execCommands grant ---
// Same regression the intents param fixed: kill() drops the record and the
// recreate rebuilds it from spawn args only, so a grant that was a post-create
// seed vanished on every restart. As a create() param persisted by create()'s
// own upsert, threading `entry.execCommands` back in re-establishes it. The
// exec-specific twist vs intents: an EMPTY grant writes NO key (absent ≡ [] ≡
// "nothing granted"), so the upsert uses a `.length` guard — no bloat.
test('create: a non-empty execCommands grant is persisted by create()\'s own upsert (survives restart)', async () => {
  const { m, persisted } = mkBashCreateProbe();
  await bashCreate(m, 'b-granted', null, ['trade-buy', 'trade-sell']);
  assert.deepStrictEqual(persisted['b-granted'].execCommands, ['trade-buy', 'trade-sell']);
});

test('create: an EMPTY execCommands grant writes NO key (absent ≡ [] ≡ no grant)', async () => {
  const { m, persisted } = mkBashCreateProbe();
  await bashCreate(m, 'b-nogrant', null, []);
  assert.ok(persisted['b-nogrant'], 'the record was written');
  assert.strictEqual('execCommands' in persisted['b-nogrant'], false);
});

// --- T46: scoped env merged into the PTY env at create() ---------------------
// Drives a REAL create() on a bash session (agentType null → no hooks/wire; the
// upsert + env build are type-agnostic) with a fake pty capturing the env passed
// to spawn, plus a real env-scope store fake + a tmp userData (no override file).
// This exercises the actual mergeSessionEnv wire-in, not the try/catch degrade
// path the other bash probes fall into (they don't inject getEnvScopes/path).
function mkEnvProbe({ global = {}, workspaces = {} } = {}) {
  const persisted = {};
  let capturedEnv = null;
  const fakePty = {
    spawn: (_cmd, _args, opts) => { capturedEnv = opts.env; return { onData() {}, onExit() {}, pid: 999 }; },
  };
  const userData = mkTmpRoot('clodex-envud-'); // no env-override.env inside
  // A root that is NOT ~/.clodex, so the CLODEX_HOME pin below asserts something:
  // against the real default it would agree with an unpinned env by accident.
  const registryDir = mkTmpRoot('clodex-envroot-');
  const m = mk({
    REGISTRY_DIR: registryDir,
    getPersistence: () => ({
      list: () => [], get: () => null,
      upsert: (e) => { persisted[e.name] = { ...(persisted[e.name] || {}), ...e }; },
      setSessionId: () => {},
    }),
    getEnvScopes: () => ({ all: () => ({ global, workspaces }) }),
    getUserDataPath: () => userData,
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: fakePty, os, path,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  m._sendToSession = () => {};
  return { m, persisted, registryDir, captured: () => capturedEnv };
}
// Like bashCreate but threads the 19th positional (sessionEnv).
const bashCreateWithEnv = (m, name, sessionEnv) => m.create(
  name, 'bash', osReal.tmpdir(), [], null, 'ws', null, false, null,
  [], [], [], [], [], null, [], [], null, sessionEnv,
);

test('create → PTY env: no scopes reduces to byte-identical { ...process.env, TERM, CLODEX_HOME }', async () => {
  // The load-bearing no-behavior-change pin: with nothing set anywhere and no
  // override file, mergeSessionEnv returns exactly its base, so the spawned env
  // is byte-for-byte process.env plus the app-owned keys on top, and NOTHING
  // else. Whole-object equality on purpose — it is what catches a key arriving
  // as undefined from a seam the harness forgot to wire, and what makes every
  // future addition to either set a deliberate edit here.
  //
  // Since t676 there is no baked base default at all: the shipped defaults are
  // seeded as ordinary GLOBAL-scope entries (stores.js seedEnvDefaults), which
  // is the case below. A default re-appearing in this empty-scope result means
  // one was baked back into the merge base, out of the operator's reach.
  const { m, captured, registryDir } = mkEnvProbe();
  await bashCreate(m, 'env-none', null);
  assert.deepStrictEqual(captured(), {
    ...process.env, TERM: 'xterm-256color', CLODEX_HOME: registryDir, FORCE_HYPERLINK: '1',
  });
});

test('create → PTY env: a SEEDED shipped default reaches the PTY as an ordinary global entry', async () => {
  // The other half of the move: the value the app used to bake now arrives
  // through the global scope, and a workspace/session value still beats it
  // (pinned in full by test/stream-idle-default.test.js).
  const { m, captured, registryDir } = mkEnvProbe({
    global: {
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: { value: '1800000', secret: false },
      CLAUDE_CODE_TURN_UPDATES: { value: 'false', secret: false },
    },
  });
  await bashCreate(m, 'env-seeded', null);
  assert.deepStrictEqual(captured(), {
    ...process.env,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
    CLAUDE_CODE_TURN_UPDATES: 'false',
    TERM: 'xterm-256color', CLODEX_HOME: registryDir, FORCE_HYPERLINK: '1',
  });
});

test('create → PTY env: a session env param layers over the base and reaches spawn', async () => {
  const { m, captured } = mkEnvProbe();
  await bashCreateWithEnv(m, 'env-sess', { AWS_PROFILE: 'acct', AWS_ROLE_SESSION_NAME: 'sess' });
  const env = captured();
  assert.strictEqual(env.AWS_PROFILE, 'acct');   // the driving per-session case
  assert.strictEqual(env.AWS_ROLE_SESSION_NAME, 'sess');
  assert.strictEqual(env.TERM, 'xterm-256color'); // app-owned key still applied last
  assert.strictEqual(env.PATH, process.env.PATH); // base env still present underneath
});

test('create → PTY env: scope precedence (global < workspace < session) reaches the PTY', async () => {
  // session wins over workspace wins over global; a global-only key survives.
  const { m, captured } = mkEnvProbe({
    global: { K: { value: 'g' }, GONLY: { value: 'gv' } },
    workspaces: { ws: { K: { value: 'w' } } },
  });
  await bashCreateWithEnv(m, 'env-prec', { K: 's' });
  const env = captured();
  assert.strictEqual(env.K, 's', 'session overrides workspace and global');
  assert.strictEqual(env.GONLY, 'gv', 'global-only key survives the merge');

  // No session override → workspace wins over global (bashCreate passes ws-id 'ws').
  const { m: m2, captured: cap2 } = mkEnvProbe({
    global: { K: { value: 'g' } }, workspaces: { ws: { K: { value: 'w' } } },
  });
  await bashCreate(m2, 'env-prec2', null);
  assert.strictEqual(cap2().K, 'w', 'workspace wins over global with no session override');
});

test('create → PTY env: a deny-listed scope key never reaches the PTY', async () => {
  // flattenScope drops CLODEX_REMOTE_TOKEN before it can reach the merge, so a
  // scope can't clobber the wire gate through the surface it gates.
  const { m, captured } = mkEnvProbe({ global: { CLODEX_REMOTE_TOKEN: { value: 'leak' }, OK: { value: '1' } } });
  await bashCreate(m, 'env-deny', null);
  const env = captured();
  assert.strictEqual(env.OK, '1', 'a legal sibling key still lands');
  assert.strictEqual(env.CLODEX_REMOTE_TOKEN, process.env.CLODEX_REMOTE_TOKEN,
    'the scope did not inject the deny key (base value, whatever it is, untouched)');
});

// t173: CLODEX_HOME is an app-owned key, applied AFTER the merge like TERM.
// A seat that runs scripts/task-ledger.js from its own shell must land on the
// same tree the exec dispatcher already pins (session-manager.js:3067), so a
// scope-set value is overridden rather than rejected — sanitizeFlat's deny-list
// is for keys that gate their own write surface, which this is not. Every case
// sets the variable to a tree that is NOT registryDir, because with it unset the
// two agree whatever the code does.
test('create → PTY env: the app-owned CLODEX_HOME pin beats a SESSION-scope value', async () => {
  const { m, captured, registryDir } = mkEnvProbe();
  await bashCreateWithEnv(m, 'env-home-sess', { CLODEX_HOME: '/tmp/decoy-session-home', OK: '1' });
  const env = captured();
  assert.strictEqual(env.CLODEX_HOME, registryDir, 'the app root wins over the session scope');
  assert.strictEqual(env.OK, '1', 'a legal sibling key in the same scope still lands');
});

test('create → PTY env: the app-owned CLODEX_HOME pin beats a global/workspace scope value', async () => {
  const { m, captured, registryDir } = mkEnvProbe({
    global: { CLODEX_HOME: { value: '/tmp/decoy-global-home' } },
    workspaces: { ws: { CLODEX_HOME: { value: '/tmp/decoy-ws-home' } } },
  });
  await bashCreate(m, 'env-home-scope', null);
  assert.strictEqual(captured().CLODEX_HOME, registryDir);
});

test('create → PTY env: the CLODEX_HOME pin beats an INHERITED value (the t132 split)', async () => {
  // The defect the pin closes: the app launched from a shell with CLODEX_HOME
  // set handed that value to every seat, so the same script read one tree
  // through the shell and another through exec.
  const prev = process.env.CLODEX_HOME;
  process.env.CLODEX_HOME = '/tmp/decoy-inherited-home';
  try {
    const { m, captured, registryDir } = mkEnvProbe();
    await bashCreate(m, 'env-home-inherit', null);
    assert.strictEqual(captured().CLODEX_HOME, registryDir,
      'the value in the app\'s own environment must not reach the PTY');
  } finally {
    if (prev === undefined) delete process.env.CLODEX_HOME; else process.env.CLODEX_HOME = prev;
  }
});

test('create: a session env param persists as a flat { KEY: value } on the entry (--resume identity)', async () => {
  const { m, persisted } = mkEnvProbe();
  await bashCreateWithEnv(m, 'env-persist', { AWS_PROFILE: 'acct' });
  assert.deepStrictEqual(persisted['env-persist'].env, { AWS_PROFILE: 'acct' });
});

test('create: an absent session env writes NO env key (absent ≡ {} ≡ falls through to global/workspace)', async () => {
  const { m, persisted } = mkEnvProbe();
  await bashCreate(m, 'env-noenv', null);
  assert.ok(persisted['env-noenv'], 'the record was written');
  assert.strictEqual('env' in persisted['env-noenv'], false);
});

// The tee-blind CORRECTNESS TRAP (spec-called-out): create() consults
// teeBlindBackend(readEffectiveClaudeEnv(cwd, { baseEnv: mergedEnv })) to decide
// a claude session's backend. Once scopes exist, a SCOPE-set CLAUDE_CODE_USE_BEDROCK
// is visible ONLY if the MERGED env is the baseEnv — with the old default
// (process.env) the classifier returns null, and the claude arm would flip
// intentSource from 'jsonl' to 'wire' on a session whose Bedrock-routed bytes
// never traverse the wire tee → its intent scanner goes dark. Spinning up a full
// claude create() (preseed + wire + hook setup + prompt merge) just to observe
// `backend` is disproportionate, so this pins the trap at the exact composed seam
// create() runs (mergeSessionEnv → readEffectiveClaudeEnv → teeBlindBackend),
// proving the fix is load-bearing: base {} models process.env WITHOUT the scope,
// so only the merged env can carry bedrock. (Flagged in the report as a
// seam-level pin, not a through-create pin.)
const claudeEnv = require('../claude-env');
const { mergeSessionEnv } = require('../env-scopes');
test('tee-blind trap: a SCOPE-set CLAUDE_CODE_USE_BEDROCK is seen only through the merged baseEnv (scanner stays jsonl)', () => {
  const cwd = mkTmpRoot('clodex-tee-');   // no .claude/settings.json
  const home = mkTmpRoot('clodex-teehome-'); // isolate ~/.claude too
  // The scope (e.g. a global env var) sets bedrock; the base env does not.
  const merged = mergeSessionEnv({ base: {}, global: { CLAUDE_CODE_USE_BEDROCK: { value: '1' } } });
  // FIXED path — create() passes baseEnv: mergedEnv → bedrock is seen → the claude
  // arm keeps intentSource 'jsonl' (the JsonlWatcher reads the transcript regardless
  // of backend).
  assert.strictEqual(
    claudeEnv.teeBlindBackend(claudeEnv.readEffectiveClaudeEnv(cwd, { baseEnv: merged, homeDir: home })),
    'bedrock', 'the merged env carries the scope bedrock into the classifier',
  );
  // BUGGY path — the pre-fix default baseEnv: process.env (modeled by {}) can't see
  // the scope → null → the arm would flip intentSource to 'wire' and the scanner
  // goes dark. This is exactly what passing mergedEnv prevents.
  assert.strictEqual(
    claudeEnv.teeBlindBackend(claudeEnv.readEffectiveClaudeEnv(cwd, { baseEnv: {}, homeDir: home })),
    null, 'without the merged baseEnv the scope bedrock is invisible (the trap)',
  );
});

// --- session-exit meta: `expected` discriminates crash from deliberate teardown ---
// Every deliberate teardown flags the session BEFORE the PTY dies (kill() →
// _userKilled, which restart also routes through; killAll() → _shuttingDown),
// so an unflagged exit means the process died on its own. The renderer's
// crash toast keys off meta.expected — pin the flag at the send site for all
// three paths. Drives a real create() on a bash session with a fake pty whose
// onExit callback the probe captures and fires.
function mkExitProbe() {
  const sent = [];
  let onExitCb = null;
  const fakePty = { spawn: () => ({ onData() {}, onExit(cb) { onExitCb = cb; }, kill() {}, pid: 999 }) };
  const m = mk({
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {}, remove: () => {},
    }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: fakePty,
    os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    setAppQuitting: () => {},
  });
  m._sendToSession = (...a) => sent.push(a);
  const broadcasts = [];
  m._broadcast = (channel, msg) => broadcasts.push([channel, msg]);
  return { m, sent, broadcasts, exit: (payload) => onExitCb(payload) };
}
// _sendToSession(name, channel, ...args) — the event payload starts at [2].
const exitEventOf = (sent) => sent.find((a) => a[1] === 'session-exit');
// The always-on exit IPC-log entry (any session type); body is a grep-stable
// soft contract: `code=N` always, ` signal=X` / ` unexpected` only when applicable.
const exitLogOf = (broadcasts) =>
  (broadcasts.find((b) => b[0] === 'ipc-message' && b[1] && b[1].type === 'exit') || [])[1];

test('session-exit: natural death sends expected:false with code and signal', async () => {
  const { m, sent, broadcasts, exit } = mkExitProbe();
  await bashCreate(m, 'b-crash', null);
  exit({ exitCode: 1, signal: undefined });
  assert.deepStrictEqual(exitEventOf(sent), ['b-crash', 'session-exit', 'b-crash', 1, { expected: false, signal: null, agentType: null, missingTool: null }]);
  // Unexpected exit, no signal → `code=1 unexpected`.
  assert.deepStrictEqual(exitLogOf(broadcasts), { type: 'exit', from: 'b-crash', to: 'exit', body: 'code=1 unexpected' });
});

test('session-exit: a user-killed session (kill() flag) sends expected:true', async () => {
  const { m, sent, broadcasts, exit } = mkExitProbe();
  await bashCreate(m, 'b-killed', null);
  // Set the flag directly rather than calling kill(): kill() arms a real 5s
  // SIGKILL fallback timer against the fake pid — firing process.kill(999)
  // from a test would hit whatever real process owns that pid.
  m.sessions.get('b-killed')._userKilled = true;
  exit({ exitCode: 1, signal: 15 });
  assert.deepStrictEqual(exitEventOf(sent), ['b-killed', 'session-exit', 'b-killed', 1, { expected: true, signal: 15, agentType: null, missingTool: null }]);
  // Expected exit with a signal → `code=1 signal=15` (no ` unexpected`).
  assert.strictEqual(exitLogOf(broadcasts).body, 'code=1 signal=15');
});

test('session-exit: app-quit teardown (killAll) sends expected:true', async () => {
  const { m, sent, broadcasts, exit } = mkExitProbe();
  await bashCreate(m, 'b-quit', null);
  await m.killAll();
  exit({ exitCode: 0, signal: 15 });
  assert.deepStrictEqual(exitEventOf(sent), ['b-quit', 'session-exit', 'b-quit', 0, { expected: true, signal: 15, agentType: null, missingTool: null }]);
  assert.strictEqual(exitLogOf(broadcasts).body, 'code=0 signal=15');
});

// --- exec body-capture JSON terminator (_extractIntents) ---
// exec bodies are JSON DATA: greedy multi-line capture swallowed trailing prose
// a seat wrote on following lines INTO the payload, corrupting the downstream
// JSON.parse (observed live). The terminator JSON.parses the accumulated buffer
// after each body line and stops at the first complete value — no brace lexer.
// Scoped to exec; dm/memory/context keep the greedy capture. These drive the
// real _extractIntents with the real parseIntent + the 64KB region cap injected.
const { parseIntent: parseIntentReal, looksLikeIntent: looksLikeIntentReal } = require('../intent-scanner');
function mkExtract() {
  return mk({ parseIntent: parseIntentReal, looksLikeIntent: looksLikeIntentReal, execBodyCap: 64 * 1024 });
}
const execBodyOf = (m, text) => {
  const found = m._extractIntents(text).filter((x) => x.type === 'exec');
  return found.length ? found[0].body : undefined;
};

test('exec terminator: single-line body captures identically to today (regression guard)', () => {
  const m = mkExtract();
  assert.strictEqual(execBodyOf(m, '[agent:exec bridge-reply] {"id":"r1.json"}'), '{"id":"r1.json"}');
});

test('exec terminator: prose on FOLLOWING lines is dropped, body is exactly the JSON', () => {
  const m = mkExtract();
  const body = execBodyOf(m,
    '[agent:exec bridge-reply] {"id":"r1.json"}\nAlso, I want to flag the risk here.\nmore prose');
  assert.strictEqual(body, '{"id":"r1.json"}');
  assert.doesNotThrow(() => JSON.parse(body)); // the payload downstream would parse cleanly
});

test('exec terminator: trailing prose on the SAME line is unextractable → greedy → bounces', () => {
  // No lexer, so a value + prose sharing one line can't be split; it falls to the
  // greedy capture and stays invalid JSON, bouncing exactly like an incomplete
  // payload. (Trader's "exec line isolated/last" prompt rule is the defence.)
  const m = mkExtract();
  const body = execBodyOf(m, '[agent:exec bridge-reply] {"id":"r1.json"} and my thesis is risk');
  assert.strictEqual(body, '{"id":"r1.json"} and my thesis is risk');
  assert.throws(() => JSON.parse(body));
});

test('exec terminator: braces inside JSON strings do not confuse the terminator', () => {
  const m = mkExtract();
  const body = execBodyOf(m,
    '[agent:exec bridge-reply] {"note":"risk {tail} and }{ braces","id":"x"}\ntrailing prose');
  assert.deepStrictEqual(JSON.parse(body), { note: 'risk {tail} and }{ braces', id: 'x' });
});

test('exec terminator: multi-line pretty-printed JSON is captured across lines', () => {
  const m = mkExtract();
  const body = execBodyOf(m,
    '[agent:exec bridge-reply] {\n  "id": "r1.json",\n  "note": "hi"\n}\ntrailing commentary');
  assert.deepStrictEqual(JSON.parse(body), { id: 'r1.json', note: 'hi' });
});

test('exec terminator: still-incomplete-at-EOR bounces exactly as today (greedy body kept)', () => {
  const m = mkExtract();
  const body = execBodyOf(m, '[agent:exec bridge-reply] {"id":"r1.json"'); // never closes
  assert.strictEqual(body, '{"id":"r1.json"');
  assert.throws(() => JSON.parse(body));
});

test('exec terminator: a col-1 intent after the value ends capture and still fires', () => {
  // Stopping at the JSON leaves the following lines for the outer loop, so a real
  // intent written after the payload is no longer swallowed (better than today).
  const m = mkExtract();
  const types = m._extractIntents(
    '[agent:exec bridge-reply] {"id":"x"}\nsome prose\n[agent:dm clodex] hi there',
  ).map((x) => x.type);
  assert.deepStrictEqual(types, ['exec', 'dm']);
});

test('exec terminator: 64KB region cap — multi-line growth past the cap is not terminated early', () => {
  // The cap bounds the growth loop (runaway re-parse guard): a value split across
  // lines whose accumulation crosses 64KB before closing is left to the greedy
  // capture (prose included), so prose-stripping is bounded to <=64KB payloads.
  const m = mkExtract();
  const parts = ['[agent:exec bridge-reply] {', `"pad":"${'a'.repeat(70 * 1024)}",`, '"id":"r1.json"', '}', 'trailing prose'];
  const body = execBodyOf(m, parts.join('\n'));
  assert.ok(body.includes('trailing prose'), 'over-cap multiline falls to greedy (not terminated)');
  assert.throws(() => JSON.parse(body));
  // A clean value already complete ON the intent line is accepted regardless of
  // size — the cap only guards multi-line growth, and the precise per-command cap
  // stays downstream in parseAndValidate.
  const big = JSON.stringify({ id: 'r1.json', pad: 'a'.repeat(70 * 1024) });
  assert.strictEqual(execBodyOf(m, `[agent:exec bridge-reply] ${big}`), big);
});

test('exec terminator: dm / memory multi-line capture is left untouched (greedy)', () => {
  const m = mkExtract();
  const dm = m._extractIntents('[agent:dm clodex] line one\nline two\nline three')[0];
  assert.strictEqual(dm.body, 'line one\nline two\nline three');
  const mem = m._extractIntents('[agent:memory remember] fact one\nfact two')[0];
  assert.strictEqual(mem.body, 'fact one\nfact two');
});

// --- [agent:end] body terminator ---
// The footgun this closes fired live: a memory-remember followed by
// operator-facing prose saved the prose INTO the unit (bodies run to the next
// intent or end of turn). `end` is the explicit close: it terminates the open
// body via the generic boundary check and is itself discarded — never emitted
// as an intent, so it can't be dispatched, deduped, or gated.

test('[agent:end]: closes a dm body — trailing operator prose is NOT swallowed', () => {
  const m = mkExtract();
  const out = m._extractIntents(
    '[agent:dm clodex] the message\nbody line two\n[agent:end]\nAnd here I talk to my operator.');
  assert.deepStrictEqual(out.map((x) => x.type), ['dm'], 'end itself emits nothing, prose is not an intent');
  assert.strictEqual(out[0].body, 'the message\nbody line two');
});

test('[agent:end]: closes a memory-remember body (the live incident shape)', () => {
  const m = mkExtract();
  const out = m._extractIntents(
    '[agent:memory remember] the durable rule\n[agent:end]\nDone. Report to the operator follows.');
  assert.deepStrictEqual(out.map((x) => x.type), ['memory']);
  assert.strictEqual(out[0].body, 'the durable rule');
});

test('[agent:end]: enables interleaving — prose between two bodied intents', () => {
  const m = mkExtract();
  const out = m._extractIntents([
    '[agent:dm alice] first message',
    '[agent:end]',
    'Console note between intents.',
    '[agent:dm bob] second message',
    '[agent:end]',
    'Closing note.',
  ].join('\n'));
  assert.deepStrictEqual(out.map((x) => x.type), ['dm', 'dm']);
  assert.strictEqual(out[0].body, 'first message');
  assert.strictEqual(out[1].body, 'second message');
});

test('[agent:end]: bare at top level (no open body) is silently spent', () => {
  const m = mkExtract();
  assert.deepStrictEqual(m._extractIntents('[agent:end]'), []);
  // and it is not a near-miss: no `unknown` bounce is synthesized for it
  assert.deepStrictEqual(m._extractIntents('prose\n[agent:end]\nmore prose'), []);
});

// The task grammar line (t355) tells a seat its report body is closed by a bare
// [agent:end], the way dm's is. That claim is only true because `task done` is a
// greedy row and `end` is the generic boundary — nothing in the ticket path
// special-cases it. Pinned here so the documented shape and the scanner cannot
// drift apart: a seat that trusts the line and writes prose after its report
// would otherwise ship that prose to the lead inside the report.
test('[agent:end]: closes a task done report body — the shape the grammar line documents', () => {
  const m = mkExtract();
  const out = m._extractIntents(
    '[agent:task done t42] the report\nsecond line\n[agent:end]\nNow I talk to my operator.');
  assert.deepStrictEqual(out.map((x) => x.type), ['task'], 'end emits nothing; the prose is not an intent');
  assert.strictEqual(out[0].sub, 'done');
  assert.strictEqual(out[0].id, 't42');
  assert.strictEqual(out[0].body, 'the report\nsecond line');
});

// The contrast that makes the terminator worth documenting on the line at all.
test('[agent:end]: without it a task report swallows the trailing prose (greedy)', () => {
  const m = mkExtract();
  const out = m._extractIntents('[agent:task done t42] the report\nNow I talk to my operator.');
  assert.strictEqual(out[0].body, 'the report\nNow I talk to my operator.');
});

// --- term exec is LINE-SCOPED (t233) ---
// The live incident: a seat emitted the correct `[agent:term exec] <cmd>` form
// and kept writing prose underneath. Greedy capture pulled the prose into the
// command, and vetTermCommand refused the result for containing a newline — so
// a correctly-written command became a refusal because of text after it. The
// vetter was right; the row's capture mode was wrong. These drive the real
// _extractIntents and then the real vetter, because the bug only appears when
// the two are composed: either half alone looks correct.
const { vetTermCommand } = require('../drawer-avail');
const termBodyOf = (m, text) => {
  const found = m._extractIntents(text).filter((x) => x.type === 'term');
  assert.strictEqual(found.length, 1, `ENTER: exactly one term intent parsed from ${JSON.stringify(text)}`);
  return found[0].body;
};

test('term exec: prose on following lines is NOT part of the command (the live incident)', () => {
  const m = mkExtract();
  const body = termBodyOf(m, '[agent:term exec] git status\nI am running this to check the tree.');
  assert.strictEqual(body, 'git status');
  // The half that actually bit: the composed path must now VET clean.
  assert.deepStrictEqual(vetTermCommand(body), { ok: true, command: 'git status' });
});

test('term exec: a trailing [agent:end] is harmless — the trained incantation still works', () => {
  const m = mkExtract();
  // Agents have been taught to close bodies. term no longer opens one, so this
  // must be inert rather than an error: `end` is spent at the top of the scan.
  const out = m._extractIntents('[agent:term exec] pwd\n[agent:end]\nOperator prose.');
  assert.deepStrictEqual(out.map((x) => x.type), ['term'], 'no bounce, no second intent');
  assert.strictEqual(out[0].body, 'pwd');
  assert.deepStrictEqual(vetTermCommand(out[0].body), { ok: true, command: 'pwd' });
});

test('term exec: interior spacing and shell metacharacters survive line scoping', () => {
  const m = mkExtract();
  const body = termBodyOf(m, '[agent:term exec] echo "a]b" && echo \'c;d\'  | cat\ntrailing prose');
  assert.strictEqual(body, 'echo "a]b" && echo \'c;d\'  | cat',
    'the command is the rest of the line verbatim — brackets and quotes included');
  assert.strictEqual(vetTermCommand(body).ok, true);
});

test('term exec: a command written on the line BELOW is refused, not silently run', () => {
  const m = mkExtract();
  // This form used to work (greedy capture + the vetter's end-trim) and the
  // vetter's own refusal used to advertise it. Line scoping ends it, so the
  // contract is that it produces the empty-command REFUSAL — never a command
  // assembled out of lines the agent did not put after the bracket.
  const body = termBodyOf(m, '[agent:term exec]\npwd');
  assert.strictEqual(body, '', 'nothing is captured from the following line');
  const vet = vetTermCommand(body);
  assert.strictEqual(vet.ok, false);
  assert.match(vet.error, /SAME line/, 'and the refusal names the form that works');
});

test('[agent:end]: escaped \\[agent:end] stays literal body text, not a boundary', () => {
  const m = mkExtract();
  const out = m._extractIntents('[agent:dm clodex] quoting the terminator:\n\\[agent:end]\nstill the body');
  assert.strictEqual(out[0].body, 'quoting the terminator:\n\\[agent:end]\nstill the body');
});

// --- fenced code blocks are quotes (_extractIntents + fencedLines) ---
// The misfire this closes fired live: an operator-facing reply documented the
// [agent:end] terminator with example dm lines inside a ``` fence — a fence
// only RENDERS as a block, the raw turn text kept each example at column 1,
// and both examples went out as real dms to nonexistent agents.

test('fence: an intent-shaped line inside a code fence does not fire and does not bounce', () => {
  const m = mkExtract();
  const out = m._extractIntents([
    'This is how you would send a dm:',
    '```',
    '[agent:dm alice] the message body',
    '[agent:frobnicate now]',
    '```',
    'And that concludes the documentation.',
  ].join('\n'));
  assert.deepStrictEqual(out, [], 'no intent fired, no unknown synthesized');
});

test('fence: a real intent after a closed fence still fires', () => {
  const m = mkExtract();
  const out = m._extractIntents('```\n[agent:dm alice] example\n```\n[agent:dm bob] real message');
  assert.deepStrictEqual(out.map((x) => x.type), ['dm']);
  assert.strictEqual(out[0].target, 'bob');
});

test('fence: inside a dm body, a fenced example is body text, not a boundary', () => {
  const m = mkExtract();
  const out = m._extractIntents([
    '[agent:dm clodex] here is the incantation:',
    '```',
    '[agent:who]',
    '```',
    'end of message',
  ].join('\n'));
  assert.deepStrictEqual(out.map((x) => x.type), ['dm']);
  assert.strictEqual(out[0].body,
    'here is the incantation:\n```\n[agent:who]\n```\nend of message',
    'fence delimiters and quoted intent all delivered as body text');
});

test('fence: unclosed fence quotes the rest of the turn (markdown semantics)', () => {
  const m = mkExtract();
  const out = m._extractIntents('```\n[agent:dm clodex] never fires');
  assert.deepStrictEqual(out, []);
});

test('remind: multi-line reminder text is captured greedily (allow-set), stops at next intent', () => {
  const m = mkExtract();
  // Free-text body spans lines (greedy like dm — NOT the exec JSON terminator).
  const r = m._extractIntents('[agent:remind every 30m] check the build\nand the deploy')[0];
  assert.strictEqual(r.type, 'remind');
  assert.strictEqual(r.spec, 'every 30m');
  assert.strictEqual(r.body, 'check the build\nand the deploy');
  // A following col-1 intent ends the reminder body and fires as its own intent.
  const both = m._extractIntents('[agent:remind on compact] reassess\n[agent:who]');
  assert.deepStrictEqual(both.map((x) => x.type), ['remind', 'who']);
  assert.strictEqual(both[0].body, 'reassess');
});

test('notify-user: multi-line note is captured greedily (allow-set), stops at next intent', () => {
  const m = mkExtract();
  // Free-text body spans lines (greedy like dm).
  const r = m._extractIntents('[agent:notify-user] blocked on the schema\nneed a decision')[0];
  assert.strictEqual(r.type, 'notify-user');
  assert.strictEqual(r.body, 'blocked on the schema\nneed a decision');
  // A following col-1 intent ends the note and fires as its own intent.
  const both = m._extractIntents('[agent:notify-user] decide please\n[agent:who]');
  assert.deepStrictEqual(both.map((x) => x.type), ['notify-user', 'who']);
  assert.strictEqual(both[0].body, 'decide please');
});

// --- _handleRemindIntent — [agent:remind <spec>] text -----------------------
// The intent seam over the scheduler: parse the spec head to split management
// (list/cancel) from scheduling, and match exec's tone — SILENT on a clean
// schedule/cancel, LOUD [agent:remind] bounce on a bad spec or unknown id;
// `list` always replies. A fake scheduler captures the add/cancel/list calls;
// the REAL parseRemindSpec drives the list/cancel/schedule split.
const { parseRemindSpec: parseRemindSpecReal } = require('../remind-schedule');

function mkRemind({ addResult, cancelResult = false, listResult = [] } = {}) {
  const calls = { add: [], cancel: [], list: [] };
  const scheduler = {
    add: (agent, spec, body) => { calls.add.push({ agent, spec, body }); return addResult || { ok: true, record: { id: 'ab12', kind: parseRemindSpecReal(spec).kind } }; },
    cancel: (agent, id) => { calls.cancel.push({ agent, id }); return cancelResult; },
    listForAgent: (agent) => { calls.list.push(agent); return listResult; },
  };
  const m = mk({
    parseRemindSpec: parseRemindSpecReal,
    getRemindScheduler: () => scheduler,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const replies = [], ipc = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = (_c, msg) => ipc.push(msg);
  const session = { name: 't1', agentType: 'claude' };
  return { m, session, replies, ipc, calls };
}

test('_handleRemindIntent: valid schedule is silent (no reply), audited via ipc', () => {
  const { m, session, replies, ipc, calls } = mkRemind();
  m._handleRemindIntent(session, 'every 30m', 'check the build');
  assert.strictEqual(replies.length, 0); // silent success
  assert.deepStrictEqual(calls.add, [{ agent: 't1', spec: 'every 30m', body: 'check the build' }]);
  assert.match(ipc.at(-1).body, /scheduled ab12/);
});

test('_handleRemindIntent: a bad spec bounces loudly with the parser error', () => {
  const { m, session, replies, calls } = mkRemind();
  m._handleRemindIntent(session, 'every 10s', 'x'); // under the 60s floor
  assert.strictEqual(calls.add.length, 0); // never reached the scheduler
  assert.match(replies.at(-1), /^\[agent:remind\] /);
  assert.match(replies.at(-1), /at least 60s/);
});

test('_handleRemindIntent: list with no schedules replies "none"', () => {
  const { m, session, replies } = mkRemind({ listResult: [] });
  m._handleRemindIntent(session, 'list', '');
  assert.match(replies.at(-1), /no reminders/);
});

test('_handleRemindIntent: list renders ids + specs', () => {
  const { m, session, replies, calls } = mkRemind({ listResult: [
    { id: 'ab12', spec: 'every 30m', body: 'check build' },
    { id: 'cd34', spec: 'on compact', body: '' },
  ] });
  m._handleRemindIntent(session, 'list', '');
  assert.deepStrictEqual(calls.list, ['t1']);
  const out = replies.at(-1);
  assert.match(out, /2 reminder\(s\)/);
  assert.match(out, /ab12  every 30m — check build/);
  assert.match(out, /cd34  on compact/);
});

test('_handleRemindIntent: cancel of a known id is silent success', () => {
  const { m, session, replies, ipc, calls } = mkRemind({ cancelResult: true });
  m._handleRemindIntent(session, 'cancel ab12', '');
  assert.strictEqual(replies.length, 0); // silent
  assert.deepStrictEqual(calls.cancel, [{ agent: 't1', id: 'ab12' }]);
  assert.match(ipc.at(-1).body, /cancel ab12: ok/);
});

test('_handleRemindIntent: cancel of an unknown id bounces loudly', () => {
  const { m, session, replies } = mkRemind({ cancelResult: false });
  m._handleRemindIntent(session, 'cancel zz99', '');
  assert.match(replies.at(-1), /^\[agent:remind\] no reminder zz99/);
});

test('_handleRemindIntent: scheduler add failure (past at) bounces with its error', () => {
  const { m, session, replies } = mkRemind({ addResult: { ok: false, error: 'that time is already in the past' } });
  m._handleRemindIntent(session, 'at 2020-01-01T00:00:00', 'nope');
  assert.match(replies.at(-1), /already in the past/);
});

// --- _handleNotifyUserIntent — [agent:notify-user] text ---------------------
// The operator-inbox seam: add the note to the store, fire notifyOS UNCONDITION-
// ally, broadcast one `notify` ipc line. Tone matches exec/remind — SILENT on a
// clean add, LOUD `[agent:notify-user] …` bounce on an empty body or an over-cap
// (16KB) body. A fake store captures adds; a notifyOS spy captures the toast.
function mkNotify() {
  const added = [], toasts = [], ipc = [];
  const store = {
    add: (rec) => { added.push(rec); return { id: 'nt01', ...rec }; },
  };
  const m = mk({
    getNotifications: () => store,
    notifyOS: (opts) => toasts.push(opts),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const replies = [];
  m._injectText = (_s, t) => replies.push(t);
  m._broadcast = (_c, msg) => ipc.push(msg);
  const session = { name: 't1', agentType: 'claude', workspaceId: 'ws-1' };
  return { m, session, added, toasts, ipc, replies };
}

test('_handleNotifyUserIntent: valid note is silent, stored, toasted, and broadcast', () => {
  const { m, session, added, toasts, ipc, replies } = mkNotify();
  m._handleNotifyUserIntent(session, 'blocked on which API to use');
  assert.strictEqual(replies.length, 0); // silent success
  assert.deepStrictEqual(added, [{ from: 't1', workspaceId: 'ws-1', body: 'blocked on which API to use' }]);
  // OS notification fires unconditionally (title = sender, body = first line).
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].title, 't1');
  assert.strictEqual(toasts[0].body, 'blocked on which API to use');
  // One `notify` ipc line for the audit log + the inbox island's live signal.
  assert.strictEqual(ipc.at(-1).type, 'notify');
  assert.strictEqual(ipc.at(-1).from, 't1');
  assert.strictEqual(ipc.at(-1).to, 'user');
});

test('_handleNotifyUserIntent: an empty (or whitespace-only) body bounces loudly, no store write', () => {
  const { m, session, added, toasts, replies } = mkNotify();
  m._handleNotifyUserIntent(session, '   \n  ');
  assert.strictEqual(added.length, 0);
  assert.strictEqual(toasts.length, 0);
  assert.match(replies.at(-1), /^\[agent:notify-user\] /);
  assert.match(replies.at(-1), /empty note/);
});

test('_handleNotifyUserIntent: an over-16KB body bounces with a keep-it-a-summary nudge', () => {
  const { m, session, added, replies } = mkNotify();
  const huge = 'x'.repeat(16 * 1024 + 1);
  m._handleNotifyUserIntent(session, huge);
  assert.strictEqual(added.length, 0); // never stored
  assert.match(replies.at(-1), /^\[agent:notify-user\] /);
  assert.match(replies.at(-1), /keep it a summary/);
});

test('_handleNotifyUserIntent: toast + broadcast use the FIRST line only (multi-line note)', () => {
  const { m, session, added, toasts, ipc } = mkNotify();
  m._handleNotifyUserIntent(session, 'need a call on option A\nvs option B\ndetails here');
  // Full body is stored; toast/broadcast preview only the first line.
  assert.strictEqual(added[0].body, 'need a call on option A\nvs option B\ndetails here');
  assert.strictEqual(toasts[0].body, 'need a call on option A');
  assert.strictEqual(ipc.at(-1).body, 'need a call on option A');
});

test('_handleNotifyUserIntent: missing workspaceId stores null (does not crash)', () => {
  const { m, added } = mkNotify();
  m._handleNotifyUserIntent({ name: 't2', agentType: 'claude' }, 'no workspace on this session');
  assert.strictEqual(added[0].workspaceId, null);
});

// --- _deliverReminder — durable fire routing (live / park-offline / drop) ----
// The reminder deliver seam: a fired self-reminder must never be silently lost
// the way a plain dm to an absent target is. Live → the DM path; offline but
// still in persistence (exited-naturally, or not-yet-restored at launch) → PARK
// into the real pending store so it drains on resume; gone from persistence
// (UI-killed) → dropped with a 'gone' signal so main.js prunes the schedule.
// Real temp PENDING_DIR + real parkDelivery/hasPending; persistence faked.
const { createRemindScheduler: createRemindSchedulerReal } = require('../remind-scheduler');
const { initStores: initStoresReal } = require('../stores');

function mkDeliver({ persisted = null } = {}) {
  const PENDING_DIR = mkTmpRoot('clodex-remind-pending-');
  const persistence = { list: () => [], get: (n) => (persisted && persisted.name === n ? persisted : null) };
  const m = mk({
    PENDING_DIR, parkDelivery, fs: fsReal, path: pathReal, os: osReal,
    randBase36: () => Math.random().toString(36).slice(2, 7),
    parkIdInUse: () => false,
    MSG_SPILL_THRESHOLD: 500,
    getPersistence: () => persistence,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const injected = [];
  m._injectText = (_s, t) => injected.push(t);
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._maybeParkDelivery = () => false; // force the direct inject on the live path
  return { m, PENDING_DIR, injected };
}

test('_deliverReminder: live session → injected via the DM path, returns "delivered"', () => {
  const { m, PENDING_DIR, injected } = mkDeliver();
  m.sessions.set('t1', { name: 't1', agentType: 'claude' });
  const status = m._deliverReminder('t1', '[ab12 every 30m] check build');
  assert.strictEqual(status, 'delivered');
  assert.match(injected.at(-1), /\[agent:from reminder\] \[ab12 every 30m\] check build/);
  // No reply trailer for the synthetic reminder sender (agent's own loop).
  assert.doesNotMatch(injected.at(-1), /reply: start a line/);
  assert.strictEqual(hasPending(PENDING_DIR, 't1'), false); // live → not parked
});

test('_deliverReminder: offline WITH a persistence entry → parked (drains on resume)', () => {
  const { m, PENDING_DIR } = mkDeliver({ persisted: { name: 't1', type: 'claude' } });
  // sessions map is EMPTY (agent exited naturally / not yet restored).
  const status = m._deliverReminder('t1', '[ab12 in 1h] ship it');
  assert.strictEqual(status, 'parked');
  assert.strictEqual(hasPending(PENDING_DIR, 't1'), true);
  // The parked bytes are the real delivery text.
  const drained = drainPending(PENDING_DIR, 't1', 'test');
  assert.match(drained.join('\n'), /\[agent:from reminder\] \[ab12 in 1h\] ship it/);
});

test('_deliverReminder: offline WITHOUT a persistence entry → dropped, returns "gone"', () => {
  const { m, PENDING_DIR } = mkDeliver({ persisted: null });
  const status = m._deliverReminder('t1', '[ab12 in 1h] ship it');
  assert.strictEqual(status, 'gone');
  assert.strictEqual(hasPending(PENDING_DIR, 't1'), false); // not parked — nothing accumulates
});

test('remind: start()-before-restore race — launch fire into an empty map is parked, not lost', () => {
  // Reproduce the whenReady ordering: scheduler.start() runs BEFORE sessions
  // restore, so a coalesced missed fire lands on an empty session map. With the
  // real store + the real deliver seam, that fire must PARK (persistence still
  // has the resumable entry) rather than vanish.
  const userData = mkTmpRoot('remind-race-ud-');
  const registryDir = mkTmpRoot('remind-race-reg-');
  const stores = initStoresReal(userData, { log: console, registryDir });
  try {
    const { m, PENDING_DIR } = mkDeliver({ persisted: { name: 't1', type: 'claude' } });
    // A schedule due in the PAST (app was "down"): pre-seed the store with a
    // stale nextFireAt so start()'s catch-up fires it immediately.
    stores.reminders.add({ agent: 't1', kind: 'every', spec: 'every 30m', body: 'reassess', nextFireAt: Date.now() - 60_000 });
    const scheduler = createRemindSchedulerReal({
      now: () => Date.now(), setTimer: () => 1, clearTimer: () => {},
      store: stores.reminders,
      deliver: (agent, id, spec, body) => {
        const prefix = `[${id} ${spec}]`;
        const status = m._deliverReminder(agent, body ? `${prefix} ${body}` : prefix);
        if (status === 'gone') stores.reminders.remove(id);
      },
    });
    // sessions map is empty (restore hasn't happened) — exactly the race.
    scheduler.start();
    scheduler.stop();
    assert.strictEqual(hasPending(PENDING_DIR, 't1'), true); // parked, not dropped
    const drained = drainPending(PENDING_DIR, 't1', 'test');
    assert.match(drained.join('\n'), /reassess/);
    // Recurring survived + recomputed forward (still scheduled, not consumed away).
    assert.strictEqual(stores.reminders.listForAgent('t1').length, 1);
  } finally {
    fsReal.rmSync(userData, { recursive: true, force: true });
    fsReal.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('remind: a gone agent\'s recurring schedule is pruned by the deliver seam (no zombie)', () => {
  const userData = mkTmpRoot('remind-gone-ud-');
  const registryDir = mkTmpRoot('remind-gone-reg-');
  const stores = initStoresReal(userData, { log: console, registryDir });
  try {
    const { m } = mkDeliver({ persisted: null }); // no persistence entry → 'gone'
    stores.reminders.add({ agent: 't1', kind: 'every', spec: 'every 30m', body: 'x', nextFireAt: Date.now() - 60_000 });
    const scheduler = createRemindSchedulerReal({
      now: () => Date.now(), setTimer: () => 1, clearTimer: () => {},
      store: stores.reminders,
      deliver: (agent, id, spec, body) => {
        const status = m._deliverReminder(agent, `[${id} ${spec}] ${body}`);
        if (status === 'gone') stores.reminders.remove(id);
      },
    });
    scheduler.start();
    scheduler.stop();
    assert.strictEqual(stores.reminders.list().length, 0); // pruned — won't recompute+drop forever
  } finally {
    fsReal.rmSync(userData, { recursive: true, force: true });
    fsReal.rmSync(registryDir, { recursive: true, force: true });
  }
});

// ── U6: reply-trailer reachability (_isDmReachable + _buildDeliveryText gate) ──
// The "(reply: [agent:dm <sender>])" nudge must only appear when that reply path
// actually exists: receiver can emit dm AND sender is a reachable agent.

function mkReach({ peers = [], receiverIntents = undefined } = {}) {
  return mk({
    getPeerManager: () => ({ statuses: () => peers }),
    // Receiver record carries the intents allowlist the dm-enabled check reads.
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'rcv' ? { intents: receiverIntents } : null) }),
  });
}

test('_isDmReachable: live local agent session → true; bash/dead/absent → false', () => {
  const m = mkReach();
  m.sessions.set('a', { name: 'a', agentType: 'claude' });
  m.sessions.set('bash1', { name: 'bash1' });                 // no agentType → private bash
  m.sessions.set('dead1', { name: 'dead1', agentType: 'claude', _dead: true });
  assert.strictEqual(m._isDmReachable('a'), true);
  assert.strictEqual(m._isDmReachable('bash1'), false, 'bash sessions are not DM-able');
  assert.strictEqual(m._isDmReachable('dead1'), false, 'dead sender excluded');
  assert.strictEqual(m._isDmReachable('ghost'), false, 'absent sender excluded');
  // The old hardcoded exclusions now fall out of reachability for free.
  assert.strictEqual(m._isDmReachable('user'), false);
  assert.strictEqual(m._isDmReachable('reminder'), false);
  assert.strictEqual(m._isDmReachable(''), false);
});

test('_isDmReachable: federated name@origin → true only for an ONLINE peer', () => {
  const m = mkReach({ peers: [
    { label: 'laptop', online: true },
    { label: 'server', online: false },
  ] });
  assert.strictEqual(m._isDmReachable('t1@laptop'), true);
  assert.strictEqual(m._isDmReachable('T1@LAPTOP'), true, 'origin match is case-insensitive');
  assert.strictEqual(m._isDmReachable('t1@server'), false, 'offline peer → reply would bounce');
  assert.strictEqual(m._isDmReachable('t1@unknown'), false, 'unconfigured origin');
});

test('_buildDeliveryText trailer: present only when sender reachable AND receiver dm-enabled', () => {
  const target = { name: 'rcv', agentType: 'claude' };
  const RE = /\(reply: start a line with \[agent:dm .+?\], close the body with a bare \[agent:end\] line\)/;

  // Reachable live sender + receiver dm-enabled (intents absent = all enabled).
  const m1 = mkReach();
  m1.sessions.set('a', { name: 'a', agentType: 'claude' });
  assert.match(m1._buildDeliveryText(target, 'a', 'hi', 'dm'), RE);

  // Receiver has dm GATED OFF ([] = everything gated) → no trailer even though
  // the sender is perfectly reachable.
  const m2 = mkReach({ receiverIntents: [] });
  m2.sessions.set('a', { name: 'a', agentType: 'claude' });
  assert.doesNotMatch(m2._buildDeliveryText(target, 'a', 'hi', 'dm'), RE);

  // Unreachable external sender (e.g. a `nc -U` wake script's from:"t1-wake") →
  // no trailer: nothing answers [agent:dm t1-wake]. Trader's case.
  const m3 = mkReach();
  assert.doesNotMatch(m3._buildDeliveryText(target, 't1-wake', 'wake up', 'dm'), RE);

  // Non-dm mtype (memory/system injection) never carries the conversational nudge.
  const m4 = mkReach();
  m4.sessions.set('a', { name: 'a', agentType: 'claude' });
  assert.doesNotMatch(m4._buildDeliveryText(target, 'a', 'unit body', 'memory'), RE);
});

test('_buildDeliveryText: a system sender gets no trailer even when a REAL session owns that name', () => {
  const target = { name: 'rcv', agentType: 'claude' };
  const RE = /\(reply: start a line with \[agent:dm .+?\], close the body with a bare \[agent:end\] line\)/;

  // The live-observed bug: team roster/delta notices ride senderName 'team', and
  // session names are one global namespace, so an unrelated agent named `team` in
  // ANOTHER workspace made the sender look answerable. Every seat was then told to
  // reply to it, and that agent received the replies as nonsense. Reachability is
  // true here on purpose — this pins the guard, not the absence of a session.
  for (const sender of ['team', 'clodex-team', 'reminder', 'memory', 'reboot', 'clodex']) {
    const m = mkReach();
    m.sessions.set(sender, { name: sender, agentType: 'claude' });
    assert.strictEqual(m._isDmReachable(sender), true,
      `ENTER: a live session named "${sender}" must be reachable, or this case never reaches the guard`);
    assert.doesNotMatch(m._buildDeliveryText(target, sender, 'roster', 'dm'), RE,
      `system sender "${sender}" must never advertise a reply address`);
  }

  // The guard is a fixed set, not a blanket mute: an ordinary sender whose name
  // merely CONTAINS a system label still gets its trailer.
  const m2 = mkReach();
  m2.sessions.set('team-lead', { name: 'team-lead', agentType: 'claude' });
  assert.match(m2._buildDeliveryText(target, 'team-lead', 'hi', 'dm'), RE);
});

// --- flushPending / _flushParkedNow (operator parked-DM flush) ----------------
// PTY-free: drainPending is a spy (records the claim tag), _injectText is stubbed
// so we don't build a real InjectQueue. Covers the three flushPending verdicts
// and the claim-tag / dialog-guard invariants from the spec.

function mkFlush(overrides = {}) {
  const drained = [];
  const m = mk({
    PENDING_DIR: '/tmp/pending-test',
    log: { warn() {}, info() {}, error() {}, debug() {} },
    drainPending: (root, name, tag) => { drained.push({ name, tag }); return overrides._texts || []; },
    // The pre-count is non-destructive and must agree with what the stubbed drain
    // would yield; the real fn would read the (nonexistent) PENDING_DIR as 0.
    countPending: () => (overrides._texts || []).length,
    ...overrides,
  });
  m._drained = drained;
  m._injected = [];
  // Models the QUEUE: a producer is evaluated at write time, not at enqueue.
  // Running it here is what keeps `_drained` a record of when the claim actually
  // happened — a fixture that ignored `produce` would record no claim at all and
  // every assertion about the drain would pass vacuously.
  m._injectText = (session, text, opts) => {
    const produced = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    m._injected.push({ name: session.name, text: produced, opts });
  };
  return m;
}

test('t360 _flushParkedNow: ANY forced flush ends the notice deferral chain, not just the operator flush', () => {
  // The chain otherwise dies only on a real turn or its own flush. So an operator
  // keeping the pane warm past the 300s park cap left it alive AFTER the cap had
  // already delivered the notice — and the next unrelated park would be forced out
  // early by a deadline with nothing left to deliver. Pinned at _flushParkedNow
  // rather than flushPending so the park-cap fire is covered by the same clear.
  const m = mkFlush({ _texts: ['parked one'] });
  const s = { name: 'a', agentType: 'claude' };
  m.sessions.set('a', s);
  let fired = 0;
  s._rebootNoticeFlushTimer = setTimeout(() => { fired += 1; }, 50);
  // ENTER: the chain is really live, or the clear below proves nothing.
  assert.ok(s._rebootNoticeFlushTimer, 'ENTER: a deferral round is armed');
  m._flushParkedNow(s, `cap.${process.pid}`, 'park-cap');   // the 300s cap firing
  assert.strictEqual(s._rebootNoticeFlushTimer, null, 'the park-cap flush ended the deferral chain too');
  assert.strictEqual(m._drained.length, 1, 'ENTER: and it really was a flush (the drain happened)');
  return new Promise((r) => setTimeout(() => {
    assert.strictEqual(fired, 0, 'the cleared round never fires against a later, unrelated park');
    r();
  }, 70));
});

test('flushPending: unknown / non-claude / dead target → refused, nothing drained', () => {
  const m = mkFlush();
  assert.deepStrictEqual(m.flushPending('ghost'), { ok: false, reason: 'no-such-agent' });
  m.sessions.set('cx', { name: 'cx', agentType: 'codex' });
  assert.deepStrictEqual(m.flushPending('cx'), { ok: false, reason: 'no-such-agent' });
  m.sessions.set('dead', { name: 'dead', agentType: 'claude', _dead: true });
  assert.deepStrictEqual(m.flushPending('dead'), { ok: false, reason: 'no-such-agent' });
  assert.strictEqual(m._drained.length, 0, 'refused targets never reach the drain');
});

test('flushPending: dialog-blocked target refuses WITHOUT draining (leaves durable store intact)', () => {
  const m = mkFlush({ _texts: ['[agent:from bob] hi'] });
  m.sessions.set('a', { name: 'a', agentType: 'claude', needsAttention: { kind: 'permission' } });
  assert.deepStrictEqual(m.flushPending('a'), { ok: false, reason: 'dialog-blocked' });
  assert.strictEqual(m._drained.length, 0, 'dialog guard returns before the claim');
  assert.strictEqual(m._injected.length, 0);
});

test('flushPending: happy path claims with a flush.<pid> tag and injects the parked pile as ONE batched message', () => {
  const m = mkFlush({ _texts: ['m1', 'm2'] });
  m.sessions.set('a', { name: 'a', agentType: 'claude', activityState: 'idle' });
  const r = m.flushPending('a');
  assert.deepStrictEqual(r, { ok: true, count: 2 });
  assert.strictEqual(m._drained.length, 1);
  assert.match(m._drained[0].tag, /^flush\./, 'operator flush uses a flush.<pid> claim tag');
  // Batched: N parked texts land as ONE injection (blank-line separator, park
  // order) — a per-text drain stranded the tail in the CLI's turn-start (field bug).
  assert.strictEqual(m._injected.length, 1, 'one injection for the whole drain, not N');
  assert.strictEqual(m._injected[0].text, 'm1\n\nm2');
});

test('flushPending: injects NON-parkable (the resend-recursion guard) and clears the badge', () => {
  const m = mkFlush({ _texts: ['only'] });
  const broadcasts = [];
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m.sessions.set('a', { name: 'a', agentType: 'claude', activityState: 'idle' });
  m._lastPendingCounts.set('a', 1);
  m.flushPending('a');
  // NON-parkable is the recursion guard: no parkable flag means no fire-time
  // divert, so a flushed message can never re-park the way a resent one could.
  assert.strictEqual(m._injected.length, 1);
  assert.ok(!m._injected[0].opts || !m._injected[0].opts.parkable,
    'flush injects without parkable');
  // The flush must push an immediate count:0 delta so the badge clears at once.
  assert.ok(broadcasts.some(b => b.channel === 'pending-count' && b.msg.name === 'a' && b.msg.count === 0));
  assert.strictEqual(m._lastPendingCounts.has('a'), false, 'poll map entry dropped');
});

test('_flushParkedNow: empty claim (another drainer won) is a no-op returning count 0', () => {
  const m = mkFlush({ _texts: [] });
  const target = { name: 'a', agentType: 'claude' };
  assert.deepStrictEqual(m._flushParkedNow(target, 'cap.1', 'park-cap'), { ok: true, count: 0 });
  assert.strictEqual(m._injected.length, 0);
});

// t229: the same no-op must SAY so. This is not log-prose pedantry — the early
// return sat above the only log call, so a park cap firing on an already-empty
// mailbox produced zero output and was indistinguishable from a cap that never
// fired at all. That absence was then read as proof the timer was broken, and it
// could not have been: nothing it could do would have printed anything.
test('t229 _flushParkedNow: an empty claim is LOGGED — silence here was read as a dead timer for four days', () => {
  const debugs = [];
  const m = mkFlush({
    _texts: [],
    log: { warn() {}, info() {}, error() {}, debug: (_scope, msg) => debugs.push(msg) },
  });
  const target = { name: 'a', agentType: 'claude' };
  assert.deepStrictEqual(m._flushParkedNow(target, 'cap.1', 'park-cap'), { ok: true, count: 0 },
    'ENTER: this is the empty-claim path, not a delivery');
  assert.strictEqual(debugs.length, 1, 'the empty cap fire is recorded, not silent');
  assert.match(debugs[0], /park-cap for a/, 'and names the seat and the kind that fired');
});

// --- hub relay: _relayClaimedDm ------------------------------------------
// Behavioral guard for the claimed-relay hot path. This path shipped broken
// (relayVersionOk used but missing from the relay-protocol destructure — a
// ReferenceError on EVERY claimed relay envelope, logged-and-dropped by the
// claim loop's catch) while the whole suite stayed green: relay-protocol.test
// covers the pure functions and nothing drove the session-manager side. The
// free-identifier scanner can't see it either — it checks names against
// main.js's module scope, not sibling-module imports. So: drive the real
// method with a valid envelope and assert the terminal leg fires.
function mkRelay({ statuses, conn } = {}) {
  const dm = [];
  const c = conn || { dm: (payload, cb) => { dm.push(payload); cb && cb({ ok: true }); } };
  const m = mk({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getUiSettings: () => ({ get: () => ({ peers: [
      { label: 'docker', relayAllowed: true },
      { label: 'murmurfi', relayAllowed: true },
    ] }) }),
    getPeerManager: () => ({
      statuses: () => statuses || [{ id: 'p2', label: 'murmurfi', online: true, caps: ['dm', 'relay'], sessions: [] }],
      get: (id) => (id === 'p2' ? c : null),
    }),
  });
  return { m, dm };
}

test('_relayClaimedDm: valid envelope relays as a plain terminal DM (fields stripped, from sacred)', () => {
  const { m, dm } = mkRelay();
  m._relayClaimedDm('p1', 'docker', { label: 'docker', relayAllowed: true }, {
    rv: 1, to: 'murmur', finalTarget: 'murmur@murmurfi', from: 'docker@docker',
    body: 'hello across the star', urgent: false, hops: 1, ts: 1,
  });
  assert.strictEqual(dm.length, 1, 'terminal leg delivered exactly once');
  assert.deepStrictEqual(dm[0], { to: 'murmur', from: 'docker@docker', body: 'hello across the star', urgent: false });
});

test('_relayClaimedDm: exhausted hop budget and offline destination both drop without delivering', () => {
  const { m, dm } = mkRelay();
  m._relayClaimedDm('p1', 'docker', { label: 'docker', relayAllowed: true }, {
    rv: 1, to: 'murmur', finalTarget: 'murmur@murmurfi', from: 'docker@docker', body: 'x', hops: 0,
  });
  const offline = mkRelay({ statuses: [{ id: 'p2', label: 'murmurfi', online: false, caps: ['dm'], sessions: [] }] });
  offline.m._relayClaimedDm('p1', 'docker', { label: 'docker', relayAllowed: true }, {
    rv: 1, to: 'murmur', finalTarget: 'murmur@murmurfi', from: 'docker@docker', body: 'x', hops: 1,
  });
  assert.strictEqual(dm.length, 0, 'hop-exhausted envelope dropped');
  assert.strictEqual(offline.dm.length, 0, 'offline destination dropped');
});

test('_relayClaimedDm: terminal-leg from is origin-normalized to OUR label for the source spoke', () => {
  // The spoke stamps its own selfLabel (hostname-ish) — the hub must rewrite the
  // suffix to its configured label ('docker'), or the recipient gets a reply
  // address no roster advertises. Local part stays sacred.
  const { m, dm } = mkRelay();
  m._relayClaimedDm('p1', 'docker', { label: 'docker', relayAllowed: true }, {
    rv: 1, to: 'murmur', finalTarget: 'murmur@murmurfi', from: 'degen@clodex-docker',
    body: 'ack', urgent: false, hops: 1,
  });
  assert.strictEqual(dm.length, 1);
  assert.strictEqual(dm[0].from, 'degen@docker', 'selfLabel suffix rewritten to hub label');

  const bare = mkRelay();
  bare.m._relayClaimedDm('p1', 'docker', { label: 'docker', relayAllowed: true }, {
    rv: 1, to: 'murmur', finalTarget: 'murmur@murmurfi', from: 'degen', body: 'x', hops: 1,
  });
  assert.strictEqual(bare.dm[0].from, 'degen@docker', 'bare from gets qualified with hub label');
});

// --- Silent-drop bounces: unknown intents, undeliverable dms, context typos ---
// Three feedback holes of the same family, each of which used to swallow an
// agent's action in silence: (1) a `[agent:…]`-shaped line that parses to
// nothing (typo'd verb / malformed args) was dropped by _extractIntents;
// (2) a dm to a target that is neither a local agent, a `name@peer` route,
// nor a socket peer fell through to the ipc-log broadcast alone; (3) an
// unknown `context` sub-command was a console.warn the agent never saw.

function mkBounce() {
  const injected = [];
  const broadcasts = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: () => null }),
    registry: { listPeers: () => [], getPeer: () => null },
    getPeerManager: () => null,
    peerStatusLabel: () => 'idle',
    parseIntent: parseIntentReal,
    looksLikeIntent: looksLikeIntentReal,
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = (_ch, msg) => broadcasts.push(msg);
  m.sessions.set('a', { name: 'a', type: 'claude', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('sh', { name: 'sh', workspaceId: 'ws1' }); // bash: no agentType
  return { m, injected, broadcasts };
}

test('extract: a top-level near-miss line synthesizes ONE unknown intent, counting the rest', () => {
  const { m } = mkBounce();
  const found = m._extractIntents('prose\n[agent:frobnicate now]\nmore prose\n[agent:dmm b] typo');
  const unknown = found.filter((x) => x.type === 'unknown');
  assert.strictEqual(unknown.length, 1, 'capped at one unknown per batch');
  assert.strictEqual(unknown[0].text, '[agent:frobnicate now]', 'carries the first offending line');
  assert.strictEqual(unknown[0].more, 1, 'later near-misses only bump the counter');
});

test('extract: near-misses inside a dm body stay body text — quoting is safe', () => {
  const { m } = mkBounce();
  const found = m._extractIntents('[agent:dm b] look at this example:\n[agent:frobnicate now]\ntrailing prose');
  assert.strictEqual(found.length, 1, 'only the dm fires');
  assert.strictEqual(found[0].type, 'dm');
  assert.match(found[0].body, /\[agent:frobnicate now\]/, 'the near-miss was captured as body');
});

test('extract: escaped and mid-line [agent: text never synthesize unknown', () => {
  const { m } = mkBounce();
  const found = m._extractIntents('\\[agent:dm b] literal\nsee the [agent:dm] docs for details');
  assert.strictEqual(found.length, 0);
});

test('unknown: bounces to an agent sender naming the line and the escape, before the gate', async () => {
  const injected = [];
  const m = mk({
    // Empty allowlist gates EVERYTHING — unknown must still bounce as itself,
    // not as "the unknown intent is disabled" nonsense.
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents: [] } : null) }),
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  await m._handleIntent('a', { type: 'unknown', text: '[agent:frobnicate now]', more: 2 });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /^\[agent:\?\] unrecognized intent `\[agent:frobnicate now\]`/);
  assert.match(injected[0], /\+2 more/);
  assert.match(injected[0], /escape it as \\\[agent:/);
});

test('unknown: never injects into a bash session', async () => {
  const { m, injected, broadcasts } = mkBounce();
  await m._handleIntent('sh', { type: 'unknown', text: '[agent:x]', more: 0 });
  assert.strictEqual(injected.length, 0, 'nothing typed at a shell prompt');
  assert.strictEqual(broadcasts.length, 1, 'still visible in the ipc log');
});

// ── t232: the term near-miss gets a FORM hint, not just the verb list ─────────
// The generic bounce is actively misleading for this one line. `[agent:term exec
// pwd]` fails on the GRAMMAR (the command belongs after the bracket), yet the
// bounce answers with a valid-intents list that NAMES `term` — so the seat reads
// "the verb was fine" and looks for a different fault. Every other near-miss is
// a bad verb, where that list IS the answer.

test('t232: a bracket-argumented term near-miss is told where the command goes', async () => {
  const { m, injected } = mkBounce();
  // The exact line the old help text taught, through the real scanner: it must
  // still reach the bounce as an `unknown`, or the hint below is unreachable.
  const found = m._extractIntents('[agent:term exec pwd]');
  assert.deepStrictEqual(found, [{ type: 'unknown', text: '[agent:term exec pwd]', more: 0 }],
    'ENTER: the documented-but-unparseable form arrives as a near-miss');
  await m._handleIntent('a', found[0]);
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /AFTER the closing bracket/, 'names the grammar fault, not just the verb');
  assert.match(injected[0], /\[agent:term exec\] <command>/, 'and names the form that works');
  // Still the full generic bounce underneath — the hint is an insert, not a
  // replacement, so a seat that got here by some OTHER mistake keeps the list.
  assert.match(injected[0], /Valid intents:.*\bterm\b/);
  assert.match(injected[0], /escape it as \\\[agent:/);
});

test('t232: the form hint fires ONLY for term — other near-misses are unchanged', async () => {
  const { m, injected } = mkBounce();
  for (const text of ['[agent:rebot]', '[agent:termite exec] x', '[agent:dm]', '[agent:terminal]']) {
    await m._handleIntent('a', { type: 'unknown', text, more: 0 });
  }
  assert.strictEqual(injected.length, 4, 'ENTER: all four bounced');
  const withHint = injected.filter((t) => /AFTER the closing bracket/.test(t));
  // `termite`/`terminal` are the interesting rows: a prefix match on `term`
  // alone would hand a term-specific hint to a seat that never wrote term.
  assert.deepStrictEqual(withHint, [], 'no non-term near-miss gets the term hint');
});

test('t232: the hint never reconstructs or runs what the line probably meant', async () => {
  const termRuns = [];
  const { m, injected } = mkBounce();
  m._handleTermIntent = (...a) => { termRuns.push(a); };
  await m._handleIntent('a', { type: 'unknown', text: '[agent:term exec rm -rf /tmp/x]', more: 0 });
  assert.strictEqual(injected.length, 1, 'ENTER: it bounced');
  assert.deepStrictEqual(termRuns, [], 'a near-miss must never execute the command it resembles');
  // The payload appears EXACTLY once, and only inside the pre-existing verbatim
  // quote of the line the seat wrote. The hint half must stay a fixed string:
  // re-emitting `[agent:term exec] rm -rf /tmp/x` as a "did you mean" would hand
  // the seat a runnable line nobody authored, one paste from running.
  const hint = injected[0].slice(injected[0].indexOf('nothing was done.'));
  assert.ok(!hint.includes('rm -rf'), 'the hint names the FORM, never the seat\'s payload');
  assert.strictEqual(injected[0].split('rm -rf').length - 1, 1, 'quoted once, as the offending line');
});

// The false-positive half, and the one that matters most: agents quote intents
// in prose constantly (this ticket is about documenting one). A hint that fired
// on a fenced example or an escape would train seats to ignore the channel. Both
// guards are inherited from the near-miss path rather than newly built, which is
// exactly why they need a pin here — nothing in the new code re-states them.
test('t232: a fenced or escaped term example produces no bounce at all', async () => {
  const { m, injected } = mkBounce();
  const fenced = m._extractIntents('```\n[agent:term exec pwd]\n```');
  assert.deepStrictEqual(fenced, [], 'a fenced example is a quote, not a near-miss');
  const escaped = m._extractIntents('\\[agent:term exec pwd]');
  assert.deepStrictEqual(escaped, [], 'an escaped example is a quote too');
  // And nothing reached the seat by either route.
  for (const i of [...fenced, ...escaped]) await m._handleIntent('a', i);
  assert.deepStrictEqual(injected, []);
});

test('dm: a target that exists nowhere bounces to the sender instead of vanishing', async () => {
  const { m, injected, broadcasts } = mkBounce();
  await m._handleIntent('a', { type: 'dm', target: 'nosuch', body: 'hello?' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /NOT delivered: no agent named "nosuch"/);
  assert.match(injected[0], /\[agent:who\]/, 'points at the discovery intent');
  assert.match(broadcasts[0].body, /^UNDELIVERED \(no such agent\)/);
});

test('dm: a bash-session target bounces (exists, but not DM-able)', async () => {
  const { m, injected, broadcasts } = mkBounce();
  await m._handleIntent('a', { type: 'dm', target: 'sh', body: 'ping' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /"sh" is a bash session/);
  assert.match(broadcasts[0].body, /^UNDELIVERED \(bash session\)/);
});

test('context: an unknown sub-command bounces to the agent, not just console.warn', async () => {
  const { m, injected } = mkBounce();
  await m._handleIntent('a', { type: 'context', sub: 'compress', body: '' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /unknown or unsupported sub-command "compress"/);
  assert.match(injected[0], /compact\|clear\|reload/);
});

// --- T35: boot-readiness gate wiring (_injectQueueFor + the 2004 latch) -------
// The first inject into a freshly spawned CLAUDE seat races CLI boot: text+Enter
// written before the raw-mode input loop is up read as one paste-like chunk and
// the Enter lands as content, so the message never submits. _injectQueueFor
// gates claude agent seats on the latched mode-2004 edge (_bootReadySeen);
// bash/codex pass straight through. (Behavioral gate mechanics — hold, cap, dead,
// latch — are pinned deterministically in test/inject-queue.test.js; here we pin
// the session-manager wiring: which seats get gated, and the latch predicate.)
function mkBoot() {
  return mk({
    InjectQueue: require('../inject-queue').InjectQueue,   // real queue — we drive real seams
    INJECT_BOOT_MAXWAIT: 20_000,
    INJECT_QUIET_MS: 0,
    INJECT_QUIET_MAXWAIT: 0,
    LONG_TEXT_THRESHOLD: 100000, LONG_TEXT_DELAY: 0, SHORT_TEXT_DELAY: 0,
  });
}
function bootSession(over = {}) {
  const writes = [];
  const s = {
    name: 'seat', agentType: 'claude', _dead: false,
    _pasteModeOn: false, _bootReadySeen: false,
    lastUserInputTs: 0,
    pty: { write: (b) => writes.push(b) },
    ...over,
  };
  return { s, writes };
}

test('T35 wiring: a claude seat with the boot latch already set injects immediately', async () => {
  const m = mkBoot();
  const { s, writes } = bootSession({ _bootReadySeen: true });
  await m._injectQueueFor(s).enqueue('scope');
  assert.deepStrictEqual(writes, ['\x15', 'scope', '\r']);
});

test('T35 wiring: a claude seat still booting holds the write until the latch flips', async () => {
  const m = mkBoot();
  const { s, writes } = bootSession({ _bootReadySeen: false });
  const p = m._injectQueueFor(s).enqueue('scope');
  // Wait out more than one real poll cycle (readyPollMs default 250) so the
  // drain has actually spun the ready-gate loop at least once — a genuine hold,
  // not merely "enqueue didn't write on the same microtask". Nothing may reach
  // the pane while the seat is still booting (the race that swallowed the Enter).
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(writes, [], 'still nothing written after a poll cycle — the gate holds');
  // Simulate the CLI turning bracketed-paste on (composer accepting input) →
  // latch opens; the next poll picks it up and the item drains.
  s._bootReadySeen = true;
  await p;
  assert.deepStrictEqual(writes, ['\x15', 'scope', '\r']);
});

test('T35 wiring: a bash seat is NOT gated (ready pass-through, injects immediately)', async () => {
  const m = mkBoot();
  // agentType null = bash; _bootReadySeen never set — must still inject at once.
  const { s, writes } = bootSession({ agentType: null, _bootReadySeen: false });
  const t0 = Date.now();
  await m._injectQueueFor(s).enqueue('cmd');
  // No-gate-wait: a wrongly-engaged boot gate would burn a poll cycle (≥250ms)
  // waiting on a never-set latch; pass-through drains on microtasks only.
  assert.ok(Date.now() - t0 < 200, 'bash inject did not wait on the boot gate');
  assert.deepStrictEqual(writes, ['\x15', 'cmd', '\r']);
});

test('T35 wiring: a codex seat is NOT gated (own boot-settle machinery, pass-through)', async () => {
  const m = mkBoot();
  const { s, writes } = bootSession({ agentType: 'codex', _bootReadySeen: false });
  const t0 = Date.now();
  await m._injectQueueFor(s).enqueue('cmd');
  // Same no-gate-wait guard: codex must never touch the claude boot gate.
  assert.ok(Date.now() - t0 < 200, 'codex inject did not wait on the boot gate');
  assert.deepStrictEqual(writes, ['\x15', 'cmd', '\r']);
});

test('T35 latch: the boot gate reads the latch live, and the latch never un-sets', async () => {
  // The queue re-reads _bootReadySeen each drain, so a second item on an
  // already-ready seat drains with no extra waiting — and because the caller's
  // latch never un-sets (2004 toggling around dialogs doesn't clear it), a later
  // item can't be re-blocked by the boot gate.
  const m = mkBoot();
  const { s, writes } = bootSession({ _bootReadySeen: true });
  const q = m._injectQueueFor(s);
  await q.enqueue('one');
  // 2004 goes off around a dialog (paste-mode flips) — but the boot latch holds.
  s._pasteModeOn = false;
  await q.enqueue('two');
  assert.deepStrictEqual(writes, ['\x15', 'one', '\r', '\x15', 'two', '\r']);
});

// --- T35 REWORK (MUST-FIX): the PRODUCTION latch path (ptyProc.onData) --------
// The prior T35 tests hand-set _bootReadySeen, so deleting the sniff-site latch
// line (session-manager.js:1334 `if (session._pasteModeOn) _bootReadySeen=true`)
// would leave the suite green while production regresses to a 20s cap-delay and
// the same swallowed Enter. These drive the REAL ptyProc.onData closure captured
// from a real create() and assert the latch flips on a genuine mode-2004 chunk.
//
// The latch line runs for EVERY session type (it's before the `if (!agentType)`
// scan branch), so a cheap BASH create() — already scaffolded elsewhere — drives
// the exact production line without a heavy claude create() (Transport/wire/
// hooks). The gate itself (_injectQueueFor's isClaude arm) reads session.agentType
// at queue-BUILD time; test (c) relabels the seat 'claude' before building the
// queue so the real onData latch, the real ready() seam, and the real InjectQueue
// drain compose end-to-end. Only the relabel is a test artifact.
function mkOnDataProbe(overrides = {}) {
  let onDataCb = null;
  const fakePty = {
    spawn: () => ({ onData(cb) { onDataCb = cb; }, onExit() {}, kill() {}, pid: 777 }),
  };
  const PENDING_DIR = mkTmpRoot('clodex-pend-ondata-');
  const m = mk({
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {}, remove: () => {},
    }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: fakePty,
    os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // T35 gate deps (mk() omits them) — a real InjectQueue for the end-to-end drain.
    InjectQueue: require('../inject-queue').InjectQueue,
    INJECT_BOOT_MAXWAIT: 20_000,
    INJECT_QUIET_MS: 0, INJECT_QUIET_MAXWAIT: 0,
    LONG_TEXT_THRESHOLD: 100000, LONG_TEXT_DELAY: 0, SHORT_TEXT_DELAY: 0,
    // T54: the boot-ready rising edge now calls _drainPendingAtBootReady from
    // onData (after a settle margin), so this harness needs the drain's deps + a
    // REAL pending store (production always has them). bootDrainSettleMs:0 fires
    // the deferred drain on the next tick so the tests don't wait the ~750ms
    // production margin. With no pending seeded the drain is a harmless no-op
    // (hasActivePending → false), so it doesn't perturb the T35 readiness-gate
    // assertions; the T54 edge tests below seed a park to exercise it.
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen: isDraftOpenReal,
    bootDrainSettleMs: 0,
    ...overrides,
  });
  m._sendToSession = () => {};
  m._scanPtyOutput = () => {};        // bash onData scans pty output — silence it
  return { m, PENDING_DIR, fireData: (d) => onDataCb(d), getSession: (n) => m.sessions.get(n) };
}

// A POSITIVE settling signal for the boot edge, for the subjects below that assert
// an ABSENCE. You cannot poll for something to stay absent: an absence assertion
// that runs early is trivially true, so a fixed wall-clock wait in front of one
// passes whether or not the edge ever fired — with `fireData('\x1b[?2004h')`
// deleted outright from the two absence subjects, both stayed GREEN. Two stages,
// both load-bearing:
//   1. production nulls `session._bootDrainTimer` as the FIRST line of the deferred
//      callback, so `null` proves that callback RAN. The other two states are
//      distinct: `undefined` = never armed (the edge never fired), a Timeout object
//      = still pending. The rest of the callback is synchronous, so once a poll
//      observes null, any enqueue the drain made is already on the queue's chain.
//   2. `InjectQueue._chain` is a serial FIFO (`_chain = _chain.then(run, run)`), so
//      a sentinel enqueued after stage 1 settles only once everything the boot edge
//      queued has itself finished draining.
// On a SECOND call against the same seat stage 1 is already satisfied — the timer
// was nulled by the first — so it returns at once and carries nothing. Stage 2 is
// what does the work there: the sentinel still queues behind whatever the edge
// left on the chain. That is the boot-g case, where the producer is released
// between the two calls.
// The caller then asserts the sentinel's bytes AND NOTHING ELSE — a positive
// assertion. An early run has no sentinel either; a payload that was wrongly
// drained appears ahead of it. Both fail loudly instead of passing vacuously.
const SETTLE_SENTINEL = 'boot-edge settle sentinel';
async function settleBootEdge(m, s) {
  try {
    await waitFor(() => s._bootDrainTimer === null);
  } catch {
    // The verdict is per-arm, not just the parenthetical: a live Timeout is a
    // loaded box and `undefined` is a dead edge, and calling both "a broken
    // mechanism" is the false sentence this ticket exists to remove. Only the
    // vacuity warning is shared, because it is true either way. `null` cannot
    // reach here — it is what the poll waits for.
    assert.fail('the boot-ready deferred drain never ran, so the absence asserted next '
      + 'would have been vacuously true. '
      + (s._bootDrainTimer === undefined
        ? '_bootDrainTimer was never armed — the rising edge never fired. A broken mechanism, not a slow box.'
        : '_bootDrainTimer is still pending (a live Timeout) — it was armed but this box was too '
          + 'loaded to run it inside the poll. A RESOURCE failure, not a broken edge.'));
  }
  await m._injectQueueFor(s).enqueue(SETTLE_SENTINEL);
}

test('T35 latch (production onData): a real mode-2004h chunk flips _bootReadySeen', async () => {
  const { m, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-a', null);
  const s = getSession('boot-a');
  assert.strictEqual(!!s._bootReadySeen, false, 'not ready before any 2004 output');
  fireData('\x1b[?2004h');            // CLI turns bracketed paste on = composer live
  assert.strictEqual(s._bootReadySeen, true, 'latch flipped by the real onData handler');
});

test('T35 latch (production onData): the latch never un-sets on a later 2004l chunk', async () => {
  const { m, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-b', null);
  const s = getSession('boot-b');
  fireData('\x1b[?2004h');            // boot: composer accepting input
  assert.strictEqual(s._bootReadySeen, true);
  fireData('\x1b[?2004l');            // 2004 off around a dialog/teardown
  assert.strictEqual(s._pasteModeOn, false, 'paste-mode tracks the live toggle');
  assert.strictEqual(s._bootReadySeen, true, 'but the BOOT latch stays set (not a liveness gate)');
});

test('T35 latch (production onData): a claude-gated delivery holds until the real latch flips, then drains', async () => {
  const { m, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-c', null);
  const s = getSession('boot-c');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };   // capture the queue's PTY writes
  s.agentType = 'claude';                      // gate reads this at queue-build time
  const p = m._injectQueueFor(s).enqueue('scope message');
  // Booting: no 2004 seen yet → the real ready() seam (reads _bootReadySeen)
  // holds the write past a full poll cycle. This is the swallowed-Enter race made
  // impossible: nothing reaches the pane while the input loop may not be up.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(writes, [], 'delivery held while the claude seat boots');
  fireData('\x1b[?2004h');                     // real onData latches _bootReadySeen
  await p;
  assert.deepStrictEqual(writes, ['\x15', 'scope message', '\r'], 'drained once ready');
});

test('T54 (production onData): the boot-ready rising edge DRAINS an active-parked scope (no idle turn needed)', async () => {
  // The load-bearing edge, end-to-end through the REAL onData handler: a
  // boot-silent claude seat never reaches an idle EDGE, so the ONLY thing that
  // delivers an active-parked scope is the first mode-2004h rising edge calling
  // _drainPendingAtBootReady (deferred a settle margin, 0 in this harness). Seat
  // the scope active, fire the real 2004h chunk, and assert it drains to the PTY
  // — WITHOUT any idle/turn event.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-d', null);
  const s = getSession('boot-d');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';                       // gate + drain both read this
  // Scope parked ACTIVE (as _deliverParkedActive would), nothing injected yet.
  parkDelivery(PENDING_DIR, 'boot-d', '[agent:from lead] review the fix', '1');
  assert.deepStrictEqual(writes, [], 'silent while booting — no spawn-time write (T40/T42 stance)');
  assert.strictEqual(s._bootReadySeen ? true : false, false, 'not ready before any 2004 output');
  fireData('\x1b[?2004h');                       // the rising edge — the whole fix
  // Bounded poll, NOT a widened deadline: it returns the instant the drain lands, so
  // the pass path has no deadline left in it at all. The old fixed 50ms sleep failed
  // 16 times in 48 runs at concurrency 24 on a 14-core box, always with `['\x15']`.
  // That partial is the whole diagnostic, and it is observable only because
  // InjectQueue._drain writes the Ctrl-U, the text and the \r as THREE separate PTY
  // writes with sleeps between them.
  try {
    await waitFor(() => writes.length >= 3);
  } catch {
    assert.fail(`the boot-edge drain did not complete: writes=${JSON.stringify(writes)} — `
      + (writes.length !== 0
        ? 'a PARTIAL drain means the drain was still in flight when the poll expired, i.e. this box was too loaded, not that the edge is broken'
        // EMPTY is not one finding either: nothing was written because the drain
        // never wrote, or because the deferred callback never ran at all. The
        // timer separates them for free, same three states as boot-g.
        : s._bootDrainTimer === null
          ? 'EMPTY with the deferred drain already RUN (_bootDrainTimer null) means the rising edge did not drain the active scope at all — a real regression, not a slow box'
          : s._bootDrainTimer === undefined
            ? 'EMPTY and the drain was never armed (_bootDrainTimer undefined) — the rising edge never fired at all. A real regression, not a slow box'
            : 'EMPTY but the deferred drain is still pending (_bootDrainTimer is a live Timeout) — this box was too loaded to run it inside the poll. A RESOURCE failure, not a broken edge'));
  }
  assert.strictEqual(s._bootReadySeen, true, 'boot-ready latched');
  assert.deepStrictEqual(writes, ['\x15', '[agent:from lead] review the fix', '\r'],
    'the rising edge drained the active scope to the pane — no human ✉-click, no idle turn');
  assert.strictEqual(hasPending(PENDING_DIR, 'boot-d'), false, 'claimed + removed from the store');
});

test('T54 (production onData): the rising edge leaves a PASSIVE-only store parked (class boundary holds)', async () => {
  // A passive ride-along on the same boot-silent seat must NOT be drained by the
  // boot-ready edge — only the active scope class earns it.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-e', null);
  const s = getSession('boot-e');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'boot-e', '[agent:from team] roster delta', '1', null, true); // passive
  fireData('\x1b[?2004h');
  // Positive settling signal, then a positive assertion: the sentinel's bytes are the
  // ONLY thing on the pane. Under the old fixed sleep this subject stayed green with
  // the rising edge deleted, because an absence that is asserted early is trivially
  // true — measured, not assumed.
  await settleBootEdge(m, s);
  assert.deepStrictEqual(writes, ['\x15', SETTLE_SENTINEL, '\r'],
    'a passive-only store is not drained by the boot-ready edge — only the later sentinel reached the pane');
  assert.ok(hasPending(PENDING_DIR, 'boot-e'), 'the passive delta stays parked for an organic carrier');
});

test('T54 (fix) INVARIANT: a boot-edge drain that cannot land leaves the scope RECOVERABLE, never both-gone', async () => {
  // The regression this fix exists for: pre-fix the boot edge DESTRUCTIVELY claimed
  // the store (drainPending) before an unconfirmed fire-and-forget inject, so a
  // delivery that couldn't land was claimed off disk AND not written = silent loss
  // (no ✉, orphan file). Here an operator draft is open at the boot edge, so the
  // scope must NOT be injected (would splice the draft) AND must stay on disk
  // (recoverable — the ✉ survives). NEVER both-gone. This is the invariant that
  // was violated; the recoverable-not-destructive net is what restores it.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-f', null);
  const s = getSession('boot-f');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'boot-f', '[agent:from lead] review the fix', '1');
  // Operator is composing a draft (lastUserInputTs > lastUserSubmitTs) — isDraftOpen true.
  s.lastUserInputTs = Date.now();
  s.lastUserSubmitTs = 0;
  fireData('\x1b[?2004h');                       // boot-ready edge, the only trigger
  // Same reason as boot-e: the absence below was vacuous behind a fixed sleep. Note
  // the sentinel still lands with the draft open — the draft gate lives in
  // _drainPendingAtBootReady's producer, not in the queue, so an ordinary enqueue is
  // unaffected and stays a valid settling signal here.
  await settleBootEdge(m, s);
  assert.deepStrictEqual(writes, ['\x15', SETTLE_SENTINEL, '\r'],
    'draft open → the parked scope was not injected (no splice); only the later sentinel reached the pane');
  assert.ok(hasPending(PENDING_DIR, 'boot-f'), 'INVARIANT: scope stays recoverable on disk (✉ survives) — never claimed-and-lost');
});

test('T54 (fix) INVARIANT: a draft opening AFTER enqueue, BEFORE the producer fires, still leaves the scope recoverable', async () => {
  // boot-f above opens the draft at DRAIN time, so _drainPendingAtBootReady's
  // pre-enqueue gate short-circuits — it never reaches the producer. This case
  // drives the HEART of the fix: the FIRE-TIME producer re-check inside the queue's
  // critical section. The draft is CLOSED when the drain enqueues (so the producer
  // IS enqueued), then opens while the queue holds on its boot-readiness gate, then
  // the seat signals ready → the producer fires and re-checks: draft now open →
  // it does its destructive drainPending claim on NOTHING and returns null. The
  // scope is never claimed off disk. Same invariant, the actual claim path.
  //
  // The lever is the boot-readiness gate: hold _bootReadySeen false to keep the
  // producer parked mid-queue (as a still-booting readline loop would), open the
  // draft in that window, then flip it true to release the producer. This is the
  // only deterministic way to interleave a draft between enqueue and fire.
  //
  // Both halves wait on a POSITIVE observable, because every assertion here is an
  // absence and an absence asserted early is trivially true: with
  // `fireData('\x1b[?2004h')` deleted outright this subject passed 1/1, all four
  // assertions surviving — the region's strongest invariant measuring nothing.
  // The queue's own length is what proves the producer reached the queue at all
  // (InjectQueue.enqueue increments immediately, and only _drain's finally
  // decrements), which `hasPending` alone cannot tell from "never enqueued".
  // Length 1 does NOT by itself prove the producer has not fired — it is equally
  // true mid-write — so the assertions on `writes` and the store are what carry
  // that half; the length assertion's message points at them rather than
  // claiming it.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'boot-g', null);
  const s = getSession('boot-g');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'boot-g', '[agent:from lead] review the fix', '1');
  // Draft CLOSED at the boot edge → the pre-enqueue gate passes and the producer enqueues.
  s.lastUserInputTs = 0; s.lastUserSubmitTs = 0;
  fireData('\x1b[?2004h');                     // latches _bootReadySeen, schedules the deferred drain
  // Immediately re-hold the queue's ready-gate: the deferred drain (settle 0) will
  // enqueue the producer, which then parks on this gate instead of firing.
  s._bootReadySeen = false;
  try {
    await waitFor(() => m._injectQueueFor(s).length === 1);
  } catch {
    // An empty queue does not have one cause, so the timer decides which finding
    // this is rather than the message asserting one. Three states, three
    // different readings. Do not fold `undefined` into the resource arm as
    // `t !== null`: that prints "never armed … so this box was too loaded".
    const t = s._bootDrainTimer;
    assert.fail(`the producer never reached the queue (length ${m._injectQueueFor(s).length}, expected 1): `
      + (t === null
        ? 'the deferred drain RAN and enqueued nothing — it bailed at one of its own gates, '
          + 'so the absences below would be vacuously true. A broken mechanism, not a slow box.'
        : t === undefined
          ? 'the drain was never even armed (_bootDrainTimer undefined) — the rising edge never fired. '
            + 'A broken mechanism, not a slow box.'
          : 'the deferred drain is still pending (_bootDrainTimer is a live Timeout) — it was armed '
            + 'but this box was too loaded to run it inside the poll. A RESOURCE failure, not a broken edge.'));
  }
  assert.strictEqual(m._injectQueueFor(s).length, 1,
    'the producer is enqueued and still on the queue; the two assertions below are what say it has not fired');
  assert.deepStrictEqual(writes, [], 'and nothing written yet');
  assert.ok(hasPending(PENDING_DIR, 'boot-g'), 'nothing claimed off disk while it waits');
  // Operator opens a draft in the enqueue→fire window, THEN the loop signals ready.
  s.lastUserInputTs = Date.now();               // isDraftOpen → true at fire time
  s._bootReadySeen = true;                       // release the producer (fires within a ready-poll)
  // The sentinel queues BEHIND the held producer on the serial _chain, so it can
  // only settle once the producer was released and its fire-time re-check returned
  // null. If that re-check ever regressed and claimed, the payload would land ahead
  // of the sentinel and the deepEqual below fails loudly instead of silently.
  await settleBootEdge(m, s);
  assert.deepStrictEqual(writes, ['\x15', SETTLE_SENTINEL, '\r'],
    'fire-time re-check saw the draft → claimed nothing, wrote nothing; only the later sentinel reached the pane');
  assert.ok(hasPending(PENDING_DIR, 'boot-g'), 'INVARIANT (fire-time claim path): scope NOT claimed off disk — stays recoverable');
});

// t168: the same invariant, for the two OTHER drains that reach the store. T54
// fixed only the boot edge; _flushParkedNow and _drainPendingAtIdle kept the
// eager claim (drainPending, THEN a fire-and-forget inject), so a write that
// never happened took the only copy with it. Both are ported to the fire-time
// producer here. The lever is the same one boot-g uses: hold the queue's
// readiness gate so the producer is enqueued but not yet fired, then make the
// write impossible and assert the payload is STILL ON DISK and re-drains.
//
// Asserting "the bytes arrived" would NOT test this. The pre-fix code delivers
// the bytes correctly whenever the write does happen; the defect is only visible
// on the path where it does not.

test('t168 INVARIANT: an operator FLUSH whose write never lands leaves the mail on disk and re-drainable', async () => {
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'flush-a', null);
  const s = getSession('flush-a');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'flush-a', '[agent:from lead] the only copy', '1');
  fireData('\x1b[?2004h');
  s._bootReadySeen = false;                      // hold the queue before the producer can fire
  const r = m.flushPending('flush-a');
  // The operator-facing report is synchronous and optimistic by design (the spec
  // forbids awaiting the write), so it says 1 — that is precisely why the payload
  // must survive underneath it.
  assert.deepStrictEqual(r, { ok: true, count: 1 }, 'the flush reports what it queued');
  await new Promise((r2) => setTimeout(r2, 20));
  assert.deepStrictEqual(writes, [], 'producer parked at the ready gate — nothing written');
  assert.ok(hasPending(PENDING_DIR, 'flush-a'),
    'INVARIANT: pre-fix this was already claimed off disk while the button reported success — the mail existed nowhere');
  // The seat dies before ever becoming ready: the write can now never happen.
  s._dead = true;
  s._bootReadySeen = true;
  await new Promise((r2) => setTimeout(r2, 400));
  assert.deepStrictEqual(writes, [], 'dead seat → no write');
  assert.ok(hasPending(PENDING_DIR, 'flush-a'),
    'and the mail is STILL on disk — recoverable by the next drain, not silently destroyed');
  // Re-drainable, which is the whole point of not having claimed it.
  assert.deepStrictEqual(drainPending(PENDING_DIR, 'flush-a', 'check'),
    ['[agent:from lead] the only copy'], 'the payload survives intact and re-drains');
});

test('t168 INVARIANT: an IDLE-edge drain whose write never lands leaves the mail on disk and re-drainable', async () => {
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe();
  await bashCreate(m, 'idle-a', null);
  const s = getSession('idle-a');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'idle-a', '[agent:from lead] the only copy', '1');
  fireData('\x1b[?2004h');
  s._bootReadySeen = false;                      // hold the queue before the producer fires
  s.lastUserInputTs = 0; s.lastUserSubmitTs = 0; // no draft — the pre-enqueue gate passes
  m._drainPendingAtIdle(s);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.deepStrictEqual(writes, [], 'producer parked at the ready gate — nothing written');
  assert.ok(hasPending(PENDING_DIR, 'idle-a'), 'INVARIANT: not claimed at schedule time');
  s._dead = true;
  s._bootReadySeen = true;
  await new Promise((r2) => setTimeout(r2, 400));
  assert.deepStrictEqual(writes, [], 'dead seat → no write');
  assert.ok(hasPending(PENDING_DIR, 'idle-a'), 'the mail is STILL on disk after a write that never happened');
  assert.deepStrictEqual(drainPending(PENDING_DIR, 'idle-a', 'check'),
    ['[agent:from lead] the only copy'], 'the payload survives intact and re-drains');
});

// The idle twin of boot-g: a draft opening between enqueue and fire. The parkable
// divert alone is NOT enough here — it runs AFTER the producer has claimed, so it
// re-parks a JOINED blob under a fresh seq with no resend id, and the originals
// (their ids, their separation) are gone. Nothing is lost, which is why every
// disk-presence assertion above stays green either way; what is lost is identity.
test('t168 rework: a draft opening between the idle enqueue and the fire leaves the parked entries UNTOUCHED', async () => {
  // INJECT_QUIET_MAXWAIT explicitly large, for the reason mkCompact documents about
  // INJECT_HOLD_TIMEOUT: mkOnDataProbe omits it, so the park cap armed by a divert
  // runs on setTimeout(fn, undefined) — next tick — and re-flushes the re-parked
  // blob before any assertion, turning an identity check into a write race.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe({ INJECT_QUIET_MAXWAIT: 60_000 });
  await bashCreate(m, 'idle-b', null);
  const s = getSession('idle-b');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  // seq must be the `<ts>.<counter>` form _nextParkSeq mints: parkFileHasId reads
  // the id from segment 2 of a 4-segment name, so a single-token seq hides the id.
  parkDelivery(PENDING_DIR, 'idle-b', '[agent:from lead] first', '100.1', 'pk1');
  parkDelivery(PENDING_DIR, 'idle-b', '[agent:from lead] second', '100.2', 'pk2');
  fireData('\x1b[?2004h');
  s._bootReadySeen = false;                      // hold the queue before the producer fires
  s.lastUserInputTs = 0; s.lastUserSubmitTs = 0; // no draft — the pre-enqueue gate passes
  m._drainPendingAtIdle(s);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.strictEqual(countPendingReal(PENDING_DIR, 'idle-b'), 2, 'ENTER: producer enqueued and held, nothing claimed yet');
  s.lastUserInputTs = Date.now();                // draft opens in the enqueue→fire window
  s._bootReadySeen = true;                       // release the producer
  await new Promise((r2) => setTimeout(r2, 400));
  assert.deepStrictEqual(writes, [], 'draft open at fire time → nothing spliced into it');
  assert.strictEqual(countPendingReal(PENDING_DIR, 'idle-b'), 2,
    'still TWO entries — a claim-then-divert would have re-parked them as one joined blob');
  assert.ok(parkIdInUse(PENDING_DIR, 'pk1') && parkIdInUse(PENDING_DIR, 'pk2'),
    'and their resend handles survive — the divert re-parks with no id, so a resend would resolve to nothing');
});

// The HOLD branch is the longest-lived window a producer can sit in — a compact
// or a permission dialog lasts as long as the operator does, not a poll tick —
// so it is where an eager claim costs the most. Two separate places could
// flatten a producer into text there and both leave every other test green:
// _injectText pushing produce() at ENQUEUE time, and _maybeFlushInjectQueue
// joining producers at RELEASE time. One timeline covers both because the claim
// they'd each make happens at a different instant, so the disk is asserted twice.
test('t168 INVARIANT: a producer held across a compact window claims nothing at enqueue OR at release', async () => {
  // INJECT_HOLD_TIMEOUT explicitly large: mk() omits it, so the valve armed by the
  // hold branch runs on setTimeout(fn, undefined) — next tick — and clears
  // _compactGuard before the assertions, testing a hold that never happened.
  const { m, PENDING_DIR, fireData, getSession } = mkOnDataProbe({ INJECT_HOLD_TIMEOUT: 60_000 });
  await bashCreate(m, 'hold-a', null);
  const s = getSession('hold-a');
  const writes = [];
  s.pty = { write: (b) => writes.push(b) };
  s.agentType = 'claude';
  parkDelivery(PENDING_DIR, 'hold-a', '[agent:from lead] the only copy', '1');
  fireData('\x1b[?2004h');
  s._bootReadySeen = false;                      // queue gate held for the whole test
  s.lastUserInputTs = 0; s.lastUserSubmitTs = 0; // no draft — the pre-enqueue gate passes
  s._compactGuard = true;                        // _injectHoldReason → 'compact-window'
  m._drainPendingAtIdle(s);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(s._injectQueue && s._injectQueue.length === 1, 'the drain reached the hold branch');
  assert.strictEqual(typeof s._injectQueue[0].produce, 'function',
    'held as an unclaimed ENTRY, not as text — flattening here claims now and holds the bytes in memory for the whole compact');
  assert.ok(hasPending(PENDING_DIR, 'hold-a'), 'INVARIANT: nothing claimed at enqueue time');
  // Compact ends. The release re-enqueues, and must STILL not claim: the queue's
  // own gates are downstream of this point.
  s._compactGuard = false;
  m._maybeFlushInjectQueue(s);
  assert.strictEqual(s._injectQueue.length, 0,
    'the flush actually ran — it early-returns on any hold reason, and then the disk assertion below is vacuous');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(writes, [], 'ready gate still held — nothing written');
  assert.ok(hasPending(PENDING_DIR, 'hold-a'), 'INVARIANT: nothing claimed at hold-release time either');
  // The seat dies before the queue ever writes.
  s._dead = true;
  s._bootReadySeen = true;
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual(writes, [], 'dead seat → no write');
  assert.deepStrictEqual(drainPending(PENDING_DIR, 'hold-a', 'check'),
    ['[agent:from lead] the only copy'], 'the payload survived the whole hold and re-drains');
});

// --- plugin intent verbs (plugin-plan.md [internal design doc, not in this repo] R-INT-2, rules P1/P4) ----------
//
// These exercise the DISPATCH TAIL: the switch keeps every core case verbatim
// and a registry lookup runs only for a type no core case claimed. The registry
// is module-level shared state (that is what makes a plugin verb live on all
// three feeds by construction), so every test here resets it in a finally.

const intentRegistry = require('../intent-registry');

// NOTE the promise handling: a plain try/finally would run the reset the moment
// an ASYNC fn returned its promise — i.e. at fn's first await, with the test
// body still to come — and every dispatch after that point would find an empty
// registry. (It did. One test caught it.)
// `shipped: true` (t661): these seats carry no `plugins` list, which the seat
// gate resolves on origin — registered as custom, every verb below would bounce
// before reaching the dispatch wiring this section exists to pin.
function withVerb(spec, fn) {
  intentRegistry.registerIntent(spec, spec.source || 'fake-plugin', { shipped: true });
  const reset = () => intentRegistry._resetPluginRows();
  let out;
  try { out = fn(); } catch (e) { reset(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { reset(); return v; }, (e) => { reset(); throw e; });
  reset();
  return out;
}

// A manager whose plugin-hook getter mints the same shape plugin-host-engine's
// sessionHandle does — the tail asks the HOST for the handle rather than
// building its own, so the fake has to supply one.
function mkWithPluginHost(overrides = {}) {
  const injected = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: () => ({ intents: ['branch'] }) }),
    log: (...a) => { void a; },
    getPluginHooks: () => ({
      handleFor: (name) => {
        const s = m.sessions.get(name);
        if (!s) return null;
        return Object.freeze({
          name: s.name, type: s.type, cwd: s.cwd, workspaceId: s.workspaceId,
          isAlive: () => !!m.sessions.get(name),
          inject: (text, opts = {}) => m._injectText(s, String(text), { parkable: opts.parkable !== false }),
        });
      },
    }),
    ...overrides,
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp/x' });
  return { m, injected };
}

test('plugin verb: a granted seat reaches the handler with a SessionHandle', async () => {
  const seen = [];
  await withVerb({
    verb: 'branch',
    parse: (l) => (l === '[agent:branch]' ? { type: 'branch' } : null),
    handler: (handle, intent) => { seen.push([handle, intent]); handle.inject('[agent:branch] main'); },
  }, async () => {
    const { m, injected } = mkWithPluginHost();
    await m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(seen.length, 1, 'handler ran');
    const [handle, intent] = seen[0];
    assert.strictEqual(intent.type, 'branch');
    // The OPAQUE handle, not the raw session: no pty, no _dead, no map entry.
    assert.deepStrictEqual(Object.keys(handle).sort(), ['cwd', 'inject', 'isAlive', 'name', 'type', 'workspaceId']);
    assert.strictEqual(handle.name, 'a');
    assert.strictEqual(handle.cwd, '/tmp/x');
    assert.deepStrictEqual(injected, ['[agent:branch] main'], 'reply rode handle.inject');
  });
});

test('plugin verb: P1 — an absent allowlist DENIES it, with the standard gate bounce', async () => {
  let ran = false;
  await withVerb({
    verb: 'branch',
    parse: () => null,
    handler: () => { ran = true; },
  }, async () => {
    const { m, injected } = mkWithPluginHost({
      // The "living all-enabled default": absent list. A core verb fires; a
      // plugin verb must NOT (it is privileged by construction).
      getPersistence: () => ({ list: () => [], get: () => ({ intents: null }) }),
    });
    await m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(ran, false, 'absent allowlist must not grant a plugin verb');
    assert.deepStrictEqual(injected, ['[agent:branch] the branch intent is disabled for this session']);
  });
});

test('plugin verb: an explicit grant enables it, an unrelated grant does not', async () => {
  let runs = 0;
  await withVerb({ verb: 'branch', parse: () => null, handler: () => { runs++; } }, async () => {
    const denied = mkWithPluginHost({ getPersistence: () => ({ list: () => [], get: () => ({ intents: ['dm', 'who'] }) }) });
    await denied.m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(runs, 0);
    const granted = mkWithPluginHost({ getPersistence: () => ({ list: () => [], get: () => ({ intents: ['branch'] }) }) });
    await granted.m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(runs, 1);
  });
});

test('plugin verb: a throwing handler becomes a bounce, never a crash', async () => {
  await withVerb({
    verb: 'branch',
    parse: () => null,
    handler: () => { throw new Error('detached HEAD'); },
  }, async () => {
    const { m, injected } = mkWithPluginHost();
    await m._handleIntent('a', { type: 'branch' });   // must not reject
    assert.deepStrictEqual(injected, ['[agent:branch] error: detached HEAD']);
  });
});

test('plugin verb: bash panes never reach the handler (no typing into a live shell)', async () => {
  let ran = false;
  await withVerb({ verb: 'branch', parse: () => null, handler: () => { ran = true; } }, async () => {
    const { m, injected } = mkWithPluginHost();
    m.sessions.set('sh', { name: 'sh', workspaceId: 'ws1' }); // no agentType
    await m._handleIntent('sh', { type: 'branch' });
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(injected, [], 'and nothing typed at the operator prompt');
  });
});

test('plugin verb: no plugin host (kill switch) → the tail is a clean no-op', async () => {
  let ran = false;
  await withVerb({ verb: 'branch', parse: () => null, handler: () => { ran = true; } }, async () => {
    const { m, injected } = mkWithPluginHost({ getPluginHooks: () => null });
    await m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(injected, []);
  });
});

test('plugin verb: a row with no handler is a silent no-op, not a crash', async () => {
  await withVerb({ verb: 'branch', parse: () => null }, async () => {
    const { m, injected } = mkWithPluginHost();
    await m._handleIntent('a', { type: 'branch' });
    assert.deepStrictEqual(injected, []);
  });
});

test('plugin verb: an async handler is refused (sync-only), and does not bounce', async () => {
  let ran = false;
  await withVerb({
    verb: 'branch',
    parse: () => null,
    handler: () => { ran = true; return Promise.resolve('nope'); },
  }, async () => {
    const { m, injected } = mkWithPluginHost();
    await m._handleIntent('a', { type: 'branch' });
    assert.strictEqual(ran, true, 'it still ran — the RESULT is what is ignored');
    assert.deepStrictEqual(injected, [], 'a contract violation is logged, not bounced at the agent');
  });
});

test('plugin verb: the dispatch tail cannot touch core dispatch', async () => {
  // A plugin registering something adjacent must not perturb a core verb's
  // routing — the switch claims it first and the tail never sees it.
  let ran = false;
  await withVerb({ verb: 'branch', parse: () => null, handler: () => { ran = true; } }, async () => {
    const { m, injected } = mkWithPluginHost();
    await m._handleIntent('a', { type: 'name' });
    assert.strictEqual(ran, false);
    assert.strictEqual(injected.length, 1);
    assert.match(injected[0], /^\[agent:name\]/);
  });
});

test('plugin verb: P4 — a registered verb joins the near-miss bounce list', async () => {
  await withVerb({ verb: 'branch', parse: () => null, handler: () => {} }, async () => {
    const { m, injected } = mkWithPluginHost({ getPersistence: () => ({ list: () => [], get: () => ({ intents: null }) }) });
    await m._handleIntent('a', { type: 'unknown', text: '[agent:brnch]', more: 0 });
    assert.match(injected[0], /Valid intents: dm, .*, reboot, branch, end\./,
      'plugin verbs sit after the core list and before the trailing `end`');
  });
});

test('plugin verb: body capture obeys the row bodyMode, through the real _extractIntents', () => {
  withVerb({
    verb: 'branch',
    parse: (l) => { const mm = l.match(/^\[agent:branch\]\s*(.*)/s); return mm ? { type: 'branch', body: mm[1] } : null; },
    bodyMode: () => 'greedy',
  }, () => {
    const m = mkExtract();
    const out = m._extractIntents('[agent:branch] first\nsecond line\n[agent:who]');
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].type, 'branch');
    assert.strictEqual(out[0].body, 'first\nsecond line');
    assert.strictEqual(out[1].type, 'who');
  });
  withVerb({
    verb: 'terse',
    parse: (l) => { const mm = l.match(/^\[agent:terse\]\s*(.*)/s); return mm ? { type: 'terse', body: mm[1] } : null; },
  }, () => {
    const m = mkExtract();
    const out = m._extractIntents('[agent:terse] first\nsecond line');
    assert.strictEqual(out[0].body, 'first', 'default bodyMode none: the next line is NOT swallowed');
  });
});

test('plugin verb: live on the BASH PTY feed too — but with no body (documented difference)', () => {
  // R-INT-3. The bash feed calls parseIntent DIRECTLY (deliberately not
  // fence-aware, no body capture), while jsonl/wire go through _extractIntents.
  // Because registration mutates the one list parseIntent reads, the verb is
  // live on both; the SEMANTIC difference is the missing body, and that is
  // asserted rather than papered over.
  withVerb({
    verb: 'branch',
    parse: (l) => { const mm = l.match(/^\[agent:branch\]\s*(.*)/s); return mm ? { type: 'branch', body: mm[1] } : null; },
    bodyMode: () => 'greedy',
  }, () => {
    const { parseIntent: pi } = require('../intent-scanner');
    // What the bash feed sees, line by line:
    assert.deepStrictEqual(pi('[agent:branch] first'), { type: 'branch', body: 'first' });
    assert.strictEqual(pi('second line'), null, 'the continuation line is its own (non-)intent on this feed');
    // What the jsonl feed sees for the same two lines:
    const out = mkExtract()._extractIntents('[agent:branch] first\nsecond line');
    assert.strictEqual(out[0].body, 'first\nsecond line');
  });
});

// --- t57: the EEXIST branch asks the SOCKET, not the pid ---------------------
//
// The registry records a bare pid. After an unclean shutdown the socket file
// survives and the OS recycles the pid, so `isAlive(existing.pid)` reports a
// stranger's process as our agent: the name is wedged with no in-app recovery
// (audit.md §5.1). create() now probes the socket before deciding.
//
// These drive the REAL create() registry block. A bash create cannot: agentType
// is null for type 'bash' (session-manager.js:870), so the whole `if (agentType)`
// block — the EEXIST branch included — is skipped and the test would pass
// without ever reaching the code it claims to cover. Hence a codex-typed create,
// the lighter of the two agent arms (claude's arm pulls the wire/hook/library
// stack for machinery this has nothing to do with).
// opts.wrapTransport (t58) lets one test hand create() a Transport whose bind
// fails, to reach the failure path that now exists BELOW the registry check. The
// wrapped class goes only to create(); the returned `Transport` stays the real
// one, so tests keep building genuine victim servers with it.
function mkAgentCreateProbe(opts = {}) {
  const REGISTRY_DIR = mkTmpRoot('clodex-t57-');
  const { isAlive, registry, Transport } = require('../agent-transport')
    .createAgentTransport({ REGISTRY_DIR, MAX_MSG: 65536 });
  const m = mk({
    REGISTRY_DIR, registry, isAlive,   // the real registry + transport, on a temp dir
    Transport: opts.wrapTransport ? opts.wrapTransport(Transport) : Transport,
    fs: fsReal, os: osReal, path: pathReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: require('../fs-util').ensureDir,
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {}, remove: () => {},
    }),
    pty: { spawn: () => ({ onData() {}, onExit() {}, kill() {}, pid: 4242 }) },
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    JsonlWatcher: class { start() {} stop() {} },
    // Codex-arm leaves, stubbed to their shapes — none of them is under test here.
    mergeCodexInstructions: () => ({ cleaned: [], merged: 'instructions' }),
    readAppendBodies: () => [], buildIpcPrompt: () => 'ipc', pluginGrammarLines: () => [],
    codexStatusLineArg: () => 'tui.status_line=x',
    resolveProxyAgentId: () => 'clodex-probe-x', resolveTeam: () => null,
    memoryStore: { list: () => [] }, composeDigest: () => null,
    whichBin: () => '/usr/bin/codex',
    MSG_DIR: pathReal.join(REGISTRY_DIR, 'messages'),
    // setupCodexHook's real job here is just making run/<name>/ exist before the
    // instructions file is written into it.
    setupCodexHook: (n) => require('../fs-util').ensureDir(runDirForReal(REGISTRY_DIR, n)),
    getEnvScopes: () => ({ get: () => ({}) }),
    getPluginHooks: () => ({ emit: () => {} }),
    getUserDataPath: () => REGISTRY_DIR,
    refreshAppMenu: () => {}, refreshTrayMenu: () => {},
  });
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const agentCreate = (name) => m.create(
    name, 'codex', osReal.tmpdir(), [], null, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], null,
  );
  // A created agent session owns a REAL listening net.Server. Left running it
  // holds the event loop open and `node --test` never exits — the whole file
  // then fails by hanging, which is the least diagnosable failure there is. Every
  // test using this harness must close its sessions.
  const closeAll = async () => {
    for (const s of m.sessions.values()) if (s.transport) await s.transport.stop();
  };
  return { m, REGISTRY_DIR, registry, Transport, agentCreate, closeAll };
}

// Seed a blocking agent.json whose pid is LIVE and is NOT ours, which is what an
// OS pid recycle leaves behind. isStaleRegistration says "not stale" for this, so
// the ONLY thing that can free the name is the socket probe — a test that seeds a
// dead pid, or our own pid, would ride isStaleRegistration's existing force-clean
// path and pass whether or not the probe exists.
function seedGhost(REGISTRY_DIR, name, socketPath) {
  // A live pid that is not this process: the pty stub's own pid is irrelevant, so
  // use a real child we control. pid 1 (launchd) is alive, is never us, and needs
  // no cleanup — process.kill(1, 0) succeeds for any user on macOS/Linux (EPERM,
  // which isAlive counts as alive, exactly as it does in production).
  const ghostPid = 1;
  assert.notStrictEqual(ghostPid, process.pid, 'the seeded pid must not be ours or isStaleRegistration frees the name by itself');
  assert.strictEqual(isStaleRegistration(ghostPid, process.pid, require('../agent-transport')
    .createAgentTransport({ REGISTRY_DIR, MAX_MSG: 1 }).isAlive), false,
    'the seeded registration must read NOT-stale to the pid-only check — otherwise this test never exercises the probe');
  fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, name), { recursive: true });
  fsReal.writeFileSync(pathForReal(REGISTRY_DIR, name, 'registry'),
    JSON.stringify({ name, socket: socketPath, pid: ghostPid }));
}

test('create: a pid-recycle GHOST (live foreign pid, nothing listening) self-heals and the session starts (t57)', async () => {
  const { m, REGISTRY_DIR, Transport, agentCreate, closeAll } = mkAgentCreateProbe();
  const sock = pathForReal(REGISTRY_DIR, 'ghost', 'socket');
  fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, 'ghost'), { recursive: true });
  fsReal.writeFileSync(sock, '');            // the socket file an unclean shutdown leaves
  seedGhost(REGISTRY_DIR, 'ghost', sock);

  try {
    await agentCreate('ghost');              // must NOT throw "already running elsewhere"

    assert.ok(m.sessions.has('ghost'), 'the session must start — a dead agent whose pid got recycled must not wedge its own name forever');
    const rec = JSON.parse(fsReal.readFileSync(pathForReal(REGISTRY_DIR, 'ghost', 'registry'), 'utf-8'));
    assert.strictEqual(rec.pid, process.pid, 'the ghost record must have been replaced by ours, not merely tolerated');
    // t58 (d): and the healed session must be REACHABLE, not merely recorded.
    // Before the reorder this failed: the force-clean unlinked `existing.socket`,
    // which is the same name-derived path the transport had just bound one step
    // earlier — so create() deleted its own socket and the session came up
    // listening on a detached inode. `rec.pid` alone could never see that;
    // dialing is the only assertion that can.
    assert.strictEqual(await Transport.isSocketLive(rec.socket), true,
      'the self-healed session must actually answer on its socket — a registry entry pointing at a detached inode is the silent-unreachability bug wearing a healthy record');
  } finally {
    await closeAll();
  }
});

test('create: a name whose socket is genuinely LISTENING still refuses, by message (t57)', async () => {
  const { m, REGISTRY_DIR, Transport, agentCreate, closeAll } = mkAgentCreateProbe();
  const sock = pathForReal(REGISTRY_DIR, 'busy', 'socket');
  fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, 'busy'), { recursive: true });

  const other = new Transport(sock, () => {});
  await other.start();                       // a REAL server: the name is truly taken
  try {
    seedGhost(REGISTRY_DIR, 'busy', sock);
    await assert.rejects(() => agentCreate('busy'), /already running elsewhere/,
      'a live socket means the name really is in use — the probe must not turn the honest refusal into a stomp');
    assert.ok(!m.sessions.has('busy'), 'and no session may be created behind that refusal');
    // The victim's registry ENTRY must survive: a refusal that unregistered the
    // agent it just refused to displace would hand the name over on the next try.
    const rec = JSON.parse(fsReal.readFileSync(pathForReal(REGISTRY_DIR, 'busy', 'registry'), 'utf-8'));
    assert.strictEqual(rec.pid, 1, 'the refused-against registration must be left intact, not consumed by the attempt');
    // t58 (a) — the whole ticket. `existsSync(sock)` is NOT the assertion: the
    // file can sit there while the server behind it listens on an inode that has
    // been unlinked and replaced, which is exactly the state the old ordering
    // left. Only a dial can tell those apart, so dial.
    assert.strictEqual(await Transport.isSocketLive(sock), true,
      'the refused-against agent must still ANSWER — a refusal that destroys the socket it refused to displace is the bug this ticket exists for');
  } finally {
    await closeAll();
    await other.stop();
  }
});

// --- t58: the registry decides BEFORE anything binds -------------------------

test('create: a refused create delivers to the victim it refused to displace (t58)', async () => {
  const { m, REGISTRY_DIR, Transport, agentCreate, closeAll } = mkAgentCreateProbe();
  const sock = pathForReal(REGISTRY_DIR, 'busy', 'socket');
  fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, 'busy'), { recursive: true });

  // isSocketLive proves a server ACCEPTS; it does not prove a message still
  // arrives. End-to-end delivery is what the victim actually loses when its
  // inode is detached, so pin that too, through the real send path.
  const got = [];
  const other = new Transport(sock, (msg) => { got.push(msg); });
  await other.start();
  try {
    seedGhost(REGISTRY_DIR, 'busy', sock);
    await assert.rejects(() => agentCreate('busy'), /already running elsewhere/);

    assert.strictEqual(await Transport.send(sock, { hello: 'still there' }), true,
      'a dm to the refused-against agent must still be accepted after the refusal');
    await new Promise(r => setTimeout(r, 50));   // let the server drain the frame
    assert.deepStrictEqual(got, [{ hello: 'still there' }],
      'and it must actually REACH the agent — an unlinked-inode server accepts nothing, so this is the end-to-end form of (a)');
  } finally {
    await closeAll();
    await other.stop();
  }
});

test('create: a bind that fails AFTER the registry check takes its registration back (t58)', async () => {
  // With the bind moved below the registry check, a failed bind leaves an entry
  // that outlives the failure — pointing at a socket nobody listens on, which
  // advertises a session that does not exist. create() must unregister on the
  // way out.
  let registeredAtBindTime = null;
  let REGISTRY_DIR;
  const probe = mkAgentCreateProbe({
    wrapTransport: (Real) => class extends Real {
      start() {
        // Records whether the registration already existed when the bind ran.
        // Without this the test passes VACUOUSLY under the old ordering — a bind
        // that fails before anything registers also leaves no entry, so the
        // "no entry" assertion below would hold for the bug as well as the fix.
        registeredAtBindTime = fsReal.existsSync(pathForReal(REGISTRY_DIR, 'halfway', 'registry'));
        return Promise.reject(new Error('bind refused (t58 stub)'));
      }
    },
  });
  const { m, agentCreate, closeAll } = probe;
  REGISTRY_DIR = probe.REGISTRY_DIR;
  try {
    await assert.rejects(() => agentCreate('halfway'), /bind refused/,
      'the bind failure must surface, not be swallowed');
    assert.strictEqual(registeredAtBindTime, true,
      'the bind must run AFTER the registration — if it ran first there is nothing to take back and this test proves nothing');
    assert.strictEqual(fsReal.existsSync(pathForReal(REGISTRY_DIR, 'halfway', 'registry')), false,
      'a create that registered and then failed to bind must leave NO registry entry — a record whose socket has no server is a session the whole app believes in and cannot reach');
    assert.ok(!m.sessions.has('halfway'), 'and no session record may survive the failure');
  } finally {
    await closeAll();
  }
});

// --- t59: a PROVEN-live socket outranks the pid check ------------------------
//
// isStaleRegistration fires on any record naming our own pid — the Docker
// deterministic-pid case it exists for. But two create() calls for the same name
// in ONE process also produce such a record: sessions.has(name) at the top of
// create() cannot catch the second, because the map is not written until well
// past the bind. The second create would then force-clean the first, unlinking a
// socket the probe had just proven alive.

test('create: a second concurrent create for the same name refuses instead of stomping the first (t59)', async () => {
  // The first create is parked INSIDE start(), genuinely bound and registered but
  // not yet in the sessions map — the window that sessions.has() cannot see. Only
  // the first start() is gated: under a revert the second create reaches its own
  // bind, and it must proceed and fail this test BY MESSAGE rather than hang.
  let release;
  const parked = new Promise((r) => { release = r; });
  let binds = 0;
  const verdicts = [];
  // Every transport this test's creates bind, whether or not it survives into
  // the sessions map. Under a revert BOTH creates succeed and the second
  // overwrites the first in the map, so closeAll() — which iterates the map —
  // would leave a real server listening and the file would fail by HANGING
  // instead of by message. Closing these explicitly keeps the revert diagnosable.
  const bound = [];
  const probe = mkAgentCreateProbe({
    wrapTransport: (Real) => class extends Real {
      async start() {
        const first = ++binds === 1;
        await super.start();              // a REAL bind either way
        bound.push(this);
        if (first) await parked;
      }
      // The ENTER instrumentation: what the probe actually told the decision.
      static async isSocketLive(p) {
        const v = await Real.isSocketLive(p);
        verdicts.push(v);
        return v;
      }
    },
  });
  const { m, REGISTRY_DIR, Transport, agentCreate, closeAll } = probe;

  const got = [];
  m._onIncoming = (n, msg) => { got.push([n, msg]); };

  const firstCreate = agentCreate('dup');           // parks inside start(), bound
  await new Promise(r => setTimeout(r, 60));
  try {
    await assert.rejects(() => agentCreate('dup'), /already running elsewhere/,
      'a name this process is already bound to must be refused, not force-cleaned — the own-pid clause is for a DEAD engine, and this engine is alive and listening');
    assert.strictEqual(verdicts[verdicts.length - 1], true,
      'the second create must have reached the decision with a PROVEN-live verdict — if the probe said anything else this test is not exercising the veto');

    // The first agent must still DELIVER, not merely accept (t58's lesson).
    const sock = pathForReal(REGISTRY_DIR, 'dup', 'socket');
    assert.strictEqual(await Transport.send(sock, { still: 'here' }), true,
      'the first create must still accept a dm after the second was refused');
    await new Promise(r => setTimeout(r, 50));
    assert.deepStrictEqual(got, [['dup', { still: 'here' }]],
      'and the message must REACH it — a stomped create leaves the first listening on a detached inode, which accepts nothing');
  } finally {
    release();
    await firstCreate.catch(() => {});
    await closeAll();
    for (const t of bound) await t.stop();
  }
});

test('create: the Docker own-pid force-clean still works when nothing is listening (t59)', async () => {
  // The veto must not re-wedge the case isStaleRegistration exists for. After a
  // Docker restart the surviving agent.json names the new engine's own pid, but
  // the previous engine is gone and its children never inherited the listen fd —
  // so nothing accepts and the probe cannot return true.
  //
  // Three shapes, and the third is the one that matters. isSocketLive answers
  // FALSE for a missing file, not null (ENOENT is "cannot deliver", same as
  // ECONNREFUSED), so both socket-file variants are decided by the
  // `blockerLive === false` clause and never consult the pid at all. Only a
  // record the probe could not form a verdict about — here one carrying no
  // `socket` field — reaches isStaleRegistration, which is the clause the veto
  // wraps. Without that third case this test passes with the pid check deleted
  // outright, and proves nothing about the veto.
  const cases = [
    { name: 'docker-leftover', socketFile: true, field: true, expect: false },
    { name: 'docker-clean', socketFile: false, field: true, expect: false },
    { name: 'docker-nosocketfield', socketFile: false, field: false, expect: null },
  ];
  for (const c of cases) {
    const verdicts = [];
    const probe = mkAgentCreateProbe({
      wrapTransport: (Real) => class extends Real {
        static async isSocketLive(p) {
          const v = await Real.isSocketLive(p);
          verdicts.push(v);
          return v;
        }
      },
    });
    const { m, REGISTRY_DIR, agentCreate, closeAll } = probe;
    const sock = pathForReal(REGISTRY_DIR, c.name, 'socket');
    fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, c.name), { recursive: true });
    if (c.socketFile) fsReal.writeFileSync(sock, '');
    fsReal.writeFileSync(pathForReal(REGISTRY_DIR, c.name, 'registry'),
      JSON.stringify({ name: c.name, pid: process.pid, ...(c.field ? { socket: sock } : {}) }));
    try {
      await assert.doesNotReject(() => agentCreate(c.name),
        `a restarted engine must reclaim its own name (${c.name}) — nothing is listening, so the live-socket veto must not apply and the own-pid force-clean must still fire`);
      assert.ok(m.sessions.has(c.name),
        `and the session must actually start (${c.name})`);
      // The ENTER question, asked per case rather than argued.
      const verdict = verdicts.length ? verdicts[verdicts.length - 1] : null;
      assert.strictEqual(verdict, c.expect,
        `${c.name} must reach the decision with blockerLive === ${c.expect} — otherwise it is not exercising the branch it is named for`);
    } finally {
      await closeAll();
    }
  }
});

test('create: a record replaced between probe and re-read falls back to the pid check (t59)', async () => {
  // The probe awaits, so the record it described can be gone by the time the
  // EEXIST branch re-reads. Applying the old verdict to the new record is how
  // `blockerLive === false` force-cleans a LIVE agent. The verdict must be
  // discarded when the bytes change.
  const realTransport = require('../agent-transport')
    .createAgentTransport({ REGISTRY_DIR: '/nonexistent', MAX_MSG: 65536 }).Transport;
  let REGISTRY_DIR;
  let swap = null;
  const probe = mkAgentCreateProbe({
    wrapTransport: (Real) => class extends Real {
      static async isSocketLive(p) {
        const v = await Real.isSocketLive(p);   // dials the DEAD socket → false
        if (swap) { swap(); swap = null; }      // …and the record changes underneath
        return v;
      }
    },
  });
  const { m, agentCreate, closeAll } = probe;
  REGISTRY_DIR = probe.REGISTRY_DIR;

  fsReal.mkdirSync(runDirForReal(REGISTRY_DIR, 'swapped'), { recursive: true });
  const deadSock = pathForReal(REGISTRY_DIR, 'swapped', 'socket');
  fsReal.writeFileSync(deadSock, '');                       // nothing bound: probe says false
  const regPath = pathForReal(REGISTRY_DIR, 'swapped', 'registry');
  fsReal.writeFileSync(regPath, JSON.stringify({ name: 'swapped', socket: deadSock, pid: 1 }));

  // The replacement: a genuinely listening agent, on a different socket path.
  const liveSock = pathReal.join(runDirForReal(REGISTRY_DIR, 'swapped'), 'other.sock');
  const got = [];
  const victim = new realTransport(liveSock, (msg) => { got.push(msg); });
  await victim.start();
  swap = () => fsReal.writeFileSync(regPath,
    JSON.stringify({ name: 'swapped', socket: liveSock, pid: 1 }));

  try {
    await assert.rejects(() => agentCreate('swapped'), /already running elsewhere/,
      'a verdict about bytes that are no longer there must not decide the fate of the record that replaced them — degrade to the pid check, which says this one is live and not ours');
    assert.strictEqual(await realTransport.send(liveSock, { alive: true }), true,
      'the agent that arrived during the probe must still accept a dm');
    await new Promise(r => setTimeout(r, 50));
    assert.deepStrictEqual(got, [{ alive: true }],
      'and still receive it — a stale verdict applied to a fresh record force-cleans a live agent into silence');
  } finally {
    await closeAll();
    await victim.stop();
  }
});

// ── t77: the _cleanup teardown-ordering invariant ──────────────────────────
//
// Not a bug — a correctness property held by call-site discipline alone, which a
// plausible tidy would silently break, and which nothing else tests.
//
// THE PROPERTY. `waitForSessionExit` (engine.js:1308-1314) polls
// `manager.sessions.has(name)`, so the map slot is the RESPAWN'S GO-SIGNAL: the
// instant _cleanup drops it, a queued create() for that name may start. Every
// statement that releases a resource the respawn would COLLIDE with must
// therefore run BEFORE the map drop. Grouping the map mutations upward — moving
// `sessions.delete` next to the prune calls, which reads as tidying — hands the
// go-signal out while those resources are still held. No other test fails.
//
// WHY "AFTER THE RESOURCE RELEASES" AND NOT "LAST". `sessions.delete` is NOT the
// last statement (:2404-2406 follow it) and must not be pinned as such. Those
// three trailing statements — rebuilding the live-name set, pruning the intent
// deduper and activity tracker, notifying the remote server — are IN-PROCESS
// BOOKKEEPING that no respawn touches: a new session with the same name
// re-registers itself in each of them on the way up, so racing them is harmless.
// They are excluded DELIBERATELY, not overlooked. Stated because the tempting
// tightening is to re-pin "delete is last", which was never the real property —
// it was a proxy that happened to hold while _cleanup still did an rmSync, and
// stopped holding when that rm was correctly removed (session-manager.js:1198:
// it enforced its guarantee "destructively — and wrongly, since restart routes
// through kill() too"). A pin asserting "last" would fail on correct code.
//
// Pinned STRUCTURALLY by reading source and comparing indexOf positions — the
// technique already used at plugin-host-engine.test.js:138-151 for the onExit
// landmine — because a unit test cannot execute _cleanup's PTY-driven path.
test('t77: every respawn-colliding release runs BEFORE _cleanup drops the map slot', () => {
  const fsReal2 = require('node:fs');
  const pathReal2 = require('node:path');
  const src = fsReal2.readFileSync(pathReal2.join(__dirname, '..', 'session-manager.js'), 'utf8');

  const body = src.indexOf('_cleanup(name) {');
  assert.ok(body > 0, '_cleanup(name) not found — this pin reads source and has gone stale');
  const at = (needle) => {
    const i = src.indexOf(needle, body);
    assert.ok(i > 0, `landmark not found inside _cleanup: ${needle}`);
    return i;
  };

  const mapDrop = at('this.sessions.delete(name);');
  // Each of these is a DIFFERENT collision, so each carries its own consequence.
  assert.ok(at('registry.unregister(name)') < mapDrop,
    'registry.unregister must precede the map drop: the respawn is released by the map slot, so a create() starting here finds the dead entry still present, hits EEXIST, and takes the force-clean path against what is by then a LIVE registration — t76\'s bug arriving by a second route');
  assert.ok(at('s.transport.stop()') < mapDrop,
    'transport.stop() must precede the map drop: otherwise the respawn binds its socket while the old server is still listening on that same name-derived path, and Transport.start unlinks the path before binding — the old listener survives on an unlinked inode, reachable by nobody, with no error to notice by');
  assert.ok(at('cleanupClaudeHook(name)') < mapDrop,
    'the Claude hook cleanup must precede the map drop: otherwise the successor writes its generated hook files and this teardown then deletes them, leaving a live session whose transcript symlink and hook script are gone');
  assert.ok(at('cleanupCodexHook(name, s.cwd)') < mapDrop,
    'the Codex hook cleanup must precede the map drop: same collision as the Claude path — the successor\'s generated files are removed after it wrote them');
});

// The companion to the ordering pin. The invariant above only buys anything if
// every kill-then-recreate path actually WAITS for the map slot; a fourth caller
// added without the wait re-opens the race the ordering exists to make safe.
// Grep-based because the point is to catch a call site that does not exist yet.
test('t77: every kill-then-respawn path awaits waitForSessionExit', () => {
  const fsReal2 = require('node:fs');
  const pathReal2 = require('node:path');
  const root = pathReal2.join(__dirname, '..');
  // Files that legitimately kill and then recreate. A NEW file doing so is not
  // caught here by construction — the pin's reach is these two, which is why the
  // per-file count check below matters more than the presence check.
  const files = ['engine.js', 'ipc-handlers.js'];
  let waits = 0;
  for (const f of files) {
    const src = fsReal2.readFileSync(pathReal2.join(root, f), 'utf8');
    const kills = (src.match(/await manager\.kill\(/g) || []).length;
    const w = (src.match(/await waitForSessionExit\(/g) || []).length;
    waits += w;
    assert.ok(w >= kills,
      `${f} has ${kills} \`await manager.kill(\` call(s) but only ${w} \`await waitForSessionExit(\` — a kill-then-recreate path that does not wait for the map slot will respawn while _cleanup is still releasing the registry entry, the socket and the generated hook files, and the collision surfaces as "session already exists" or a silently unreachable agent, not as a test failure`);
  }
  assert.strictEqual(waits, 2,
    `expected exactly 2 waitForSessionExit call sites (engine.js restart x2) and found ${waits} — if a third kill+create caller was added, extend the ordering pin above to cover it rather than bumping this number`);
  // session:kill's wait did not disappear, it MOVED: the handler now delegates
  // to manager.destroy, which waits on its own copy before removing the tree.
  // Without this, the count above could be satisfied by deleting the wait
  // outright — the pin would read green over exactly the race it exists to stop.
  const sm = fsReal2.readFileSync(pathReal2.join(root, 'session-manager.js'), 'utf8');
  assert.ok(/await this\._waitForExit\(name\)/.test(sm),
    'manager.destroy must await the map slot before removing the worktree — git cannot remove a checkout that is still some live process\'s cwd, and the failure is a left-behind tree, not a throw');
});

// `proxyBase` is captured when the session SPAWNS, so it outlives the pref that
// produced it: unticking traffic optimization stops wirescope but leaves every
// already-running session holding a base that still looks live. Before the
// re-resolution in `_armCtx`, hint-arm read that base, ranked, and POSTed to the
// dead port — and a REJECTED POST does not release the pre-arm's inject-queue
// hold, so deliveries to that seat stalled for the full 30s cap. The pref alone
// is not the gate either: an explicitly-routed session (`proxy` = a URL string)
// must keep its hints when the global pref is off.
test('hint arming re-resolves the proxy pref per draft, and an explicit route survives it', () => {
  // proxyBase is its OWN column, never derived from proxyRequested: deriving it
  // makes `proxyBase: null` reachable only via `proxyRequested: false`, and the
  // two rows that justify the `s.proxyBase &&` conjunct then cannot be written at
  // all — so deleting that half of the gate passes.
  const cases = [
    // [proxyRequested, proxyBase (what the spawn resolved to), pref, want, why]
    [null, 'http://127.0.0.1:7800', true, 'http://127.0.0.1:7800',
      'follows the pref, pref on'],
    [null, 'http://127.0.0.1:7800', false, null,
      'follows the pref, pref off — the captured base must not resurrect it'],
    ['http://explicit:9', 'http://explicit:9', false, 'http://explicit:9',
      'explicitly routed — the global pref does not reach it'],
    [false, null, true, null,
      'spawned with the proxy off stays off'],
    // Spawned while the pref was off, pref later turned ON. The CLI was launched
    // with no upstream override, so its traffic does not reach wirescope no matter
    // what the pref says now — a hint armed on that route could never attach.
    [null, null, true, null,
      'a session spawned unrouted cannot gain hints when the pref comes back on'],
    // Tee-blind backend: create() nulls proxyBase AFTER resolving it (a Bedrock /
    // Vertex env the proxy must not sit in front of), leaving an explicit request
    // with no base. Re-resolution alone says "routed"; only the AND says no.
    ['http://explicit:9', null, true, null,
      'tee-blind nulling at spawn survives re-resolution'],
  ];
  for (const [proxyRequested, proxyBase, proxyEnabled, want, why] of cases) {
    const m = mk({
      getUiSettings: () => ({ get: () => ({ proxyEnabled, proxyUrl: 'http://127.0.0.1:7800' }) }),
      resolveProxyBase: require('../statusline').resolveProxyBase,
    });
    const ctx = m._armCtx({ name: 'a', proxyBase, proxyRequested, proxyAgent: 'clodex-a-x' });
    assert.strictEqual(ctx.base, want,
      `${why} (requested=${JSON.stringify(proxyRequested)}, base=${JSON.stringify(proxyBase)}, pref=${proxyEnabled})`);
  }
});

// ── t188: WHICH LAYER stops a repeated exec in a replayed turn ──────────────
//
// The wire loop exempts exec from its per-turn `fired` Set (two identical
// registered-command calls in one turn are both legitimate) and the recovery
// loop does not. That asymmetry reads like drift — it was filed as a bug — but
// it is correct, and the reason lives one layer down in IntentDeduper.claim:
// claim ALLOWS wire-after-wire, so on the wire side the Set is the only
// intra-turn dedup and the exemption is load-bearing; claim REJECTS
// recovery-after-recovery unconditionally (a replay tail repeats every poll),
// so mirroring the exemption here would only hand the second exec to claim,
// which drops it anyway. Measured: with the exemption mirrored in, a replayed
// turn with two identical execs still fires ONE.
//
// TWO layers, and which one answers depends on the SHAPE of the repeat, so both
// halves are pinned here:
//   - twice inside ONE replayed callback → the recovery `fired` Set;
//   - the same exec again on a LATER poll of the tail → claim, reason
//     `recovery replay repeat`.
// Asserting the fire count alone cannot tell those apart, and they have
// different futures: deleting claim's replay-repeat rule to "make the second
// exec fire" — the change this test exists to catch — leaves the first half
// green and fails the second with a diff naming the rule that was removed.
//
// Drives the real closure rather than a lifted copy: the loop is a closure
// inside _ensureWire(), reachable only through a wire failure event, and
// extracting it would reshape production code to suit a test.
function mkRecovery() {
  const root = mkTmpRoot('clodex-t188-');
  const warns = [];
  const m = mk({
    REGISTRY_DIR: root, fs: fsReal, path: pathReal,
    getUserDataPath: () => root,
    log: { info: () => {}, warn: (_tag, msg) => warns.push(msg), error: () => {} },
    // The intent scan is the subject here, so every leaf it walks is real: a
    // stubbed parseIntent would decide the two "identical" emissions are
    // identical by fiat, which is the thing under test.
    shadowIntentKey: require('../intent-scanner').shadowIntentKey,
    parseIntent: parseIntentReal,
    looksLikeIntent: looksLikeIntentReal,
    execBodyCap: 64 * 1024,
  });
  return { m, warns };
}

test('t188: a replayed turn fires a repeated exec ONCE, and the DEDUPER is what stops the second', async () => {
  const { m, warns } = mkRecovery();
  const fired = [];
  m._handleIntent = (agent, intent) => { fired.push(`${intent.type}:${intent.cmd || intent.target}`); };
  m._broadcast = () => {};

  const wire = await m._ensureWire(); // binds an ephemeral port — torn down below
  try {
    const captured = [];
    m.sessions.set('a', {
      name: 'a', intentSource: 'wire',
      sentinel: { recovering: false, armRecovery: (cb) => captured.push(cb) },
    });
    wire.emit('tee-failure', { agent: 'a', reqId: 'r1', error: 'tee closed mid-stream' });
    // Without this the callback below is undefined and every assertion after it
    // reads an empty `fired` — the whole test would pass while reaching nothing.
    assert.strictEqual(captured.length, 1, 'ENTER: the tee-failure armed recovery and we hold the real callback');

    const emission = '[agent:exec deploy] {"env":"prod"}';

    // Half 1 — twice in ONE replayed callback: the recovery `fired` Set answers.
    captured[0](`${emission}\n${emission}`);
    // _handleIntent is dispatched through setImmediate, so asserting in this
    // tick reads [] and passes vacuously no matter what the loops did.
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(fired, ['exec:deploy'], 'the exec repeated within one replayed turn fired once');
    assert.deepStrictEqual(warns, ['intra-turn dup exec a — swallowed'],
      'the recovery Set is the layer that stopped the same-callback repeat');

    // Half 2 — the tail replayed AGAIN on a later poll: claim answers, and the
    // reason names the rule. This is the differential half.
    captured[0](emission);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(fired, ['exec:deploy'], 'the re-polled tail did not re-run the command');
    assert.ok(
      warns.includes('drop exec a: recovery replay repeat'),
      `the DEDUPER stopped the cross-callback repeat, by that rule — warns: ${JSON.stringify(warns)}`,
    );
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
  }
});

// ── t313: two bodyless siblings in ONE turn are two emissions, not a repeat ──
//
// The dedupe key short-circuited on `sub`, so `[agent:task start t210]` and
// `[agent:task start t309]` hashed the same and the per-turn `fired` Set ate
// the second — a log.warn the emitting seat never sees. Measured live on a pair
// of `task accept`s: one ticket's branch and worktree never appeared.
//
// Driven through the REAL wire handler and the REAL parser, because both halves
// of the requirement live in that loop and pull opposite ways: distinct ids must
// BOTH fire, and a genuine double-paste must still collapse to one. A key change
// that bought the first by losing the second would be worse than the bug — a
// double-pasted `task cancel` executing twice is destructive where the bug only
// drops one. The `swallowed` warn is asserted alongside the fire count because
// counts alone cannot say WHICH layer answered.

async function wireRig(text) {
  const { m, warns } = mkRecovery();
  const fired = [];
  const errors = [];
  m._handleIntent = (_agent, intent) => { fired.push(`${intent.type}:${intent.sub}:${intent.id || intent.name || ''}`); };
  m._broadcast = () => {};
  m._publishAgentText = () => {};
  m._maybeDeliverDigest = () => {};
  m._maybeRearmHold = () => {};
  m._maybeFireCompactLatch = () => {};
  const shadowLog = m._shadowLog.bind(m);
  m._shadowLog = (rec) => { if (rec.type === 'wire-observer-error') errors.push(rec.error); shadowLog(rec); };

  const wire = await m._ensureWire();
  try {
    m.sessions.set('a', { name: 'a', intentSource: 'wire', sessionId: 'sid-1' });
    wire.emit('turn.completed', { agent: 'a', text, reqId: 'r1', sessionId: 'sid-1', stop: { is_turn: true } });
    await new Promise((r) => setImmediate(r));
    // The handler body is wrapped in a try that only shadow-logs: a throw would
    // leave `fired` empty and every assertion below would read as "deduped".
    assert.deepStrictEqual(errors, [], 'ENTER: the wire handler ran to completion, so the fire counts below are real');
    return { fired, warns };
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
  }
}

test('t313: two bodyless `task start` with distinct ids both fire on the wire path', async () => {
  const { fired, warns } = await wireRig('[agent:task start t210]\n[agent:task start t309]');
  assert.deepStrictEqual(fired, ['task:start:t210', 'task:start:t309'],
    'both tickets started — the second is a distinct command, not a repeat of the first');
  assert.deepStrictEqual(warns, [], 'and nothing was swallowed as an intra-turn duplicate');
});

test('t313: two IDENTICAL bodyless intents in one turn still collapse to one', async () => {
  const { fired, warns } = await wireRig('[agent:task cancel t7]\n[agent:task cancel t7]');
  assert.deepStrictEqual(fired, ['task:cancel:t7'],
    'a double-pasted cancel must run ONCE — running it twice is the regression this guards');
  assert.deepStrictEqual(warns, ['intra-turn dup task a — swallowed'],
    'and the per-turn Set is the layer that stopped it');
});

test('t313: `team role-rm` with distinct roles both fire', async () => {
  const { fired, warns } = await wireRig('[agent:team role-rm hand]\n[agent:team role-rm designer]');
  assert.deepStrictEqual(fired, ['team:role-rm:hand', 'team:role-rm:designer']);
  assert.deepStrictEqual(warns, []);
});

// The recovery loop takes the same bkey from the same function, so the fix has
// to land there too — a wire-path-only change would leave the replayed tail
// collapsing siblings. Its dedupe is stricter (no exec exemption, and claim
// rejects recovery-after-recovery), so this asserts only the half the key
// controls: distinct ids inside ONE replayed callback both fire.
test('t313: the RECOVERY path also fires both distinct-id siblings', async () => {
  const { m, warns } = mkRecovery();
  const fired = [];
  m._handleIntent = (_agent, intent) => { fired.push(`${intent.type}:${intent.sub}:${intent.id}`); };
  m._broadcast = () => {};
  m._publishAgentText = () => {};

  const wire = await m._ensureWire();
  try {
    const captured = [];
    m.sessions.set('a', {
      name: 'a', intentSource: 'wire',
      sentinel: { recovering: false, armRecovery: (cb) => captured.push(cb) },
    });
    wire.emit('tee-failure', { agent: 'a', reqId: 'r1', error: 'tee closed mid-stream' });
    assert.strictEqual(captured.length, 1, 'ENTER: recovery armed and we hold the real replay callback');

    captured[0]('[agent:task start t210]\n[agent:task start t309]');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(fired, ['task:start:t210', 'task:start:t309'],
      'the replayed turn dispatched both tickets');
    assert.deepStrictEqual(warns, [], 'neither was swallowed as an intra-turn duplicate');
  } finally {
    await wire.close();
    if (m._holdKeeper) m._holdKeeper.stop();
  }
});

test('t313: a double-pasted dm still dedupes, and urgent still splits the identity', async () => {
  const dup = await wireRig('[agent:dm bob] ping\n[agent:dm bob] ping');
  assert.deepStrictEqual(dup.fired, ['dm:undefined:'], 'the repeated dm was sent once');
  assert.deepStrictEqual(dup.warns, ['intra-turn dup dm a — swallowed']);

  const esc = await wireRig('[agent:dm bob] ping\n[agent:dm bob urgent] ping');
  assert.deepStrictEqual(esc.fired, ['dm:undefined:', 'dm:undefined:'],
    'the urgent resend of a held dm must dispatch, not be swallowed as a duplicate');
  assert.deepStrictEqual(esc.warns, []);
});

// --- spawn into a git worktree ------------------------------------------------
// `worktree:<branch>` is what makes several seats able to edit one repo at once.
// Real git, because the payload is git's own on-disk layout: the seat must boot
// with the WORKTREE as its cwd (not the repo), and the tree must be recorded on
// the session so Delete Session… can offer to remove it.

// git runs as a child process; the spawn path is async past it, so tests wait on
// the observable effect rather than a fixed number of microtask ticks.
async function until(cond, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function mkGitRepo() {
  const root = trackTmpRoot(fsReal.realpathSync(fsReal.mkdtempSync(path.join(os.tmpdir(), 'sm-wt-'))));
  const repo = path.join(root, 'repo');
  fsReal.mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  require('node:child_process').execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'pipe', env });
  require('node:child_process').execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe', env });
  return { root, repo };
}

function mkWtManager(repo, overrides = {}) {
  const worktreeSet = [];
  const m = mk({
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    getPersistence: () => ({
      list: () => [],
      get: (n) => (n === 'child' ? null : { extraArgs: [] }),
      setWorktree: (name, wt) => worktreeSet.push({ name, wt }),
    }),
    getTemplates: () => ({ list: () => [] }),
    gitWorktree: require('../git-worktree'),
    ensureDir: () => {},
    os: require('node:os'),
    path: require('node:path'),
    log: { info: () => {}, error: () => {} },
    ...overrides,
  });
  m._injectText = (_s, msg) => { m._replies.push(msg); };
  m._replies = [];
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._worktreeSet = worktreeSet;
  return m;
}

test('spawn worktree: the seat boots IN the worktree, on its branch, recorded for cleanup', async () => {
  const { root, repo } = mkGitRepo();
  const m = mkWtManager(repo);
  let createdCwd = 'UNSET';
  m.create = async (...args) => { createdCwd = args[2]; return { name: args[0] }; };
  const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: repo };
  m.sessions.set('a', spawner);

  m._handleSpawnIntent(spawner, { name: 'child', cwd: repo, worktree: 't999' });
  // git runs in a child process, so setImmediate ticks do not cover it — poll.
  await until(() => createdCwd !== 'UNSET' || m._replies.length);

  // ENTER: the spawn must have got past worktree creation. Without this, a failed
  // create leaves createdCwd UNSET and every assertion below reads as "not the
  // repo", which is trivially true of a spawn that never happened.
  assert.notStrictEqual(createdCwd, 'UNSET',
    `ENTER: create() was never reached — replies: ${JSON.stringify(m._replies)}`);
  assert.notStrictEqual(createdCwd, repo, 'the seat must NOT boot in the shared repo');
  assert.ok(fsReal.lstatSync(path.join(createdCwd, '.git')).isFile(),
    'cwd must be a linked worktree (a .git FILE), not a fresh clone or the repo');

  // The branch is checked out in that tree, and the tree is recorded on the session.
  const head = require('node:child_process')
    .execFileSync('git', ['-C', createdCwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, 't999');
  assert.deepStrictEqual(m._worktreeSet, [{ name: 'child', wt: { path: createdCwd, branch: 't999' } }],
    'the worktree must be recorded on the session, or Delete Session… cannot remove it');

  fsReal.rmSync(root, { recursive: true, force: true });
});

test('spawn worktree: a seat in the worktree still resolves onto the repo team', async () => {
  const { root, repo } = mkGitRepo();
  const m = mkWtManager(repo);
  let createdCwd = null;
  m.create = async (...args) => { createdCwd = args[2]; return { name: args[0] }; };
  const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: repo };
  m.sessions.set('a', spawner);
  m._handleSpawnIntent(spawner, { name: 'child', cwd: repo, worktree: 't998' });
  await until(() => createdCwd !== null || m._replies.length);
  assert.ok(createdCwd && createdCwd !== repo, 'ENTER: worktree spawn must have happened');

  // The whole point of the membership change: without it the seat is invisible to
  // the roster and every ticket resolves to "no live seat".
  const { createTeamManifest } = require('../team-manifest');
  const tm = createTeamManifest({ fs: fsReal, clodexHome: path.join(root, 'home') });
  assert.ok(tm.cwdInProject(createdCwd, repo),
    'a seat in the worktree must still be a member of the repo team');

  fsReal.rmSync(root, { recursive: true, force: true });
});

test('spawn worktree: a failed create() removes the tree instead of stranding it', async () => {
  const { root, repo } = mkGitRepo();
  const m = mkWtManager(repo);
  let attempted = null;
  m.create = async (...args) => { attempted = args[2]; throw new Error('boom'); };
  const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: repo };
  m.sessions.set('a', spawner);
  m._handleSpawnIntent(spawner, { name: 'child', cwd: repo, worktree: 't997' });
  await until(() => m._replies.some((r) => /error: boom/.test(r)));

  assert.ok(attempted && attempted !== repo, 'ENTER: a worktree must have been created and handed to create()');
  assert.ok(!fsReal.existsSync(attempted),
    'the worktree must be removed when the spawn fails — nothing else can offer to');
  assert.ok(m._replies.some((r) => /error: boom/.test(r)), 'the failure is reported to the spawner');

  fsReal.rmSync(root, { recursive: true, force: true });
});

test('spawn worktree: a bare `worktree:` is refused, never a silent unisolated spawn', async () => {
  const { root, repo } = mkGitRepo();
  const m = mkWtManager(repo);
  let created = false;
  m.create = async () => { created = true; return { name: 'child' }; };
  const spawner = { name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: repo };
  m.sessions.set('a', spawner);
  // The parser yields worktree:'' for a bare `worktree:` — the isolation the
  // caller asked for must not evaporate into a normal seat.
  m._handleSpawnIntent(spawner, { name: 'child', cwd: repo, worktree: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(created, false, 'no seat may be spawned without the requested isolation');
  assert.ok(m._replies.some((r) => /worktree: needs a branch name/.test(r)));
  fsReal.rmSync(root, { recursive: true, force: true });
});

// --- branch per ticket: an opted-in role gets its own branch, worktree and seat ---
// The rung above the spawn intent: the lead writes a ticket, and the isolation is
// arranged for it. Real git, because the whole mechanism is git's linked-worktree
// on-disk shape.

function mkTicketWt(repo, roleExtra = {}, extraDeps = {}) {
  // A temp clodex HOME, not a team dir: the board resolves under it off the
  // project root, and it must be the same home the manager gets as REGISTRY_DIR.
  const home = mkTmpRoot('clodex-twt-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: repo, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead', dispatch: 'standing' },
      hand: { instantiate: 'session', brief: 'the hand', dispatch: 'worktree', ...roleExtra },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer', dispatch: 'standing' },
    },
  };
  const upserted = [];
  const removed = [];
  const worktreeSet = [];
  const stripCalls = [];
  const acCalls = [];
  // The record's worktree is read back to decide whether a tree is OCCUPIED, so
  // the stub has to carry it. A get() that returns a bare { name } makes every
  // live seat look like it is in no tree at all.
  const wtByName = new Map();
  // Every non-worktree field an upsert carried, by name. `worktree` stays in its
  // own map because setWorktree/remove already maintain it there, and two
  // writers onto one key is how the two spellings drift.
  const fieldsByName = new Map();
  const persistence = {
    // Records, not names: the reuse path SCANS this to find another record
    // naming the tree it is about to take over. An empty list makes that scan
    // vacuous and the stale-pointer bug unreachable.
    list: () => upserted.map((n) => ({ ...(fieldsByName.get(n) || {}), name: n, ...(wtByName.has(n) ? { worktree: wtByName.get(n) } : {}) })),
    get: (n) => (upserted.includes(n)
      ? { ...(fieldsByName.get(n) || {}), name: n, ...(wtByName.has(n) ? { worktree: wtByName.get(n) } : {}) }
      : (n === 'lead' ? { extraArgs: [] } : null)),
    // Dedupe: the real store keys by name, so a name pushed twice would appear
    // twice in list() and be cleared twice by the pointer scan.
    //
    // The whole ENTRY is kept, not just the name. The real store persists every
    // field it is handed, and `ephemeral: true` — stamped by _spawnTicketSeat
    // and read by accept to tell a one-shot seat from a standing one — is
    // invisible to a stub that records names alone. That gap is silent in the
    // direction that matters: the missing key reads as `undefined`, which is
    // exactly "not ephemeral", so the standing arm runs and the test sees a
    // teardown that simply did not happen.
    upsert: (e) => {
      if (!upserted.includes(e.name)) upserted.push(e.name);
      const { name, worktree, ...rest } = e;
      fieldsByName.set(e.name, { ...(fieldsByName.get(e.name) || {}), ...rest });
    },
    // Splices `upserted` as well as clearing the tree, mirroring the real store:
    // a get()/list() that keeps reporting a removed record makes the respawn path
    // (which re-enters through _mintTicketSeat's taken check) unrepresentable.
    remove: (n) => {
      removed.push(n);
      wtByName.delete(n);
      fieldsByName.delete(n);
      const i = upserted.indexOf(n);
      if (i >= 0) upserted.splice(i, 1);
    },
    // Mirrors the real store, which DELETES the key for a null worktree rather
    // than storing one — a stub that kept it would leave the cleared seat still
    // looking like the tree's holder.
    setWorktree: (name, wt) => {
      worktreeSet.push({ name, wt });
      if (wt && wt.path) wtByName.set(name, wt); else wtByName.delete(name);
    },
    // Recorders, not no-ops: the ticket path's only persistence-application
    // assertion was create()'s argv, so deleting its _applyTemplatePersistence
    // call left the suite green. Gated on `upserted` for the same reason the
    // real setters resolve by name — an unconditional recorder cannot tell a
    // call placed BEFORE create() from one placed after.
    setStripLevel: (n, l) => { if (upserted.includes(n)) stripCalls.push([n, l]); },
    setAutoCompact: (n, on) => { if (upserted.includes(n)) acCalls.push([n, on]); },
  };
  const m = mkPark({
    fs: fsReal, path: pathReal, os: osReal, countPending: countPendingReal,
    REGISTRY_DIR: home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    resolveTeam: (cwd) => (cwd && cwd.startsWith(repo) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(repo) ? repo : null),
    gitWorktree: require('../git-worktree'),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    ensureDir: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...extraDeps,
  }).m;
  const gated = [];
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); return { queued: true }; };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  const seat = (name, cwd = repo) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  // The two teardowns a ticket seat actually gets, kept apart because the
  // difference between them is load-bearing: archive KEEPS the persistence record
  // (so the derived seat name stays taken), kill drops it. A test that only ever
  // models the kill shape cannot reach the archived-seat path at all.
  // A live seat whose record names a tree this run did not mint — the shape of a
  // record written by session:markWorktree, by the spawn intent, or carried in
  // from a previous app run. The pointer scan defends against exactly these, and
  // a fixture that can only hold records it minted itself cannot represent one.
  const seatWithTree = (name, wt) => {
    const s = seat(name);
    if (!upserted.includes(name)) upserted.push(name);
    wtByName.set(name, wt);
    return s;
  };
  const archiveSeat = (name) => { m.sessions.delete(name); };
  const killSeat = (name) => {
    m.sessions.delete(name);
    const i = upserted.indexOf(name);
    if (i >= 0) upserted.splice(i, 1);
    wtByName.delete(name);
    fieldsByName.delete(name);
  };
  // The record as the CODE sees it, for tests whose subject is a field the seat
  // record carries (`ephemeral`) rather than the bare fact that a name was
  // upserted. Reading `upserted` alone cannot express those.
  const record = (n) => (upserted.includes(n)
    ? { ...(fieldsByName.get(n) || {}), name: n, ...(wtByName.has(n) ? { worktree: wtByName.get(n) } : {}) }
    : null);
  // t431: same dispatch precondition mkTasks supplies, for the same reason — these
  // specs exercise worktree minting, not artifact resolution. On the record, not
  // in the spec text, so the delivered body stays what each test wrote.
  // Opt-out: the cost ledger only runs for a ticket that HAS a task dir, so a
  // test measuring the no-git path needs a ticket without one — stamping it
  // unconditionally would drag `listWorktrees` onto a path that must not touch git.
  const wtState = { autoTaskDir: true };
  const handleTaskWt = m._handleTask.bind(m);
  m._handleTask = (session, intent) => {
    const isAdd = wtState.autoTaskDir && intent && intent.type === 'task' && intent.sub === 'add';
    const before = isAdd ? new Set(tstore.load(team.root).map((t) => t.id)) : null;
    const r = handleTaskWt(session, intent);
    if (isAdd) {
      const ts = tstore.load(team.root);
      let touched = false;
      // Only the ids this `add` INTRODUCED. Stamping every task-dir-less ticket on
      // the board would resurrect state a test deliberately built: strip `taskDir`
      // from t1, file t2, and the loop silently puts t1's back.
      // t453: stamped ALREADY-RESOLVED. The dispatch renders a `TASK DIR:` line
      // for a RELATIVE pointer, so a relative stamp would inject that line into
      // every body these tests pin byte-for-byte — for a reason unrelated to
      // what any of them is about. resolveTaskDir maps both spellings to the
      // same directory, so nothing downstream of the stamp changes.
      for (const t of ts) {
        if (!before.has(t.id) && !t.taskDir) {
          t.taskDir = pathReal.join(clodexPaths.projectDirFor(home, team.root), 'tasks', `${t.id}-fixture`, 'SPEC.md');
          touched = true;
        }
      }
      if (touched) tstore.save(team.root, ts);
    }
    return r;
  };
  return { m, team, home, tstore, seat, seatWithTree, gated, upserted, removed, worktreeSet, stripCalls, acCalls, archiveSeat, killSeat, record, persistence, wtState,
    load: () => tstore.load(team.root), one: (id) => tstore.load(team.root).find((t) => t.id === id) };
}

test('task add: a template env key outside the allowlist is dropped AND named in the ticket reply', async () => {
  // The ticket path dropped it SILENTLY while the review and spawn paths both
  // announced it — reintroducing on this path exactly the bug the allowlist's
  // own comment names. A drop the lead cannot see is only visible by reading
  // the seat's generated prompt on disk.
  const { repo } = mkGitRepo();
  const f = mkTicketWt(repo, { template: 'ht' }, {
    getTemplates: () => ({ list: () => [{
      name: 'ht', type: 'claude', cwd: repo,
      env: {
        CLODEX_DISABLE_IPC_PROMPT: '1',      // allowed
        ANTHROPIC_BASE_URL: 'http://evil',   // NOT allowed
        FORCE_PROMPT_CACHING_5M: 5,          // allowed KEY, bad value type
      },
    }] }),
  });
  // Captured here rather than through mkTicketWt, which does not surface
  // mkPark's `injected`; the reply is the whole subject of this test.
  const replies = [];
  f.m._injectText = (_s, text) => { replies.push(text); };
  let sessionEnv = 'UNSET';
  f.m.create = async (...args) => { sessionEnv = args[18]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // NOT on the reply text: the handler emits a pre-spawn "ticket t1 -> spawning"
  // line BEFORE create(), so waiting on that raced ahead of the env resolution
  // and read an UNSET capture. Wait on the spawn itself.
  await until(() => sessionEnv !== 'UNSET' || f.gated.length);

  // ENTER: a dispatch that never spawned, or one whose spawn reply never landed,
  // would make every assertion below read as a vacuous absence.
  assert.notStrictEqual(sessionEnv, 'UNSET', 'ENTER: create() must have been reached');
  // Anchored on the SUCCESS shape (`ticket t1 → team-hand-1 on branch …`), not
  // on /on branch /: the pre-spawn line is `ticket t1 → spawning team-hand-1 in
  // a worktree on branch …`, which contains that substring too. A finder that
  // matched it would make the ENTER guard below pass vacuously and the real
  // failure surface as a confusing miss on one of the env regexes instead.
  // `spawning` sits in the seat-name slot here, so ` on ` cannot follow it.
  const reply = replies.find((r) => /ticket \S+ → \S+ on /.test(r));
  assert.ok(reply, `ENTER: the spawn reply must have landed, got: ${JSON.stringify(replies)}`);

  assert.deepStrictEqual(sessionEnv, { CLODEX_DISABLE_IPC_PROMPT: '1' },
    'only the well-typed allowlisted key crosses');
  assert.match(reply, /ANTHROPIC_BASE_URL/, 'the out-of-allowlist key must be named to the lead');
  assert.match(reply, /outside the allowed set/, 'with the authority reason');
  assert.match(reply, /FORCE_PROMPT_CACHING_5M/, 'the badly-typed key must be named too');
  assert.match(reply, /allowed but their values are not strings/, 'with its OWN reason, not the authority one');
});

// t431 point (b): the refusal must land before ANYTHING is written. The
// whole-record assertions in task-start.test.js pin the BOARD, but the expensive
// half of a mis-dispatch is on disk — a branch cut, a worktree checked out, a
// persistence record upserted — and that half only exists on a worktree-dispatch
// role, which task-start's fixture does not build. So the observables that would
// catch a gate placed one line too late are asserted here, on the fixture that
// has them: a gate below the mint still refuses, still returns the right string,
// and has already cut the tree.
test('t431: a task-dir-less ticket creates no branch, no worktree and no record, through EITHER verb', async () => {
  const { repo, root } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'worktree' });
  // The fixture's convenience stamp is the whole thing under test here.
  f.wtState.autoTaskDir = false;
  let created = null;
  f.m.create = async (...args) => { created = args[0]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  const branches = () => require('node:child_process')
    .execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { stdio: 'pipe' })
    .toString().split('\n').filter(Boolean).sort();
  const branchesBefore = branches();

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'no artifact path anywhere' });
  assert.strictEqual(f.one('t1').taskDir, undefined, 'ENTER: the ticket really has no task dir');
  const before = JSON.parse(JSON.stringify(f.one('t1')));

  for (const intent of [
    { type: 'task', sub: 'start', who: null, id: 't1', body: '' },
    { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' },
  ]) {
    f.gated.length = 0;
    f.m._handleTask(f.m.sessions.get('lead'), intent);
    // The mint is async on the success path, so a gate that leaked would need
    // these turns to show its worktree. Without the wait a leak could pass.
    for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

    assert.deepStrictEqual(f.one('t1'), before, `${intent.sub}: the ticket record is exactly as it was found`);
    assert.deepStrictEqual(f.worktreeSet, [], `${intent.sub}: no worktree was recorded on any seat`);
    assert.deepStrictEqual(f.upserted, [], `${intent.sub}: no persistence record was written`);
    assert.deepStrictEqual(branches(), branchesBefore, `${intent.sub}: no branch was cut`);
    assert.strictEqual(created, null, `${intent.sub}: no seat was spawned`);
    assert.deepStrictEqual(f.gated, [], `${intent.sub}: and no spec was delivered`);
  }

  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task add: an opted-in role mints a branch, a worktree and a seat, and the ticket pins to the SEAT', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  let createdName = null;
  f.m.create = async (...args) => { createdName = args[0]; createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  // ENTER: without this every assertion below reads as "not the shared repo",
  // which is trivially true of a dispatch that never spawned anything.
  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(createdName, 'team-hand-1', 'seat name carries the ticket number');
  // The seat boots in the SHARED repo and is TOLD where its tree is. Booting it in
  // the worktree would bind its transcript, project root and team block to a
  // checkout that is removed when the ticket's session is deleted.
  assert.strictEqual(createdCwd, repo, 'the seat boots in the repo, not in the worktree');

  // The worktree still exists, on its branch, beside the repo — the seat just is
  // not living in it.
  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath && fsReal.lstatSync(pathReal.join(wtPath, '.git')).isFile(),
    'ENTER: a linked worktree (a .git FILE) must have been created, or the rest asserts nothing');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, 't1-build-the-widget', 'branch is named from the ticket id + title slug');

  // The re-pin. Left on the ROLE, _ticketAssigneeSeat would route the NEXT
  // ticket to this seat, in the wrong branch's checkout.
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'ticket pins to the SEAT, not the role');
  assert.strictEqual(t.role, 'hand', 'the originating role is preserved');
  // baseSha asserted as a SHAPE, not a value (it is the lead's HEAD, which the
  // fixture moves): a null one silently sends the close-time commit count to its
  // merge-base fallback, which answers differently on a merged branch.
  assert.deepStrictEqual(
    f.worktreeSet.map((w) => ({ ...w, wt: { ...w.wt, baseSha: typeof w.wt.baseSha } })),
    [{ name: 'team-hand-1', wt: { path: wtPath, branch: 't1-build-the-widget', baseSha: 'string' } }],
    'the worktree is recorded (with its fork point), or Delete Session… cannot remove it');
  assert.strictEqual(t.worktree.path, wtPath, 'the ticket carries the tree, so a REPLAY can re-tell a respawned seat');

  // The seat cannot find a tree it is not told about: git puts it BESIDE the repo,
  // which is nowhere the seat would look from its cwd.
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  assert.strictEqual(f.gated[0].target, 'team-hand-1');
  assert.match(f.gated[0].body, new RegExp(`WORK IN: ${wtPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'the spec must name the worktree path — the seat boots in the repo and would otherwise edit the shared tree');
  assert.match(f.gated[0].body, /branch t1-build-the-widget/, 'and its branch');
  // t353: the worktree branch of the head is the one a hand actually gets, so the
  // close verb has to survive it too — a line that rides only the plain dispatch
  // would miss every branch-per-ticket seat, which is all of them.
  assert.match(f.gated[0].body, /CLOSE WITH: \[agent:task done t1\]/,
    'the close verb rides the worktree dispatch as well as the plain one');
  assert.ok(f.gated[0].body.endsWith('build the widget\ndetail'),
    'the spec text itself still arrives, after the location line');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The role-cwd AREA line. It is ADDITIVE to `WORK IN:` and must never rewrite
// it: wt.path is the tree identity claimTree, the suite runner and the merge all
// use, so a WORK IN: naming a subdirectory would be copied straight into a git
// command that then runs in the wrong place.
test('task start: a role cwd adds an AREA line under an UNCHANGED WORK IN:, and boots the seat there', async () => {
  const { root, repo } = mkGitRepo();
  fsReal.mkdirSync(pathReal.join(repo, 'api'));
  const f = mkTicketWt(repo, { cwd: 'api' });
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  // The reattach payload feeds the sidebar row's dataset.cwd, which is what
  // "Reveal Working Directory in Finder" opens. It sent team.root while create()
  // got the role cwd — and after a restart the row is rebuilt from the
  // persistence record, so the app disagreed with itself across a restart.
  const reattached = [];
  f.m._sendToSession = (_n, ch, p) => { if (ch === 'session:context-action') reattached.push(p); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  // ENTER: a dispatch that never spawned delivers no body, and every assertion
  // below would read as a vacuous absence — including the two that ARE absences.
  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath, 'ENTER: a worktree must have been minted');

  assert.strictEqual(createdCwd, pathReal.join(repo, 'api'),
    'the seat boots in the role subdirectory of the SHARED repo, not in the worktree');
  const body = f.gated[0].body;
  assert.match(body, new RegExp(`WORK IN: ${wtPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(git worktree`),
    'WORK IN: still names the tree ROOT — every git command in the spec is relative to it');
  assert.strictEqual((body.match(/YOUR AREA in that tree:/g) || []).length, 1,
    'exactly one AREA line');
  assert.match(body, new RegExp(`YOUR AREA in that tree: ${pathReal.join(wtPath, 'api').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'the AREA line joins the role cwd onto the WORKTREE path, not onto the repo');

  // ENTER: a payload list that never got the reattach makes the cwd assertion
  // below read off `undefined?.cwd`, which is not `repo` either.
  const ra = reattached.find((p) => p && p.action === 'reattach');
  assert.ok(ra, `ENTER: the reattach payload must have been sent, got: ${JSON.stringify(reattached)}`);
  assert.strictEqual(ra.cwd, createdCwd,
    'the sidebar row is told the directory the seat actually booted in, not the team root');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The control. Without it a line emitted UNCONDITIONALLY passes the test above,
// since that one only asserts the line is present and well-formed.
test('task start: a role with NO cwd gets no AREA line at all', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  assert.match(f.gated[0].body, /WORK IN: /, 'ENTER: the worktree dispatch shape is the one under test');

  assert.strictEqual(createdCwd, repo, 'no cwd means the team root');
  assert.doesNotMatch(f.gated[0].body, /YOUR AREA/, 'no role cwd, no AREA line');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The pin on the shared-helper fix. team.json is agent-writable and the LOAD path
// is deliberately lenient, on the promise that a bad cwd is neutralized at spawn.
// This line read the raw value, so it kept telling the seat its files lived
// outside the worktree while the lead's reply said the seat was spawned at the
// root — the two messages contradicting each other, and the one the HAND reads
// pointing out of its tree.
test('task start: a hand-edited escaping cwd yields NO area line, and the lead is told why', async () => {
  const { root, repo } = mkGitRepo();
  // Not `../x`: this collapses to an escape only after normalization, so a check
  // that looks for a leading ".." on the raw string waves it through.
  const f = mkTicketWt(repo, { cwd: 'api/../../elsewhere' });
  const replies = [];
  f.m._injectText = (_s, text) => { replies.push(text); };
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  assert.match(f.gated[0].body, /WORK IN: /, 'ENTER: the worktree dispatch shape is the one under test');
  const reply = replies.find((r) => /ticket \S+ → \S+ on /.test(r));
  assert.ok(reply, `ENTER: the spawn reply must have landed, got: ${JSON.stringify(replies)}`);

  assert.strictEqual(createdCwd, repo, 'the seat falls back to the team root');
  assert.doesNotMatch(f.gated[0].body, /YOUR AREA/,
    'the AREA line must be suppressed by the SAME neutralization the spawn applied');
  assert.doesNotMatch(f.gated[0].body, /elsewhere/, 'and the bad value must not reach the seat in any form');
  assert.match(reply, /resolves outside the team root/, 'the lead is told the cwd was refused');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The lexical helper is only HALF the refusals. The resolver adds three it cannot
// make — the directory missing, a symlink realpathing out of the root, a nested
// team.json owning it — and each ends with the seat booted at the tree root. The
// AREA line read the lexical half alone, so a cwd refused for any of those three
// still got a "YOUR AREA in that tree: <wt>/<rel>" naming a directory the seat was
// never spawned in. A missing directory is the cheapest of the three to drive.
test('task start: a cwd the RESOLVER refuses (not the lexical check) yields no AREA line either', async () => {
  const { root, repo } = mkGitRepo();
  // Lexically impeccable — relative, no escape, normalizes to itself — so the
  // helper returns it as a `rel` and only the resolver's stat refuses it. A test
  // using an absolute or escaping path would pass against the OLD gate too.
  const f = mkTicketWt(repo, { cwd: 'api' });
  const replies = [];
  f.m._injectText = (_s, text) => { replies.push(text); };
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  assert.match(f.gated[0].body, /WORK IN: /, 'ENTER: the worktree dispatch shape is the one under test');
  // ENTER: the value has to survive the LEXICAL half, or this test is a duplicate
  // of the escaping-cwd one above and proves nothing about the resolver.
  assert.strictEqual(f.m._roleCwdRel(f.team.roles.hand).rel, 'api',
    'ENTER: the lexical helper must ACCEPT this cwd — the resolver is what refuses it');
  assert.ok(!fsReal.existsSync(pathReal.join(repo, 'api')),
    'ENTER: and the directory must be absent, which is the resolver-only refusal being driven');

  assert.strictEqual(createdCwd, repo, 'the seat falls back to the team root, as the resolver decided');
  assert.doesNotMatch(f.gated[0].body, /YOUR AREA/,
    'and the AREA line is gone with it — a refused cwd names no honorable area, whatever refused it');
  const reply = replies.find((r) => /ticket \S+ → \S+ on /.test(r));
  assert.ok(reply, `ENTER: the spawn reply must have landed, got: ${JSON.stringify(replies)}`);
  assert.match(reply, /does not exist under the team root/, 'the lead is still told why');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// t453. The spec's task-dir pointer is ONE string read by two resolvers that
// disagree. team-cost resolveTaskDir places a relative `tasks/<name>` under the
// project's artifact dir; a SEAT resolves the same bytes against its cwd — the
// repo — where a stale `tasks/` still exists. Observed live: t451's hand reported
// the artifact missing, worked without it, then journalled into the decoy.
// Most live taskDirs are relative, and a large share of those name a directory
// that EXISTS in the repo — which is why this fails the dangerous way: the
// seat's read lands in a real, wrong tree rather than failing loudly.
test('task dispatch: a RELATIVE task dir is rendered resolved, against the artifact dir and not the repo', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null,
    body: 'tasks/stale-trap/PRECHECK.md — build it\ndetail',
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  const body = f.gated[0].body;
  // ENTER: the pointer has to have been CAPTURED as the relative shape, or the
  // line under test is suppressed by the already-absolute arm and every
  // assertion below is about a case this test never built. The fixture stamps a
  // relative taskDir of its own when a spec carries none, so a spec whose
  // pointer failed to parse would look identical downstream.
  assert.strictEqual(f.one('t1').taskDir, 'tasks/stale-trap/PRECHECK.md',
    'ENTER: the ticket must carry the spec\'s own RELATIVE pointer');

  // The resolution the main process already performs — recomputed here from the
  // same primitive, so a change to the placement rule fails this test rather
  // than silently teaching the seat a path Clodex would not write to. The
  // file-shaped tail is dropped, as _ticketDiffDest drops it.
  const want = pathReal.join(clodexPaths.projectDirFor(f.home, repo), 'tasks', 'stale-trap');
  assert.match(body, new RegExp(`TASK DIR: ${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'the seat is handed the RESOLVED artifact dir, not left to resolve the relative form itself');
  // The decoy is the whole hazard: a `tasks/…` under the repo is a real
  // directory a hand can cd into and journal in. Asserting the absence of the
  // WRONG resolution as well as the presence of the right one, because a line
  // built by joining onto the wrong base would still match the regex above if
  // the repo happened to sit under the clodex home.
  const decoy = pathReal.join(repo, 'tasks', 'stale-trap');
  assert.ok(!body.includes(`TASK DIR: ${decoy}`),
    'and never the repo-relative resolution, which is the stale tree this exists to route around');
  assert.match(body, /relative to the PROJECT'S ARTIFACT DIR/,
    'the RULE rides with the path — a seat reading a spec Clodex did not render still has to place the next one');
  // t453 r2 nit 3: the rendered path is a DIRECTORY while the pointer usually
  // names a file inside it, and an absent directory is the t451 step exactly —
  // "the dir was not there, so I proceeded without it". Both halves are stated,
  // and both are asserted: a clause that says only one still leaves that step
  // available.
  assert.match(body, /may name a file inside it/,
    'the line says the path is the directory, not the file the pointer names');
  assert.match(body, /may not exist yet/,
    'and that its absence is not evidence there is no artifact — the t451 failure step');

  // ADDITIVE, exactly like the AREA line: the stored spec is what the lead wrote
  // and `respec` is the only thing that replaces it. Rewriting it would destroy
  // the provenance of the text under review.
  assert.strictEqual(f.one('t1').spec, 'tasks/stale-trap/PRECHECK.md — build it\ndetail',
    'the STORED spec is untouched — only the delivered body carries the resolution');
  assert.ok(body.endsWith('tasks/stale-trap/PRECHECK.md — build it\ndetail'),
    'and the spec text still arrives verbatim, after the location lines');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The control. Without it a TASK DIR line emitted unconditionally passes the
// test above. It is not only redundancy that is at stake: every dispatch already
// spills past the 500-byte threshold, so a line that tells 107 of the live
// board's seats what they already know costs each of them a Read turn.
test('task dispatch: an ALREADY-ABSOLUTE task dir gets no TASK DIR line — it means the same to both readers', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  // Under the FIXTURE's own clodex home, not a plausible-looking literal. A
  // pointer naming some other home is refused by the confinement — so a test
  // using one asserts the absence of a line that was suppressed for an entirely
  // different reason, and stays green against a build with no gate at all. Red-
  // proofed: with `~/.clodex/projects/p-1234abcd/…` this test passed while the
  // relative-only gate was removed, which is precisely the control it claims
  // to be failing to do its one job.
  const placed = pathReal.join(clodexPaths.projectDirFor(f.home, repo), 'tasks', 'already-placed', 'SPEC.md');
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null,
    body: `${placed} — build it\ndetail`,
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  // ENTER: the fixture stamps a RELATIVE taskDir onto any ticket that parsed
  // none, which is precisely the case this test must not be in. Without this the
  // absence below would be an absence over the wrong ticket shape.
  assert.strictEqual(f.one('t1').taskDir, placed,
    'ENTER: the ticket must carry the ABSOLUTE pointer, not the fixture\'s relative stamp');
  // ENTER: and that pointer must RESOLVE — this is the whole difference between a
  // control and a vacuous absence. If the confinement refuses it, the line is
  // dropped by the refusal arm and the gate under test is never consulted.
  assert.strictEqual(f.m._ticketDiffDest(f.team, f.one('t1')).ok, true,
    'ENTER: the pointer must be one the confinement ACCEPTS, or the absence below proves nothing');

  assert.doesNotMatch(f.gated[0].body, /TASK DIR: /,
    'an absolute pointer resolves the same way in the seat as in the main process — nothing to say');
  assert.match(f.gated[0].body, /WORK IN: /,
    'ENTER: the dispatch itself still rendered, so the absence above is a suppression and not a dead path');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// t453 r2 nit 1: the TILDE arm's control. Without it, deleting
// `startsWith('~')` from the gate goes green while ~100 live pointers silently
// start carrying a redundant line — the absolute control cannot catch it,
// because `path.isAbsolute('~/x')` is false.
//
// The `~` must expand to a home the confinement ACCEPTS, so `os` is overridden
// to the fixture's own clodex home. A test using the REAL home is refused by the
// confinement and its absence then comes from the refusal arm rather than the
// shape gate — vacuous in exactly the way this file's absolute control once was.
test('task dispatch: a TILDE task dir gets no TASK DIR line either — `~` is not relative', async () => {
  const { root, repo } = mkGitRepo();
  // `home` is minted inside mkTicketWt, so the override reads it back off the
  // fixture rather than assuming a path — a hardcoded one would not be the home
  // REGISTRY_DIR actually points at, and the pointer would be refused.
  let fixtureHome = null;
  const f = mkTicketWt(repo, {}, { os: { ...osReal, homedir: () => fixtureHome } });
  fixtureHome = f.home;
  const rel = pathReal.relative(f.home, pathReal.join(clodexPaths.projectDirFor(f.home, repo), 'tasks', 'tilde-placed'));
  const tilde = `~/${rel}`;
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null, body: `${tilde} — build it\ndetail`,
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery to assert on');
  // ENTER: the ticket must carry the TILDE form — the fixture stamps a resolved
  // pointer over any ticket that parsed none, which is a different shape.
  assert.strictEqual(f.one('t1').taskDir, tilde,
    'ENTER: the ticket must carry the tilde pointer');
  assert.ok(!pathReal.isAbsolute(tilde),
    'ENTER: `~/…` is NOT absolute to path.isAbsolute — which is exactly why it needs its own gate arm');
  // ENTER: and it must RESOLVE. A refused pointer drops the line for an
  // unrelated reason and the absence below would prove nothing about the gate.
  assert.strictEqual(f.m._ticketDiffDest(f.team, f.one('t1')).ok, true,
    'ENTER: the tilde pointer must be one the confinement ACCEPTS');

  assert.doesNotMatch(f.gated[0].body, /TASK DIR: /,
    'a `~`-prefixed pointer expands the same way in the seat as in the main process — nothing to say');
  assert.match(f.gated[0].body, /WORK IN: /,
    'ENTER: the dispatch itself still rendered, so the absence above is a suppression, not a dead path');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The refusal arm. `taskDir` is spec TEXT an agent wrote and extractTaskDir's
// charset admits `.` and `/`, so `tasks/../../..` parses fine and resolveTaskDir
// THROWS on it. Two things must hold: the line is dropped (naming a directory
// Clodex would itself refuse to write is worse than naming none), and the
// DISPATCH still goes out — a rendering nicety must never be able to strand a
// ticket that would otherwise have been delivered.
test('task dispatch: a task dir the confinement REFUSES drops the line and still delivers the spec', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null,
    body: 'tasks/../../../../../../etc/pwn — build it\ndetail',
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');
  assert.strictEqual(f.gated.length, 1, 'ENTER: the dispatch must still have been delivered');
  // ENTER: the escaping form has to have survived capture, and it has to be the
  // arm that THROWS rather than the one that returns null — a pointer that never
  // reached the resolver would make the absence below vacuous.
  assert.strictEqual(f.one('t1').taskDir, 'tasks/../../../../../../etc/pwn',
    'ENTER: the ticket must carry the escaping pointer');
  assert.throws(() => teamCost.resolveTaskDir({
    taskDir: 'tasks/../../../../../../etc/pwn',
    projectDir: clodexPaths.projectDirFor(f.home, repo),
    projectsRoot: pathReal.join(f.home, 'projects'),
    homedir: osReal.homedir(),
  }), 'ENTER: the confinement must REFUSE this pointer, or there is no refusal being handled');

  assert.doesNotMatch(f.gated[0].body, /TASK DIR: /,
    'a refused pointer names no directory — least of all one Clodex would not write to');
  // Scoped to the RENDERED prefix, not the whole body: the spec arrives verbatim
  // and carries the escaping string itself, so a whole-body absence would be
  // asserting the opposite of the line below and could only ever fail.
  assert.ok(f.gated[0].body.includes(f.one('t1').spec),
    'ENTER: the spec must be present in the body, or indexOf returns -1 and the slice is the whole body minus one character');
  const rendered = f.gated[0].body.slice(0, f.gated[0].body.indexOf(f.one('t1').spec));
  assert.ok(!rendered.includes('etc'),
    'nothing Clodex RENDERED mentions the escaping target — only the lead\'s own text does');
  assert.ok(f.gated[0].body.endsWith('tasks/../../../../../../etc/pwn — build it\ndetail'),
    'the spec still arrives — a rendering line must not be able to strand a dispatch');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// A REPLAY is the delivery that needs the pointer most: the incarnation that died
// is the one that may never have written an artifact, and its replacement is told
// to "check the task artifact" before it builds anything. A line that rode only
// the first dispatch would send exactly that seat looking in its cwd — which is
// how t451 happened.
test('task dispatch: the TASK DIR line rides a REPLAY too, where the artifact check is the instruction', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null,
    body: 'tasks/stale-trap/PRECHECK.md — build it\ndetail',
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);
  assert.strictEqual(f.gated.length, 1, 'ENTER: the first dispatch must have landed');
  const ticket = f.one('t1');
  assert.ok(ticket && ticket.taskDir, 'ENTER: the ticket must carry a pointer to render');

  f.gated.length = 0;
  f.m._deliverTicketSpec(f.team, ticket, ticket.spec, 'clodex-team', true, true);

  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one REPLAY delivery to assert on');
  const body = f.gated[0].body;
  assert.match(body, /REPLAY\] this ticket was already open/,
    'ENTER: the body under test must be the replay shape, not a fresh dispatch');
  const want = pathReal.join(clodexPaths.projectDirFor(f.home, repo), 'tasks', 'stale-trap');
  assert.match(body, new RegExp(`TASK DIR: ${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'the replay carries the resolved pointer — a respawned seat has no memory of it');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// Wiring, not slug rules — those are pinned in tickets-store.test.js. What this
// asserts is that the branch git actually checks out went through branchSlug:
// _mintTicketSeat carried its own inline slugger for three tickets, and the
// branches it minted embedded a task-dir path, a duplicated id, and once an id
// the board never issued.
test('task add: the minted branch carries the REAL ticket id and no id from the title', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdName = null;
  f.m.create = async (...args) => { createdName = args[0]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  // The first line a lead actually writes: an artifact link (which extractTaskDir
  // needs there) plus a guessed id (which the lead cannot know before dispatch).
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null,
    body: 't306 — tasks/t306-accept-and-retire/spec.md accept and retire\ndetail',
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdName || f.gated.length);
  assert.strictEqual(createdName, 'team-hand-1', 'ENTER: the seat must have spawned, or nothing below was reached');

  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath, 'ENTER: a worktree must have been created');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, 't1-accept-and-retire', 'the branch names the board`s id and the title`s words, nothing else');
  // Stated as absences too: the two spans that leaked into real branch names.
  assert.doesNotMatch(head, /t306/, 'the guessed id must not survive into the branch');
  assert.doesNotMatch(head, /tasks/, 'nor the task-dir path');
  // The artifact link still comes off the SAME line — the fix is in the slug,
  // not in the line, and a change that stripped the path from the spec instead
  // would pass every branch assertion above while breaking this.
  assert.strictEqual(f.one('t1').taskDir, 'tasks/t306-accept-and-retire/spec.md',
    'extractTaskDir still reads its path off that first line');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The t463 defect at the WIRING level: _mintTicketSeat slugged `ticket.title`,
// which is capped at 80 for display, so a dispatch opening with a ~67-char
// task-dir path left ~13 characters of prose and minted `t460-the`. The branch
// git checks out must come from the untruncated line.
test('task add: the minted branch is slugged from the UNTRUNCATED first line', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdName = null;
  f.m.create = async (...args) => { createdName = args[0]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  const line1 = '~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/anchor-slice-guards/ — the two-anchor slice, unguarded at four sites';
  f.m._handleTask(f.m.sessions.get('lead'), {
    type: 'task', sub: 'add', who: 'hand', id: null, body: `${line1}\ndetail`,
  });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdName || f.gated.length);
  assert.strictEqual(createdName, 'team-hand-1', 'ENTER: the seat must have spawned, or nothing below was reached');

  // ENTER: the stored title must be the TRUNCATED one, or the fixture does not
  // reproduce the defect — the whole bug is that this string was the slug input.
  const stored = f.one('t1');
  assert.ok(stored.title.endsWith('…') && stored.title.length === 78,
    `ENTER: the title must be cut at 80 for this fixture: ${stored.title}`);

  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath, 'ENTER: a worktree must have been created');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, 't1-the-two-anchor-slice-unguarded-at-four',
    'the branch carries the line\'s words, cut by branchSlug\'s own 40-char cap');
  // The pointer still comes off that same line: the fix changes what the slug
  // is handed, not the line.
  assert.strictEqual(stored.taskDir, '~/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/anchor-slice-guards/');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// t464: a ticket's branch is an identity minted ONCE. `_mintTicketSeat` re-derived
// it from the ticket's CURRENT spec on every call, and two things move that spec
// under a live ticket — the slug rule itself changed (t463), and respec/editSpec
// rewrite the text. When _existingTicketTree rejects the recorded tree, the fresh
// createWorktree took the RE-DERIVED name: a second branch off HEAD, with the
// previous seat's commits left on the old one and `worktree.branch` overwritten
// to match, so the lead's merge target and the hand's commits disagree silently.
//
// The fixture has to make the two names DIFFER (FACTS 31: a recorded branch that
// happens to equal its re-derived slug passes identically with and without the
// fix), so the spec is rewritten between the two dispatches.
test('task assign: a re-dispatch keeps the RECORDED branch, not one re-derived from the current spec', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const first = f.one('t1').worktree;
  assert.ok(first && first.path, 'ENTER: the first dispatch must have made a tree');
  assert.strictEqual(first.branch, 't1-build-the-widget', 'ENTER: the recorded branch is the one the first spec slugged to');
  // ENTER for the baseSha half below: the first dispatch must have recorded a fork
  // point, or "it survived" is vacuously true about a value that never existed.
  assert.ok(first.baseSha, 'ENTER: the first dispatch must have captured a baseSha to preserve');

  // The tree goes away the way an operator's `rm -rf` leaves it: still REGISTERED
  // and printed by `git worktree list`, flagged prunable — which is precisely what
  // _existingTicketTree rejects, dropping the re-dispatch onto the fresh-mint path
  // where the branch NAME is taken from the mint. Without this the reuse arm runs,
  // the recorded branch is carried by _existingTicketTree, and the defect is
  // unreachable no matter what the mint returns.
  fsReal.rmSync(first.path, { recursive: true, force: true });
  const listed = await require('../git-worktree').listWorktrees(repo);
  assert.ok(listed.worktrees.some((w) => w.branch === first.branch && w.prunable),
    'ENTER: git must still list the tree as prunable, or the reuse arm runs and this asserts nothing');
  f.killSeat('team-hand-1');

  // The spec is REWRITTEN, which is what _taskRespec and the viewer's editSpec do
  // to a live ticket. Line 1 now slugs somewhere else entirely.
  const tickets = f.load();
  const t0 = tickets.find((x) => x.id === 't1');
  t0.spec = 'rewrite the gadget instead\ndetail';
  t0.title = 'rewrite the gadget instead';
  f.tstore.save(f.team.root, tickets);
  // ENTER, and the whole point of the fixture: the two candidate names must
  // DIFFER. If a future change to branchSlug made them agree, this test would pass
  // with the fix reverted and prove nothing.
  const derived = `t1-${ticketsMod.branchSlug(ticketsMod.titleLine(t0.spec))}`;
  assert.notStrictEqual(derived, first.branch,
    `ENTER: the re-derived name must differ from the recorded one (${derived})`);

  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1') || f.removed.length);

  const t = f.one('t1');
  assert.ok(t.worktree && t.worktree.path, 'ENTER: a replacement tree must have been made');
  assert.strictEqual(t.worktree.branch, first.branch,
    'the ticket keeps its original branch — the identity, not a view of the current title');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', t.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, first.branch, 'and git actually checked THAT branch out, so the previous seat`s commits are still the ticket`s work');
  assert.notStrictEqual(head, derived, 'not a second branch forked off HEAD under the new title');
  // Stated on the wire too: the reply and the log name the branch the lead will
  // merge, and a mint that returned the derived name would announce that one.
  assert.ok(!f.gated.some((g) => g.body.includes(derived)), 'nor is the re-derived name announced anywhere in the dispatch');
  // The SECOND axis, independent of the branch name and broken by the same arm:
  // createWorktree resolves a fork point only for a branch it created, so reusing
  // the recorded name returns none — and the record is overwritten wholesale, so a
  // dropped baseSha is destroyed rather than absent.
  assert.ok(t.worktree.baseSha, 'the fork point survives the re-dispatch — loopEligible reads it, and without it the whole verify/review/merge loop silently never runs');
  assert.strictEqual(t.worktree.baseSha, first.baseSha, 'and it is the ORIGINAL fork point, not a new one');

  fsReal.rmSync(root, { recursive: true, force: true });
});

// The other half of the same rule: preferring the RECORDED branch must not change
// what a first dispatch mints, which is the case with nothing recorded to prefer.
test('task start: a ticket with NO recorded branch still mints from the slug', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  // ENTER: nothing recorded, or this measures the reuse arm instead of the mint.
  assert.strictEqual(f.one('t1').worktree, undefined, 'ENTER: an unstarted ticket carries no tree');

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));

  const t = f.one('t1');
  assert.ok(t.worktree && t.worktree.path, 'ENTER: the dispatch must have made a tree');
  assert.strictEqual(t.worktree.branch, 't1-build-the-widget', 'the branch is slugged from the spec exactly as before');
  const head = require('node:child_process')
    .execFileSync('git', ['-C', t.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    .toString().trim();
  assert.strictEqual(head, 't1-build-the-widget', 'and that is what git checked out');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// A spawn-mode ticket has no tree by construction: _spawnTicketSeat CLEARS any
// pointer it arrives carrying rather than reusing it. Preferring a recorded branch
// in the mint must not resurrect one here — the mint still runs (both one-shot
// modes need the seat NAME), so a recorded branch reaching the spawn arm would
// contradict the mode the same way an uncleared pointer does.
test('task assign: a spawn-mode ticket carrying a recorded branch still gets no tree', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'spawn' });
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });

  // The shape a ticket has after a worktree role dispatched it and the lead re-filed
  // it under a spawn role — the only way a spawn ticket ever carries a pointer.
  const tickets = f.load();
  const t0 = tickets.find((x) => x.id === 't1');
  t0.worktree = { path: pathReal.join(root, 'stale-tree'), branch: 't1-some-older-name' };
  f.tstore.save(f.team.root, tickets);
  assert.ok(f.one('t1').worktree.branch, 'ENTER: the ticket must carry a recorded branch, or the mint has nothing to prefer');

  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.gated.length > 0);

  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'ENTER: the spawn seat must have taken the ticket');
  assert.strictEqual(t.worktree, undefined,
    'the pointer is cleared — ABSENT, not null: every downstream reader tests `ticket.worktree && .path`');
  const gwListed = await require('../git-worktree').listWorktrees(repo);
  assert.ok(!gwListed.worktrees.some((w) => w.branch === 't1-some-older-name'),
    'and no worktree was minted on the recorded branch — spawn mode never touches git');
  const body = f.gated[0].body;
  assert.ok(!/WORK IN: /.test(body), 'the spec sends the seat to the shared checkout, with no tree pointer');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task add: a role WITHOUT the opt-in keeps the old role-assigned path', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  let created = false;
  f.m.create = async () => { created = true; return { name: 'x' }; };
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'ordinary work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(created, false, 'no seat is spawned for a role that did not opt in');
  const t = f.one('t1');
  // No worktree, but the same re-pin: the seat that got the spec is recorded, so
  // the close-time cost path reads a seat instead of inferring one.
  assert.strictEqual(t.assignee, 'team-hand', 'ticket pins to the seat that received it');
  assert.strictEqual(t.role, 'hand', 'and keeps the role the lead filed it under');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: specBody('t1', 'ordinary work') }],
    'the existing live seat receives the spec as before');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// --- t295: role tickets re-pin to the seat that receives them ---
// A ticket left on its role carries no record of WHICH seat spent, so the
// close-time cost path can only infer one. These pin the four ways that can go
// wrong: pinning to the lead, pinning to nobody, pinning so hard the ticket
// cannot move again, and leaving a stale role behind when it does.

test('task add: a role ticket with no live seat stays on the role — there is nothing to pin to', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'nobody home' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  const t = f.one('t1');
  // ENTER: the ticket must exist, or every assertion below is about undefined.
  assert.ok(t, 'ENTER: the ticket must have been filed');
  assert.strictEqual(t.assignee, 'hand', 'no live seat — the ticket stays addressable by role');
  assert.strictEqual(t.role, undefined, 'and no role field is invented for a pin that did not happen');
  assert.deepStrictEqual(f.gated, [], 'nothing was delivered');

  // The CONTROL. Without it this test is an absence that is trivially true of a
  // tree that never pins at all, so it would pass against the unfixed source and
  // certify nothing. Same team, same role — the only difference is a live seat.
  f.seat('team-hand');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'somebody home' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t2').assignee, 'team-hand',
    'the SAME role pins once a seat is live — so the un-pinned t1 above is about liveness, not about pinning being off');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The lead is excluded from cost attribution on purpose: its ledger spans every
// ticket in the project. Pinning `lead` here would read downstream as an EXACT
// seat pin and bill one ticket for the lead's entire lifetime — an honest
// "unknown" replaced by a confidently wrong number.
test('task add: a lead-held role ticket is NOT re-pinned to the lead', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'lead', id: null, body: 'my own work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket must have been filed');
  assert.strictEqual(t.assignee, 'lead', 'the lead stays role-assigned, so cost reads it as unattributable');
  assert.strictEqual(t.role, undefined, 'no pin, no role field');

  // The CONTROL: a non-lead role on the same team, with a live seat, DOES pin.
  // It is what makes the lead carve-out above a discrimination rather than an
  // absence that any never-pinning tree satisfies.
  f.seat('team-hand');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'delegated work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t2').assignee, 'team-hand',
    'a non-lead role pins — so the lead exemption above is specific to the lead');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task assign: a re-pinned ticket still moves to another seat, and back to the role', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  f.seat('lead'); f.seat('team-hand'); f.seat('team-hand-2');
  const lead = f.m.sessions.get('lead');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the work' });
  f.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  // ENTER: the pin under test must have happened, or the moves below prove nothing.
  assert.strictEqual(f.one('t1').assignee, 'team-hand', 'ENTER: the ticket must be seat-pinned first');
  assert.strictEqual(f.one('t1').role, 'hand', 'ENTER: and carry its role');

  // Move it to a DIFFERENT named seat. The role it was filed under no longer
  // describes the assignment, so it must not be left on the record.
  f.m._handleTask(lead, { type: 'task', sub: 'assign', who: 'team-hand-2', id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t1').assignee, 'team-hand-2', 'a pinned ticket can still be reassigned');
  assert.strictEqual(f.one('t1').role, undefined, 'the stale role is cleared with the pin');

  // And back to the role, which re-pins to whichever seat answers for it.
  f.m._handleTask(lead, { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t1').assignee, 'team-hand', 'assigning back to the role re-pins to a live seat');
  assert.strictEqual(f.one('t1').role, 'hand', 'and records the role it was filed under again');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The queued hand-off is a dispatch like the other two, and the only one a
// queued ticket ever gets. A ticket filed while nobody was live reaches its seat
// here or not at all.
test('advance: the queued ticket handed to a seat on close is re-pinned to it', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  f.seat('lead');
  const lead = f.m.sessions.get('lead');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'first job' });
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'second job' });
  // t308: both dispatched, since the advance now only sees started tickets. The
  // `standing` dispatch mode means neither mints a seat, so t2 stays role-assigned
  // through its start — which is exactly the precondition the ENTER below wants.
  f.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  f.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t2').assignee, 'hand', 'ENTER: t2 must still be role-assigned before the seat exists');

  f.seat('team-hand');
  f.gated.length = 0;
  f.m._handleTask(lead, { type: 'task', sub: 'done', id: 't1', body: 'done with the first' });
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

  const t2 = f.one('t2');
  assert.strictEqual(t2.assignee, 'team-hand', 'the advanced ticket pins to the seat it was handed to');
  assert.strictEqual(t2.role, 'hand', 'and keeps the role it was filed under');
  assert.deepStrictEqual(f.gated.map((g) => g.target), ['team-hand'],
    'ENTER: the advance must actually have delivered, or the pin above is unrelated to a hand-off');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task add: the ticket branch forks from the lead\'s HEAD, not the default branch', async () => {
  const { root, repo } = mkGitRepo();
  const git = (...a) => require('node:child_process')
    .execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe', env: { ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    .toString().trim();
  // HEAD ahead of the repo's default branch — the everyday state of a lead with
  // unpushed commits, which is exactly when the spec cites symbols the default
  // branch does not have yet.
  git('checkout', '-q', '-b', 'work');
  git('commit', '-q', '--allow-empty', '-m', 'unpushed');
  const headSha = git('rev-parse', 'HEAD');
  const defaultSha = git('rev-parse', 'master');
  assert.notStrictEqual(headSha, defaultSha, 'ENTER: HEAD must actually be ahead, or this asserts nothing');

  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'work on it' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);
  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: create() must have been reached');

  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath, 'ENTER: a worktree must have been created');
  const wtSha = require('node:child_process')
    .execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim();
  assert.strictEqual(wtSha, headSha,
    'the hand must get the tree the ticket was written against; forking from the default branch hands it a stale checkout and merging it back reverts the unpushed commits');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// Releasing a parked ticket is the OTHER dispatch path, and it is the documented
// one for filing work ahead of time. Without the mint here, `task add park` +
// `assign` quietly opts a role OUT of its own worktree: the hand lands in the
// shared checkout holding a spec written for an isolated tree.
test('task assign: releasing a parked ticket mints the worktree and seat too', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = 'UNSET';
  let createdName = null;
  f.m.create = async (...args) => { createdName = args[0]; createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'deferred work\ndetail' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(createdCwd, 'UNSET', 'ENTER: parking must not have spawned anything yet');

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => createdCwd !== 'UNSET' || f.gated.length);

  assert.notStrictEqual(createdCwd, 'UNSET', 'ENTER: the release must have reached create()');
  assert.strictEqual(createdName, 'team-hand-1', 'the released ticket gets its own seat');
  assert.strictEqual(createdCwd, repo, 'the seat boots in the repo, like every other ticket seat');
  const wtPath = f.worktreeSet.length ? f.worktreeSet[0].wt.path : null;
  assert.ok(wtPath && fsReal.lstatSync(pathReal.join(wtPath, '.git')).isFile(),
    'a linked worktree must exist, or the release opted the role out of its branch');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'ticket pins to the seat on release, not the role');
  assert.strictEqual(t.role, 'hand', 'the originating role is preserved');
  assert.strictEqual(t.parked, undefined, 'release unparks');
  const body = f.gated.map((g) => g.body).join('\n');
  assert.match(body, new RegExp(`WORK IN: ${wtPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'the spec must name the tree — the seat boots in the repo and would otherwise edit the shared one');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// t522: the route this team's `hand` role actually takes. `_taskAssign` has three
// delivery sites and a `worktree`/`spawn` role reaches NONE of the direct ones —
// it calls `_spawnTicketSeat`, which delivers from inside a `setImmediate` after
// `_taskAssign` has already returned. A flag that only reached the fall-through
// would be invisible on exactly this dispatch shape while its test still passed,
// so the async route is pinned separately rather than trusted to the same plumbing.
test('t522: the backlog line survives the ASYNC worktree spawn route, not just the fall-through', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  // who:null → filed with NO assignee, which is what backlog IS (it is derived,
  // not stored). The parked release case above is a different shape: it files
  // WITH a role, so `prev` is truthy there and no line is owed.
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'deferred work' });
  assert.strictEqual(f.one('t1').assignee, null, 'ENTER: backlog is the absence of an assignee — the state under test');
  f.gated.length = 0;

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.gated.length > 0);

  const body = f.gated.map((g) => g.body).join('\n');
  assert.match(body, /WORK IN: /, 'ENTER: the worktree dispatch shape is the one under test, not the standing fall-through');
  assert.ok(body.includes(BACKLOG_LINE.trimEnd()),
    'the backlog line reached the seat through the setImmediate boundary');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task assign: a ticket whose seat is still live is not given a second worktree', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let creates = 0;
  f.m.create = async (...args) => { creates += 1; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => creates > 0 || f.gated.length);
  assert.strictEqual(creates, 1, 'ENTER: the first dispatch must have spawned the seat');
  const treesAfterAdd = f.worktreeSet.length;

  // Re-assigning to the same role, with the ticket's seat still live. The seat
  // name is derived from the ticket id, so the mint refuses a name already taken.
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(creates, 1, 'no second seat for a ticket that already has one');
  assert.strictEqual(f.worktreeSet.length, treesAfterAdd, 'and no second worktree');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// Re-assigning a worktree ticket to its OWN role is the shape a lead reaches for
// to re-deliver a spec, and it is where the mint's two halves come apart: the
// re-pin is what keeps a ticket bound to the seat holding its tree, so a path
// that un-pins without minting hands the tree to whoever answers for the role.
test('task assign: re-assigning a live worktree ticket to its role keeps it on its own seat', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job two' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't2', body: '' });
  await until(() => f.m.sessions.has('team-hand-2'));
  assert.strictEqual(f.one('t2').assignee, 'team-hand-2', 'ENTER: t2 must be pinned to its own seat first');

  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't2', body: '' });
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

  const t = f.one('t2');
  assert.strictEqual(t.assignee, 'team-hand-2', 'the ticket stays pinned to the seat that holds its tree');
  assert.strictEqual(t.role, 'hand', 'and keeps its role');
  // The damage un-pinning does: _ticketAssigneeSeat resolves a role to the FIRST
  // live seat, so t2's spec — carrying t2's WORK IN: path — would be delivered to
  // t1's hand, which is mid-work in a different branch's checkout.
  assert.deepStrictEqual(f.gated.map((g) => g.target), ['team-hand-2'],
    'the spec goes to its own seat, never to another ticket\'s hand');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// A ticket seat that dies is replaceable and its tree outlives it, so re-assigning
// is the documented recovery. It must ATTACH to the existing tree: minting a
// second one fails on git's own branch-in-use guard, and that failure un-pins the
// ticket, which is the recovery leaving the ticket worse than it found it.
test('task assign: a ticket whose seat died respawns onto its EXISTING tree', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let createdCwd = null;
  f.m.create = async (...args) => { createdCwd = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;
  assert.ok(tree && tree.path, 'ENTER: the first dispatch must have made a tree to respawn onto');

  // Deleted, not archived: that is the teardown which releases the name. The
  // archived case keeps the record and is a different path (its own test below).
  f.killSeat('team-hand-1');
  createdCwd = null;
  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => createdCwd || f.removed.length);

  assert.strictEqual(createdCwd, repo, 'ENTER: a replacement seat must have been spawned');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'the replacement takes the ticket back');
  assert.deepStrictEqual(t.worktree, tree, 'on the SAME tree — its commits are the work that survived');
  assert.deepStrictEqual(f.removed, [], 'no seat name is released — nothing failed');
  const body = f.gated.map((g) => g.body).join('\n');
  assert.match(body, new RegExp(`WORK IN: ${tree.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'and it is told where that tree is — a replacement has no memory of it');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// A tree the operator deleted by hand stays REGISTERED (git flags it prunable and
// prints it in `worktree list` like any other), so the record and the listing both
// still name it. Reusing it would `cd` the hand into a directory that is gone.
test('task assign: a tree removed by hand is not reused — a fresh one is made', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const gone = f.one('t1').worktree;
  assert.ok(gone && fsReal.existsSync(gone.path), 'ENTER: the tree must exist before it is removed');

  // Removed the way an operator would, leaving git's admin entry behind.
  fsReal.rmSync(gone.path, { recursive: true, force: true });
  const listed = await require('../git-worktree').listWorktrees(repo);
  assert.ok(listed.worktrees.some((w) => w.branch === gone.branch && w.prunable),
    'ENTER: git must still LIST the removed tree, or this asserts nothing');

  f.killSeat('team-hand-1');
  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1') || f.removed.length);

  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'the replacement still takes the ticket');
  assert.ok(fsReal.existsSync(t.worktree.path), 'the tree it is pointed at must actually exist');
  const body = f.gated.map((g) => g.body).join('\n');
  assert.match(body, new RegExp(`WORK IN: ${t.worktree.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `),
    'and that is the path it is told to cd into');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// An ARCHIVED seat keeps its record, so the derived name stays taken while no
// session answers for it. Reusing the live-seat branch here dead-ends: the spec
// goes to a seat that cannot receive it, and every retry re-enters the same
// branch. The recovery has to be named, because nothing will spawn on its own.
test('task assign: a ticket whose seat is ARCHIVED reports the recovery, and stays pinned', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));

  f.archiveSeat('team-hand-1');   // session gone, record KEPT
  assert.ok(f.upserted.includes('team-hand-1'), 'ENTER: the archived record must survive, or this is the kill path');
  said.length = 0;
  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));

  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'stays pinned — un-pinning would misroute its tree to another hand');
  assert.deepStrictEqual(f.gated, [], 'nothing is delivered — no seat can receive it');
  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  assert.match(said[0], /archived/, 'the reply must say WHY nothing happened');
  assert.match(said[0], /unarchive|Delete Session/,
    'and name the recovery — "wait for it to spawn" is a lie, nothing will');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// Two worktree-enabled roles is a supported team.json shape, and moving a ticket
// between them is the one case where the derived seat name CHANGES while the tree
// does not. git's own "branch already used by worktree" refusal used to catch
// this; reuse removed that guard, so the occupancy check has to be explicit.
test('task assign: a tree still held by a live seat is never handed to a second one', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  const cwds = {};
  f.m.create = async (...args) => { cwds[args[0]] = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;

  said.length = 0;
  f.gated.length = 0;   // drop the spawn-time spec delivery; this asserts on the ASSIGN
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.ok(f.m.sessions.has('team-hand-1'), 'ENTER: the holder must still be live, or nothing is contended');
  assert.ok(!cwds['team-builder-1'],
    'no second seat may be spawned into a tree another seat is working in');
  assert.strictEqual(f.one('t1').assignee, 'team-hand-1', 'the ticket stays with the seat holding its tree');
  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  // Not just the NAME: the taken-but-not-live reply also carries it, so a bare
  // name match cannot tell the occupancy refusal from the archived-seat one.
  assert.match(said[0], /is held by/, 'the OCCUPANCY refusal, not the archived-seat reply');
  assert.match(said[0], /team-hand-1/, 'and it names who holds the tree');
  assert.deepStrictEqual(f.worktreeSet.map((w) => w.name), ['team-hand-1'],
    'and no second tree is recorded either');
  // The reply claims "Nothing was changed", so the holder must not have been told
  // its ticket moved. A refusal that fires after the notice leaves a seat standing
  // down on a ticket that is still its own, and nothing ever un-tells it.
  assert.deepStrictEqual(f.gated, [], 'no notice reaches the holder — the ticket did not move');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// "Nothing was changed" has to be true of the RECORD too. Every field _taskAssign
// writes sits above the refusal, so a refusal placed after them unparks a parked
// ticket back into advance, replay, the badge and the watchdog, and pushes
// lastActivityAt forward — deferring the one nudge a stalled ticket gets, once per
// retry.
test('task assign: a refused move leaves a PARKED ticket parked, and its stall clock alone', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'park', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').parked, true, 'ENTER: the ticket must really be parked, or the unpark cannot be observed');
  const before = f.one('t1').lastActivityAt;

  said.length = 0; f.gated.length = 0;
  await new Promise((r) => setTimeout(r, 5));   // so an unwanted stamp differs from `before`
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  assert.match(said[0], /Nothing was changed/, 'ENTER: this must be the refusal, not a successful move');
  const t = f.one('t1');
  assert.strictEqual(t.parked, true, 'still parked — the refusal must not dispatch it as a side effect');
  assert.strictEqual(t.lastActivityAt, before, 'and its stall clock is untouched, or retries defer the watchdog forever');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The occupancy gate keys off the TICKET's tree, not the destination's role: a
// destination with no worktree of its own still receives this ticket's WORK IN:
// line. A gate that only covered worktree-role destinations left every plain role,
// name-addressed seat, subagent role, lead and reviewer as a way in.
test('task assign: a NON-worktree destination is refused too while the tree is held', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.other = { instantiate: 'session', brief: 'the other', dispatch: 'standing' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  f.seat('team-other-9');   // a live seat filling the non-worktree role

  said.length = 0; f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'other', id: 't1', body: '' });
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.ok(f.m.sessions.has('team-hand-1'), 'ENTER: the holder must still be live, or nothing is contended');
  assert.strictEqual(f.one('t1').assignee, 'team-hand-1', 'the ticket stays with the seat holding its tree');
  assert.deepStrictEqual(f.gated, [], 'nothing is delivered — least of all the WORK IN: line of an occupied tree');
  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  // Not just the NAME: the taken-but-not-live reply also carries it, so a bare
  // name match cannot tell the occupancy refusal from the archived-seat one.
  assert.match(said[0], /is held by/, 'the OCCUPANCY refusal, not the archived-seat reply');
  assert.match(said[0], /team-hand-1/, 'and it names who holds the tree');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// session:kill reads the tree off whichever RECORD it is deleting, so two records
// naming one path means deleting either one removes the tree from under the seat
// living in it. The delete handler has no way to detect that.
test('task assign: reusing a tree moves the record pointer off the previous seat', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;

  f.archiveSeat('team-hand-1');   // record KEPT, still naming the tree
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-builder-1'));
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.one('t1').worktree.path, tree.path, 'ENTER: the tree must have been REUSED, or there is no second pointer');
  const holders = f.worktreeSet.filter((w) => w.wt && w.wt.path === tree.path).map((w) => w.name);
  const cleared = f.worktreeSet.filter((w) => !w.wt).map((w) => w.name);
  assert.ok(holders.includes('team-builder-1'), 'the new seat records the tree');
  assert.ok(cleared.includes('team-hand-1'),
    'and the archived seat\'s pointer is CLEARED — Delete Session… on it would otherwise force-remove a live seat\'s tree');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The failure path un-pins, and with reuse the ticket already carries a live
// WORK IN: pointer by then. A role-assigned ticket is matched to EVERY seat
// filling that role, so un-pinning would replay this ticket's tree into an
// unrelated hand — the exact harm the pinning exists to prevent.
test('task assign: a failed respawn onto a reused tree leaves the ticket pinned', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let n = 0;
  f.m.create = async (...args) => {
    n += 1;
    if (n === 2) throw new Error('boom');
    f.seat(args[0], args[2]);
    return { name: args[0] };
  };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;
  f.killSeat('team-hand-1');

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => n >= 2 && f.removed.includes('team-hand-1'));

  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'stays pinned: a pinned-but-dead assignee is inert, a role-assigned one misroutes');
  assert.deepStrictEqual(t.worktree, tree, 'the reused tree is untouched — it holds the previous seat\'s commits');
  assert.ok(fsReal.existsSync(tree.path), 'and it is still on disk, not rolled back by a spawn that did not create it');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The stale-pointer harm does not need REUSE. Delete the directory by hand and
// createWorktree prunes the dead entry, then recomputes the same default path —
// which is free again — so a FRESH tree lands exactly where the archived seat's
// record still points. Two records, one path, and Delete Session… on either
// removes the live seat's checkout.
test('task assign: a fresh tree on a recycled path also moves the record pointer', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;

  f.archiveSeat('team-hand-1');                                // record KEPT, still naming the tree
  fsReal.rmSync(tree.path, { recursive: true, force: true });   // the operator deletes the DIRECTORY

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-builder-1'));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  // ENTER: the whole point is that the NEW tree reoccupies the OLD path. Without
  // that there is only one record naming it and nothing below is contended.
  assert.strictEqual(f.one('t1').worktree.path, tree.path,
    'ENTER: the fresh tree must land on the recycled path, or there is no second pointer');
  const cleared = f.worktreeSet.filter((w) => !w.wt).map((w) => w.name);
  assert.ok(f.worktreeSet.some((w) => w.name === 'team-builder-1' && w.wt && w.wt.path === tree.path),
    'the new seat records the tree');
  assert.ok(cleared.includes('team-hand-1'),
    'and the archived seat\'s pointer is CLEARED even though nothing was reused');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// create() succeeding and a LATER step throwing is the window the liveness gate
// was added for: the tree is deliberately kept because a live seat is in it. The
// un-pin has to respect that too, or the ticket goes back to the role while its
// worktree names an occupied tree — and _openTicketsFor matches a role-assigned
// ticket to every seat filling that role.
test('task add: a seat that spawned then failed keeps its pin, its tree and its record', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  // Seats FIRST, then throws — every other stub in this file either seats and
  // returns or throws before seating, so this window has no other coverage.
  f.m.create = async (...args) => { f.seat(args[0], args[2]); throw new Error('boom'); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  const t = f.one('t1');
  assert.ok(f.m.sessions.has('team-hand-1'), 'ENTER: the seat must be LIVE, or the liveness gate is not what is under test');
  assert.ok(t.worktree && t.worktree.path, 'ENTER: the ticket must still carry a tree, or un-pinning it would be harmless');
  assert.strictEqual(t.assignee, 'team-hand-1',
    'stays pinned to the seat: role-assigned with a live tree replays this ticket into every other hand');
  assert.ok(fsReal.existsSync(t.worktree.path), 'the tree is kept — a live seat is sitting in it');
  assert.ok(!f.removed.includes('team-hand-1'), 'and its record is kept for the same reason');
  // The kept record has to NAME the kept tree. _ticketTreeHolder reads occupancy
  // off the record, so a live seat whose record has no worktree is invisible to
  // it; session:kill also reads entry.worktree to remove the tree, and without it
  // the checkout is orphaned when the session is deleted.
  assert.ok(f.worktreeSet.some((w) => w.name === 'team-hand-1' && w.wt && w.wt.path === t.worktree.path),
    'the kept tree is RECORDED on the kept record, or nothing can see the seat is in it');
  assert.strictEqual(f.m._ticketTreeHolder(t.worktree.path), 'team-hand-1',
    'and the occupancy gate resolves it — this is what a second spawn is refused on');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// Recording the tree on the seated-then-threw record is only half of it. On the
// REUSE path the tree already has a record naming it, so writing this seat's
// pointer without clearing that one leaves TWO records on one tree — and
// session:kill removes the tree named by whichever row is deleted, so Delete
// Session… on the stale row destroys the live seat's checkout. The scan lives in
// the try, which this path skips by definition, so it has to run in the catch too.
test('task assign: a seat that spawned then failed onto a REUSED tree takes the pointer with it', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;
  // Archived, not killed: the record is KEPT and still names the tree, which is
  // what makes a second pointer a collision rather than a fresh write.
  f.archiveSeat('team-hand-1');

  // ENTER: the whole test is "two records named one tree". If the archived record
  // ever stopped naming it, `naming` would be ['team-builder-1'] and every
  // assertion below would pass without a collision ever existing.
  assert.ok(f.worktreeSet.some((w) => w.name === 'team-hand-1' && w.wt && w.wt.path === tree.path),
    'ENTER: the archived record must still NAME the tree, or there is no collision to detect');

  const replies = [];
  f.m._injectText = (t, msg) => { replies.push(msg); return { queued: true }; };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); throw new Error('boom'); };
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  // The spawn is fire-and-forget; a fixed tick count can sample BEFORE the catch
  // runs and read a clean state that is only clean because nothing happened yet.
  await until(() => replies.some((r) => /failed to spawn/.test(r)));

  assert.ok(f.m.sessions.has('team-builder-1'), 'ENTER: the seat must be LIVE, or the catch takes its !live arm');
  assert.ok(replies.some((r) => /failed to spawn/.test(r)), 'ENTER: and the spawn must have actually failed');
  const holder = f.m._ticketTreeHolder(tree.path);
  assert.strictEqual(holder, 'team-builder-1', 'the live seat holds the tree');
  // The point of the test: exactly ONE record may name it.
  const naming = f.upserted.filter((n) => {
    const w = f.worktreeSet.filter((x) => x.name === n).pop();
    return w && w.wt && w.wt.path === tree.path;
  });
  assert.deepStrictEqual(naming, ['team-builder-1'],
    'and it is the ONLY record naming it — a second row lets Delete Session… remove the tree under the live seat');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// ── task start: the worktree arm's two refusals ────────────────────────────
// Every other _taskStart test runs on the non-worktree fixture, so both of these
// refusals — the ones guarding the collision this whole field exists to prevent
// — were reachable only through `assign` in the suite. Same hazard, same guards,
// but `start` is now the verb a lead reaches for, so it needs its own pins.

test('task start: a tree still held by a live seat is refused, and nothing is changed', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;
  assert.ok(tree && tree.path, 'ENTER: the worktree arm really ran — on the standing fixture there would be no tree to contend');

  // The contended shape: the ticket's own seat is GONE (killed, so its name is
  // free again and a fresh mint would succeed), but another live seat has since
  // been pointed at the tree the ticket still names. A start that trusted the
  // free name would spawn a second agent into an occupied checkout, which is the
  // collision the whole worktree mechanism exists to prevent.
  // It has to be a DIFFERENT seat: when the ticket's own live seat holds the
  // tree, "already started" is the correct diagnosis, not occupancy.
  f.killSeat('team-hand-1');
  f.seatWithTree('team-other-9', tree);
  assert.strictEqual(f.m._ticketTreeHolder(tree.path), 'team-other-9',
    'ENTER: a live seat that is NOT the ticket`s own holds the tree');
  assert.ok(!f.m.sessions.has('team-hand-1') && !f.upserted.includes('team-hand-1'),
    'ENTER: and the ticket`s own seat name is free, so nothing but the occupancy guard can refuse this');

  said.length = 0; f.gated.length = 0;
  const before = JSON.stringify(f.one('t1'));
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  // Not just the NAME: the taken-but-not-live reply carries it too, so a bare
  // name match cannot tell the occupancy refusal from the archived-seat one.
  assert.match(said[0], /is held by/, 'the OCCUPANCY refusal, not the archived-seat reply');
  assert.match(said[0], /team-other-9/, 'and it names who holds the tree — the lead cannot clear it without knowing');
  assert.deepStrictEqual(f.gated, [],
    'nothing is delivered — least of all the WORK IN: line of a tree another seat is committing in');
  assert.strictEqual(JSON.stringify(f.one('t1')), before,
    'and the record is byte-identical: the refusal sits above every field start writes, so "Nothing was changed" is true of the board too');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The seat name is derived from the ticket id, so a record under it that OUTLIVED
// its session means this ticket already has a seat. Nothing here can fix it:
// _spawnTicketSeat calls create() directly, bypassing the nameConflict front door,
// so respawning would overwrite the record and split one name across two rows.
test('task start: a taken-but-dead seat name is refused with the recovery named, not respawned', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  // Archived, not killed: archive KEEPS the persistence record, which is what
  // holds the derived name while nothing answers for it. A kill would free the
  // name and this path would be unreachable.
  f.archiveSeat('team-hand-1');
  const all = f.tstore.load(f.team.root);
  all.find((t) => t.id === 't1').startedAt = null;
  f.tstore.save(f.team.root, all);
  assert.ok(!f.m.sessions.has('team-hand-1'), 'ENTER: the seat is not live');
  assert.ok(f.upserted.includes('team-hand-1'), 'ENTER: but its RECORD survives, which is what keeps the name taken');

  said.length = 0; f.gated.length = 0;
  const createdBefore = f.upserted.slice();
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  assert.match(said[0], /archived or dead/, 'the taken-but-dead reply, not the occupancy one');
  // The recovery has to be USABLE: no amount of re-starting reaches one, so the
  // reply names the two exits that do.
  assert.match(said[0], /Unarchive it/, 'and names unarchiving, which replays the spec on resume');
  assert.match(said[0], /Delete Session/, 'and the destructive alternative');
  assert.match(said[0], /UNCOMMITTED/,
    'with the data loss spelled out — a lead choosing Delete Session… on this advice destroys the seat`s uncommitted work');
  assert.deepStrictEqual(f.upserted, createdBefore, 'no second record is minted over the surviving one');
  assert.deepStrictEqual(f.gated, [], 'and nothing is delivered to a name nothing answers for');
  assert.ok(!f.m.sessions.has('team-hand-1'), 'no seat was respawned');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The createWorktree-failure exit is the catch's sibling and needs the same
// invariant. Reaching it means the RECORDED tree was rejected (locked, or held)
// and the fresh one failed too — so the ticket still names a real tree, and
// un-pinning it hands that tree's WORK IN: line to every seat filling the role.
test('task assign: a failed worktree leaves a ticket that still names a tree pinned', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;
  f.archiveSeat('team-hand-1');

  // The recorded tree is rejected (git reports it locked), and the replacement
  // cannot be made either — git refuses the branch, already checked out at `tree`.
  f.m._existingTicketTree = async () => null;
  const gw = require('../git-worktree');
  const orig = gw.createWorktree;
  gw.createWorktree = async () => ({ ok: false, error: 'already checked out' });
  try {
    f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  } finally { gw.createWorktree = orig; }

  const t = f.one('t1');
  // ENTER: without a surviving tree pointer the un-pin would be harmless and this
  // asserts nothing.
  assert.ok(t.worktree && t.worktree.path === tree.path,
    'ENTER: the ticket must still name the tree nothing cleared');
  // Exact, not "not the role": a wrong third value would satisfy notStrictEqual
  // against both role names and leave the ticket just as misrouted.
  assert.strictEqual(t.assignee, 'team-builder-1',
    'stays pinned to the seat — role-assigned, its tree replays into every seat filling the role');
  // The pin is kept BECAUSE a dead assignee is inert and the next assign recovers.
  // That justification only holds if the name was actually released.
  assert.ok(f.removed.includes('team-builder-1'), 'and the reserved seat name is released, so a re-assign re-mints it');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The pointer scan compares canonically. Every path in the other tests is minted
// by createWorktree itself, so a raw === would pass them identically and the
// realpathSync would be untested — a record written through another route can
// name the same tree through a symlinked prefix.
test('task assign: a record naming the tree through a symlink is cleared too', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.builder = { instantiate: 'session', brief: 'the builder', dispatch: 'worktree' };
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  const tree = f.one('t1').worktree;

  // A second record naming the SAME tree through a symlinked parent — the shape a
  // record written by session:markWorktree or carried across a restart can take.
  // The link points at its own ancestor, which is a cycle on purpose — it is the
  // cheapest way to get a second spelling of `tree.path`. rmSync does not follow
  // symlinks, so the teardown below does not walk it; leave it alone.
  const link = pathReal.join(root, 'link-to-repo-parent');
  fsReal.symlinkSync(pathReal.dirname(tree.path), link);
  const aliased = pathReal.join(link, pathReal.basename(tree.path));
  assert.notStrictEqual(aliased, tree.path, 'ENTER: the alias must differ as a STRING, or nothing distinguishes the compares');
  assert.strictEqual(fsReal.realpathSync(aliased), fsReal.realpathSync(tree.path),
    'ENTER: and must resolve to the same tree, or it is not an alias at all');
  // Recorded but NOT live: a live holder would make _ticketTreeHolder refuse the
  // reuse outright, and the scan under test would never be reached.
  f.seatWithTree('ghost', { path: aliased, branch: tree.branch });
  f.archiveSeat('ghost');

  f.archiveSeat('team-hand-1');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'builder', id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-builder-1'));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  const cleared = f.worktreeSet.filter((w) => !w.wt).map((w) => w.name);
  assert.ok(cleared.includes('ghost'),
    'the aliased pointer is cleared — a raw string compare would skip it and leave two records on one tree');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task add: a parked ticket for an opted-in role spawns nothing', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let created = false;
  f.m.create = async () => { created = true; return { name: 'x' }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'later work' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(created, false, 'parking means recorded-not-started — including the worktree');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'hand', 'a parked ticket stays on the role until it is assigned');
  assert.strictEqual(t.parked, true);
  assert.deepStrictEqual(f.gated, [], 'ENTER: parking must not have delivered a spec either');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The role's `template:` was inert on THIS path while the spawn intent honored
// it, so a hand booted with the full tool roster no matter what its template
// said — the one field written to make hands cheap, ignored by the only route
// that staffs them. Asserts the whole arg set, not a probe: an unwired slot
// arrives as `[]` or undefined, which reads as "nothing configured" rather than
// as a failure.
test('task add: the role\'s template shapes the seat it staffs', async () => {
  const { root, repo } = mkGitRepo();
  const tpl = {
    name: 'hand-seat', type: 'claude', cwd: '/unused',
    extraArgs: ['--model', 'claude-opus-5[1m]'],
    disabledTools: ['WebFetch', 'TodoWrite'],
    injectSkills: ['grok'],
    execCommands: ['clodex-run-tests'],
    intents: ['dm', 'reboot'], // reboot is PRIVILEGED — must be stripped
    env: { FORCE_PROMPT_CACHING_5M: '1', ANTHROPIC_BASE_URL: 'http://evil' },
    stripLevel: 2,
  };
  const f = mkTicketWt(repo, { template: 'hand-seat', prompt: 'clodex-team-hand' },
    { getTemplates: () => ({ list: () => [tpl] }) });
  const got = {};
  f.m.create = async (...a) => {
    Object.assign(got, {
      extraArgs: a[3], disabledTools: a[11], injectSkills: a[13],
      promptFile: a[14], execCommands: a[16], intents: a[17], env: a[18],
    });
    return { name: a[0] };
  };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'shaped work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => got.disabledTools !== undefined);

  assert.deepStrictEqual(got.disabledTools, ['WebFetch', 'TodoWrite'],
    'ENTER: the template reached create() at all — every assertion below is vacuous if this is []');
  assert.deepStrictEqual(got.extraArgs, ['--model', 'claude-opus-5[1m]'], 'model override applies');
  assert.deepStrictEqual(got.injectSkills, ['grok'], 'injected skills apply');
  assert.deepStrictEqual(got.execCommands, ['clodex-run-tests'], 'exec grants apply');
  assert.deepStrictEqual(got.intents, ['dm'],
    'a PRIVILEGED intent in a template must be stripped: this is an agent-initiated mint, so a template carrying `reboot` cannot self-grant it');
  assert.deepStrictEqual(got.env, { FORCE_PROMPT_CACHING_5M: '1' },
    'env is confined to the allowlist — a template is agent-writable and ANTHROPIC_BASE_URL redirects credentials');
  assert.strictEqual(got.promptFile, 'clodex-team-hand',
    'the ROLE prompt still wins the prompt slot: a template must not silently displace the role delta that defines the seat\'s job');
  // stripLevel is NOT a create() arg — it is a persistence write applied after,
  // so create()'s argv above cannot see it and dropping the call was invisible.
  // The recorder is gated on the record existing, which is also the ordering pin.
  assert.deepStrictEqual(f.stripCalls, [[f.upserted.at(-1), 2]],
    'the template stripLevel is applied to the seat, after create() minted its record');
  assert.deepStrictEqual(f.acCalls, [],
    'and a template with no autoCompact never calls that setter');
  fsReal.rmSync(root, { recursive: true, force: true });
});

test('task add: a worktree that cannot be created leaves the ticket on the role, unspawned', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  let created = false;
  f.m.create = async () => { created = true; return { name: 'x' }; };
  // A branch name git will refuse. The fallback under test is the DANGEROUS one:
  // spawning in the shared checkout would have the hand commit onto whatever
  // branch the operator has checked out.
  f.m._mintTicketSeat = (team, role, ticket) => ({ ok: true, name: 'team-hand-1', branch: 'bad..name' });
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'doomed work' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.removed.includes('team-hand-1'));

  assert.strictEqual(created, false, 'NO fallback into the shared checkout');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'hand', 'the ticket is un-pinned back to the role');
  assert.strictEqual(t.role, undefined, 'the stale role field is cleared with the pin');
  assert.ok(f.removed.includes('team-hand-1'), 'the reserved seat name is released');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The badge and the stall clock have to follow an INHERITED ticket too. Without
// the degradation reaching both, the sibling doing the work shows no ticket and
// its activity never refreshes `lastActivityAt` — so the watchdog nudges the lead
// about a ticket somebody is actively working.
test('t295: an inherited ticket gives the sibling a badge and keeps its stall clock live', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'work' });
  f.m.sessions.delete('team-hand');
  f.seat('team-hand-2');
  f.m._reconcileTickets(f.team);
  assert.strictEqual(f.m._ticketWatch.get('team-hand-2') != null, true,
    'the sibling is watched for the ticket it inherited');
  assert.ok(f.broadcasts.some((b) => b.channel === 'session-ticket'
    && b.msg.name === 'team-hand-2' && b.msg.ticket === 't1'),
    'ENTER: the badge names the inherited ticket, or reconcile did not reach it');
  // list() is FIRST PAINT and reconcile is every change. A term in one and not
  // the other is the inverse drift of the parked case: no badge until the next
  // reconcile, then one appears. Both must carry the degraded pin.
  assert.strictEqual(f.m.list().find((s) => s.name === 'team-hand-2').ticket, 't1',
    'first paint agrees with reconcile about the inherited ticket');

  const ts = f.load(); ts[0].lastActivityAt = 1; f.tstore.save(f.team.root, ts);
  f.m._touchTicketActivity('team-hand-2');
  assert.notStrictEqual(f.one('t1').lastActivityAt, 1,
    'the sibling\'s activity refreshes the inherited ticket — otherwise the watchdog nudges over live work');
});

// Two teams rooted at ONE project. The board is the project's, so the SWEEP must
// collapse to one pass (nudging twice about one stalled ticket is the bug that
// collapse fixes) — but RECONCILE must not, because it resolves roles against a
// specific manifest. Deduping reconcile by root as well leaves the second team
// unreconciled, and since _teamLiveSeatNames is project-scoped it has already
// returned that team's seats: they resolve to no role against the FIRST team's
// manifest, so every sweep deletes their watch entry and broadcasts a null badge,
// with no later pass to put them back. Silent, and it costs a working seat its
// stall detection.
test('sweep: two teams on one project sweep the board ONCE but reconcile SEPARATELY', async () => {
  const home = mkTmpRoot('clodex-2team-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const mkT = (name) => ({
    name, root: '/proj', lead: `${name}-lead`, watchdogMs: null,
    file: pathReal.join(home, 'teams', name, 'team.json'),
    roles: { lead: { instantiate: 'session' }, hand: { instantiate: 'session' } },
  });
  const alpha = mkT('alpha');
  const beta = mkT('beta');
  // Beta's role is NAMED DIFFERENTLY on purpose. The ticket below is assigned by
  // ROLE, and role resolution is the only thing the missing reconcile pass costs:
  // a ticket pinned to a seat NAME matches by name in _reconcileTickets no matter
  // which team's manifest is in hand, so a name-pinned fixture passes with the
  // defect present. That was the first draft of this test, and it did.
  beta.roles = { lead: { instantiate: 'session' }, scout: { instantiate: 'session' } };
  const teamOf = (cwd) => (cwd && cwd.startsWith('/proj') ? (cwd.includes('beta') ? beta : alpha) : null);
  const { m } = mkPark({
    fs: fsReal, path: pathReal, countPending: countPendingReal, REGISTRY_DIR: home,
    resolveTeam: (cwd) => teamOf(cwd),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
  });
  const broadcasts = [];
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._gatedDeliver = () => ({ queued: true });
  m._sendToSession = () => {};
  const seat = (name, cwd) => m.sessions.set(name, {
    name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle',
  });
  seat('alpha-lead', '/proj'); seat('alpha-hand', '/proj');
  seat('beta-lead', '/proj/beta'); seat('beta-scout', '/proj/beta');

  // One open ticket per team, both on the single project board. t2 is assigned to
  // beta's ROLE, which only beta's manifest can resolve.
  tstore.save('/proj', [
    { id: 't1', state: 'open', assignee: 'alpha-hand', role: 'hand', openedAt: Date.now(), lastActivityAt: Date.now() },
    { id: 't2', state: 'open', assignee: 'scout', role: 'scout', openedAt: Date.now(), lastActivityAt: Date.now() },
  ]);

  let sweeps = 0;
  const realSweep = m._sweepTeamTickets.bind(m);
  m._sweepTeamTickets = (team, now) => { sweeps += 1; return realSweep(team, now); };

  await m._sweepTickets(Date.now());

  assert.strictEqual(sweeps, 1, 'the shared board is swept once, not once per team');
  // ENTER: the reduction below is a filter on a broadcast channel. If reconcile
  // never ran for either team the list would be empty, and "no seat was stripped"
  // is vacuously true of an empty list.
  const badges = broadcasts.filter((b) => b.channel === 'session-ticket');
  assert.ok(badges.length >= 4, `ENTER: every live seat got a badge decision (${badges.length})`);
  const last = (name) => badges.filter((b) => b.msg.name === name).pop();
  assert.strictEqual(last('alpha-hand').msg.ticket, 't1', 'alpha reconciles against its own manifest');
  assert.strictEqual(last('beta-scout').msg.ticket, 't2',
    'and so does beta — deduping reconcile by root nulls this, because `scout` is not a role in alpha manifest');
  assert.ok(m._ticketWatch.has('beta-scout'), 'the second team keeps its watch entry');
});

// ---------------------------------------------------------------------------
// t423 — `dispatch: "spawn"`: a one-shot seat in the SHARED checkout.
//
// The cell `standing`/`worktree` could not express: ephemeral lifecycle without
// git isolation. The subjects below pull in different directions and are
// asserted apart — the spawn itself, what the ticket must NOT grow (a tree, a
// loop step, a WORK IN: line), the non-git root that is the whole ask, the
// fail-closed resolver, and accept's archive.

// The spawn itself. Asserts the WHOLE outcome set rather than "a seat appeared":
// a spawn that also minted a tree, or recorded one on the ticket, is exactly the
// fusion this value exists to break, and a probe on `sessions.has` reads around
// both.
test('task start: a `spawn` role gets a one-shot seat in the shared checkout, no branch, no tree', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.hand = { instantiate: 'session', brief: 'the hand', dispatch: 'spawn' };
  const cwds = {};
  f.m.create = async (...args) => { cwds[args[0]] = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  // ENTER: the seat really spawned. Every absence asserted below is vacuously
  // true of a dispatch that never happened.
  assert.ok(f.m.sessions.has('team-hand-1'), 'ENTER: the one-shot seat spawned');
  assert.strictEqual(cwds['team-hand-1'], repo,
    'and it boots in the SHARED checkout — the whole point of the value');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand-1', 'the ticket is re-pinned from the role to its seat');
  assert.strictEqual(t.role, 'hand', 'and remembers the role it was filed under');
  assert.strictEqual(t.worktree, undefined,
    'no tree is recorded — ABSENT, not null: every downstream reader tests `ticket.worktree && .path`');
  assert.deepStrictEqual(f.worktreeSet, [],
    'and no worktree pointer is written to the seat record either');
  // The record is what accept reads to tell a spawn seat from a standing one.
  assert.ok(f.upserted.includes('team-hand-1'), 'the seat record exists');
  // Not a bare name match: the worktree reply carries the name too.
  const spawnReply = said.find((s) => /shared checkout/.test(s));
  assert.ok(spawnReply, `a reply must name the shared checkout — got ${JSON.stringify(said)}`);
  assert.ok(!said.some((s) => /on branch/.test(s)),
    'and none of them may claim a branch — there is none');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// D6 + D7: the dispatch text. `WORK IN:` and `YOUR AREA` exist to send a seat
// somewhere its cwd is NOT; a spawn seat's cwd IS where it works, so both would
// name the directory the shell already opened in. The shared-checkout line is
// the one thing that must be SAID, because the isolation every other one-shot
// seat is handed silently does not exist here.
test('task start: a spawn dispatch carries the shared-checkout line and NO WORK IN:/AREA line', async () => {
  const { root, repo } = mkGitRepo();
  // A role cwd is set deliberately: the AREA line is gated on the worktree path,
  // so a role with no cwd could not tell "absent because no tree" from "absent
  // because no cwd", and the pin would hold for the wrong reason.
  const f = mkTicketWt(repo, { dispatch: 'spawn', cwd: 'api' });
  fsReal.mkdirSync(pathReal.join(repo, 'api'), { recursive: true });
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.m._injectText = () => {};
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.gated.length > 0);

  // ENTER: a spec really was delivered. Every "must not contain" below is true
  // of an empty list.
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one spec delivery to assert on');
  const body = f.gated[0].body;
  assert.match(body, /SHARED checkout/, 'the seat is told it shares the checkout');
  assert.match(body, /committing to the lead|leave committing/,
    'and that committing is not its call');
  assert.ok(!/WORK IN:/.test(body),
    'no WORK IN: line — its cwd IS where it works, so the line would name the shell it is already in');
  assert.ok(!/YOUR AREA/.test(body),
    'and no AREA line either, for the same reason');
  assert.match(body, /job one/, 'the spec text itself still rides');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The shared-checkout line and `WORK IN:` gate on DIFFERENT facts — the role's
// dispatch mode versus the ticket's own pointer — and the two can disagree. When
// they do, one dispatch tells a seat both "commit to <branch> as you go" and "you
// have no branch of your own". The pointer is the half that is real (the loop and
// the accept teardown both act on that tree), so the TEXT yields to it. Two
// reachable ways in, one test each.
test('task assign: a role flipped worktree→spawn mid-flight does NOT tell its seat it has no branch', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.m._injectText = () => {};
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));

  // ENTER: the ticket must really hold a tree, or the contradiction under test
  // cannot form and every assertion below passes on the spawn dispatch's own text.
  assert.ok(f.one('t1').worktree && f.one('t1').worktree.path,
    'ENTER: the ticket carries a worktree, minted while the role still said worktree');

  // The operator edits the role while the ticket is in flight. The tree already
  // exists and stays the seat's; only the mode changed.
  f.team.roles.hand.dispatch = 'spawn';
  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.gated.length > 0);

  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one re-send to assert on');
  const body = f.gated[0].body;
  assert.match(body, /WORK IN: /, 'the tree pointer still rides — it is the half that is real');
  assert.ok(!/SHARED checkout/.test(body),
    'and the shared-checkout line must NOT, or one message says both "commit to your branch" and "you have none"');
  assert.ok(!/no worktree and no branch of your own/.test(body),
    'stated against the sentence itself, not just its heading');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The other way in: _taskAssign's mint-failure fall-through. The derived seat name
// is TAKEN by a seat that is not this ticket's current assignee, so `minted.ok` is
// false and the oneShot arm falls through to the generic delivery — with the tree
// the ticket already carries still on the record and the spawn role still
// resolving. Nothing between there and the delivery clears either.
test('task assign: the mint-failure fall-through on a spawn role keeps the tree pointer un-contradicted', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'spawn' });
  f.m._injectText = () => {};
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });

  // An inherited tree on a ticket that is still filed under its ROLE: the shape a
  // record written by an earlier run (or by session:markWorktree) leaves behind.
  const tickets = f.load();
  const t = tickets.find((x) => x.id === 't1');
  t.worktree = { path: pathReal.join(root, 'inherited-tree'), branch: 't1-inherited' };
  f.tstore.save(f.team.root, tickets);
  // Holds the DERIVED name without being the ticket's assignee — this is what
  // makes the mint fail `taken` with `name !== prev`.
  f.seat('team-hand-1');

  assert.strictEqual(f.one('t1').assignee, 'hand', 'ENTER: still filed under the role, so prev !== the derived name');
  assert.ok(f.one('t1').worktree.path, 'ENTER: and it carries a tree the fall-through will not clear');

  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', who: 'hand', id: 't1', body: '' });
  await until(() => f.gated.length > 0);

  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one delivery — the fall-through really delivered');
  const body = f.gated[0].body;
  assert.match(body, /WORK IN: /, 'ENTER: the inherited pointer reached the dispatch, which is the whole premise');
  assert.ok(!/SHARED checkout/.test(body),
    'so the shared-checkout line stands down here too — same contradiction, different way in');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// D4: the ticket loop is gated on the ticket having a BRANCH, and every check in
// it (commits, ancestry, a diff) is a question about one. A spawn ticket has
// none, so `done` must stay terminal. This is EXISTING behaviour of the gate;
// nothing pinned it for a seat that is ephemeral WITHOUT a tree, which is the
// state that reads most like a loop candidate.
test('task done on a spawn ticket: no loop step, no reviewer, done stays terminal', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'spawn' });
  const created = [];
  f.m.create = async (...args) => { created.push(args[0]); f.seat(args[0], args[2]); return { name: args[0] }; };
  f.m._injectText = () => {};
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));

  created.length = 0;
  f.m._handleTask(f.m.sessions.get('team-hand-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));

  const t = f.one('t1');
  // ENTER: the close really landed. `loopStep === undefined` is true of a ticket
  // that was never closed at all, which is the vacuous reading this guards.
  assert.strictEqual(t.state, 'done', 'ENTER: the ticket is closed, so the gate was reached');
  assert.strictEqual(t.report, 'shipped it', 'ENTER: and the report was recorded');
  assert.strictEqual(t.loopStep, undefined,
    'no loop step — every check in the loop is a question about a branch, and there is none');
  assert.deepStrictEqual(created, [],
    'and no reviewer is spawned: there is no diff to review');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// D10, the ask itself: a team whose root is NOT a git repo. `worktree` cannot
// serve one at all (createWorktree fails and the path deliberately refuses to
// fall back to team.root), so this is the case the third value exists for. The
// assertion that matters is that NO git call sits on the path — a mode that
// merely tolerates git failing would work here by accident.
test('a non-git team root can dispatch, spawn and accept a spawn ticket end to end', async () => {
  const plain = fsReal.realpathSync(mkTmpRoot('sm-nogit-'));
  assert.ok(!fsReal.existsSync(pathReal.join(plain, '.git')),
    'ENTER: the root must genuinely not be a repo, or this measures nothing');
  // Every gitWorktree entry point RECORDS itself and then throws. The record is
  // the assertion, not the throw: `_existingTicketTree` wraps `listWorktrees` in
  // its own `try {} catch { return null; }`, so a call to the very entry point
  // this change removes would be swallowed and never reach a reply. Asserting on
  // the replies alone pins only `createWorktree` (whose throw does surface), and
  // the test would pass over a path that still shells out to git.
  const reached = [];
  const boom = (name) => async () => { reached.push(name); throw new Error(`git reached: ${name}`); };
  const f = mkTicketWt(plain, { dispatch: 'spawn' }, {
    gitWorktree: {
      createWorktree: boom('createWorktree'),
      listWorktrees: boom('listWorktrees'),
      removeWorktree: boom('removeWorktree'),
      isMerged: boom('isMerged'),
      commitsOnBranch: boom('commitsOnBranch'),
      deleteBranch: boom('deleteBranch'),
    },
  });
  // The COST ledger is the one thing on the accept path that lists worktrees, and
  // it runs for any ticket carrying a task dir — which every dispatched ticket now
  // must, since t431 refuses one without. It is a separate concern from the
  // question under test (does the DISPATCH/ACCEPT path shell out to git), and it
  // already guards its own git calls, so it is stubbed out rather than dodged by
  // filing a ticket that could not be dispatched at all.
  f.m._writeTicketCost = () => {};
  const cwds = {};
  f.m.create = async (...args) => { cwds[args[0]] = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  const said = [];
  f.m._injectText = (s, t) => { said.push(t); };
  const archived = [];
  f.m.archive = async (n) => { archived.push(n); f.m.sessions.delete(n); };
  f.seat('lead');

  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(cwds['team-hand-1'], plain, 'ENTER: the seat spawned, in the non-repo root');
  assert.deepStrictEqual(reached, [],
    'no git entry point was called on the dispatch path — swallowed calls included');

  f.m._handleTask(f.m.sessions.get('team-hand-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped it' });
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(f.one('t1').state, 'done', 'the report closes the ticket');

  said.length = 0;
  await f.m._taskAccept(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'accept', id: 't1', who: null, body: '' }, (msg) => said.push(msg));

  assert.ok(f.one('t1').acceptedAt > 0, 'and accept closes it out — with no git anywhere on the path');
  assert.deepStrictEqual(reached, [], 'accept reached no git entry point either');
  fsReal.rmSync(plain, { recursive: true, force: true });
});

// The security bar: an unrecognized or malformed `dispatch` must resolve to
// `standing`, NEVER to `spawn`. A spawn seat is a full agent in the operator's
// own working tree, so the degradation has to be toward the seat that touches
// nothing. Every value here is one a hand-edited team.json can carry.
test('a malformed or unknown dispatch resolves to standing, never to spawn', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.seat('lead');
  for (const bad of ['Spawn', 'SPAWN', 'spawn ', 'oneshot', '', null, undefined, true, 1, {}, ['spawn']]) {
    f.team.roles.hand = { instantiate: 'session', brief: 'the hand', dispatch: bad };
    const got = f.m._ticketDispatchMode(f.team, 'hand');
    assert.strictEqual(got.mode, 'standing',
      `dispatch ${JSON.stringify(bad)} must degrade to standing, not to a seat in the operator's checkout`);
  }
  // The controls: both real values still resolve, or a resolver that answered
  // 'standing' unconditionally would satisfy every assertion above.
  f.team.roles.hand = { instantiate: 'session', brief: 'the hand', dispatch: 'spawn' };
  assert.strictEqual(f.m._ticketDispatchMode(f.team, 'hand').mode, 'spawn', 'the real value resolves');
  f.team.roles.hand = { instantiate: 'session', brief: 'the hand', dispatch: 'worktree' };
  assert.strictEqual(f.m._ticketDispatchMode(f.team, 'hand').mode, 'worktree', 'and so does worktree');

  // Reserved roles hold the line at the RESOLVER too, because team.json is
  // hand-editable and files predating assertDispatchAllowed exist.
  for (const reserved of ['lead', 'reviewer']) {
    f.team.roles[reserved] = { instantiate: 'session', brief: 'x', dispatch: 'spawn' };
    assert.strictEqual(f.m._ticketDispatchMode(f.team, reserved).mode, 'standing',
      `${reserved} cannot be dispatched a one-shot seat even by hand-edit`);
  }
  // A role that is not in the manifest at all, and a seat-addressed ticket: both
  // are the narrowness the resolver inherited and must keep.
  assert.strictEqual(f.m._ticketDispatchMode(f.team, 'team-hand-1').mode, 'standing',
    'a SEAT name resolves to standing — a session cwd is fixed at PTY spawn');
  assert.strictEqual(f.m._ticketDispatchMode(f.team, 'nosuchrole').mode, 'standing');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The cross-mode path (r1 MUST-FIX 1). A ticket can arrive at a spawn dispatch
// already carrying a tree — dispatched to a worktree role, its seat dies, the
// lead re-assigns to a spawn role. Nothing in the spawn path wrote a worktree,
// but nothing CLEARED the inherited one either, and a stale pointer outvotes the
// mode in every reader that tests for it: the spec says both `WORK IN: <another
// ticket's tree>` and "you have no worktree", the loop gate goes true so the
// ticket re-enters the git loop this mode exists to avoid, and accept resolves a
// branch and takes the DESTROY arm on the one-shot seat instead of D5's archive.
// All four are asserted together because they are one bug, not four.
test('task assign to a spawn role CLEARS a worktree the ticket inherited', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo);
  f.team.roles.helper = { instantiate: 'session', brief: 'the helper', dispatch: 'spawn' };
  const created = [];
  const cwds = {};
  f.m.create = async (...args) => { created.push(args[0]); cwds[args[0]] = args[2]; f.seat(args[0], args[2]); return { name: args[0] }; };
  f.m._injectText = () => {};
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  // ENTER: the ticket really acquired a tree. Every "no tree" assertion below is
  // vacuously true of a ticket that never had one — which is the fresh-spawn
  // case the other tests already cover, and NOT what this one is about.
  const before = f.one('t1');
  assert.ok(before.worktree && before.worktree.path,
    'ENTER: the worktree dispatch recorded a tree on the ticket');
  assert.ok(before.worktree.branch, 'ENTER: and a branch, which is what accept resolves');

  // Routine: accept on an unmerged branch archives the seat, and a natural exit
  // does the same. `killSeat` releases the derived name so the re-assign mints.
  f.killSeat('team-hand-1');
  f.gated.length = 0;
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'helper', body: '' });
  await until(() => f.m.sessions.has('team-helper-1'));
  for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));

  const t = f.one('t1');
  assert.strictEqual(t.worktree, undefined,
    'the inherited tree is cleared from the ticket — ABSENT, which is the state every downstream reader tests');
  assert.strictEqual(cwds['team-helper-1'], repo, 'and the seat boots in the shared checkout');
  assert.strictEqual(f.gated.length, 1, 'ENTER: exactly one spec delivery to assert on');
  assert.ok(!/WORK IN:/.test(f.gated[0].body),
    'the spec carries no WORK IN: line — it would point the seat into the dead ticket\'s branch checkout');
  assert.match(f.gated[0].body, /SHARED checkout/, 'and does carry the shared-checkout line');

  created.length = 0;
  f.m._handleTask(f.m.sessions.get('team-helper-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped' });
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
  const after = f.one('t1');
  assert.strictEqual(after.state, 'done', 'ENTER: the close landed, so the loop gate was reached');
  assert.strictEqual(after.loopStep, undefined,
    'and no loop step: the gate reads the tree the clear removed');
  assert.deepStrictEqual(created, [], 'no reviewer either');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// D5, the one genuinely new semantic. The `!branch` arm was written for a
// STANDING seat, where retiring the operator's persistent session would be a
// teardown the merge fact never licensed. A spawn seat is the opposite: one-shot
// by construction, and no cleanup verb reaches it. ARCHIVED, never destroyed —
// there is no tree to reclaim and its work may be uncommitted in the shared
// checkout.
test('task accept: a spawn seat is ARCHIVED, and the reply says so', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'spawn' });
  f.m.create = async (...args) => { f.seat(args[0], args[2]); return { name: args[0] }; };
  f.m._injectText = () => {};
  const archived = [];
  const destroyed = [];
  f.m.archive = async (n) => { archived.push(n); f.m.sessions.delete(n); };
  f.m.destroy = async (n) => { destroyed.push(n); return { ok: true }; };
  f.seat('lead');
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  await until(() => f.m.sessions.has('team-hand-1'));
  f.m._handleTask(f.m.sessions.get('team-hand-1'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done, so accept reaches its arms');
  assert.ok(f.m.sessions.has('team-hand-1'), 'ENTER: and the seat is still LIVE, or the archive is vacuous');
  // ENTER: the arm tells a spawn seat from a standing one by THIS key. A fixture
  // whose persistence stub dropped it would send this test down the standing arm
  // and report a teardown that never ran — which is exactly how it first failed.
  assert.strictEqual(f.record('team-hand-1').ephemeral, true,
    'ENTER: the seat record carries `ephemeral`, which is what accept reads');

  const said = [];
  await f.m._taskAccept(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'accept', id: 't1', who: null, body: '' }, (msg) => said.push(msg));

  assert.deepStrictEqual(archived, ['team-hand-1'],
    'the one-shot seat is archived — nothing will ever dispatch to it again');
  assert.deepStrictEqual(destroyed, [],
    'and NOT destroyed: no tree is reclaimed, and its work may be uncommitted in the shared checkout');
  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  assert.match(said[0], /ARCHIVED/, 'the reply names what happened to the seat');
  assert.ok(!/nothing was torn down/.test(said[0]),
    'and must NOT claim nothing was torn down — a reply that lies about an archive is the class of bug this fixes');
  assert.ok(f.one('t1').closedOut, 'terminal: there is no branch to merge and no second accept to invite');
  fsReal.rmSync(root, { recursive: true, force: true });
});

// The other half of D5's split, and the reason it is a split at all: a STANDING
// seat reaching the same arm must still be left alone. Without this control the
// test above is satisfied by an arm that archives everything, which would retire
// the operator's own persistent session on every accept.
test('task accept: a STANDING seat on the same arm is left exactly as it is', async () => {
  const { root, repo } = mkGitRepo();
  const f = mkTicketWt(repo, { dispatch: 'standing' });
  f.m._injectText = () => {};
  const archived = [];
  const destroyed = [];
  f.m.archive = async (n) => { archived.push(n); f.m.sessions.delete(n); };
  f.m.destroy = async (n) => { destroyed.push(n); return { ok: true }; };
  f.seat('lead');
  const hand = f.seat('hand');
  // A real operator seat HAS a persistence record; `f.seat()` only seats a
  // session. Without this upsert the arm is reached with `rec === null`, so
  // `ephemeral` is falsy because there is no record at all — and the control
  // would pass against an arm that checked `!rec` and nothing more.
  f.persistence.upsert({ name: 'hand' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'job one' });
  f.m._handleTask(f.m.sessions.get('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  f.m._handleTask(hand, { type: 'task', sub: 'done', id: 't1', who: null, body: 'shipped' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  assert.strictEqual(f.one('t1').state, 'done', 'ENTER: the ticket is done');
  assert.strictEqual(f.one('t1').worktree, undefined, 'ENTER: and it has no branch, so it takes the same arm');
  assert.ok(f.m.sessions.has('hand'), 'ENTER: the standing seat is live');
  // ENTER: the record EXISTS and merely lacks the key — the shape a real operator
  // seat has. Reaching the arm with no record at all would satisfy an arm that
  // only checked `!rec`, and the control would hold for the wrong reason.
  assert.ok(f.record('hand'), 'ENTER: the standing seat has a persistence record, as a real one does');
  assert.strictEqual(f.record('hand').ephemeral, undefined,
    'ENTER: and it is non-ephemeral by ABSENCE of the key, which is what accept has to read past');

  const said = [];
  await f.m._taskAccept(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'accept', id: 't1', who: null, body: '' }, (msg) => said.push(msg));

  assert.deepStrictEqual([archived, destroyed], [[], []],
    'a standing seat is the operator\'s persistent session — the merge fact never licensed retiring it');
  assert.ok(f.m.sessions.has('hand'), 'and it is still live');
  assert.strictEqual(said.length, 1, 'ENTER: exactly one reply to assert on');
  assert.match(said[0], /nothing was torn down/, 'and the reply still says so truthfully');
  fsReal.rmSync(root, { recursive: true, force: true });
});
