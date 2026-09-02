'use strict';
// Run: node --test
// t388 — a plain `[agent:dm]` written into an idle seat that then never starts a
// turn is lost with no trace anywhere: the sender is told `queued`, the operator's
// log shows a delivery, and mode-2004 stays on in the swallowing state, so
// `_bootReadySeen` latches and the inject queue's ready-gate is a no-op true.
// Every signal this process has reads healthy while the message vanishes — which
// is why the failure has no known frequency, only a known invisibility.
//
// What is built, and what these tests must therefore NOT drift into pinning, is
// DETECTION AND REPORT ONLY. DESIGN.md §3 refuses redelivery for arbitrary dm
// content on two independent grounds, and a test that started asserting a retry
// would be pinning the thing the design rules out. So the central assertions here
// are two absences — nothing is re-sent to the target, and the report does not
// arm a latch on its own sender — alongside the wording, which is part of the
// deliverable because a confidently wrong report is worse than a hedged one.
//
// The harness drives REAL create()s and observes deliveries at the seat's PTY
// bytes, not at a spy on _armDmConfirm: the property is that a swallowed message
// produces a report, and a spy pins the call while proving nothing about the
// gates between the intent and the write.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const CWD = os.tmpdir();

// One app process, with the delivery machinery real from the intent down to the
// PTY write. Modelled on test/ticket-replay.test.js's boot for the same reason it
// is real there: the disposition this latch arms on is produced by the inject
// queue, so a stubbed queue would hand every test the disposition it expected.
function boot(opts = {}) {
  const root = mkTmpRoot('clx-dm-run-');
  const home = mkTmpRoot('clx-dm-home-');
  const writes = new Map();          // seat name -> concatenated PTY bytes
  let pending = null;                // the name create() is currently spawning
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    setArchived: () => {}, setRosterSent: () => {},
  };
  const SessionManager = createSessionManager({
    REGISTRY_DIR: home,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
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
    registry: { register: () => {}, unregister: () => {}, getPeer: async () => null },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: {
      spawn: () => {
        const who = pending;
        return {
          onData() {}, onExit() {}, pid: 999, kill() {},
          write(b) { writes.set(who, (writes.get(who) || '') + b); },
        };
      },
    },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
    // Real leaves: _handleIntent gates on intentEnabledFor before it reaches the
    // dm arm, so a stub deciding it here would put the gate under this file's
    // control instead of the delivery path's.
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    parkDelivery: require('../pending-store').parkDelivery,
    parkIdInUse: require('../pending-store').parkIdInUse,
    drainPending: () => [], countPending: () => 0, peekPending: () => [],
    hasActivePending: () => false,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    // REAL: `held` and `parked` are the dispositions this latch must NOT arm on,
    // so a gate stubbed open would delete the only interaction under test.
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    InjectQueue: require('../inject-queue').InjectQueue,
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    spillToFile: () => null,
    isAlive: () => false,
    scheduleTrayRefresh: () => {}, refreshAppMenu: () => {}, refreshTrayMenu: () => {},
    // Every wait to 0: the boot-readiness gate latches off a real mode-2004 byte
    // that a fake PTY never sends, so production caps would leave every delivery
    // queued forever and the file would go green and then hang.
    INJECT_BOOT_MAXWAIT: 0, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    INJECT_HOLD_TIMEOUT: 60_000,
    ...opts.deps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  const casts = [];
  m._broadcast = (ch, payload) => { casts.push({ ch, payload }); };
  // Every session this boot ever created, tracked SEPARATELY from m.sessions: a
  // real create() leaves an fs.watch handle behind, and one test below removes a
  // seat from the map to model a dead sender. Teardown driven off the map would
  // silently skip that seat, and node then hangs on the surviving FSEvent after
  // the file reports green.
  const spawned = [];
  const spawn = async (name) => {
    pending = name;
    await m.create(name, 'claude', CWD, [], null, 'ws');
    const s = m.sessions.get(name);
    assert.ok(s, `ENTER: create() must have put ${name} in the map`);
    spawned.push(s);
    return s;
  };
  const stop = () => {
    for (const s of spawned) {
      try { if (s.sentinel) s.sentinel.stop(); } catch {}
      try { if (s.watcher) s.watcher.stop(); } catch {}
      try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
      clearTimeout(s._bootDrainTimer);
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._bootSettleTimer);
      clearTimeout(s._parkCapTimer);
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._specConfirmTimer);
      clearTimeout(s._dmConfirmTimer);
    }
  };
  return {
    m, spawn, stop, casts, home,
    seen: (name) => writes.get(name) || '',
    // How many parked entries MATCH, never how many exist: "nothing reached the
    // PTY" is equally true of a park that THREW, so a park must be proven
    // positively or the disposition under test is assumed rather than measured.
    parked: (name, re) => {
      const dir = path.join(root, 'pending', name);
      let files;
      try { files = fs.readdirSync(dir); } catch { return 0; }
      return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).filter((f) => {
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return obj && typeof obj.text === 'string' && re.test(obj.text);
        } catch { return false; }
      }).length;
    },
  };
}

// The inject queue is a promise chain, so bytes land a few ticks after the intent
// returns. Polled rather than slept: a fixed sleep tuned on a fast machine is how
// a green suite starts flaking.
async function settled(app, name, want, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (want.test(app.seen(name))) return app.seen(name);
    await new Promise((r) => setTimeout(r, 5));
  }
  return app.seen(name);
}

// An injected unit is three writes (Ctrl-U, text, Enter) and `settled` returns on
// the middle one. The absence assertions below baseline the PTY and require it to
// be UNCHANGED, so a baseline taken before the trailing Enter fails on the first
// delivery merely finishing itself.
async function complete(app, name) {
  for (let i = 0; i < 300 && !app.seen(name).endsWith('\r'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(app.seen(name).endsWith('\r'),
    `ENTER: the delivery to ${name} must be COMPLETE before a test baselines its terminal`);
}

const dm = (target, body, urgent = false) => ({ type: 'dm', target, body, urgent });

// A sender and an idle target, with one dm written into the target and the latch
// armed by that write. The window is injected LONG and the check is then called
// directly: driving it at 0 makes the check race the delivery it is meant to
// judge, so the latch would already be spent by the time a test could look at it.
async function swallowed(opts = {}) {
  const app = boot({ deps: { specConfirmMs: 60_000, ...(opts.deps || {}) } });
  const sender = await app.spawn('sender');
  const target = await app.spawn('target');
  // Runs AFTER the seat exists and BEFORE the dm, which is the only window in
  // which a transcript baseline can be established: the latch reads the seat's
  // size at write time, so a file created afterwards anchors at -1 and every
  // growth assertion below would measure the blind spot instead.
  if (opts.prepare) await opts.prepare(app, target);
  app.m._handleIntent('sender', dm('target', 'THE ORIGINAL MESSAGE'));
  const got = await settled(app, 'target', /THE ORIGINAL MESSAGE/);
  assert.match(got, /THE ORIGINAL MESSAGE/,
    'ENTER: the dm must have been WRITTEN at all — with no delivery there is nothing for the latch to watch '
    + 'and every assertion below holds vacuously');
  await complete(app, 'target');
  assert.strictEqual((target._dmUnconfirmed || []).length, 1,
    'ENTER: the write must ARM the latch — this is the mutant of dropping the onWrite hook at the dm arm, and '
    + 'unarmed there is no report for anything below to assert on');
  return { app, sender, target };
}

// Entries armed by a real delivery are milliseconds old, and the report drains
// only the units that have had their FULL window — so a test calling the check
// directly must age them first. Aged rather than run at a short window: at a
// window short enough to elapse on its own, the production timer races the check
// the test is about to make, and the latch is spent before it can be looked at.
function ripen(target, byMs = 61_000) {
  assert.ok(target._dmUnconfirmed && target._dmUnconfirmed.length,
    'ENTER: there must be an outstanding unit to ripen, or the check below returns early');
  target._dmUnconfirmed.forEach((e) => { e.at -= byMs; });
}

// ── arming ──────────────────────────────────────────────────────────────────

test('t388: a dm INJECTED into an idle seat arms the latch, with its sender recorded', async () => {
  const { app, target } = await swallowed();
  try {
    assert.strictEqual(target._dmUnconfirmed.length, 1);
    assert.strictEqual(target._dmUnconfirmed[0].sender, 'sender',
      'the sender must be recorded on the entry: it is the only thing that makes a report deliverable, and a '
      + 'latch that knows a seat was written to but not by whom can broadcast and nothing more');
    assert.ok(target._dmConfirmTimer, 'and the window must be armed, or nothing ever checks');
  } finally { app.stop(); }
});

test('t388: a dm PARKED at a busy seat does not arm — a park produces no edge to confirm', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // Busy at the park decision AND at write time: _maybeParkDelivery diverts it
    // to a file that the out-of-process hook drains mid-loop.
    target.activityState = 'thinking';
    const before = app.seen('target');
    app.m._handleIntent('sender', dm('target', 'PARKED MESSAGE'));
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(app.seen('target'), before,
      'ENTER: the dm must have been PARKED rather than written — if it reached the PTY this fixture never took '
      + 'the park path and the assertion below is about a disposition it did not produce');
    assert.strictEqual(app.parked('target', /PARKED MESSAGE/), 1,
      'ENTER: the dm itself must be in the park store — the absence above cannot tell a successful park from a '
      + 'park that threw, and only one of those is the state this test names');
    assert.strictEqual((target._dmUnconfirmed || []).length, 0,
      'a parked dm must NOT arm: it becomes a file drained by the hook mid-loop, and a seat already thinking '
      + 'emits no fresh activity edge for it — so the latch could never be cleared by consumption and would '
      + 'report every parked dm in the system as swallowed');
    clearTimeout(target._parkCapTimer);
  } finally { app.stop(); }
});

test('t388: a dm HELD-PARKED behind a permission dialog does not arm', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // Raised BEFORE the dm: arming through a normal delivery and only then
    // raising the dialog exercises the injected path with a dialog attached,
    // never the hold-park, which is a different branch of _gatedDeliver.
    target.needsAttention = { kind: 'permission', ts: Date.now(), message: 'allow?' };
    const before = app.seen('target');
    app.m._handleIntent('sender', dm('target', 'DIALOG MESSAGE'));
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(app.seen('target'), before,
      'ENTER: the dm must have been held-parked rather than written');
    assert.strictEqual(app.parked('target', /DIALOG MESSAGE/), 1,
      'ENTER: the dm must be in the park store, proving the hold-park path positively');
    assert.strictEqual((target._dmUnconfirmed || []).length, 0,
      'a held-parked dm must not arm — the same reason as the busy park: the bytes are a file, not a write');
  } finally { app.stop(); }
});

test('t388: a seat that went busy while the unit waited in the gates does not arm', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // Idle at the park decision, busy at WRITE time. The arm runs inside the
    // queue's `produce`, so it reads the state here and not the one the
    // disposition was chosen under. Deterministic rather than raced: the dm arm
    // reaches _gatedDeliver synchronously and the queue's drain does not start
    // until a microtask, so this assignment always lands between the two.
    app.m._handleIntent('sender', dm('target', 'RACED MESSAGE'));
    target.activityState = 'thinking';
    const got = await settled(app, 'target', /RACED MESSAGE/);
    assert.match(got, /RACED MESSAGE/,
      'ENTER: the dm must have been WRITTEN — a park here would make the assertion below true for the '
      + 'unrelated reason the two tests above already cover');
    assert.strictEqual((target._dmUnconfirmed || []).length, 0,
      'a write into a seat that is already thinking must not arm: it emits no fresh activity edge (the tracker '
      + 'dedupes on unchanged state), so the latch would run its whole window over a dm that landed fine and '
      + 'report a healthy delivery as swallowed');
  } finally { app.stop(); }
});

// ── clearing ────────────────────────────────────────────────────────────────

test('t388: a started turn clears the WHOLE fifo, not just the newest entry', async () => {
  const { app, target } = await swallowed();
  try {
    app.m._handleIntent('sender', dm('target', 'SECOND MESSAGE'));
    await settled(app, 'target', /SECOND MESSAGE/);
    assert.strictEqual(target._dmUnconfirmed.length, 2,
      'ENTER: both units must be outstanding — with one entry this test cannot tell "cleared the fifo" from '
      + '"cleared an entry", which is the mutant it exists to kill');

    app.m._emitActivity('target', 'thinking');
    assert.deepStrictEqual(target._dmUnconfirmed, [],
      'a started turn clears every outstanding entry: the seat submitted, and the earlier entries were '
      + "Ctrl-U-destroyed into that submitted line's history — either way nothing is still sitting eaten");
    assert.strictEqual(target._dmConfirmTimer, null,
      'and the window is disarmed — a live timer over an empty fifo is a report waiting to fire at nothing');
  } finally { app.stop(); }
});

test('t388: the activity edge clears the dm latch — a NEW field inherits no defence by construction', async () => {
  const { app, target } = await swallowed();
  try {
    // t387's redirect kind got this defence for free by reusing _specConfirmTimer.
    // This latch has its own field, so the clear is a hand-added line in
    // _emitActivity and a hand-added line in _cleanup — and a hand-added line is
    // exactly what a later edit removes without noticing. Both get their own pin.
    assert.ok(target._dmUnconfirmed.length && target._dmConfirmTimer,
      'ENTER: latch and timer must both be live for their clearing to mean anything');
    // All THREE pieces of state, not just the fifo: the cap-dropped record is
    // the one a clear is most likely to be written without.
    target._dmOverflow = new Map([['starved', { count: 2, at: Date.now() - 1000 }]]);
    app.m._emitActivity('target', 'thinking');
    assert.strictEqual(target._dmUnconfirmed.length, 0, 'the fifo is cleared on the non-idle edge');
    assert.strictEqual(target._dmUnconfirmedLast, null,
      'and so is the expired-latch record: it exists to attribute SILENCE, and a seat that took a turn is not '
      + 'silent — left set it would keep blaming a delivered dm for every later stall');
    assert.ok(!target._dmOverflow || target._dmOverflow.size === 0,
      'and so is the OVERFLOW record. Left behind, a seat that demonstrably took a turn keeps reporting a '
      + 'backlog of dropped dms forever, and _dmLatchEvidence keeps returning non-null for it');
    assert.strictEqual(app.m._dmLatchEvidence('target'), null,
      'ENTER-shaped: the evidence reads all three, so this is the assertion that catches a clear which '
      + 'forgets one of them');
  } finally { app.stop(); }
});

test('t388: _cleanup disarms the dm confirmation timer (a fired timer re-enters a dead seat)', async () => {
  const { app, target } = await swallowed();
  try {
    assert.ok(target._dmConfirmTimer, 'ENTER: the timer must be live, or the absence below is vacuous');
    let fired = false;
    clearTimeout(target._dmConfirmTimer);
    target._dmConfirmTimer = setTimeout(() => { fired = true; }, 5);
    app.m._cleanup('target');
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(fired, false,
      'no dm timer survives _cleanup: its callback re-enters the manager with a session that is gone from the '
      + 'map, and the report it writes names a seat that no longer exists');
  } finally { app.stop(); }
});

// ── the report ──────────────────────────────────────────────────────────────

test('t388: a swallowed dm is reported to its sender, hedged, and says nothing was re-sent', async () => {
  const { app, sender, target } = await swallowed();
  try {
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > before.length, 'ENTER: the report must be a NEW write to the sender');
    // Sliced past everything the sender's terminal already held: matched against
    // the whole buffer these assertions would read the sender's own earlier
    // traffic, which is the vacuous-reach shape that survived t387's first pass.
    const body = notice.slice(before.length);
    assert.match(body, /target/, 'the report must name the seat that never took a turn');
    assert.match(body, /may have been swallowed/,
      'a SINGLE outstanding unit is the one case where the reading is unambiguous — no other write destroyed '
      + 'its draft — so it is reported as a probable swallow rather than as an unresolvable one');
    assert.match(body, /NOTHING was re-sent, and nothing will be/,
      'the notice must say plainly that no retry happened: a sender that assumes delivery was retried does '
      + 'nothing, and the whole point of the report is to put the resend decision in the hands that hold the '
      + 'content — DESIGN.md §3 refuses to make it here');
    assert.match(body, /\[agent:dm target urgent\]/,
      'and it must point at the resend affordance the parked path already teaches, or the sender is told a '
      + 'problem with no exit');
    assert.doesNotMatch(body, /was lost/,
      'never "was lost": this process cannot prove a loss, and a confidently wrong report is worse than a '
      + 'hedged one');
  } finally { app.stop(); }
});

test('t388: NOTHING is re-sent to the target — the refusal, asserted where it would break', async () => {
  const { app, target } = await swallowed();
  try {
    const before = app.seen('target');
    ripen(target);
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /has not started a turn/);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('target'), before,
      'the target receives NOTHING. Redelivery of arbitrary dm content is refused by design: a dm can carry an '
      + 'instruction whose second execution is expensive, no board record proves a copy identical, and no '
      + 'idempotent close verb catches a duplicate downstream. A retry added here would pass every other test '
      + 'in this file');
  } finally { app.stop(); }
});

test('t388: a multi-sender window is reported as "may not have been seen", never as a swallow', async () => {
  const { app, target } = await swallowed();
  try {
    const other = await app.spawn('other');
    app.m._handleIntent('other', dm('target', 'A SECOND SENDER MESSAGE'));
    await settled(app, 'target', /A SECOND SENDER MESSAGE/);
    assert.strictEqual(target._dmUnconfirmed.length, 2,
      'ENTER: two units from two senders must be outstanding — with one, the ambiguous wording below is '
      + 'unreachable and the test asserts nothing about the branch it names');

    const beforeSender = app.seen('sender');
    const beforeOther = app.seen('other');
    ripen(target);
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /may not have been seen/);
    await settled(app, 'other', /may not have been seen/);
    const s = app.seen('sender').slice(beforeSender.length);
    const o = app.seen('other').slice(beforeOther.length);
    for (const [who, body] of [['sender', s], ['other', o]]) {
      assert.match(body, /may not have been seen/,
        `${who} must get the HEDGED wording: with two units outstanding the second's leading Ctrl-U destroyed `
        + "the first's eaten draft, so which one landed cannot be told from here — that is DESIGN.md §3, and a "
        + 'report claiming otherwise is confidently wrong');
      assert.doesNotMatch(body, /may have been swallowed/,
        `${who} must NOT get the single-unit reading — this is the mutant of one unconditional wording, and it `
        + 'is the one this ticket calls out by name');
      assert.match(body, /2 messages were outstanding/,
        'and the ambiguity must be explained, not merely hinted at by a softer verb');
    }
    assert.ok(other._dmUnconfirmed == null || other._dmUnconfirmed.length === 0,
      'ENTER: the second sender is a sender, not a target — a latch on it would mean this test measured the '
      + 'wrong seat');
  } finally { app.stop(); }
});

test('t388: the broadcast fires even when no sender can be told — the report is not circular', async () => {
  const { app, sender, target } = await swallowed();
  try {
    // The sender notice travels by the very channel whose reliability is in
    // question: a sender that is itself in a swallowing state loses the notice to
    // the same failure. Modelled here at its limit — the sender is GONE — because
    // that is the shape where a broadcast reachable only through the notice path
    // would leave the event unrecorded anywhere.
    app.m.sessions.delete('sender');
    const before = app.casts.length;
    ripen(target);
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    const fresh = app.casts.slice(before)
      .filter((c) => c.ch === 'ipc-message' && c.payload && c.payload.kind === 'dm-unconfirmed');
    assert.strictEqual(fresh.length, 1,
      'the out-of-band broadcast must fire regardless of whether any sender could be reached — it is the path '
      + 'that keeps a report about swallowed dms from depending on dms not being swallowed');
    assert.match(fresh[0].payload.body, /target/, 'and it must name the seat');
    assert.match(fresh[0].payload.body, /no turn started/, 'and say what happened');
    assert.strictEqual((sender._dmUnconfirmed || []).length, 0,
      'ENTER: nothing latched on the sender seat itself, so the broadcast above is the target latch firing and '
      + 'not a second one');
  } finally { app.stop(); }
});

test('t388: the report does not arm a latch of its own — an unconfirmed report has no fixed point', async () => {
  const { app, sender, target } = await swallowed();
  try {
    assert.strictEqual(sender.activityState, 'idle',
      'ENTER: the SENDER must be idle when the notice is written — that is the exact condition the arm tests, '
      + 'so a busy sender would make the absence below true for a reason that has nothing to do with the arm '
      + 'staying opt-in');
    ripen(target);
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /has not started a turn/);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(!sender._dmUnconfirmed || sender._dmUnconfirmed.length === 0,
      'the notice must not arm a latch on the sender it is written to. This holds because the arm is passed '
      + 'explicitly at the ONE dm arm of _handleIntent — moving it into _gatedDeliver would cover all 16 '
      + 'delivery sites including this one, and an unconfirmed report of an unconfirmed report never settles');
    assert.ok(!sender._dmConfirmTimer, 'and no window is armed on the sender either');
  } finally { app.stop(); }
});

test('t388: a target on a permission dialog RE-ARMS rather than reporting, and reports once it clears', async () => {
  const { app, target } = await swallowed();
  try {
    target.needsAttention = { kind: 'permission', ts: Date.now(), message: 'allow?' };
    const beforeSender = app.seen('sender');
    const beforeCasts = app.casts.length;
    clearTimeout(target._dmConfirmTimer);
    target._dmConfirmTimer = null;
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('sender'), beforeSender,
      'a seat waiting on a dialog must produce NO report: the dm is very likely still unread behind it, and '
      + 'the wait is legitimately unbounded rather than a symptom');
    assert.strictEqual(app.casts.slice(beforeCasts)
      .filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 0,
      'and no broadcast either — deferral must be silent on both paths, not just the one');
    assert.strictEqual(target._dmUnconfirmed.length, 1,
      'the latch is KEPT, not cleared: clearing here is the mutant that loses the report entirely for every '
      + 'dm that arrives while a dialog is up');
    assert.ok(target._dmConfirmTimer,
      'and the window is RE-ARMED, uncapped — the operator may answer at any time, and a seat that never woke '
      + 'is still worth reporting an hour later');

    // The dialog is answered. The re-armed window must now be able to report.
    target.needsAttention = null;
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > beforeSender.length,
      'once the dialog clears the deferred report is reachable — a deferral that could never resolve is a '
      + 'silent drop wearing a re-arm');
  } finally { app.stop(); }
});

test('t388: a check with nothing outstanding reports nothing (the timer is not the signal)', async () => {
  const { app, target } = await swallowed();
  try {
    app.m._emitActivity('target', 'thinking');
    const before = app.seen('sender');
    const beforeCasts = app.casts.length;
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('sender'), before, 'an empty fifo produces no notice');
    assert.strictEqual(app.casts.slice(beforeCasts)
      .filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 0,
      'and no broadcast: a check that fired after its latch was legitimately cleared must be a no-op, or every '
      + 'healthy delivery is reported one window later');
  } finally { app.stop(); }
});

// ── starvation: the deadline belongs to the OLDEST unit ─────────────────────
//
// The property here replaced an earlier test that asserted only
// `notStrictEqual(timer, firstTimer)` — "the timer object changed", which is
// true of the starvable implementation and the fixed one alike, for different
// reasons. An assertion satisfied by the defect AND the fix pins nothing, and
// every mutant of the timer policy passed straight through it. What is asserted
// now is the deadline: a later dm must NOT move the earlier unit's report.

test('t388: a later dm does not push out an earlier unit\'s deadline (the starvation regression)', async () => {
  // The five pushes below must ALL land inside one window, or the assertion
  // measures scheduling rather than policy: the timer would fire mid-loop, the
  // check would drain the ripe entry and re-arm a new object, and the test would
  // flake red for a reason that has nothing to do with the deadline. 50ms of
  // pushes against a 500ms window leaves an order of magnitude of slack on a
  // loaded box.
  const app = boot({ deps: { specConfirmMs: 500 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // Armed directly rather than through deliveries: the property is the timer
    // policy, and at a window short enough to observe, real deliveries race the
    // check they are meant to feed.
    app.m._armDmConfirm('target', 'sender', 'injected');
    const firstAt = target._dmUnconfirmed[0].at;
    const deadline = target._dmConfirmTimer;
    // A stream of later dms, each arriving well inside the window. Under the
    // restart-on-every-push policy each of these moved the deadline, so a seat
    // dm-ed faster than the window NEVER reported — and `urgent` bypasses
    // shouldHoldDm's idle band, so nothing upstream bounds that stream.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
      app.m._armDmConfirm('target', 'sender', 'injected');
    }
    assert.strictEqual(target._dmUnconfirmed.length, 6,
      'ENTER: all six units must be outstanding, or the starvation below cannot be exercised');
    assert.strictEqual(target._dmUnconfirmed[0].at, firstAt,
      'ENTER: the oldest entry must still be the first one');
    assert.strictEqual(target._dmConfirmTimer, deadline,
      'the pending timer is the SAME object across all five later pushes: the deadline belongs to the oldest '
      + 'outstanding unit and no later traffic may reschedule it. Re-arming here is the starvation — a wedged '
      + 'seat is precisely the seat people keep dm-ing, and our own notice tells them to resend urgent');

    const notice = await settled(app, 'sender', /has not started a turn/, 400);
    assert.match(notice, /has not started a turn/,
      'and the report FIRES on the oldest unit\'s own schedule while the stream continues — a detector that '
      + 'can be starved into silence by traffic to the seat it is watching is not a detector');
  } finally { app.stop(); }
});

test('t388: only the RIPE units are drained; a young one keeps its full window', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // `at` values crafted, and the check called directly: at a window short
    // enough for a real delivery to age past, EVERY entry is ripe, and a fixture
    // where everything is ripe cannot tell a partial drain from a full one.
    const now = Date.now();
    target._dmUnconfirmed = [
      { sender: 'sender', at: now - 90_000 },   // ripe
      { sender: 'sender', at: now - 61_000 },   // ripe
      { sender: 'sender', at: now - 1_000 },    // young
    ];
    app.m._checkDmConfirm(target);
    assert.strictEqual(target._dmUnconfirmed.length, 1,
      'the two ripe units drain and the young one STAYS: draining it too is the defect the pegged deadline '
      + 'would otherwise introduce — a unit written a second before the oldest\'s deadline reported after a '
      + 'second of silence');
    assert.strictEqual(target._dmUnconfirmed[0].at, now - 1_000, 'and it is the young one that survived');
    assert.ok(target._dmConfirmTimer,
      'with the window re-armed for the remainder — a partial drain that stops arming loses every surviving '
      + 'unit, which is the same silence by another route');
    assert.ok(target._dmConfirmTimer._idleTimeout <= 59_000 && target._dmConfirmTimer._idleTimeout > 55_000,
      'and re-armed for the REMAINDER of the young unit\'s window, not a fresh full one');
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.match(notice, /your 2 messages/,
      'and the report covers exactly the drained units, not the outstanding one');
  } finally { app.stop(); }
});

test('t388: a fire with nothing ripe re-arms rather than returning (the cap shifts the pegged entry)', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    const now = Date.now();
    // The shape a cap overflow leaves behind: the timer was pegged to an entry
    // the cap has since shifted out, so it fires early relative to the new
    // oldest and finds nothing ripe.
    target._dmUnconfirmed = [{ sender: 'sender', at: now - 5_000 }];
    const before = app.seen('sender');
    app.m._checkDmConfirm(target);
    assert.strictEqual(target._dmUnconfirmed.length, 1, 'the unripe unit is kept, not dropped');
    assert.ok(target._dmConfirmTimer,
      'and the window is RE-ARMED. Returning here is how an overflowing seat goes permanently silent: the '
      + 'timer that would have reported it has already fired and nothing re-arms it');
    assert.ok(target._dmConfirmTimer._idleTimeout <= 55_000 && target._dmConfirmTimer._idleTimeout > 50_000,
      'for the REMAINDER of that unit\'s window (~55s), not a fresh full one. A full re-arm here gives the '
      + 'surviving unit two windows of silence instead of one every time the cap fires');
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('sender'), before,
      'and NOTHING is reported on an early fire — reporting an unripe unit is the report-after-one-second bug');
  } finally { app.stop(); }
});

test('t388: one wedge reports once per window — the repeat is the feature, not noise', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    const now = Date.now();
    target._dmUnconfirmed = [{ sender: 'sender', at: now - 61_000 }];
    app.m._checkDmConfirm(target);
    const first = await settled(app, 'sender', /has not started a turn/);
    const firstCasts = app.casts.filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length;
    assert.strictEqual(firstCasts, 1, 'ENTER: the first window must have reported');

    // A later dm to the same still-wedged seat, ripe in its own window.
    target._dmUnconfirmed = [{ sender: 'sender', at: now - 61_000 }];
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /has not started a turn[\s\S]*has not started a turn/);
    assert.strictEqual(app.casts.filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 2,
      'a SECOND report fires for the second window. Suppressing the repeat as noise is what leaves a sender '
      + 'whose message arrived after an earlier report told nothing at all');
    assert.ok(app.seen('sender').length > first.length, 'and its sender is told again, not only the log');
  } finally { app.stop(); }
});

test('t388: the evidence ACCUMULATES across reports, so a sustained wedge does not shrink it', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    const now = Date.now();
    target._dmUnconfirmed = [{ sender: 'sender', at: now - 90_000 }];
    app.m._checkDmConfirm(target);
    assert.strictEqual(app.m._dmLatchEvidence('target').count, 1, 'ENTER: the first report must be evidence');
    target._dmUnconfirmed = [{ sender: 'sender', at: now - 61_000 }];
    app.m._checkDmConfirm(target);
    const ev = app.m._dmLatchEvidence('target');
    assert.strictEqual(ev.count, 2,
      'both reported units are still evidence. Replacing _dmUnconfirmedLast per report shrinks the backlog to '
      + 'the last window during exactly the sustained wedge the attribution exists for');
    assert.ok(ev.at <= now - 90_000, 'and the span still starts at the OLDEST unit, not the latest report');
    assert.ok(target._dmUnconfirmedLast.at <= now - 90_000,
      'and the accumulated record itself carries the oldest `at`, not the newest report\'s. Read through the '
      + 'surviving entries this looks right either way; it stops looking right the moment the cap folds an '
      + 'entry into a dropped count, where the record\'s own `at` is all that is left of it');
  } finally { app.stop(); }
});

test('t388: a cap-dropped unit still tells its sender, and is counted the same everywhere', async () => {
  // Cap 2 so the drop is reachable; the partial drain makes the production cap
  // of 8 nearly unreachable, which is why this is injected rather than driven.
  const app = boot({ deps: { specConfirmMs: 60_000, dmLatchCap: 2 } });
  try {
    await app.spawn('starved');
    await app.spawn('sender');
    const target = await app.spawn('target');
    app.m._armDmConfirm('target', 'starved', 'injected');
    app.m._armDmConfirm('target', 'sender', 'injected');
    app.m._armDmConfirm('target', 'sender', 'injected');
    assert.strictEqual(target._dmUnconfirmed.length, 2,
      'ENTER: the cap must have dropped one, or nothing below is about a drop');
    assert.ok(!target._dmUnconfirmed.some((e) => e.sender === 'starved'),
      'ENTER: and the dropped one must be the starved sender\'s');

    const ev = app.m._dmLatchEvidence('target');
    assert.strictEqual(ev.count, 3,
      'the evidence counts the dropped unit. Counting only survivors makes the sweep clause disagree with the '
      + 'broadcast total about one seat\'s backlog');

    // The dropped unit is the OLDEST thing this seat is holding — which is the
    // normal case, since the cap drops from the front.
    target._dmUnconfirmed.forEach((e) => { e.at -= 61_000; });
    target._dmOverflow.get('starved').at = Date.now() - 300_000;
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'starved', /has not started a turn/);
    assert.match(notice, /has not started a turn/,
      'and the STARVED sender is told. Building the notice list from surviving entries only leaves the one '
      + 'party whose message was actually dropped as the one party never informed');
    assert.match(notice, /your message to target was written/,
      'and its notice COUNTS that dropped unit as this sender\'s own: a share computed from surviving entries '
      + 'reaches the starved sender with an empty share and tells it about "your 0 messages", which is a '
      + 'notice that names no message at all');
    assert.doesNotMatch(notice, /your 0 messages|NaN/,
      'never an empty or unarithmetic share — the age is computed from entries this sender may have none of');
    const cast = app.casts.filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').pop();
    assert.match(cast.payload.body, /^3 dms/, 'the broadcast counts all three');
    assert.match(cast.payload.body, /starved/, 'and names the starved sender it counted');
    assert.match(cast.payload.body, /after 30[01]s/,
      'and ages the backlog from the OLDEST unit INCLUDING the dropped one (300s), not from the oldest '
      + 'survivor (61s). The cap drops from the front, so the dropped units are always the oldest — an age '
      + 'read past them under-reports how long the seat has been silent by exactly the interesting amount');

    // The overflow records are CONSUMED by the report that covered them.
    assert.strictEqual(app.m._dmLatchEvidence('target').count, 3,
      'ENTER: the reported units are still evidence, so the count below is about re-reporting and not decay');
    target._dmUnconfirmed = [{ sender: 'sender', at: Date.now() - 61_000 }];
    app.m._checkDmConfirm(target);
    const second = app.casts.filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').pop();
    assert.match(second.payload.body, /^1 dm /,
      'a LATER window counts only its own units. Leaving the overflow records in place re-reports the same '
      + 'dropped messages every window for as long as the seat stays wedged, and the total grows without any '
      + 'new message having been lost');

    // And a turn clears the dropped units along with everything else.
    app.m._emitActivity('target', 'thinking');
    assert.strictEqual(app.m._dmLatchEvidence('target'), null,
      'a turn retires the OVERFLOW too: dropped units left behind by the clear keep a seat that demonstrably '
      + 'took a turn permanently accused of holding a swallowed dm');
  } finally { app.stop(); }
});

test('t388: a sender\'s dropped units keep the OLDEST age, not the newest', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000, dmLatchCap: 1 } });
  try {
    await app.spawn('starved');
    await app.spawn('target');
    const target = app.m.sessions.get('target');
    // Two drops from one sender, coalesced into one record. The record must span
    // from the OLDEST of them: it is what the notice ages and what the sweep
    // clause reports as the backlog's start.
    target._dmUnconfirmed = [{ sender: 'starved', at: 1_000 }, { sender: 'starved', at: 5_000 }];
    app.m._armDmConfirm('target', 'other', 'injected');
    assert.ok(target._dmOverflow && target._dmOverflow.get('starved'),
      'ENTER: both of the starved sender\'s units must have overflowed into one record');
    assert.strictEqual(target._dmOverflow.get('starved').count, 2, 'ENTER: coalesced, not replaced');
    assert.strictEqual(target._dmOverflow.get('starved').at, 1_000,
      'the record spans from the OLDEST dropped unit. Taking the newest under-reports how long the seat has '
      + 'been holding that sender\'s traffic, which is the one number the report is judged on');
  } finally { app.stop(); }
});

test('t388: a throw inside the dm check is contained, not raised into the host', async () => {
  const errs = [];
  const app = boot({
    deps: {
      specConfirmMs: 20,
      log: { info: () => {}, warn: () => {}, error: (_t, msg) => errs.push(String(msg)), debug: () => {} },
    },
  });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    // Armed through the real arm rather than through a delivery: at a 20ms window
    // the natural timer races the write it is meant to judge, so a fifo observed
    // after a delivery is a value the production ordering never produces. The
    // property here is containment in the timer CALLBACK, and the arm is real.
    app.m._armDmConfirm('target', 'sender', 'injected');
    assert.strictEqual((target._dmUnconfirmed || []).length, 1,
      'ENTER: the latch must be armed, or the timer below returns early and this test proves nothing');

    // The throw has to come from INSIDE the timer callback, which is the only
    // place the try/catch under test can protect. Replacing the method reaches it
    // because the callback dispatches through `this`.
    app.m._checkDmConfirm = () => { throw new Error('BOOM: the report path failed'); };
    clearTimeout(target._dmConfirmTimer);
    app.m._armDmConfirmTimer(target);
    // An unhandled throw out of a setTimeout callback terminates the run by
    // default, so surviving this await IS the assertion. This timer fires after
    // every dm to an idle seat in the whole app.
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(errs.some((msg) => /BOOM/.test(msg)),
      'the throw must be CAUGHT AND LOGGED — an observer-grade timer that dies silently is indistinguishable '
      + 'from one that never fired');
    assert.ok(errs.some((msg) => /target/.test(msg)),
      'and the log must name the seat, or an operator cannot tell which delivery went unwatched');
    // Containment alone would leave the SURVIVING fifo unwatched: the callback
    // nulls the timer before the check, and the throw skips every re-arm inside
    // it, so without the catch's own re-arm this latch waits for a later push to
    // start a fresh full window — the silence this mechanism exists to end,
    // reached through its error path. Re-arming on a persistently throwing check
    // costs one logged error per window on a seat that is already wedged, which
    // is the same trade the permission-dialog re-arm makes.
    assert.strictEqual((target._dmUnconfirmed || []).length, 1,
      'ENTER: the fifo must have survived the throw, or the re-arm below has nothing to watch');
    assert.ok(target._dmConfirmTimer,
      'a throw must leave the latch ARMED: an unwatched non-empty fifo reports nothing until some later dm '
      + 'happens to arm it, and the report it owes is the one already overdue');
  } finally { app.stop(); }
});

// ── stall attribution ───────────────────────────────────────────────────────

test('t388: the latch evidence outlives the report, which is when the stall sweep needs it', async () => {
  const { app, target } = await swallowed();
  try {
    const live = app.m._dmLatchEvidence('target');
    assert.ok(live && live.count === 1, 'ENTER: a live latch must be visible as evidence');

    ripen(target);
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /has not started a turn/);
    assert.strictEqual(target._dmUnconfirmed.length, 0,
      'ENTER: the report must have DRAINED the fifo — otherwise the assertion below reads the live entries and '
      + 'says nothing about the expired ones');
    const after = app.m._dmLatchEvidence('target');
    assert.ok(after && after.count === 1,
      'the evidence survives the report. The stall sweep runs half an hour later, so evidence read only from '
      + 'the LIVE fifo would be empty at exactly the moment the attribution is wanted — the misattribution '
      + 'this half of the ticket exists to retire would then survive the fix that was supposed to remove it');

    app.m._emitActivity('target', 'thinking');
    assert.strictEqual(app.m._dmLatchEvidence('target'), null,
      'and a turn retires it: the seat is demonstrably not silent, so blaming its quiet on a dm would be a '
      + 'stale cause attached to a live stall');
  } finally { app.stop(); }
});

test('t388: a seat with no dm history has no evidence (the clause is opt-in, not decoration)', async () => {
  const app = boot({ deps: { specConfirmMs: 60_000 } });
  try {
    await app.spawn('target');
    assert.strictEqual(app.m._dmLatchEvidence('target'), null,
      'a seat nobody dm-ed produces no clause — a cause sentence on every stall alarm carries no information '
      + 'and trains the lead to skip the line');
    assert.strictEqual(app.m._dmLatchEvidence('nobody'), null,
      'and an unknown seat is null rather than a throw: this is read from inside the stall sweep, where a '
      + 'throw would cost the alarm itself');
  } finally { app.stop(); }
});

// ── the SPEC_CONFIRM_MS move ────────────────────────────────────────────────

test('t388: SPEC_CONFIRM_MS is ONE value, reaching both the dm latch and the ticket latch', async () => {
  // The constant moved from team-tickets.js to the core deps seam because what it
  // measures — how long an injected unit has to produce a turn edge — is inject
  // plumbing, not ticket lifecycle. The risk of the move is a second default left
  // behind: two literals that agree today and drift silently. Asserted through
  // the armed timers because that is where the value is actually consumed; the
  // constants themselves are closure-private in both files.
  const app = boot({});           // no specConfirmMs: the PRODUCTION default
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    app.m._handleIntent('sender', dm('target', 'DEFAULT WINDOW MESSAGE'));
    await settled(app, 'target', /DEFAULT WINDOW MESSAGE/);
    assert.strictEqual((target._dmUnconfirmed || []).length, 1, 'ENTER: the latch must be armed');
    assert.strictEqual(target._dmConfirmTimer._idleTimeout, 90_000,
      'the dm latch gets the 90s production default. A move that changed the effective value would leave every '
      + 'test that injects its own window green while production reported after the wrong silence');

    // The ticket-side consumer, armed through the borrowed constant. Same manager,
    // same boot: a value that differed between the two would mean the move left a
    // duplicate default behind rather than passing one through.
    clearTimeout(target._specConfirmTimer);
    target._specConfirmTimer = null;
    app.m._armSpecConfirmTimer(target);
    assert.strictEqual(target._specConfirmTimer._idleTimeout, 90_000,
      'and the ticket latch reads the SAME borrowed value — this is the mutant of leaving a second '
      + 'Number.isFinite(deps.specConfirmMs) default in team-tickets.js, which agrees on the default and '
      + 'diverges the moment either is tuned');
    clearTimeout(target._specConfirmTimer);
  } finally { app.stop(); }
});

test('t388: an injected window reaches BOTH consumers, so neither can be silently re-defaulted', async () => {
  const app = boot({ deps: { specConfirmMs: 12_345 } });
  try {
    await app.spawn('sender');
    const target = await app.spawn('target');
    app.m._handleIntent('sender', dm('target', 'INJECTED WINDOW MESSAGE'));
    await settled(app, 'target', /INJECTED WINDOW MESSAGE/);
    assert.strictEqual(target._dmConfirmTimer._idleTimeout, 12_345,
      'the injected value reaches the dm latch');
    clearTimeout(target._specConfirmTimer);
    target._specConfirmTimer = null;
    app.m._armSpecConfirmTimer(target);
    assert.strictEqual(target._specConfirmTimer._idleTimeout, 12_345,
      'and the SAME injected value reaches the ticket latch through the shared bag — a re-derivation on either '
      + 'side would show up here as one consumer honouring the injection and the other falling back to 90s');
    clearTimeout(target._specConfirmTimer);
  } finally { app.stop(); }
});

// ── t616: the deadline re-probe ─────────────────────────────────────────────
//
// The false alarm this closes: a seat that HAD read the dm and replied at length
// was still reported, because the fire condition was "no observed non-idle
// transition within 90s" — a different proposition from "the seat did not consume
// the input". On a wire-routed seat the activity edge races the CLI's transcript
// append, so the edge can be missed while the bytes reach disk.
//
// It is not merely noise: the notice tells the sender to resend `urgent`, which
// lands immediately into a seat that is mid-turn, where concurrent writes
// overwrite one another's unsubmitted text. The false alarm manufactures the
// exact failure it warns about.
//
// Every test here must reach the busy-seat condition and then vary ONE thing —
// the transcript. An absence assertion is true of a fixture that never armed, so
// each drives `swallowed()`, whose own ENTER assertions prove the latch armed
// before anything below can measure a report that did not happen.

// A REAL transcript at the seat's registry path, sized `bytes`. The size is what
// the latch reads at write time, so this must run before the dm — `swallowed`'s
// `prepare` hook is that instant.
function transcript(app, name, bytes) {
  const target = path.join(app.home, `${name}-transcript.jsonl`);
  fs.writeFileSync(target, 'x'.repeat(bytes));
  fs.mkdirSync(runDirFor(app.home, name), { recursive: true });
  const link = pathFor(app.home, name, 'transcript');
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(target, link);
  return {
    path: target,
    grow: (n) => fs.writeFileSync(target, 'x'.repeat(bytes + n)),
    unreadable: () => { try { fs.unlinkSync(target); } catch {} },
  };
}

test('t616: a seat whose transcript GREW since the write is not reported — the edge was simply missed', async () => {
  let tx;
  const { app, target } = await swallowed({ prepare: (a, t) => { tx = transcript(a, t.name, 100); } });
  try {
    assert.strictEqual(target._dmUnconfirmed[0].since, 100,
      'ENTER: the entry must carry the WRITE-TIME size. Anchored at -1 (no transcript at arm) `didGrow` '
      + 'refuses both ends and this test would measure the blind spot while claiming to measure the probe');
    // The seat consumed the dm and produced a turn; only its activity edge was
    // lost. That is the whole false-alarm shape, and nothing else here differs
    // from the reported case.
    tx.grow(500);
    const before = app.seen('sender');
    const beforeCasts = app.casts.length;
    ripen(target);
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('sender'), before,
      'the sender must NOT be told: its message reached a seat that demonstrably consumed input afterwards, '
      + 'and the notice would send it resending `urgent` into a seat mid-turn — manufacturing the overwrite '
      + 'the notice itself warns about');
    assert.strictEqual(app.casts.slice(beforeCasts)
      .filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 0,
      'and no broadcast either: the operator log is the other half of the same false report, and a probe that '
      + 'silenced only the dm would leave the alarm in the place Bogdan actually reads it');
  } finally { app.stop(); }
});

test('t616: a FLAT transcript still reports — the mechanism is narrowed, not deleted', async () => {
  const { app, target } = await swallowed({ prepare: (a, t) => transcript(a, t.name, 100) });
  try {
    // Deliberately NOT grown. A genuinely swallowed dm is a real failure this
    // catches, and a probe that suppressed here would delete the mechanism under
    // cover of fixing it — which every other test in this section would pass.
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > before.length,
      'a seat that wrote NOTHING since the dm is still reported: that is the case the latch exists for, and '
      + 'the transcript is positive evidence of it rather than an absence of evidence');
    assert.strictEqual(app.casts
      .filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 1,
      'and the broadcast still fires');
  } finally { app.stop(); }
});

test('t616: an UNREADABLE transcript reports — the probe must not suppress out of its own blind spot', async () => {
  let tx;
  const { app, target } = await swallowed({ prepare: (a, t) => { tx = transcript(a, t.name, 100); } });
  try {
    assert.strictEqual(target._dmUnconfirmed[0].since, 100,
      'ENTER: readable at ARM, so the -1 below comes from the DEADLINE read. Unreadable at both ends is a '
      + 'different case that would pass this test while exercising neither');
    tx.unreadable();
    assert.strictEqual(app.m._seatTranscriptSize('target'), -1,
      'ENTER: the deadline read must genuinely fail — with a readable 100 this is the flat case again');
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > before.length,
      '`didGrow` refuses -1 at either end, so a probe that cannot answer falls through to reporting. The '
      + 'inverse — reading -1 as "no growth measured, assume fine" — is how a real swallow goes silent, and '
      + 'it is the direction that must never be traded for the false alarm');
  } finally { app.stop(); }
});

test('t616: a seat with NO transcript at all reports, at both ends of the window', async () => {
  const { app, target } = await swallowed();
  try {
    assert.strictEqual(target._dmUnconfirmed[0].since, -1,
      'ENTER: -1 is kept RAW on the entry, not normalised to 0. Normalised, a seat that then wrote one byte '
      + 'would satisfy `0 -> 1` and read as growth — a fresh seat that swallowed its first dm, silenced');
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > before.length,
      'the no-transcript seat is the population the latch protects — a codex seat writes no transcript.jsonl '
      + 'at all — so it must report exactly as it did before the probe existed');
  } finally { app.stop(); }
});

test('t616: the anchor is the size at WRITE time, so bytes already there are not growth', async () => {
  const { app, target } = await swallowed({ prepare: (a, t) => transcript(a, t.name, 4096) });
  try {
    assert.strictEqual(target._dmUnconfirmed[0].since, 4096,
      'ENTER: the entry anchors at the seat`s EXISTING size. Anchored at 0 the pre-existing 4096 bytes would '
      + 'themselves satisfy `didGrow` and every swallow at a seat with any history would be silenced');
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    const notice = await settled(app, 'sender', /has not started a turn/);
    assert.ok(notice.length > before.length,
      'a long-lived seat that swallows a dm is reported like any other: the probe asks what arrived AFTER the '
      + 'write, which is the only reading that separates consumption from history');
  } finally { app.stop(); }
});

test('t616: growth withdraws the whole ripe set and its overflow, not one entry', async () => {
  let tx;
  const { app, target } = await swallowed({ prepare: (a, t) => { tx = transcript(a, t.name, 10); } });
  try {
    const other = await app.spawn('other');
    app.m._handleIntent('other', dm('target', 'A SECOND SENDER MESSAGE'));
    await settled(app, 'target', /A SECOND SENDER MESSAGE/);
    assert.strictEqual(target._dmUnconfirmed.length, 2,
      'ENTER: two units from two senders — with one, "the whole ripe set" is indistinguishable from "the one '
      + 'entry" and this test names a property it cannot see');
    // A dropped unit from a third sender. Overflow records are older than
    // everything ripe by construction, so the growth that vindicates the ripe set
    // covers them — and a sender left in overflow would be told one window later
    // with evidence already refuted.
    app.m._overflowDmEntry(target, { sender: 'starved', at: Date.now() - 120_000 });
    assert.ok(target._dmOverflow && target._dmOverflow.size === 1,
      'ENTER: an overflow record must exist, or the drop below is asserted over an empty map');

    tx.grow(64);
    const beforeCasts = app.casts.length;
    const beforeSender = app.seen('sender');
    const beforeOther = app.seen('other');
    ripen(target);
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(app.seen('sender'), beforeSender, 'neither sender is told');
    assert.strictEqual(app.seen('other'), beforeOther,
      'and the second sender is not told either: one seat`s transcript answers for every unit written into '
      + 'it, so a per-entry verdict would be the per-unit confirmation the design refuses');
    assert.strictEqual(app.casts.slice(beforeCasts)
      .filter((c) => c.payload && c.payload.kind === 'dm-unconfirmed').length, 0,
      'and no broadcast');
    assert.strictEqual(target._dmOverflow, null,
      'the overflow records are dropped with the ripe set rather than surviving into a later report');
    // Falsy, not `null`: the withdrawal never touches this field, so its pristine
    // `undefined` is the passing state and pinning the literal would assert that
    // the withdrawal WRITES a null it has no reason to write.
    assert.ok(!target._dmUnconfirmedLast,
      'and nothing is recorded as reported: `_dmUnconfirmedLast` feeds the stall sweep`s attribution, so a '
      + 'withdrawn report left there would have the sweep blame a swallowed dm for a seat that read it');
  } finally { app.stop(); }
});

test('t616: a young unit survives the withdrawal and keeps its own window', async () => {
  let tx;
  const { app, target } = await swallowed({ prepare: (a, t) => { tx = transcript(a, t.name, 10); } });
  try {
    // Only the FIRST is ripened below, so this one is judged on its own deadline.
    app.m._armDmConfirm('target', 'sender', 'injected');
    assert.strictEqual(target._dmUnconfirmed.length, 2,
      'ENTER: two units, and only one will be ripe — with both ripe the re-arm below is unreachable');
    tx.grow(64);
    target._dmUnconfirmed[0].at -= 61_000;
    app.m._checkDmConfirm(target);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(target._dmUnconfirmed.length, 1,
      'the ripe unit is drained by the withdrawal, exactly as a report would drain it — leaving it in the '
      + 'fifo would re-judge it every window forever');
    assert.ok(target._dmConfirmTimer,
      'and the window is RE-ARMED for the young remainder. Returning without re-arming is the mutant that '
      + 'goes permanently silent on the very next dm to this seat, and it passes every other test here');
  } finally { app.stop(); }
});

test('t616: the anchor is the NEWEST ripe baseline, so old growth cannot vouch for a later dm', async () => {
  let tx;
  const { app, target } = await swallowed({ prepare: (a, t) => { tx = transcript(a, t.name, 100); } });
  try {
    // The seat consumed dm #1 and wrote 500 bytes doing it — growth that is real,
    // and that genuinely vindicates dm #1.
    tx.grow(500);
    // dm #2 arrives AFTER that growth, so it anchors above it. Armed directly:
    // the point is the baseline, and a second real delivery would race nothing
    // useful here.
    app.m._armDmConfirm('target', 'sender', 'injected');
    assert.deepStrictEqual(
      target._dmUnconfirmed.map((e) => e.since), [100, 600],
      'ENTER: the two units must carry DIFFERENT baselines straddling the growth — equal baselines make max '
      + 'and min the same number and this test cannot see the property it names');
    // Nothing since dm #2. It really was swallowed.
    const before = app.seen('sender');
    ripen(target);
    app.m._checkDmConfirm(target);
    await settled(app, 'sender', /has not started a turn/);
    assert.ok(app.seen('sender').length > before.length,
      'the report must still fire. Under `min` the anchor would be 100, the 600-byte transcript would clear '
      + '`didGrow`, and dm #2 — a genuine swallow — would be withdrawn on the strength of bytes written '
      + 'BEFORE it was ever sent. That is the false-negative direction this whole design refuses');
    assert.match(app.seen('sender').slice(before.length), /2 messages were outstanding/,
      'and both units are reported: the withdrawal is all-or-nothing over the ripe set, so a surviving '
      + 'anchor means the whole set survives');
  } finally { app.stop(); }
});
