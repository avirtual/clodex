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
  const root = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-sm-'));
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
  const root = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-rm-'));
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
// failure-strike disarms clear the intent; explicit 'off' is the wire:hold
// handler's job and is skipped here.
test('_onHoldLifecycle: re-anchor re-persists, failures clears, off is skipped', () => {
  const holds = [];
  const m = mk({
    getPersistence: () => ({
      list: () => [], get: () => null,
      setHoldUntil: (name, v) => holds.push([name, v]),
    }),
    log: { info: () => {}, warn: () => {} },
  });
  m.sessions.set('a', { name: 'a', sessionId: 'sid-1' });

  // Re-anchor: keeper's `until` is epoch SECONDS → persisted as epoch ms.
  m._onHoldLifecycle({ session: 'sid-1', event: 're-anchored', until: 1_700_000_000 });
  assert.deepStrictEqual(holds, [['a', 1_700_000_000_000]]);

  // Unknown wire sid (child claude / rotated id): never touches persistence.
  m._onHoldLifecycle({ session: 'stray', event: 're-anchored', until: 1_700_000_000 });
  assert.strictEqual(holds.length, 1);

  // Failure-strike disarm clears the intent (keys on cause, not reason text).
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'failures', reason: 'whatever', pings: 3 });
  assert.deepStrictEqual(holds[1], ['a', null]);

  // Explicit off: handled (logged+cleared) by the wire:hold handler — skipped here.
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'off', pings: 0 });
  // Expiry/max-pings: log-only, field clears lazily on the next re-arm check.
  m._onHoldLifecycle({ session: 'sid-1', event: 'disarmed', cause: 'expired', pings: 5 });
  assert.strictEqual(holds.length, 2);
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
function mkGate(intents) {
  // `intents` is the value persisted under sender 'a' (undefined = absent).
  const injected = [];
  const m = mk({
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'a' ? { intents } : null) }),
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
  const spillDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t170-'));
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

// The five bodiless gateable verbs. The spec asks that a spill on these be
// IMPOSSIBLE rather than merely unreached, so this walks the catalogue against the
// grammar table instead of listing verbs by hand — a verb that gains a body later
// fails here and has to be classified deliberately.
test('t170 every bodiless gateable verb is structurally unspillable', () => {
  const { GATEABLE_INTENTS } = require('../intent-catalog');
  const { bodyModeFor } = require('../intent-registry');
  // Probed across subs, not called bare: `context` and `memory` answer 'none' for a
  // MISSING sub and 'greedy' for compact/remember, so a single bare call would
  // misfile both as bodiless and this test would then certify a spill path it never
  // exercised. Bodiless means bodiless for every sub the verb can carry.
  const SUBS = [null, 'compact', 'clear', 'reload', 'remember', 'recall', 'add', 'done', 'list'];
  const bodiless = GATEABLE_INTENTS
    .map((i) => i.type)
    .filter((t) => SUBS.every((sub) => bodyModeFor({ type: t, sub }) === 'none'));
  assert.deepStrictEqual(bodiless.sort(), ['file', 'reboot', 'resend', 'spawn', 'who'],
    'the bodiless five — if this list changed, the disposition table needs a deliberate verdict for the new verb');
  for (const type of bodiless) {
    assert.deepStrictEqual(deniedBodyDisposition({ type }), { how: 'none', label: null },
      `${type} carries no body, so it can never reach a spill`);
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
    relaunchApp: () => { if (relaunchThrows) throw new Error('relaunch boom'); relaunches.push(Date.now()); },
    log: { info: () => {}, error: () => {} },
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
  assert.strictEqual(injected[0], '[agent:reboot] rebooting — sessions resume on relaunch');
  assert.ok(state.lastRebootAt > 0, 'lastRebootAt stamped');
  const b = broadcasts.find((x) => x.type === 'reboot');
  assert.ok(b && /rebooting: overnight restart-window test/.test(b.body), 'ipc log carries reason');
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
    + 'Valid intents: dm, resend, who, name, context, memory, spawn, file, exec, remind, notify-user, team-review, review-done, task, reboot, end. '
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
    log: { info: () => {}, error: () => {} },
  });
  m._deliverMessage = (name, sender, body) => { if (deliverThrows) throw new Error('inject boom'); delivered.push({ name, sender, body }); };
  if (live) m.sessions.set(notice.name, { name: notice.name, agentType: 'claude', workspaceId: 'ws1' });
  return { m, state, delivered, parks };
}

test('reboot notice: a LIVE CLAUDE requester gets the notice PARKED (boot-safe), then the flag clears', () => {
  const at = Date.now();
  const { m, state, delivered, parks } = mkNotice({
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
  assert.strictEqual(state.pendingRebootNotice, null, 'one-shot flag cleared');
  // T30 round 2 (field): a park alone strands on a seat that stays idle — every
  // drain trigger needs the seat to earn a turn. The starvation cap must be
  // armed so a forced drain lands within INJECT_QUIET_MAXWAIT.
  assert.ok(m.sessions.get('a')._parkCapTimer, 'starvation cap armed for the parked notice');
  clearTimeout(m.sessions.get('a')._parkCapTimer);
});

test('reboot notice: a LIVE CODEX requester keeps the active inject (no passive store to park into)', () => {
  const { m, state, delivered, parks } = mkNotice({
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
  const { m, parks } = mkNotice({
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
  const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-exec-'));
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
  const persistence = {
    list: () => [],
    get: (n) => persistedEntries[n] || null,
    setStripLevel: (n, l) => stripCalls.push([n, l]),
    setAutoCompact: (n, on) => acCalls.push([n, on]),
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
  m.create = async (...args) => { created.push(args); };
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
const tmpTplDir = () => fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-tpl-'));

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

// --- Mid-flight DM delivery: park-on-busy (piece 2) + idle-edge drain (piece 3) -
// A busy agent's DM parks to the on-disk pending store (where the out-of-process
// PostToolUse hook can drain it mid-loop) instead of the in-memory _injectQueue;
// the idle-edge Node drain is the turn-end fallback for a pure-text (no-tool)
// turn. Real pending-store fns + isDraftOpen injected over a temp PENDING_DIR;
// _injectText captured (no PTY). One atomic rename-claim = exactly-once.
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending: countPendingReal, parkIdInUse } = require('../pending-store');
const { isDraftOpen: isDraftOpenReal } = require('../proxy-util');

function mkPark(overrides = {}) {
  const PENDING_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-pend-'));
  const injected = [];
  const m = mk({
    PENDING_DIR, parkDelivery, drainPending, hasActivePending, isDraftOpen: isDraftOpenReal,
    INJECT_QUIET_MS: 4000, INJECT_QUIET_MAXWAIT: 3_600_000, // maxwait large: park cap won't fire mid-test
    findProjectRoot: () => null, // teams: default = no project anywhere; retire tests override
    log: { info: () => {}, warn: () => {}, error: () => {} },
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
    cleanupClaudeHook: () => {}, cleanupSkillPlugin: () => {},
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

function mkRetire(rootByName, rolesByRoot) {
  // rootByName: cwd → project root map for the stub findProjectRoot.
  // rolesByRoot: root → { role: def } map for the stub resolveTeam (drives the
  // archive-vs-discard disposition). Defaults to a team where lead + dev are
  // both persistent (ephemeral:false) so existing archive tests are unchanged.
  const roles = (root) => rolesByRoot?.[root] ?? { lead: {}, dev: {} };
  const normalize = (defs) => Object.fromEntries(
    Object.entries(defs).map(([r, d]) => [r, { ephemeral: d.ephemeral === true, template: d.template ?? null, instantiate: d.instantiate ?? 'session', standing: d.standing ?? null }]),
  );
  const { m, PENDING_DIR, injected } = mkPark({
    findProjectRoot: (cwd) => rootByName[cwd] ?? null,
    resolveTeam: (cwd) => {
      const root = rootByName[cwd];
      if (!root) return null;
      return { name: 'team', root, lead: 'lead', roles: normalize(roles(root)), file: `${root}/team.json` };
    },
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

test('team-retire: an ephemeral role → kill (discard), drops the record, no archived row', async () => {
  // 'team-runner' binds to the ephemeral:true 'runner' role → discard path:
  // kill() (drops the record), the window is signalled disposition:discard so
  // the row vanishes like a delete.
  const { m, PENDING_DIR, archived, killed, contextActions, delivered } = mkRetire(
    { '/proj/a': '/proj', '/proj/r': '/proj' },
    { '/proj': { lead: {}, runner: { ephemeral: true } } },
  );
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-runner', { name: 'team-runner', agentType: 'claude', cwd: '/proj/r' });
  m._buildDeliveryText = (t, sender, body) => `[agent:from ${sender}] ${body}`;
  m._onIncoming('team-runner', { from: 'lead', body: '', type: 'team-retire' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(killed, ['team-runner'], 'ephemeral role is killed (record dropped)');
  assert.deepStrictEqual(archived, [], 'never archived on the discard path');
  assert.deepStrictEqual(contextActions.map((c) => [c.name, c.payload.action, c.payload.disposition]),
    [['team-runner', 'retired', 'discard']], 'window signalled discard → row removed like a delete');
  assert.deepStrictEqual(delivered, [], 'no waking DM on success');
  const parked = drainPending(PENDING_DIR, 'lead', 't');
  assert.match(parked[0], /discarded — state lives in its task artifact/, 'discard confirmation wording');
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

test('_notifyComposition: passive delta fans to the OTHER live team seats only', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('outsider', { name: 'outsider', agentType: 'claude', cwd: '/other/x' }); // other team
  m.sessions.set('shell', { name: 'shell', agentType: null, cwd: '/proj/c' });            // bash — excluded
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-dev'), 'retired');
  assert.strictEqual(passive.length, 1, 'only the one other live team seat is notified');
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
test('_notifyComposition: a still-booting codex seat COALESCES — delta dropped, not typed', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  // codex teammate mid-boot: boot window open (fresh mint also stashed its roster).
  m.sessions.set('team-cx', { name: 'team-cx', agentType: 'codex', cwd: '/proj/b',
    _bootSettling: true, _pendingRoster: teamStub });
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('lead'), 'spawned');
  // The booting codex seat is skipped; no other live seat to notify.
  assert.deepStrictEqual(passive, [], 'no delta delivered to a seat still in its boot-settle window');
});

// MUST-FIX 1 (task 22 reopened task 20's window for RESUMED seats): a resumed
// codex seat skips its roster (stamped → no _pendingRoster) yet still boots and
// would ACTIVE-type a delta into its booting TUI. The boot-settle flag guards it
// regardless of roster. Contract: DROP (the seat's resumed context + on-demand
// roster pull is ground truth; a missed one-line delta is harmless).
test('_notifyComposition: a RESUMED-stamped codex seat mid-boot (no stashed roster) still coalesces', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  // resumed seat: booting, but its roster was skipped (stamped) → NO _pendingRoster.
  m.sessions.set('cx-resumed', { name: 'cx-resumed', agentType: 'codex', cwd: '/proj/b',
    _bootSettling: true });
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('lead'), 'spawned');
  assert.deepStrictEqual(passive, [], 'delta dropped while the resumed seat is still booting (nothing typed)');
  // Once its boot settles (_bootSettling cleared), a later delta lands normally.
  m.sessions.get('cx-resumed')._bootSettling = false;
  m._notifyComposition(m.sessions.get('lead'), 'archived');
  assert.deepStrictEqual(passive.map((p) => p.t), ['cx-resumed'], 'after settle the delta delivers on the normal path');
});

test('_notifyComposition: delta + booting seat coalesce — booted seat wins, delta never double-delivered', () => {
  // A single fan over a mixed set: cx-boot is mid-boot (window open → must be
  // dropped/coalesced), cx-live is booted (must receive). Proves the skip is
  // selective, not a blanket suppression, and that no seat is delivered twice.
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });               // source
  m.sessions.set('cx-boot', { name: 'cx-boot', agentType: 'codex', cwd: '/proj/b', _bootSettling: true, _pendingRoster: teamStub });
  m.sessions.set('cx-live', { name: 'cx-live', agentType: 'codex', cwd: '/proj/c' });          // booted
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('lead'), 'spawned');
  assert.deepStrictEqual(passive.map((p) => p.t), ['cx-live'],
    'the booting seat coalesces; the booted seat gets exactly one delta');
  // Once cx-boot settles (_bootSettling cleared), a later delta lands.
  m.sessions.get('cx-boot')._bootSettling = false;
  m._notifyComposition(m.sessions.get('lead'), 'archived');
  assert.deepStrictEqual(passive.slice(1).map((p) => p.t).sort(), ['cx-boot', 'cx-live'],
    'after boot the once-coalesced seat takes deltas promptly, still no double delivery');
});

test('_notifyComposition: a LIVE codex seat (no stashed roster) is delivered promptly', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-cx', { name: 'team-cx', agentType: 'codex', cwd: '/proj/b' }); // booted: no _pendingRoster
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('lead'), 'spawned');
  assert.strictEqual(passive.length, 1, 'a booted codex seat gets the delta on the normal (passive) path');
  assert.strictEqual(passive[0].t, 'team-cx');
  assert.match(passive[0].b, /\[team team\] seat lead spawned \(role: lead\)/);
});

test('_notifyComposition: a Claude seat still parks passively even mid-boot (boot-safe regardless)', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' }); // claude: never stashes a roster
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('lead'), 'spawned');
  assert.strictEqual(passive.length, 1, 'claude target parks passively (no active PTY write to race)');
  assert.strictEqual(passive[0].t, 'team-dev');
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

test('_notifyComposition (T34): a PERSISTENT seat delta still reaches bystanders (full fan preserved)', () => {
  // team-dev is a persistent role (no ephemeral marker on def OR record) — a hand
  // learning a second dev arrived/left IS durable topology, so the full fan stays.
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
  assert.deepStrictEqual(passive.map((p) => p.t).sort(), ['lead', 'team-hand'],
    'persistent subject keeps the full team fan — lead AND the hand bystander');
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

// T34: ephemeral via the ROLE DEF (future-proofing) — a role explicitly marked
// ephemeral:true on the manifest also fans lead-only, even with no persistence
// record. Proves the belt-and-braces predicate honors BOTH markers.
test('_notifyComposition (T34): a role-def-ephemeral seat also fans lead-only (no persistence record needed)', () => {
  const teamStubEphRole = { name: 'team', root: '/proj', lead: 'lead',
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      runner: { instantiate: 'subagent', brief: 'the runner', ephemeral: true }, // ephemeral ON the def
    } };
  const { m } = mkPark({
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? teamStubEphRole : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    getPersistence: () => ({ list: () => [], get: () => null }), // NO ephemeral record — the def carries it
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-hand', { name: 'team-hand', agentType: 'claude', cwd: '/proj/b' });
  m.sessions.set('team-runner-1', { name: 'team-runner-1', agentType: 'claude', cwd: '/proj/c' });
  const passive = [];
  m._deliverPassive = (t, s, b) => passive.push({ t, s, b });
  m._notifyComposition(m.sessions.get('team-runner-1'), 'retired');
  assert.deepStrictEqual(passive.map((p) => p.t), ['lead'],
    'role-def ephemeral is honored even without a persistence marker');
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
  assert.match(forLead, /Dispatch: \[agent:task add <role>\]/, 'the lead seat gets the action line');

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
  },
};

function mkReview(extra = {}) {
  const roleOverride = extra.reviewerRole;
  delete extra.reviewerRole;
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
  };
  const overrides = {
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => templatesList }),
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
  return { m, injected, created, delivered, passive, parkedActive, gated, archived, killed, contextActions, order, persistence, team };
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
  assert.strictEqual(type, 'claude', 'defaults to claude when role.type is null');
  assert.strictEqual(cwd, '/proj', 'cwd defaults to team root');
  // The handler passes NO inline system body — the reviewer's briefing rides as
  // the REPLACEMENT system prompt (systemPromptFile below), not an inline body.
  assert.strictEqual(sysBody, null, 'no explicit inline briefing');
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
  }, 'lean-reviewer env: CLAUDE.md loader off, 5m cache pin, IPC-prompt skip, spawn-directive block off');
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
  // Scope delivered as an ACTIVE-CLASS PARK (T54): parked (no spawn-time PTY
  // write — the mode-2004 boot-race that ate the T40/T42 scopes stays fixed) but
  // turn-earning, so the boot-ready rising edge drains it WITHOUT a human
  // ✉-click (the operator-reported stall). It does NOT ride the passive path.
  assert.deepStrictEqual(parkedActive, [{ name: 'team-reviewer-1', sender: 'lead', body: 'check the boot-race fix', mtype: 'dm' }]);
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
function mkHintProbe({ proxyBase = 'http://127.0.0.1:7811', ProxyClient, ptySpawn, registry, transportStart, socketLive = false } = {}) {
  const root = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-hint-'));
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
    buildAgentsArg: () => null,
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
    lastTranscriptWrite: () => null,
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

// C2 (T29 Slice 2): a cold reviewer ALWAYS spawns as claude — a codex seat can't
// enforce the tools cap (codex ignores disabledTools). The old MF4 REFUSAL of a
// codex-with-tools reviewer is superseded: force-claude + a loud notice is strictly
// safer (it also catches the no-tools codex reviewer MF4 let through fully armed).
test('team-review C2: a manifest codex reviewer WITH tools spawns as CLAUDE + capped, with the force-claude notice', async () => {
  const { m, injected, created } = mkReview({
    reviewerRole: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: ['Read', 'Grep', 'Glob'], type: 'codex', template: null, standing: null, ephemeral: false },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'the reviewer still spawns');
  assert.strictEqual(created[0][1], 'claude', 'forced to claude regardless of the manifest type');
  const disabledTools = created[0][11];
  assert.ok(disabledTools.includes('Bash') && !disabledTools.includes('Read'),
    'the cap is live on the forced-claude seat (Read/Grep/Glob kept, rest disabled)');
  assert.ok(injected.some((t) => /manifest requested reviewer type "codex", but cold reviewers always spawn as claude/.test(t)),
    'the lead gets the force-claude notice naming the ignored type');
});

// A codex reviewer WITHOUT a tools restriction ALSO force-spawns as claude now (the
// hole MF4 left: it only bounced codex WITH tools, so a no-tools codex reviewer
// spawned fully armed). C2 closes it — capped claude + the same notice.
test('team-review C2: a no-tools codex reviewer force-spawns as CLAUDE + capped (MF4 hole closed)', async () => {
  const { m, injected, created } = mkReview({
    reviewerRole: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: null, type: 'codex', template: null, standing: null, ephemeral: false },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'the reviewer spawns');
  assert.strictEqual(created[0][1], 'claude', 'forced to claude even with no manifest tools');
  const disabledTools = created[0][11];
  assert.ok(disabledTools.includes('Bash') && !disabledTools.includes('Read'),
    'the default cap (Read/Grep/Glob) is applied to the forced-claude seat');
  assert.ok(injected.some((t) => /always spawn as claude/.test(t)), 'force-claude notice present');
});

// A claude reviewer (the normal case) spawns with NO force-claude notice.
test('team-review C2: a claude reviewer spawns with no force-claude notice', async () => {
  const { m, injected, created } = mkReview();
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created[0][1], 'claude');
  assert.ok(!injected.some((t) => /always spawn as claude/.test(t)), 'no notice when the manifest already asked for claude');
});

// --- Task 29a → T52: `tools` is a NARROWING hint under REVIEWER_TOOL_CAP ---
// Both the reviewer TEMPLATE and the role manifest are agent-writable, so neither
// can WIDEN the cold reviewer past the code-level cap (Read/Grep/Glob). The
// template is the primary tools source (T52); it's capped exactly like the role
// manifest was (T29a). Effective = intersection.
test('team-review (T52): a TEMPLATE WIDER than the cap spawns CAPPED with a loud operator-approval line', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplate: { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit'] },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'a widened template still spawns — a capped review beats no review');
  const disabledTools = created[0][11];
  // The widening (Bash, Edit) is disabled despite the template asking for it; the cap holds.
  assert.ok(disabledTools.includes('Bash') && disabledTools.includes('Edit'),
    'tools beyond the cap are disabled even though the template requested them');
  assert.ok(!disabledTools.includes('Read') && !disabledTools.includes('Grep') && !disabledTools.includes('Glob'),
    'the capped allowlist (Read/Grep/Glob) is NOT disabled');
  assert.ok(injected.some((t) => /requested \[Bash, Edit\] beyond the reviewer cap \[Read, Grep, Glob\] — requires operator approval; spawned with \[Read, Grep, Glob\]/.test(t)),
    'the lead gets a loud line naming the beyond-cap tools and the operator-approval requirement');
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
});

// T52: template omits tools → the role manifest's tools drive (fallback), still
// capped. Proves template > role > built-in precedence for the tools field.
test('team-review (T52): a template WITHOUT tools falls back to the role manifest tools (still capped)', async () => {
  const { m, injected, created } = mkReview({
    reviewTemplates: [{ name: 'clodex-team-reviewer', systemPromptFile: 'clodex-team-reviewer', intents: [],
      env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', FORCE_PROMPT_CACHING_5M: '1', CLODEX_DISABLE_IPC_PROMPT: '1' } }],
    reviewerRole: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: ['Read', 'Bash'], type: null, template: null, standing: null, ephemeral: false },
  });
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj', workspaceId: 'default' });
  m._handleTeamReview(m.sessions.get('lead'), 'scope');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 1, 'template-without-tools falls back to role tools + spawns');
  const disabledTools = created[0][11];
  assert.ok(!disabledTools.includes('Read'), 'the role-requested Read (within cap) stays enabled');
  assert.ok(disabledTools.includes('Bash'), 'the role-requested Bash (beyond cap) is disabled — cap still holds on the fallback source');
  assert.ok(disabledTools.includes('Grep') && disabledTools.includes('Glob'), 'cap tools the role dropped are disabled');
  assert.ok(injected.some((t) => /requested \[Bash\] beyond the reviewer cap/.test(t)),
    'the beyond-cap warn fires on the role-fallback source too');
});

test('team-review: an ABSENT manifest tools list applies the cap as-is', async () => {
  const { m, injected, created } = mkReview({
    reviewerRole: { instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
      tools: null, type: null, template: null, standing: null, ephemeral: false },
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

// NIT 3 (unbriefed-reviewer trap): create() silently skips a missing role prompt.
// Preflight it and warn on the lead's confirm line so a team that never installed
// the prompt gets a signal rather than a silently-unbriefed reviewer.
test('team-review: a missing role-prompt file appends an UNBRIEFED warning to the confirm line', async () => {
  const REGISTRY_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-review-'));
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
  const REGISTRY_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-review-'));
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
// temp team dir so the ticket store round-trips to disk (like the T24 prompt
// preflight). Seats are named per the <team>-<role> convention so matchSeatRole
// binds them; the lead seat is `lead` (team.lead).
const ticketsMod = require('../tickets-store');
const tstore = ticketsMod.createTicketsStore();

function mkTasks(extra = {}) {
  const teamDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-tk-'));
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(teamDir, 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer' },
    },
  };
  const overrides = {
    fs: fsReal, path: pathReal, countPending: countPendingReal,
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
  // Fires `onWrite` (6th arg), because this stub models a delivery that REACHES
  // THE WRITE. A stub that took it and never called it would model a permanently
  // wiped write, so every caller that stamps from onWrite (the watchdog nudge)
  // would look permanently broken; a stub that ignored the arg would silently
  // certify the old stamp-on-return behaviour. Tests wanting the never-written
  // case override with a stub that omits the call.
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    gated.push({ target, sender, body }); urgents.push(urgent);
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._sendToSession = () => {};
  const seat = (name, cwd = '/proj', props = {}) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle', ...props });
    return m.sessions.get(name);
  };
  const load = () => tstore.load(teamDir);
  const one = (id) => load().find((t) => t.id === id);
  return { m, injected, gated, urgents, broadcasts, team, teamDir, seat, load, one };
}

test('task add (assigned): mints t1, delivers spec to the assignee seat, confirms to lead', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget\ndetail' });
  const t = f.one('t1');
  assert.ok(t, 'ticket persisted');
  assert.strictEqual(t.assignee, 'hand', 'role stored as the durable assignee');
  assert.strictEqual(t.state, 'open');
  assert.strictEqual(t.title, 'build the widget');
  assert.strictEqual(t.opener, 'lead');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] build the widget\ndetail' }],
    'spec delivered to the live seat holding the role, id-prefixed');
  assert.ok(f.injected.some((x) => /ticket t1 → hand/.test(x)), 'lead confirmed');
});

// _teamLiveSeats returns { name, label } for the roster's warmth column, while
// _resolveAssignee and _ticketAssigneeSeat match a SEAT NAME against that list
// through _teamLiveSeatNames. Two shapes over one walk: a consumer wired to the
// wrong one silently resolves nothing, and the role-addressed path above would
// stay green throughout. This is the name-addressed path, which nothing else
// covers.
test('task add (name-addressed): a live seat name resolves as an assignee and receives the spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'team-hand', id: null, body: 'name-addressed work' });
  const t = f.one('t1');
  assert.ok(t, 'ticket persisted');
  assert.strictEqual(t.assignee, 'team-hand', 'the seat NAME is stored as the assignee, not a role');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] name-addressed work' }],
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

test('task add to a role with no live seat: minted, but the lead is warned it was not delivered', () => {
  const f = mkTasks();
  f.seat('lead'); // no team-hand live
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec' });
  assert.strictEqual(f.one('t1').assignee, 'hand', 'role is the durable assignee even with no live seat');
  assert.deepStrictEqual(f.gated, [], 'no live seat → nothing delivered');
  assert.ok(f.injected.some((x) => /no live seat for "hand"/.test(x)), 'lead warned spec not delivered');
});

test('task assign: a backlog ticket gets an assignee and the spec is delivered', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'hand', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'hand');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] the spec' }]);
  assert.ok(f.injected.some((x) => /ticket t1 → hand/.test(x)));
});

test('task reassign: TWO deliveries — old-assignee notice ORDERED BEFORE new-assignee spec', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'assign', id: 't1', who: 'reviewer', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'reviewer', 'reassigned to the new role');
  assert.strictEqual(f.gated.length, 2, 'exactly two deliveries');
  assert.strictEqual(f.gated[0].target, 'team-hand', 'OLD assignee notice first');
  assert.match(f.gated[0].body, /reassigned/);
  assert.strictEqual(f.gated[1].target, 'team-reviewer-1', 'NEW assignee spec second');
  assert.match(f.gated[1].body, /^\[ticket t1\] the spec/);
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

// ── t94: the in-host suffix on a host with no stamp ─────────────────────────
// t93's tests all stubbed _staleHostSuffix, so they pinned what _handleTask
// does with a suffix, never what the method itself computes. A revert that
// deleted the entire t94 wiring from it failed nothing. These drive the real
// method through its seams.

test('t94 the real suffix speaks when there is no stamp and modules changed under the host', () => {
  const f = mkTasks();
  const root = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t94-sm-'));
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
  const root = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t94-sm2-'));
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
  // Exercises the REAL method (not a stub), so the try/catch inside it is what
  // is under test. Pins the contract that instrumentation cannot take down the
  // ticket protocol: the worst a broken stamp may do is say nothing.
  const realSuffix = Object.getPrototypeOf(f.m)._staleHostSuffix;
  assert.strictEqual(typeof realSuffix, 'function', 'ENTER: the real method exists to be exercised');
  assert.strictEqual(realSuffix.call(f.m), '', 'no stamp on disk in a test env ⇒ silent, per fail-closed');

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
  const note = f.injected.join('\n');
  assert.match(note, /parked/,
    'parked must be distinguishable from delivered: the spec is queued, so the lead should wait rather than re-send');
  assert.doesNotMatch(note, /NOT delivered/,
    'but parked is NOT the held wording — it drains on the seat`s next turn, and telling the lead it failed would provoke a duplicate dispatch');
});

test('t82 a DELIVERED spec still confirms cleanly, with no scary NOTE appended', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const note = f.injected.join('\n');
  assert.match(note, /ticket t1 → hand/, 'the ordinary confirmation still reads as before');
  assert.doesNotMatch(note, /NOTE:/,
    'the happy path must stay quiet — a NOTE on every dispatch would train the lead to ignore the ones that matter');
});

test('t82 a HELD watchdog nudge does not consume the one-per-episode nudge', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const stallMs = 60 * 60 * 1000;
  const past = Date.now() - (stallMs * 4);
  const ts = f.load();
  ts[0].lastActivityAt = past;
  tstore.save(f.teamDir, ts);
  // Held: the lead is un-parkable, so it never sees the nudge.
  f.m._gatedDeliver = () => ({ held: 'blocked on a permission dialog' });
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'a held nudge reaches nobody, so it must not burn the single nudge this stall episode gets — otherwise the alarm is silently spent');
  // Parked, by contrast, DOES arrive on the lead's next turn and counts — a park is
  // durable, so the real _gatedDeliver fires onWrite on it (and never on a bare held).
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => {
    if (typeof onWrite === 'function') onWrite();
    return { parked: 'pk-9', reason: 'idle' };
  };
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
  assert.ok(typeof f.one('t1').nudgedAt === 'number',
    'a parked nudge DOES count — it drains on the lead`s next turn, so re-nudging would duplicate it');
});

test('t168 a nudge QUEUED but never written does not spend the stall episode', () => {
  // The A3 half of t168. `nudgedAt` is read back to spend the one nudge a stall
  // episode gets, so stamping it from _gatedDeliver's synchronous return silences
  // the watchdog forever on exactly the ticket it exists to surface — the bytes sit
  // in the queue's ready loop and a boot re-render can wipe them. Modelled by a
  // stub that returns success WITHOUT firing onWrite: the ticket must stay
  // un-nudged, and the next sweep must try again.
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  tstore.save(f.teamDir, ts);
  let calls = 0;
  f.m._gatedDeliver = () => { calls++; return { queued: true }; };  // accepted; never written
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
  assert.strictEqual(calls, 1, 'ENTER: the sweep must have attempted a nudge, or the assertion below is vacuous');
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'queued is not delivered — a nudge whose write never happened must leave the episode UNSPENT');
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
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
test('t168 rework: a nudge written AFTER the seat spoke does not spend the NEW episode', () => {
  const f = mkTasks();
  f.seat('lead'); const hand = f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const stallMs = 60 * 60 * 1000;
  const stall = () => { const ts = f.load(); ts[0].lastActivityAt = Date.now() - (stallMs * 4); tstore.save(f.teamDir, ts); };
  stall();
  let captured = null;
  let calls = 0;
  // Models the real gap: accepted by the queue, written some time later.
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => { calls++; captured = onWrite; return { queued: true }; };
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
  assert.strictEqual(calls, 1, 'ENTER: the sweep found the stall and enqueued a nudge');
  assert.strictEqual(typeof captured, 'function', 'ENTER: the stamp rides onWrite, so there is something to fire late');
  // The seat speaks while the nudge is still in the queue. Real path, not a poke
  // at the store: _reconcileTickets arms the watch map, _touchTicketActivity ends
  // the episode exactly as a PTY turn would.
  f.m._reconcileTickets(f.team, f.teamDir);
  f.m._touchTicketActivity(hand.name);
  assert.strictEqual(f.one('t1').nudgedAt, null, 'ENTER: activity ended the episode');
  captured();
  assert.strictEqual(f.one('t1').nudgedAt, null,
    'the write is about the episode that ENDED — stamping now marks a fresh episode as already-nudged');
  // And the alarm is still armed: the next stall must reach the lead.
  stall();
  f.m._gatedDeliver = (t_, s_, b_, u_, tag_, onWrite) => { calls++; if (typeof onWrite === 'function') onWrite(); return { queued: true }; };
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
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

test('t82 the watchdog nudge itself stays passive (decision: alarm to the lead, but not a work assignment)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const stallMs = 60 * 60 * 1000;
  const ts = f.load();
  ts[0].lastActivityAt = Date.now() - (stallMs * 4);
  tstore.save(f.teamDir, ts);
  f.gated.length = 0; f.urgents.length = 0;
  f.m._sweepTeamTickets({ ...f.team, watchdogMs: stallMs }, f.teamDir, Date.now());
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
  const spillDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t166-'));
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
  return { ...f, spills, recovered, bounce };
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
    assert.doesNotMatch(f.bounce(bounceRe), /NaN|undefined/,
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
  // The seat retires with its ticket open — the other half of the hole.
  f.m.sessions.delete('team-hand');
  const t0 = f.one('t1');
  assert.strictEqual(t0.assignee, 'hand', 'window: assigned to a role the LEAD does not hold…');
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
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', who: null, body: 'done' });
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'reject', id: 't1', who: null, body: 'fix the edge case' });
  const t = f.one('t1');
  assert.strictEqual(t.state, 'open', 'reopened');
  assert.strictEqual(t.assignee, 'hand', 'assignee kept');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1 rejected] fix the edge case' }]);
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
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'the report' });

  // ENTER: two deliveries — [0] the report to the lead, [1] the advance.
  assert.strictEqual(f.gated.length, 2, 'ENTER: the report AND an advance fired');
  assert.strictEqual(f.gated[0].target, 'lead', 'ENTER: [0] is the done-report');
  assert.deepStrictEqual(f.gated[1], { target: 'team-hand', sender: 'clodex-team', body: '[ticket t2] spec two' },
    'the seat is handed the next ticket it holds, id-prefixed like any dispatch');
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
  f.gated.length = 0;

  // Called DIRECTLY with t1 still open — the shape the helper would see if the
  // advance ever ran before the terminal state was saved. Both current callers
  // save first, so no caller can reach this; the guard is what keeps that an
  // ordering detail rather than a correctness dependency.
  assert.strictEqual(f.one('t1').state, 'open', 'ENTER: t1 is still open, so only closedId can exclude it');
  const next = f.m._advanceSeat(f.team, f.teamDir, 'team-hand', 't1');

  assert.strictEqual(next.id, 't2', 'the closed ticket must not be handed back as the seat`s next work');
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'clodex-team', body: '[ticket t2] the genuine next' }]);
});

test('t89 the advance is FIFO, not id order — oldest first when the two disagree', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'closing this one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'minted second, but OLDER' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'minted third, but NEWER' });
  // Force openedAt to CONTRADICT id order: t3 is older than t2. Without this the
  // two orderings agree and the test cannot tell which one the product used.
  const tickets = tstore.load(f.teamDir);
  tickets.find((t) => t.id === 't2').openedAt = 5000;
  tickets.find((t) => t.id === 't3').openedAt = 1000;
  tstore.save(f.teamDir, tickets);
  // ENTER: the disagreement is real — lowest id (t2) is NOT the oldest (t3).
  assert.ok(f.one('t3').openedAt < f.one('t2').openedAt, 'ENTER: openedAt disagrees with id order');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.strictEqual(f.gated.length, 2, 'ENTER: the report AND an advance fired');
  assert.strictEqual(f.gated[1].body, '[ticket t3] minted third, but NEWER',
    'FIFO means OLDEST first: t3 was opened before t2, so id order must not decide the advance');
});

test('t89 the advance skips closed tickets and other seats` work', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand'); f.seat('team-reviewer-1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'closing this' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'already cancelled' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'reviewer', id: null, body: 'not mine' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'backlog, unassigned' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't2', body: 'never mind' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the real next one' });
  // ENTER: the decoys are really in the states this test claims.
  assert.strictEqual(f.one('t2').state, 'cancelled', 'ENTER: t2 is closed');
  assert.strictEqual(f.one('t3').assignee, 'reviewer', 'ENTER: t3 belongs to another seat');
  assert.strictEqual(f.one('t4').assignee, null, 'ENTER: t4 is backlog');
  f.gated.length = 0;

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'done', id: 't1', body: 'report' });

  assert.strictEqual(f.gated.length, 2, 'the report and exactly one advance');
  assert.strictEqual(f.gated[1].body, '[ticket t5] the real next one',
    'a cancelled ticket, another seat`s ticket and a backlog ticket are all skipped');
});

test('t89 the advance follows the TICKET`s seat, so a lead closing over a silent seat restarts it', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec two' });
  f.gated.length = 0; f.urgents.length = 0;

  // The LEAD closes the hand's ticket (the permitted-actor path). The seat that
  // needs restarting is the hand, not the closer.
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'done', id: 't1', body: 'closing for it' });

  assert.strictEqual(f.gated.length, 1, 'ENTER: a lead close sends no report to itself, so [0] is the advance');
  assert.deepStrictEqual(f.gated[0], { target: 'team-hand', sender: 'clodex-team', body: '[ticket t2] spec two' },
    'the advance is keyed on the ticket`s assignee seat — keying it on the closer would leave the silent seat idle, which is the whole defect');
  assert.strictEqual(f.urgents[0], true);
});

test('t89 cancel advances too — it frees the seat exactly as done does', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec one' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec two' });
  f.gated.length = 0; f.urgents.length = 0;

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't1', body: 'never mind' });

  assert.strictEqual(f.gated.length, 2, 'ENTER: the cancellation notice AND an advance');
  assert.strictEqual(f.urgents[0], false, 'the cancellation notice itself still rides passively — stopping is not work');
  assert.deepStrictEqual(f.gated[1], { target: 'team-hand', sender: 'clodex-team', body: '[ticket t2] spec two' });
  assert.strictEqual(f.urgents[1], true, 'but what follows it is');
  assert.ok(f.injected.some((x) => /cancelled — next: t2 delivered to team-hand/.test(x)));
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
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  const m = src.match(/const RECENT_DONE_MS = ([^;]+);/);
  assert.ok(m, 'ENTER: found RECENT_DONE_MS in session-manager.js');
  return Function(`return (${m[1]})`)();
})();

// `agoH` places a close in hours; `agoMs` places one exactly, for the boundary.
function mkAged(rows) {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  const now = Date.now();
  tstore.save(f.teamDir, rows.map((r, i) => ({
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

test('watchdog: a stalled ASSIGNED ticket nudges the lead ONCE; a second sweep is silent', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  // Age the ticket well past the default stall window.
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000; // 1h ago
  tstore.save(f.teamDir, arr);
  f.gated.length = 0;
  f.m._sweepTickets(Date.now());
  const nudges = f.gated.filter((g) => g.target === 'lead' && /stalled/.test(g.body));
  assert.strictEqual(nudges.length, 1, 'exactly one nudge to the lead');
  assert.ok(typeof f.one('t1').nudgedAt === 'number', 'ticket marked nudged');
  f.gated.length = 0;
  f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 0, 'no second nudge in the same episode');
});

test('watchdog: activity resets the stall episode (nudge fires again after a re-stall)', () => {
  const f = mkTasks();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  let arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  tstore.save(f.teamDir, arr);
  f.m._sweepTickets(Date.now());
  assert.ok(f.one('t1').nudgedAt, 'nudged');
  // A turn on the assignee seat resets the episode.
  f.m._emitActivity('team-hand', 'thinking', false);
  assert.strictEqual(f.one('t1').nudgedAt, null, 'activity cleared the nudge episode');
  assert.ok(f.one('t1').lastActivityAt > Date.now() - 5000, 'lastActivityAt bumped to ~now');
  // Re-stall and sweep → nudges again.
  arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  tstore.save(f.teamDir, arr);
  f.gated.length = 0;
  f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1, 're-nudged after the reset');
});

test('watchdog: a BACKLOG (unassigned) stalled ticket is EXEMPT', () => {
  const f = mkTasks();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'backlog' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 60 * 60 * 1000;
  tstore.save(f.teamDir, arr);
  f.gated.length = 0;
  f.m._sweepTickets(Date.now());
  assert.deepStrictEqual(f.gated.filter((g) => /stalled/.test(g.body)), [], 'backlog tickets never nudge');
  assert.strictEqual(f.one('t1').nudgedAt, null);
});

test('watchdog: a per-team watchdogMs override tightens the stall window', () => {
  const f = mkTasks();
  f.team.watchdogMs = 1000; // 1s
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec' });
  const arr = f.load();
  arr[0].lastActivityAt = Date.now() - 5000; // 5s ago — past 1s, well within the 30m default
  tstore.save(f.teamDir, arr);
  f.gated.length = 0;
  f.m._sweepTickets(Date.now());
  assert.strictEqual(f.gated.filter((g) => /stalled/.test(g.body)).length, 1, 'the tighter override fires the nudge');
});

// --- [agent:team <verb>] — T29 Layer A Slice 2 metadata mutation ------------
// Lead-gated (D2) role/watchdog edits. The pure mutators (setRole/removeRole/
// renameRole/setTeamWatchdog) are STUBBED here (capturing calls) — their JSON
// behavior + C1/C4/C6 guards are covered in team-manifest.test.js; this exercises
// _handleTeam's orchestration (lead-gate, verb routing, the C5 seat/ticket
// fail-close, mutator-error surfacing). Uses a real temp teamDir so _roleInUse's
// ticketsStore.load round-trips.
function mkTeamMut(extra = {}) {
  const teamDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-teammut-'));
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(teamDir, 'team.json'),
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    addRole: (t, r, def) => { calls.push(['addRole', t, r, def]); return team; },
    setRole: (t, r, patch) => { calls.push(['setRole', t, r, patch]); return team; },
    removeRole: (t, r) => { calls.push(['removeRole', t, r]); return team; },
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
  return { m, injected, calls, team, teamDir, seat };
}

test('team: lead role-add / role-set call the mutators with the parsed def/patch', () => {
  const f = mkTeamMut();
  f.seat('lead');
  f.m._handleTeam(f.seat('lead'), { type: 'team', sub: 'role-add', name: 'builder', prompt: 'p1', template: 't1', body: 'builds things' });
  assert.deepStrictEqual(f.calls[0], ['addRole', 'team', 'builder',
    { instantiate: 'session', prompt: 'p1', template: 't1', brief: 'builds things' }], 'role-add → addRole with the def');
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
  tstore.save(f.teamDir, [
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
const { isFilenameToken: isFilenameTokenReal, parseAndValidate: parseAndValidateReal } = require('../exec-schema');

function mkExec({ grants = [], entry = null, cmd = 'bridge-reply' } = {}) {
  const REGISTRY_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-exec-'));
  const execDir = pathReal.join(REGISTRY_DIR, 'library', 'exec');
  fsReal.mkdirSync(execDir, { recursive: true });
  if (entry) fsReal.writeFileSync(pathReal.join(execDir, `${cmd}.json`), JSON.stringify(entry));
  const persistence = { list: () => [], get: (n) => (n === 't2' ? { execCommands: grants } : null) };
  const m = mk({
    REGISTRY_DIR, fs: fsReal, path: pathReal, os: osReal,
    childProcess: cpReal, isFilenameToken: isFilenameTokenReal, parseAndValidate: parseAndValidateReal,
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
  assert.match(replies.at(-1), /timed out/);
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-envud-')); // no env-override.env inside
  const m = mk({
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
  return { m, persisted, captured: () => capturedEnv };
}
// Like bashCreate but threads the 19th positional (sessionEnv).
const bashCreateWithEnv = (m, name, sessionEnv) => m.create(
  name, 'bash', osReal.tmpdir(), [], null, 'ws', null, false, null,
  [], [], [], [], [], null, [], [], null, sessionEnv,
);

test('create → PTY env: no scopes reduces to byte-identical { ...process.env, TERM }', async () => {
  // The load-bearing no-behavior-change pin: with nothing set anywhere and no
  // override file, mergeSessionEnv returns exactly { ...process.env }, so the
  // spawned env is byte-for-byte the historical `{ ...process.env, TERM }`.
  const { m, captured } = mkEnvProbe();
  await bashCreate(m, 'env-none', null);
  assert.deepStrictEqual(captured(), { ...process.env, TERM: 'xterm-256color' });
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-tee-'));   // no .claude/settings.json
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-teehome-')); // isolate ~/.claude too
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
  const PENDING_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-remind-pending-'));
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
  const userData = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'remind-race-ud-'));
  const registryDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'remind-race-reg-'));
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
  const userData = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'remind-gone-ud-'));
  const registryDir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'remind-gone-reg-'));
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

// --- flushPending / _flushParkedNow (operator parked-DM flush) ----------------
// PTY-free: drainPending is a spy (records the claim tag), _injectText is stubbed
// so we don't build a real InjectQueue. Covers the three flushPending verdicts
// and the claim-tag / dialog-guard invariants from the spec.

function mkFlush(overrides = {}) {
  const drained = [];
  const m = mk({
    PENDING_DIR: '/tmp/pending-test',
    log: { warn() {}, info() {}, error() {} },
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
  const PENDING_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-pend-ondata-'));
  const m = mk({
    getPersistence: () => ({
      list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {}, remove: () => {},
    }),
    resolveProxyBase: () => null,
    lastTranscriptWrite: () => null,
    pty: fakePty,
    os: osReal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
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
  await new Promise((r) => setTimeout(r, 50));   // let the InjectQueue drain
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
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(writes, [], 'a passive-only store is not drained by the boot-ready edge');
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
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(writes, [], 'draft open → not injected (no splice)');
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
  await new Promise((r) => setTimeout(r, 20));  // let the drain enqueue the (now-held) producer
  assert.ok(hasPending(PENDING_DIR, 'boot-g'), 'producer held at the ready-gate — nothing claimed yet');
  assert.deepStrictEqual(writes, [], 'and nothing written yet');
  // Operator opens a draft in the enqueue→fire window, THEN the loop signals ready.
  s.lastUserInputTs = Date.now();               // isDraftOpen → true at fire time
  s._bootReadySeen = true;                       // release the producer (fires within a ready-poll)
  await new Promise((r) => setTimeout(r, 400));  // > readyPollMs (250) so the producer definitely fires
  assert.deepStrictEqual(writes, [], 'fire-time re-check saw the draft → claimed nothing, wrote nothing');
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
function withVerb(spec, fn) {
  intentRegistry.registerIntent(spec, spec.source || 'fake-plugin');
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
  const REGISTRY_DIR = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t57-'));
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
  assert.strictEqual(waits, 3,
    `expected exactly 3 waitForSessionExit call sites (engine.js restart x2, ipc-handlers.js session:kill) and found ${waits} — if a fourth kill+create caller was added, extend the ordering pin above to cover it rather than bumping this number`);
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
