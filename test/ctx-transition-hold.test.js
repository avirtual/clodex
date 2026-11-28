'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const pend = require('../pending-store');

const HOUR = 3_600_000;

function rig({ root = mkTmpRoot('clx-ctxhold-'), session = {} } = {}) {
  const PENDING_DIR = path.join(root, 'pending');
  const casts = [];
  const persisted = new Map();
  const m = mk({
    REGISTRY_DIR: root, PENDING_DIR,
    fs, path,
    pathFor: require('../clodex-paths').pathFor, runDirFor: require('../clodex-paths').runDirFor,
    parkDelivery: pend.parkDelivery, drainPending: pend.drainPending,
    hasActivePending: pend.hasActivePending, countPending: pend.countPending, parkIdInUse: pend.parkIdInUse, parkedTexts: pend.parkedTexts,
    randBase36: (n) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0'),
    isDraftOpen: require('../proxy-util').isDraftOpen,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    isHumanPtyInput: require('../proxy-util').isHumanPtyInput,
    draftChunkSignal: require('../proxy-util').draftChunkSignal,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    shadowIntentKey: require('../intent-scanner').shadowIntentKey,
    execBodyCap: 64 * 1024,
    isInjectInFlight: require('../inject-queue').isInjectInFlight,
    stripLevelOf: () => 0,
    getPersistence: () => ({
      list: () => [...persisted.values()],
      get: (n) => persisted.get(n) || null,
      upsert: (e) => persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }),
      remove: (n) => persisted.delete(n),
      setSessionId: () => {},
    }),
    INJECT_QUIET_MS: 4000, INJECT_QUIET_MAXWAIT: 3_600_000, INJECT_BOOT_MAXWAIT: 60_000,
    INJECT_HOLD_TIMEOUT: 60_000, COMPACT_INFLIGHT_TIMEOUT: 300_000, COMPACT_CONTINUATION_DELAY: 1500,
    RELOAD_CONTINUATION_DELAY: 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  const written = [];
  const queue = {
    length: 0,
    enqueue(text, opts) {
      const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
      if (out == null || out === '') return;
      written.push(out);
    },
  };
  m._injectQueueFor = (s) => { s._injectPtyQueue = queue; return queue; };
  m._broadcast = (ch, p) => casts.push({ ch, p });
  m._sendToSession = () => {};
  m._buildDeliveryText = (_t, from, body) => `[agent:from ${from}] ${body}`;
  m._promptDeltaPending = () => false;
  m._handoffText = (_s, t) => `HANDOFF ${t}`;
  m._activity = { lastEventTs: () => 0, turnCompleted: (agent) => m._emitActivity(agent, 'idle', true) };
  const s = {
    name: 'a', type: 'claude', agentType: 'claude', io: 'pty', intentSource: 'wire',
    sessionId: 'sid-A', activityState: 'idle', activityTs: Date.now(), createdAt: 1, ...session,
  };
  m.sessions.set('a', s);
  persisted.set('a', { name: 'a', type: 'claude', createdAt: 1 });
  return { m, s, root, PENDING_DIR, written, casts, onDisk: () => pend.countPending(PENDING_DIR, 'a') };
}

function parkWhileBusy(h, body) {
  h.s.activityState = 'thinking';
  h.m._deliverMessage('a', 'bob', body, 'dm');
  assert.strictEqual(h.written.length, 0, `ENTER: ${body} parked, not typed`);
}

const ticks = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

test('wire seat: mail parked during the clearing turn is not typed before /clear and reaches the new conversation once', async () => {
  const h = rig({ session: { activityState: 'thinking' } });
  h.m._handleIntent = (agent, intent) => {
    if (intent.type === 'context') h.m._handleContextIntent(h.m.sessions.get(agent), intent.sub, intent.body || '');
  };
  for (const k of ['_publishAgentText', '_maybeSpeak', '_maybeDeliverDigest', '_nudgeTicketClaims', '_maybeRearmHold', '_maybeFireCompactLatch']) h.m[k] = () => {};
  const wire = await h.m._ensureWire();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    parkWhileBusy(h, 'PARKED-IN-TURN');
    assert.strictEqual(h.onDisk(), 1);
    wire.emit('turn.completed', {
      agent: 'a', text: 'done\n[agent:context clear] carry on', reqId: 'r1', sessionId: 'sid-A',
      stop: { is_turn: true, stop_reason: 'end_turn' },
    });
    await ticks();
    assert.deepStrictEqual(h.written, ['/clear'], 'nothing is typed ahead of /clear');
    assert.strictEqual(h.onDisk(), 1, 'the parked mail is still on disk');
    assert.strictEqual(h.m._injectHoldReason(h.s), 'clear-window');

    h.s._leftSessionIds = ['sid-A'];
    h.s.sessionId = 'sid-B';
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'continuation');
    h.m._firePostClearContinuation(h.s);
    mock.timers.tick(1500);
    assert.deepStrictEqual(h.written, ['/clear', 'HANDOFF carry on']);
    assert.strictEqual(h.onDisk(), 1, 'still held while the continuation turn has not started');

    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(h.m._injectHoldReason(h.s), 'busy', 'released at the continuation turn start');
    assert.strictEqual(h.written.length, 2, 'and not drained into the continuation turn');
    h.m._emitActivity('a', 'idle', true);
    assert.strictEqual(h.written.length, 3);
    assert.match(h.written[2], /PARKED-IN-TURN/);
    h.m._emitActivity('a', 'thinking');
    h.m._emitActivity('a', 'idle', true);
    assert.strictEqual(h.written.filter((w) => /PARKED-IN-TURN/.test(w)).length, 1, 'exactly once');
  } finally {
    mock.timers.reset();
    await wire.close();
    if (h.m._holdKeeper) h.m._holdKeeper.stop();
  }
});

for (const [label, send] of [
  ['peer dm', (h) => h.m._gatedDeliver('a', 'bob', 'DM-BODY', false)],
  ['ticket-loop notice', (h) => h.m._gatedDeliver('a', 'ticket-loop', '[ticket t1 MERGED] NOTICE-BODY', false)],
  ['reminder', (h) => h.m._deliverReminder('a', 'REMINDER-BODY')],
  ['exec reply', (h) => h.m._injectText(h.s, '[agent:exec x] EXEC-BODY', { parkable: true })],
]) {
  test(`held between acceptance and the session-id change, then delivered once: ${label}`, () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const h = rig();
      h.m._handleContextIntent(h.s, 'clear', '');
      assert.deepStrictEqual(h.written, ['/clear']);
      send(h);
      assert.deepStrictEqual(h.written, ['/clear'], `${label} is not typed during the window`);
      assert.strictEqual(h.onDisk(), 1, `${label} waits on disk`);
      h.s._leftSessionIds = ['sid-A'];
      assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'released');
      assert.strictEqual(h.written.length, 2);
      assert.match(h.written[1], /-BODY/);
      h.m._emitActivity('a', 'thinking');
      h.m._emitActivity('a', 'idle', true);
      assert.strictEqual(h.written.length, 2, 'once');
    } finally { mock.timers.reset(); }
  });
}

test('reload: mail present at the idle edge stays on disk across the kill and reaches the respawned seat', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    parkWhileBusy(h, 'RELOAD-MAIL');
    h.s.activityState = 'idle';
    const old = h.s;
    let fresh = null;
    h.m.kill = async (name) => { old._dead = true; h.m.sessions.delete(name); };
    h.m.create = async (name) => {
      fresh = { name, type: 'claude', agentType: 'claude', io: 'pty', activityState: 'idle', activityTs: Date.now(), createdAt: 1 };
      h.m.sessions.set(name, fresh);
    };
    let injected = null;
    h.m._injectReloadHandoff = (sess, text, _t, _why, gen) => { injected = { sess, text, gen }; };
    for (const k of ['_dropRosterSent', '_reattachAction', '_preserveAcrossRestart']) h.m[k] = () => null;
    h.m.resumeCwdOf = () => '/tmp';
    const errs = [];
    h.m._sendRespawnFailed = (_n, _e, err) => errs.push(err);
    h.m._handleContextIntent(old, 'reload', 'next steps');
    assert.strictEqual(h.m._injectHoldReason(old), 'reload-window');
    h.m._drainPendingAtIdle(old);
    assert.deepStrictEqual(h.written, [], 'the idle-edge drain types nothing into the CLI about to die');
    await new Promise((r) => setImmediate(r));
    await ticks();
    assert.deepStrictEqual(errs, []);
    assert.ok(fresh && injected && injected.sess === fresh, 'ENTER: the seat respawned and the handoff was routed');
    assert.strictEqual(h.onDisk(), 1, 'the mail is still on disk after the kill');
    h.m._ctxHoldOnBootReady(fresh);
    h.m._drainPendingAtBootReady(fresh);
    assert.deepStrictEqual(h.written, [], 'boot-ready drain is held while the handoff is pending');
    h.m._ctxHoldTyped('a', injected.gen);
    h.m._emitActivity('a', 'thinking');
    h.m._emitActivity('a', 'idle', true);
    assert.strictEqual(h.written.length, 1);
    assert.match(h.written[0], /RELOAD-MAIL/);
  } finally { mock.timers.reset(); }
});

test('a clear that never lands: after an hour the hold is set, mail on disk, operator told once, state failed; a badge click releases', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', 'cont');
    h.m._gatedDeliver('a', 'bob', 'STUCK-BODY', false);
    assert.strictEqual(h.m.ctxHoldState('a'), 'clearing');
    for (let i = 0; i < 60; i++) mock.timers.tick(60_000);
    assert.strictEqual(h.m._injectHoldReason(h.s), 'clear-window');
    assert.strictEqual(h.onDisk(), 1);
    assert.deepStrictEqual(h.written, ['/clear']);
    assert.strictEqual(h.casts.filter((c) => c.p && c.p.kind === 'context-stuck').length, 1, 'told once');
    assert.strictEqual(h.m.ctxHoldState('a'), 'clear did not complete');
    assert.strictEqual(h.s.needsAttention && h.s.needsAttention.kind, 'context-stuck');
    h.m.flushPending('a');
    assert.strictEqual(h.m._ctxHoldReason(h.s), null);
    assert.ok(h.written.some((w) => /STUCK-BODY/.test(w)), 'the click delivered the held mail');
    assert.strictEqual(h.casts.filter((c) => c.p && c.p.kind === 'context-stuck').length, 1);
  } finally { mock.timers.reset(); }
});

test('operator keystrokes release a failed hold and are never gated', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const h = rig();
    const typed = [];
    h.s.pty = { write: (d) => typed.push(d) };
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m.write('a', 'x');
    assert.deepStrictEqual(typed, ['x']);
    assert.strictEqual(h.m._ctxHoldReason(h.s), 'clear-window', 'an in-flight hold survives a keystroke');
    h.m._failCtxHold('a', h.m._ctxHoldMap().get('a').gen, 'test');
    h.m.write('a', 'y');
    assert.deepStrictEqual(typed, ['x', 'y']);
    assert.strictEqual(h.m._ctxHoldReason(h.s), null);
  } finally { mock.timers.reset(); }
});

test('a stale session-id event for generation N-1 does not release generation N', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    const n1 = h.m._ctxHoldMap().get('a').gen;
    h.s._leftSessionIds = ['sid-A'];
    h.s.sessionId = 'sid-B';
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'released');
    h.m._handleContextIntent(h.s, 'clear', '');
    const n2 = h.m._ctxHoldMap().get('a').gen;
    assert.ok(n2 > n1);
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-B', 'sid-A'), 'stale', 'an echo of gen N-1\'s old conversation');
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'stale', 'gen N-1\'s new id is gen N\'s old one');
    assert.strictEqual(h.m._releaseCtxHold('a', n1, 'stale'), false);
    h.m._ctxHoldTyped('a', n1);
    assert.strictEqual(h.m._ctxHoldMap().get('a').typed, false);
    assert.strictEqual(h.m._ctxHoldReason(h.s), 'clear-window');
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-B', 'sid-C'), 'released');
  } finally { mock.timers.reset(); }
});

test('the replaced CLI never releases a reload hold', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    const rec = h.m._armCtxHold(h.s, 'reload', { cont: true, respawn: true });
    h.s._ctxGen = rec.gen - 1;
    h.m._ctxHoldTyped('a', rec.gen);
    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(h.m._ctxHoldReason(h.s), 'reload-window');
  } finally { mock.timers.reset(); }
});

test('restart mid-transition: the hold and the mail survive, no failure notice, the boot path releases it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const root = mkTmpRoot('clx-ctxhold-restart-');
    const a = rig({ root });
    a.m._handleContextIntent(a.s, 'clear', 'cont');
    a.m._gatedDeliver('a', 'bob', 'RESTART-BODY', false);
    assert.strictEqual(a.onDisk(), 1);
    const b = rig({ root });
    assert.strictEqual(b.m._injectHoldReason(b.s), 'clear-window');
    assert.strictEqual(b.m._ctxHoldMap().get('a').state, 'restored');
    assert.strictEqual(b.m.ctxHoldState('a'), 'clearing');
    assert.strictEqual(b.onDisk(), 1);
    b.m._drainPendingAtIdle(b.s);
    assert.deepStrictEqual(b.written, []);
    assert.strictEqual(b.casts.filter((c) => c.p && c.p.kind === 'context-stuck').length, 0, 'a restart is not a failure');
    b.s._bootReadySeen = true;
    b.m._ctxHoldOnBootReady(b.s);
    assert.strictEqual(b.m._ctxHoldReason(b.s), null, 'the boot path of the restored seat releases it');
    assert.ok(b.written.some((w) => /RESTART-BODY/.test(w)));
  } finally { mock.timers.reset(); }
});

test('the age wake does not fire for a seat in the hold', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const at = Date.now() - 2 * HOUR;
    const park = (r) => pend.parkDelivery(r.PENDING_DIR, 'a', '[agent:from bob] OLD-MAIL', 1, null, false, 1, null, null, at);
    const control = rig();
    control.m._parkWakeHours = () => 1;
    park(control);
    assert.deepStrictEqual(control.m._sweepParkWake(Date.now()), ['a'], 'ENTER: without the clear the 2h-old mail wakes the seat');
    const h = rig();
    h.m._parkWakeHours = () => 1;
    park(h);
    h.m._handleContextIntent(h.s, 'clear', '');
    assert.deepStrictEqual(h.m._sweepParkWake(Date.now()), []);
    assert.deepStrictEqual(h.written, ['/clear']);
    assert.strictEqual(h.onDisk(), 1);
  } finally { mock.timers.reset(); }
});

test('jsonl-intent seat: a clear handled ahead of the idle flip holds the idle drain', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig({ session: { intentSource: 'jsonl' } });
    parkWhileBusy(h, 'JSONL-MAIL');
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._emitActivity('a', 'idle', true);
    assert.deepStrictEqual(h.written, ['/clear']);
    assert.strictEqual(h.m._injectHoldReason(h.s), 'clear-window');
    assert.strictEqual(h.onDisk(), 1);
  } finally { mock.timers.reset(); }
});

test('a second clear while one is in flight keeps today\'s drop', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', 'first');
    const gen = h.m._ctxHoldMap().get('a').gen;
    h.m._handleContextIntent(h.s, 'clear', 'second');
    assert.deepStrictEqual(h.written, ['/clear']);
    assert.strictEqual(h.s._postClearContinuation, 'first');
    assert.strictEqual(h.m._ctxHoldMap().get('a').gen, gen);
    assert.ok(h.casts.some((c) => c.p && c.p.body === 'context clear → dropped (already in flight)'));
  } finally { mock.timers.reset(); }
});

test('the continuation passes only its own window: a busy seat still holds it until idle', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', 'go on');
    h.s._leftSessionIds = ['sid-A'];
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'continuation');
    h.m._firePostClearContinuation(h.s);
    h.s.activityState = 'thinking';
    mock.timers.tick(1500);
    assert.deepStrictEqual(h.written, ['/clear'], 'held while busy');
    h.m._emitActivity('a', 'idle', true);
    assert.deepStrictEqual(h.written, ['/clear', 'HANDOFF go on']);
    assert.strictEqual(h.m._ctxHoldReason(h.s), 'clear-window', 'typed but its turn has not started');
  } finally { mock.timers.reset(); }
});

for (const [agentType, cmd] of [['codex', '/clear'], ['muse', '/clear']]) {
  test(`${agentType} seat: a clear arms no hold and mail is typed as before`, () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const h = rig({ session: { type: agentType, agentType } });
      h.m._handleContextIntent(h.s, 'clear', '');
      assert.deepStrictEqual(h.written, [cmd], `ENTER: ${agentType} has a clear command`);
      assert.strictEqual(h.m._ctxHoldMap().has('a'), false);
      assert.strictEqual(h.m._injectHoldReason(h.s), null);
      h.m._injectText(h.s, 'AFTER-CLEAR', { parkable: true });
      assert.deepStrictEqual(h.written, [cmd, 'AFTER-CLEAR']);
    } finally { mock.timers.reset(); }
  });
}

test('the pre-arm reads the line as the dispatcher does: an emphasised clear is pre-armed', () => {
  const h = rig();
  h.m._preArmCtxHold(h.s, 'done\n**[agent:context clear]**');
  assert.strictEqual(h.s._ctxPreArmed, 'clear');
  assert.strictEqual(h.m._injectHoldReason(h.s), 'clear-window');
});

test('a failed clear whose own session-id edge arrives late completes and releases', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._failCtxHold('a', h.m._ctxHoldMap().get('a').gen, 'test');
    assert.strictEqual(h.m.ctxHoldState('a'), 'clear did not complete');
    h.s._leftSessionIds = ['sid-A'];
    assert.strictEqual(h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B'), 'released');
    assert.strictEqual(h.m._ctxHoldReason(h.s), null);
    assert.strictEqual(h.s.needsAttention, null);
  } finally { mock.timers.reset(); }
});

test('a failed hold keeps its attention across a turn start and is a request row', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._failCtxHold('a', h.m._ctxHoldMap().get('a').gen, 'test');
    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(h.s.needsAttention && h.s.needsAttention.kind, 'context-stuck');
    assert.strictEqual(h.s.needsAttention.message, 'clear did not complete');
  } finally { mock.timers.reset(); }
});

test('the row shows the transition in words while it is in flight', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    const rows = [];
    h.m._sendToSession = (_n, ch, _name, c) => { if (ch === 'session-compacting') rows.push(c && c.trigger); };
    h.m._handleContextIntent(h.s, 'clear', '');
    assert.deepStrictEqual(h.m.ctxHoldBadge('a').trigger, 'clearing');
    h.s._leftSessionIds = ['sid-A'];
    h.m._ctxHoldSessionEdge(h.s, 'sid-A', 'sid-B');
    assert.deepStrictEqual(rows, ['clearing', null]);
    assert.strictEqual(h.m.ctxHoldBadge('a'), null);
  } finally { mock.timers.reset(); }
});

test('a wire session rotation is a session-id edge for the hold', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._wireSessionCorroborated = () => true;
    h.m._noteConversationForDigest = () => {};
    h.m._onWireSessionRotated(h.s, 'a', 'sid-B');
    assert.strictEqual(h.m._ctxHoldReason(h.s), null);
  } finally { mock.timers.reset(); }
});

test('a dropped seat drops its hold record', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._dropCtxHold('a');
    assert.strictEqual(h.m._ctxHoldMap().has('a'), false);
    assert.strictEqual(rig({ root: h.root }).m._ctxHoldMap().has('a'), false, 'and the file forgets it');
  } finally { mock.timers.reset(); }
});

test('a compact accepted while a clear is in flight keeps today\'s path and the clear hold', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig({ session: { intentSource: 'jsonl' } });
    h.m._handleContextIntent(h.s, 'clear', '');
    const gen = h.m._ctxHoldMap().get('a').gen;
    h.m._handleContextIntent(h.s, 'compact', '');
    assert.deepStrictEqual(h.written, ['/clear', '/compact']);
    assert.strictEqual(h.m._ctxHoldMap().get('a').gen, gen);
    assert.strictEqual(h.m._ctxHoldReason(h.s), 'clear-window');
  } finally { mock.timers.reset(); }
});

test('a second reload while one is in flight keeps today\'s drop', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m.kill = async () => {};
    h.m._handleContextIntent(h.s, 'reload', 'first');
    const gen = h.m._ctxHoldMap().get('a').gen;
    h.m._handleContextIntent(h.s, 'reload', 'second');
    assert.strictEqual(h.m._ctxHoldMap().get('a').gen, gen);
    assert.strictEqual(h.s._reloadInFlight, true);
  } finally { mock.timers.reset(); }
});

function hookRun(h, ev = 'PostToolUse') {
  const { createCliHooks } = require('../cli-hooks');
  const { pathFor } = require('../clodex-paths');
  const hooks = createCliHooks({
    REGISTRY_DIR: h.root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  if (!h.hookReady) { hooks.setupClaudeHook('a'); h.hookReady = true; }
  const out = require('node:child_process').execFileSync('bash', [pathFor(h.root, 'a', 'pendingScript')],
    { timeout: 30000, killSignal: 'SIGKILL', input: JSON.stringify({ hook_event_name: ev }) }).toString();
  const delivered = pathFor(h.root, 'a', 'delivered');
  return { out, delivered: fs.existsSync(delivered) ? fs.readFileSync(delivered, 'utf8') : '' };
}

function storeSnapshot(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

test('the CLI hook drain claims nothing while a hold is set; release delivers the three in order with their names and bytes', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    for (const b of ['HM-1', 'HM-2', 'HM-3']) parkWhileBusy(h, b);
    h.s.activityState = 'idle';
    const before = storeSnapshot(pend.agentDir(h.PENDING_DIR, 'a'));
    assert.strictEqual(before.length, 3, 'ENTER: three parked');
    h.m._handleContextIntent(h.s, 'clear', '');
    const gen = h.m._ctxHoldMap().get('a').gen;
    for (const ev of ['PostToolUse', 'UserPromptSubmit']) {
      const r = hookRun(h, ev);
      assert.strictEqual(r.out, '', `${ev}: the hook hands nothing over`);
      assert.strictEqual(r.delivered, '', `${ev}: no delivered.jsonl row`);
    }
    assert.strictEqual(h.onDisk(), 3, 'the badge still counts them');
    assert.deepStrictEqual(storeSnapshot(pend.heldDir(h.PENDING_DIR, 'a')), before);
    h.s.activityState = 'thinking';
    h.m._releaseCtxHold('a', gen, 'test');
    assert.deepStrictEqual(storeSnapshot(pend.agentDir(h.PENDING_DIR, 'a')), before, 'back under their names, bytes unchanged');
    assert.strictEqual(pend.isHeld(h.PENDING_DIR, 'a'), false);
    h.s.activityState = 'idle';
    h.m._drainPendingAtIdle(h.s);
    const all = h.written.join('\n');
    assert.deepStrictEqual(['HM-1', 'HM-2', 'HM-3'].map((b) => all.split(b).length - 1), [1, 1, 1]);
    assert.ok(all.indexOf('HM-1') < all.indexOf('HM-2') && all.indexOf('HM-2') < all.indexOf('HM-3'), 'in order');
  } finally { mock.timers.reset(); }
});

test('mail arriving during the hold is hidden too; a failed hold keeps it hidden and counted until the badge click', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', 'cont');
    h.m._gatedDeliver('a', 'bob', 'LATE-BODY', false);
    assert.strictEqual(hookRun(h).out, '');
    for (let i = 0; i < 60; i++) mock.timers.tick(60_000);
    assert.strictEqual(h.m.ctxHoldState('a'), 'clear did not complete', 'ENTER: the hold failed');
    assert.strictEqual(hookRun(h).out, '', 'a failed hold still hides the mail from the hook');
    assert.strictEqual(h.m.pendingCountFor('a'), 1);
    assert.strictEqual(h.onDisk(), 1);
    h.m.flushPending('a');
    assert.ok(h.written.some((w) => /LATE-BODY/.test(w)), 'the click delivered it');
    assert.strictEqual(pend.isHeld(h.PENDING_DIR, 'a'), false);
  } finally { mock.timers.reset(); }
});

test('restart mid-hold: hidden mail stays hidden and is restored with the hold at boot-ready', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const root = mkTmpRoot('clx-ctxhold-hidden-restart-');
    const a = rig({ root });
    a.m._handleContextIntent(a.s, 'clear', 'cont');
    a.m._gatedDeliver('a', 'bob', 'RS-BODY', false);
    const b = rig({ root });
    b.m._ctxHoldMap();
    assert.strictEqual(pend.isHeld(b.PENDING_DIR, 'a'), true, 'the hidden store survives the restart');
    assert.strictEqual(hookRun(b).out, '');
    b.s._bootReadySeen = true;
    b.m._ctxHoldOnBootReady(b.s);
    assert.strictEqual(pend.isHeld(b.PENDING_DIR, 'a'), false);
    assert.ok(b.written.some((w) => /RS-BODY/.test(w)));
  } finally { mock.timers.reset(); }
});

test('boot: a hidden store with no hold record is moved back, never orphaned', () => {
  const h = rig();
  pend.parkDelivery(h.PENDING_DIR, 'a', 'ORPHAN', '100.000000001', null, false, 1);
  pend.hideParked(h.PENDING_DIR, 'a');
  assert.strictEqual(pend.hasActivePending(h.PENDING_DIR, 'a'), false, 'ENTER: hidden');
  const b = rig({ root: h.root });
  b.m.startPendingPoll(3_600_000);
  clearInterval(b.m._pendingPollTimer);
  assert.strictEqual(pend.isHeld(b.PENDING_DIR, 'a'), false);
  assert.deepStrictEqual(pend.parkedTexts(b.PENDING_DIR, 'a'), ['ORPHAN']);
  assert.strictEqual(pend.hasActivePending(b.PENDING_DIR, 'a'), true);
});

test('deleting the seat removes its hidden mail with its other pending files', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = rig();
    h.m._handleContextIntent(h.s, 'clear', '');
    h.m._gatedDeliver('a', 'bob', 'DEL-BODY', false);
    assert.strictEqual(pend.isHeld(h.PENDING_DIR, 'a'), true, 'ENTER: hidden');
    h.m._dropPendingDir('a');
    h.m._dropCtxHold('a');
    assert.strictEqual(pend.isHeld(h.PENDING_DIR, 'a'), false);
    assert.strictEqual(h.onDisk(), 0);
  } finally { mock.timers.reset(); }
});

function gapRig() {
  const h = rig();
  const old = h.s;
  let open;
  const gate = new Promise((r) => { open = r; });
  let fail = null;
  h.m.kill = async (name) => { old._dead = true; h.m.sessions.delete(name); };
  h.m.create = async (name) => {
    await gate;
    if (fail) throw new Error(fail);
    h.fresh = { name, type: 'claude', agentType: 'claude', io: 'pty', activityState: 'idle', activityTs: Date.now(), createdAt: 1 };
    h.m.sessions.set(name, h.fresh);
  };
  h.m._injectReloadHandoff = () => {};
  for (const k of ['_dropRosterSent', '_reattachAction', '_preserveAcrossRestart']) h.m[k] = () => null;
  h.m.resumeCwdOf = () => '/tmp';
  h.errs = [];
  h.m._sendRespawnFailed = (_n, _e, err) => h.errs.push(err);
  h.bob = { name: 'bob', type: 'claude', agentType: 'claude', io: 'pty', activityState: 'idle', activityTs: Date.now(), createdAt: 2 };
  h.m.sessions.set('bob', h.bob);
  h.open = (why) => { fail = why || null; open(); };
  h.old = old;
  return h;
}

async function deliverInGap(h) {
  h.m._handleContextIntent(h.old, 'reload', 'next');
  await new Promise((r) => setImmediate(r));
  await ticks();
  assert.strictEqual(h.m.sessions.has('a'), false, 'ENTER: in the gap');
  await h.m._handleIntent('bob', { type: 'dm', target: 'a', body: 'GAP-DM' });
  assert.strictEqual(h.m._deliverReminder('a', 'GAP-REM'), 'parked');
  const r = h.m._gatedDeliver('a', 'ticket-loop', 'GAP-NOTE', false, '[ticket t9 MERGED]');
  assert.ok(r.parked && !r.queued, 'a parked notice, not a typed one');
  assert.strictEqual(r.reason, 'reloading');
  assert.ok(h.written.some((w) => w.startsWith('[agent:dm] parked for a (reloading) as ')), 'the sender is told the seat is reloading');
  assert.strictEqual(h.onDisk(), 3);
  assert.strictEqual(hookRun(h).out, '', 'hidden from the hook like any held mail');
}

test('reload gap: a dm, a reminder and a ticket-loop notice are each delivered once to the respawned seat', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = gapRig();
    await deliverInGap(h);
    h.open();
    await ticks();
    assert.deepStrictEqual(h.errs, []);
    assert.ok(h.fresh, 'ENTER: respawned');
    h.fresh._bootReadySeen = true;
    h.m._ctxHoldOnBootReady(h.fresh);
    h.m._drainPendingAtBootReady(h.fresh);
    assert.strictEqual(h.written.join('\n').includes('GAP-DM'), false, 'held while the handoff is pending');
    h.m._ctxHoldTyped('a', h.m._ctxHoldMap().get('a').gen);
    h.m._emitActivity('a', 'thinking');
    h.m._emitActivity('a', 'idle', true);
    const all = h.written.join('\n');
    assert.deepStrictEqual(['GAP-DM', 'GAP-REM', 'GAP-NOTE'].map((b) => all.split(b).length - 1), [1, 1, 1]);
    assert.strictEqual(h.onDisk(), 0);
  } finally { mock.timers.reset(); }
});

test('reload gap: a failed respawn keeps all three on disk and counted; the name is no longer reserved', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = gapRig();
    await deliverInGap(h);
    h.open('boom');
    await ticks();
    assert.strictEqual(h.errs.length, 1, 'ENTER: respawn failed');
    assert.strictEqual(h.m.ctxHoldState('a'), 'reload did not complete');
    assert.strictEqual(h.onDisk(), 3);
    assert.strictEqual(hookRun(h).out, '');
    assert.deepStrictEqual(h.m._gatedDeliver('a', 'bob', 'AFTER', false), { error: 'no such agent "a"' });
    h.m.sessions.set('a', { name: 'a', type: 'claude', agentType: 'claude', io: 'pty', activityState: 'idle', activityTs: Date.now(), createdAt: 1 });
    h.m.flushPending('a');
    const all = h.written.join('\n');
    assert.deepStrictEqual(['GAP-DM', 'GAP-REM', 'GAP-NOTE'].map((b) => all.split(b).length - 1), [1, 1, 1]);
  } finally { mock.timers.reset(); }
});

test('reload gap: reservation is by hold record — an unknown name and a seat deleted in the gap still fail', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = gapRig();
    assert.deepStrictEqual(h.m._gatedDeliver('nobody', 'bob', 'X', false), { error: 'no such agent "nobody"' });
    h.m._handleContextIntent(h.old, 'reload', 'next');
    await new Promise((r) => setImmediate(r));
    await ticks();
    assert.strictEqual(h.m.sessions.has('a'), false, 'ENTER: in the gap');
    h.m._dropCtxHold('a');
    assert.deepStrictEqual(h.m._gatedDeliver('a', 'bob', 'X', false), { error: 'no such agent "a"' });
    h.open();
    await ticks();
  } finally { mock.timers.reset(); }
});

function escRig(h) {
  const tstore = require('../tickets-store').createTicketsStore({ fs, path, clodexHome: h.root });
  const team = { name: 'team', root: mkTmpRoot('clx-ctxhold-team-'), lead: 'a', roles: {} };
  tstore.save(team.root, [{ id: 't9', title: 'x', state: 'done', loopStep: 'verify', assignee: 'hand', openedAt: 1, lastActivityAt: 1 }]);
  return {
    escalate: () => h.m._escalateTicket(team, 't9', 'verify: diff', 'EVID', 'TRIED'),
    told: () => h.written.join('\n').split('[ticket t9 ESCALATED]').length - 1,
    state: (watches) => {
      const rec = tstore.load(team.root).find((t) => t.id === 't9');
      return { ...rec, lastActivityAt: typeof rec.lastActivityAt, watched: [...(watches || new Map()).keys()] };
    },
  };
}

function parkedForLiveLead() {
  const live = rig();
  const e = escRig(live);
  live.s.lastUserInputTs = Date.now();
  e.escalate();
  assert.strictEqual(e.told(), 0, 'ENTER: parked for the live idle lead');
  return { live, e };
}

async function escalateInGap(h, e) {
  h.m._handleContextIntent(h.old, 'reload', 'next');
  await new Promise((r) => setImmediate(r));
  await ticks();
  assert.strictEqual(h.m.sessions.has('a'), false, 'ENTER: in the gap');
  e.escalate();
  assert.strictEqual(h.onDisk(), 1);
  assert.strictEqual(e.state().loopStep, 'verify', 'an escalation parked in the gap has not been seen');
}

test('reload gap: an ESCALATED notice is delivered once to the respawned lead and leaves the loop state a live idle lead leaves', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { live, e: le } = parkedForLiveLead();
    live.s.lastUserInputTs = 0;
    live.m._drainPendingAtIdle(live.s);
    live.m._emitActivity('a', 'thinking');
    assert.strictEqual(le.told(), 1);
    const want = le.state(live.s._parkedEscalations);
    assert.strictEqual(want.loopStep, undefined, 'ENTER: the drained escalation released the hold');
    const h = gapRig();
    const e = escRig(h);
    await escalateInGap(h, e);
    h.open();
    await ticks();
    assert.ok(h.fresh, 'ENTER: respawned');
    h.fresh._bootReadySeen = true;
    h.m._ctxHoldOnBootReady(h.fresh);
    h.m._drainPendingAtBootReady(h.fresh);
    h.m._ctxHoldTyped('a', h.m._ctxHoldMap().get('a').gen);
    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(e.state().loopStep, 'verify', 'a turn that started before the escalation was typed keeps the hold');
    h.m._emitActivity('a', 'idle', true);
    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(e.told(), 1);
    assert.deepStrictEqual(e.state(h.fresh._parkedEscalations), want);
  } finally { mock.timers.reset(); }
});

test('reload gap: a failed respawn leaves the escalation counted, watched and held as a parked undelivered one; the badge click delivers it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { live, e: le } = parkedForLiveLead();
    const want = le.state(live.s._parkedEscalations);
    assert.deepStrictEqual([want.loopStep, want.watched], ['verify', ['t9']], 'ENTER: the reference is held and watched');
    const h = gapRig();
    const e = escRig(h);
    await escalateInGap(h, e);
    h.open('boom');
    await ticks();
    assert.strictEqual(h.errs.length, 1, 'ENTER: respawn failed');
    assert.deepStrictEqual(e.state(h.m._gapEscalations.get('a')), want);
    assert.strictEqual(h.onDisk(), 1);
    const back = { name: 'a', type: 'claude', agentType: 'claude', io: 'pty', activityState: 'idle', activityTs: Date.now(), createdAt: 1 };
    h.m.sessions.set('a', back);
    h.m.flushPending('a');
    assert.strictEqual(e.told(), 1);
    h.m._emitActivity('a', 'thinking');
    assert.strictEqual(e.state(back._parkedEscalations).loopStep, undefined, 'the delivered escalation releases the hold');
  } finally { mock.timers.reset(); }
});
