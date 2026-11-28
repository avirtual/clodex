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
    hasActivePending: pend.hasActivePending, countPending: pend.countPending,
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
