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
const { createSessionManager, isStaleRegistration } = require('../session-manager');
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
    fencedLines: require('../intent-scanner').fencedLines, // real pure leaf — _extractIntents maps fences unconditionally
    fs: require('node:fs'), // real — create()'s pre-spawn cwd validation stats it
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
  assert.strictEqual(injected[0], '[agent:exec] the exec intent is disabled for this session');
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
const { parkDelivery, drainPending, hasPending, hasActivePending } = require('../pending-store');
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
  m._injectText = (s, text) => injected.push(text);
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

test('_drainPendingAtIdle: a mixed store drains fully — passives ride along with the active', () => {
  const { m, PENDING_DIR, injected } = mkPark();
  parkDelivery(PENDING_DIR, 'a', '[agent:from monitor] tick', '1', null, true);
  parkDelivery(PENDING_DIR, 'a', '[agent:from x] hi', '2');
  m._drainPendingAtIdle({ name: 'a', agentType: 'claude' });
  assert.deepStrictEqual(injected, ['[agent:from monitor] tick', '[agent:from x] hi'],
    'the active DM justifies the turn; the passive rides with it, in order');
  assert.strictEqual(hasPending(PENDING_DIR, 'a'), false);
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

test('_onIncoming: an unknown delivery value falls through to the normal path (old-core compat shape)', () => {
  const { m } = mkPark();
  const delivered = [];
  m._deliverMessage = (name, sender, body) => delivered.push(body);
  m._onIncoming('a', { from: 'x', body: 'hi', type: 'dm', delivery: 'someday-class' });
  assert.deepStrictEqual(delivered, ['hi']);
});

// --- team-retire (docs/teams-design.md): socket envelope → archive|discard --

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
// The context architecture (docs/teams-design.md): a seat's composition rides as
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

test('_notifyComposition: teamless / dep-less session is a no-op, never throws into teardown', () => {
  const { m } = mkPark(); // no resolveTeam dep at all (archive/kill call this)
  m.sessions.set('a', { name: 'a', agentType: 'claude', cwd: '/x' });
  m.sessions.set('b', { name: 'b', agentType: 'claude', cwd: '/x' });
  const passive = [];
  m._deliverPassive = (...args) => passive.push(args);
  assert.doesNotThrow(() => m._notifyComposition(m.sessions.get('a'), 'spawned'));
  assert.deepStrictEqual(passive, [], 'no team dep → no deltas, no throw');
});

test('_injectRoster: delivers the initial roster from sender team, listing live seats', () => {
  const { m } = mkPark(teamDeps);
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', cwd: '/proj/a' });
  m.sessions.set('team-dev', { name: 'team-dev', agentType: 'claude', cwd: '/proj/b' });
  const delivered = [];
  m._deliverMessage = (t, s, b, mt) => delivered.push({ t, s, b, mt });
  m._injectRoster(m.sessions.get('lead'), teamStub);
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].t, 'lead');
  assert.strictEqual(delivered[0].s, 'team');
  assert.match(delivered[0].b, /\[team team\] roster \(lead: lead\)/);
  assert.match(delivered[0].b, /- lead \(session\) — the lead · live: lead/);
  assert.match(delivered[0].b, /- dev \(session\) — the dev · live: team-dev/);
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
  assert.deepStrictEqual(exitEventOf(sent), ['b-crash', 'session-exit', 'b-crash', 1, { expected: false, signal: null, agentType: null }]);
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
  assert.deepStrictEqual(exitEventOf(sent), ['b-killed', 'session-exit', 'b-killed', 1, { expected: true, signal: 15, agentType: null }]);
  // Expected exit with a signal → `code=1 signal=15` (no ` unexpected`).
  assert.strictEqual(exitLogOf(broadcasts).body, 'code=1 signal=15');
});

test('session-exit: app-quit teardown (killAll) sends expected:true', async () => {
  const { m, sent, broadcasts, exit } = mkExitProbe();
  await bashCreate(m, 'b-quit', null);
  await m.killAll();
  exit({ exitCode: 0, signal: 15 });
  assert.deepStrictEqual(exitEventOf(sent), ['b-quit', 'session-exit', 'b-quit', 0, { expected: true, signal: 15, agentType: null }]);
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
    ...overrides,
  });
  m._drained = drained;
  m._injected = [];
  m._injectText = (session, text, opts) => m._injected.push({ name: session.name, text, opts });
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

test('flushPending: happy path claims with a flush.<pid> tag and injects each parked message', () => {
  const m = mkFlush({ _texts: ['m1', 'm2'] });
  m.sessions.set('a', { name: 'a', agentType: 'claude', activityState: 'idle' });
  const r = m.flushPending('a');
  assert.deepStrictEqual(r, { ok: true, count: 2 });
  assert.strictEqual(m._drained.length, 1);
  assert.match(m._drained[0].tag, /^flush\./, 'operator flush uses a flush.<pid> claim tag');
  assert.deepStrictEqual(m._injected.map(x => x.text), ['m1', 'm2']);
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
