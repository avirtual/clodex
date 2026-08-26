'use strict';
// Run: node --test
// t194 — an ACTIVE park (_deliverParkedActive, the [agent:team-review] scope) is
// only half a delivery: it writes the message to PENDING_DIR and returns. Something
// has to DRAIN it, and for a brand-new reviewer seat exactly one drain edge can
// reach it — the boot-ready rising edge. The idle drain and the out-of-process hook
// both need a turn the seat will never take, because the thing it is missing IS its
// first turn. So when that one edge does not fire, the scope is parked forever:
// seat alive, files on disk, transcript never created.
//
// Measured twice in production. What pinned the mechanism was the rescue: an
// operator ✉-flush found the messages still UNCLAIMED 8.3s after the park, and
// delivered them through the same inject queue with no boot-readiness cap in the
// log. The seat could receive the whole time. Only the drain was missing.
//
// Delivery is observed at the seat's PTY BYTES, never at a spy on the drain: the
// property is that the seat ends up holding the scope, and a spy pins the call while
// proving nothing about the queue's gates or the boot re-render between. For the
// same reason `resolveTeam` returns null here — a resolved team injects its own
// composition and ticket traffic, and then bytes at the PTY would no longer be
// attributable to the drain under test.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const pendingStore = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const CWD = os.tmpdir();

// The queue polls its ready gate every 250ms by default, which would push a write
// past a wipe window for timing reasons alone and let broken code pass.
class FastQueue extends require('../inject-queue').InjectQueue {
  constructor(o) { super({ ...o, readyPollMs: 10 }); }
}

function boot(opts = {}) {
  const root = mkTmpRoot('clx-pdf-');
  const writes = new Map();          // seat name → concatenated PTY bytes
  const dataCb = new Map();          // seat name → the manager's onData handler
  // Seat name → the ms after which this terminal KEEPS what is written to it.
  // Before it, a write is discarded rather than accumulated: that is what the CLI's
  // boot re-render does to text spliced into a composer that is not yet up. Without
  // modelling it, a delivery that was wiped and one that survived are the same call
  // to pty.write().
  const keepFrom = new Map();
  let pending = null;
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    setArchived: () => {}, setRosterSent: () => {},
  };
  const PENDING_DIR = path.join(root, 'pending');
  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR,
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    resolveProxyBase: () => null,
    resolveProxyAgentId: () => null,
    normalizeProxyBase: (v) => v,
    randBase36: (n) => 'x'.repeat(n),
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => {
        const who = pending;
        return {
          onData(cb) { dataCb.set(who, cb); }, onExit() {}, pid: 999, kill() {},
          write(b) {
            const gate = keepFrom.get(who);
            if (gate != null && Date.now() < gate) return;   // wiped by the boot re-render
            writes.set(who, (writes.get(who) || '') + b);
          },
        };
      },
    },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // No team: see the header. The seat must be reachable and nothing else.
    resolveTeam: () => null,
    findProjectRoot: () => null,
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: (name) => fs.mkdirSync(runDirFor(root, name), { recursive: true }),
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => false,
    buildIpcPrompt: () => '', bakePrompt: () => '',
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [], pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    getPromptLibrary: () => ({ raw: () => null }),
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [], effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [], writeSkillPlugin: () => null,
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    // REAL pending-store throughout: park, claim and the has/count predicates are
    // the same functions the drain races in production. Stubbing hasActivePending
    // (as the sibling ticket-replay harness does) would make every drain decision
    // here a decision about the stub.
    parkDelivery: pendingStore.parkDelivery,
    drainPending: pendingStore.drainPending,
    countPending: pendingStore.countPending,
    peekPending: pendingStore.peekPending,
    hasActivePending: pendingStore.hasActivePending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    InjectQueue: FastQueue,
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    spillToFile: () => null,
    isAlive: () => false,
    scheduleTrayRefresh: () => {}, refreshAppMenu: () => {}, refreshTrayMenu: () => {},
    INJECT_BOOT_MAXWAIT: 30, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    INJECT_HOLD_TIMEOUT: 60_000,
    ...opts.deps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const spawn = async (name, type = 'claude') => {
    pending = name;
    await m.create(name, type, CWD, [], null, 'ws');
    const s = m.sessions.get(name);
    assert.ok(s, `ENTER: create() must have put ${name} in the map`);
    return s;
  };
  const stop = () => {
    for (const s of m.sessions.values()) {
      try { if (s.sentinel) s.sentinel.stop(); } catch {}
      try { if (s.watcher) s.watcher.stop(); } catch {}
      try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
      s._dead = true;
      clearTimeout(s._bootDrainTimer);
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._bootSettleTimer);
      clearTimeout(s._parkCapTimer);
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._parkedDrainFallbackTimer);
    }
  };
  return {
    m, spawn, stop, PENDING_DIR,
    emit: (name, data) => { const cb = dataCb.get(name); if (cb) cb(data); },
    seen: (name) => writes.get(name) || '',
    wipeUntil: (name, ms) => keepFrom.set(name, Date.now() + ms),
  };
}

// Polls rather than sleeping a fixed span: a fixed sleep tuned on a fast machine is
// how a green suite starts flaking.
async function settled(app, name, want, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (want.test(app.seen(name))) return app.seen(name);
    await new Promise((r) => setTimeout(r, 5));
  }
  return app.seen(name);
}

// The deterministic anchor for asserting ABSENCE. The fallback nulls its handle when
// it fires and replaces it when it re-arms, so a change of identity is the one signal
// both shapes share — and a bare sleep would assert nothing was delivered at a moment
// that may simply be BEFORE the pass, passing for the wrong reason.
async function fallbackFired(s, tries = 400) {
  const first = s._parkedDrainFallbackTimer;
  assert.ok(first != null, 'ENTER: the fallback must be armed, or there is no pass to wait for');
  for (let i = 0; i < tries; i++) {
    if (s._parkedDrainFallbackTimer !== first) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail('ENTER: the parked-drain fallback never fired, so every absence assertion below is vacuous');
}

// The production failure, exactly: the seat never announces bracketed paste, so the
// boot-ready edge never arms the drain. With no second edge the scope sits on disk
// for the life of the process and the reviewer looks like it is thinking.
test('an active park reaches a seat whose boot-ready edge never fires', async () => {
  const app = boot();
  try {
    await app.spawn('reviewer-1');
    // No emit(): this terminal never announces. The ONLY write that can reach it is
    // a drain the fallback arms — the idle edge needs a turn this seat never takes,
    // and the hook is out of process.
    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');
    assert.ok(pendingStore.hasActivePending(app.PENDING_DIR, 'reviewer-1'),
      'ENTER: the scope must actually be parked, or the drain below has nothing to find');

    const got = await settled(app, 'reviewer-1', /REVIEW THE BOOT RACE/);
    assert.match(got, /REVIEW THE BOOT RACE/,
      'the scope must reach the seat: parking is half a delivery, and for a fresh reviewer the boot-ready '
      + 'edge is the only drain that can ever run — when it does not fire, nothing else is coming');
    assert.match(got, /\[agent:from lead\]/, 'and arrives as a dm from the lead, not as bare text');
    assert.strictEqual(pendingStore.hasActivePending(app.PENDING_DIR, 'reviewer-1'), false,
      'and the park is claimed, not delivered-and-left — a copy still on disk would drain again at the next edge');
  } finally { app.stop(); }
});

// The mirror, and the harder half. The latch is set when the CLI ANNOUNCES bracketed
// paste, which PRECEDES the readline loop accepting input — BOOT_DRAIN_SETTLE_MS is
// the only margin over that window. A fallback that claims and writes on its own
// schedule lands inside the re-render, and the claim is destructive: the messages are
// off disk, so the boot drain that follows has nothing left to deliver and the seat
// ends up with neither.
test('the fallback stands down once the boot drain is armed, instead of writing into the re-render', async () => {
  // 40, not 80: a fallback that failed to defer writes one period after the park,
  // and the margin between that write and the end of the wipe window is all that
  // separates "mutant killed" from a false pass on a loaded machine. Pulling the bad
  // write to ~40ms against a window ending at 250ms buys ~210ms of it.
  const app = boot({ deps: { bootDrainSettleMs: 300, INJECT_BOOT_MAXWAIT: 40 } });
  try {
    const s = await app.spawn('reviewer-1');
    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');
    assert.ok(s._parkedDrainFallbackTimer != null && !s._bootReadySeen,
      'ENTER: the fallback must be armed and the latch still unset, or this is not the interleaving under test');

    app.wipeUntil('reviewer-1', 250);
    app.emit('reviewer-1', '\x1b[?2004h');   // announce: arms the drain; the fallback is due right after
    assert.ok(s._bootDrainTimer, 'ENTER: the announcement must have armed the boot drain');

    const got = await settled(app, 'reviewer-1', /REVIEW THE BOOT RACE/);
    assert.match(got, /REVIEW THE BOOT RACE/,
      'the scope must survive the boot re-render: the fallback has to yield to an armed boot drain, or it '
      + 'claims the files off disk and writes them into a composer that is not up — wiped, unrecoverable, '
      + 'and the drain it pre-empted has nothing left to deliver');
  } finally { app.stop(); }
});

// Yielding to the boot drain is only safe if the yield is not also a goodbye. The
// drain bails on an open draft (it will not splice into what the operator is typing)
// and its producer can claim nothing — so a fallback that returns bare when the drain
// is armed has handed the park to something that then did nothing, and there is no
// timer left alive to notice. That is this ticket's own defect one layer out: the
// second edge made one-shot exactly like the first.
test('yielding to the boot drain re-arms — a drain that bails on an open draft must not end the fallback', async () => {
  // The settle must OUTLAST the fallback period, or the drain has already fired and
  // nulled its handle before the first pass and the yield branch is never reached —
  // the terminal re-arm would then be what rescues the delivery, and this test would
  // pass against a bare-return yield. Measured: it does.
  const app = boot({ deps: { bootDrainSettleMs: 150, INJECT_BOOT_MAXWAIT: 40 } });
  try {
    const s = await app.spawn('reviewer-1');
    // An open draft: lastUserInputTs after lastUserSubmitTs is what isDraftOpen reads,
    // and it makes _drainPendingAtBootReady return without draining.
    s.lastUserInputTs = Date.now();
    s.lastUserSubmitTs = 0;

    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');
    app.emit('reviewer-1', '\x1b[?2004h');   // arms the boot drain, which will bail on the draft
    assert.ok(s._bootDrainTimer, 'ENTER: the boot drain must be armed, or the fallback is not yielding to anything');

    // One period in, the drain is STILL armed — this is the pass that must yield.
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(s._bootDrainTimer,
      'ENTER: the drain must still be armed at the first fallback pass, or the yield branch was never taken');

    // Now let the drain fire and bail with the draft still open.
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(app.seen('reviewer-1'), '',
      'ENTER: the drain must have bailed — a delivery here means the draft never blocked it and the '
      + 're-arm below is not what this test is measuring');
    assert.ok(pendingStore.hasActivePending(app.PENDING_DIR, 'reviewer-1'),
      'ENTER: and the park must still be unclaimed, which is the state the fallback has to recover from');

    s.lastUserSubmitTs = Date.now();         // draft submitted: the seat is drainable again
    const got = await settled(app, 'reviewer-1', /REVIEW THE BOOT RACE/);
    assert.match(got, /REVIEW THE BOOT RACE/,
      'the fallback must still be alive after yielding: the boot drain is one-shot and it bailed, so a bare '
      + 'return leaves the scope parked with nothing scheduled to ever look again — silent and permanent, '
      + 'which is the exact failure this fallback exists to close');
  } finally { app.stop(); }
});

// The fallback is armed for ONE park and must not act on someone else's. Pending is
// name-scoped, so once this seat's scope is claimed, mail parked meanwhile by
// _maybeParkDelivery — the busy/typing park, which exists precisely to keep text OUT
// of a working seat — would look exactly like unfinished business. Forcing that
// through _drainPendingAtBootReady bypasses _injectText's hold check and splices into
// the seat the park was protecting.
test('the fallback is scoped to its own park, not to whatever is pending under the name', async () => {
  const warns = [];
  const app = boot({ deps: { log: { info: () => {}, warn: (_t, m) => warns.push(m), error: () => {}, debug: () => {} } } });
  try {
    const s = await app.spawn('reviewer-1');
    s._bootReadySeen = true;                  // spent edge: no deferral, the next pass is terminal
    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');

    // The hook or the idle drain gets there first — the ordinary case, and the one
    // that leaves the fallback armed with its own park already gone.
    const claimed = pendingStore.drainPending(app.PENDING_DIR, 'reviewer-1', 'other-drainer', null);
    assert.strictEqual(claimed.length, 1,
      'ENTER: another drainer must have taken the scope, or the fallback still has its own park to deliver '
      + 'and the confusion below cannot arise');

    // Now unrelated mail lands under the same name while that timer is still alive.
    // The seat is mid-turn, which is why this one is parked rather than injected.
    s.activityState = 'thinking';
    const parked = app.m._maybeParkDelivery(s, '[agent:from someone] UNRELATED MID-TURN MAIL');
    assert.ok(parked, 'ENTER: the busy park must have taken it, or there is no second park to be confused by');
    assert.ok(s._parkedDrainFallbackTimer,
      'ENTER: the fallback must still be armed at this point — if it already exited, nothing is left to '
      + 'mistake this mail for its own and the test proves nothing');
    warns.length = 0;

    await new Promise((r) => setTimeout(r, 150));   // several fallback periods (30ms)
    assert.ok(!/UNRELATED MID-TURN MAIL/.test(app.seen('reviewer-1')),
      'the fallback must not deliver a park it was not armed for: that one is held back on purpose, and '
      + 'forcing it through this path skips the hold check and splices into a thinking seat');
    assert.deepStrictEqual(warns.filter((m) => /parked-drain fallback/.test(m)), [],
      'and must not warn about it either — a boot-ready edge is not missing just because unrelated mail is '
      + 'waiting for the turn to end');
  } finally { app.stop(); }
});

// The spent-edge case, and the one the deferral condition is FOR. When the park
// lands after the boot-ready edge has already fired and been consumed, the latch is
// already set — so there is no edge left to wait for and deferring is pure latency.
// Delivery must happen at the FIRST pass, not at the deadline: `Date.now() < deadline`
// alone still delivers eventually, which is why every other test here passes without
// the latch check and why this one has to exist.
test('a park landing after the boot-ready edge was already spent is delivered at the first pass', async () => {
  // The deadline is 3 periods out by construction, so the two behaviours are 200ms
  // and 600ms apart and the window below (400ms) sits squarely between them —
  // deferring is not merely slower here, it misses.
  const app = boot({ deps: { INJECT_BOOT_MAXWAIT: 200 } });
  try {
    const s = await app.spawn('reviewer-1');
    s._bootReadySeen = true;      // the edge fired and was spent before the park landed
    assert.ok(!s._bootDrainTimer,
      'ENTER: the drain must NOT be armed — a live _bootDrainTimer is the yield case, not the spent-edge case');

    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');
    const got = await settled(app, 'reviewer-1', /REVIEW THE BOOT RACE/, 80);   // 400ms: one period, not the deadline
    assert.match(got, /REVIEW THE BOOT RACE/,
      'a boot-ready seat has no edge left to wait for, so the first pass must deliver: deferring to the '
      + 'deadline anyway turns a lost scope into a scope that arrives minutes late, which is the same '
      + 'reviewer sitting idle for a watchdog interval');
  } finally { app.stop(); }
});

// The fallback must be able to conclude that there is nothing to do. Whoever drained
// first owns the messages (the claim is one atomic dir-rename), so a fallback that
// injects regardless would deliver an empty prompt — a spurious turn for the seat,
// and for a reviewer a turn spent with no scope in hand.
//
// The silence is also asserted at the LOG, which is the half a mutation run can
// distinguish: the inner drain refuses an empty park on its own, so dropping the
// fallback's own check leaves delivery correct and only the warn wrong — announcing a
// boot-ready edge that never fired, on every normal delivery. This defect was
// diagnosed from those lines and nothing else, and a warn that fires on the healthy
// path is how the next one goes unnoticed.
test('the fallback delivers nothing — and claims nothing happened — when another drainer already claimed the park', async () => {
  const warns = [];
  const app = boot({ deps: { log: { info: () => {}, warn: (_t, m) => warns.push(m), error: () => {}, debug: () => {} } } });
  try {
    const s = await app.spawn('reviewer-1');
    // Latch first: with the seat boot-ready the fallback cannot re-arm, so its single
    // pass is the deterministic moment this absence is asserted at.
    s._bootReadySeen = true;
    app.m._deliverParkedActive('reviewer-1', 'lead', 'REVIEW THE BOOT RACE', 'dm');

    const claimed = pendingStore.drainPending(app.PENDING_DIR, 'reviewer-1', 'test', null);
    assert.strictEqual(claimed.length, 1,
      'ENTER: the external claim must have taken the message, or the fallback below is not facing an empty park');

    await fallbackFired(s);
    assert.strictEqual(app.seen('reviewer-1'), '',
      'nothing may be written once the park is empty — an unconditional drain injects a blank prompt and '
      + 'burns the seat a turn with no scope in it');
    assert.deepStrictEqual(warns.filter((m) => /parked-drain fallback/.test(m)), [],
      'and the fallback must not announce a missed boot-ready edge over a park that was simply already '
      + 'drained: this whole defect was found in these log lines, and a warn on the healthy path is how the '
      + 'next one is missed');
  } finally { app.stop(); }
});
