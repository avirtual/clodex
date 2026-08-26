'use strict';
// Run: node --test
// T5 — the [agent:team-review] scope rides the reviewer's CONSTRUCTED PROMPT,
// not a dm.
//
// A dm is a delivery, and the one seat that cannot reliably take a delivery is a
// brand new one. The scope was parked and drained into the CLI's boot re-render,
// which wipes what is written to a composer that is not yet up; the t194
// parked-drain fallback then found the park CLAIMED and correctly concluded
// nothing was owed. That is why the fallback never fired for any of the six
// wedges measured on 2026-08-12 — the drain ran, the bytes died, and no
// mechanism could tell the difference. Retry timers cannot fix a channel whose
// success is unobservable; the prompt is present before the first turn instead
// of being written at it, so there is no window to lose it in.
//
// The scope is asserted at mergeClaudeSystemPrompt's `inlineBody` — the real
// function that assembles the prompt, injected as a dep — and NOT at a spy on
// the call site, which would pin the argument while proving nothing about
// whether it reaches a prompt. The dm is asserted at the seat's PTY bytes for
// the same reason.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const pendingStore = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SCOPE = 'diff at /tmp/t5.diff against 2b7179c — attn: the migration ordering';

function boot(extraDeps = {}) {
  const root = mkTmpRoot('clx-t5-');
  const writes = new Map();
  const store = new Map();
  // Every inlineBody mergeClaudeSystemPrompt was asked to bake, by seat name.
  const inline = new Map();
  // The merged prompt bytes each seat's spawn actually baked to disk.
  const realIpcFor = new Map();
  let pending = null;

  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {}, setStripLevel: () => {}, setLabel: () => {},
    setArchived: () => {}, setRosterSent: () => {}, setAutoCompact: () => {},
  };

  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor, os,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getTemplates: () => ({ list: () => [] }),
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
          onData() {}, onExit() {}, pid: 999, kill() {},
          write(b) { writes.set(who, (writes.get(who) || '') + b); },
        };
      },
    },
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: () => ({
      name: 'crew', lead: 'lead', root: root, roles: { reviewer: {} },
    }),
    findProjectRoot: () => null,
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: (name) => fs.mkdirSync(runDirFor(root, name), { recursive: true }),
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    writeClaudeDigestFile: () => false,
    buildIpcPrompt: () => '',
    // The bytes actually written to the file the CLI reads. Asserting HERE and not
    // only at inlineBody is what proves the scope survives the reviewer's own
    // config: it spawns with CLODEX_DISABLE_IPC_PROMPT=1 and a REPLACEMENT system
    // prompt, and an inline body that some path downstream drops would still have
    // been handed to the merge.
    bakePrompt: (root, n, realIpc) => { realIpcFor.set(n, realIpc); return ''; },
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    withoutPrivilegedIntentsFor: (x) => x,
    // The REAL merge, wrapped only to record what it was handed. Stubbing it to a
    // constant would make the assertion below a statement about the stub.
    mergeClaudeSystemPrompt: (a, ipc, opts = {}) => {
      inline.set(pending, opts.inlineBody || null);
      return require('../argv-merge').mergeClaudeSystemPrompt(a, ipc, opts);
    },
    readAppendBodies: () => [], pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    getPromptLibrary: () => ({ raw: () => null }),
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [], effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [], writeSkillPlugin: () => null,
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    parkDelivery: pendingStore.parkDelivery,
    drainPending: pendingStore.drainPending,
    countPending: pendingStore.countPending,
    peekPending: pendingStore.peekPending,
    hasActivePending: pendingStore.hasActivePending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    peerStatusLabel: require('../proxy-util').peerStatusLabel,
    InjectQueue: require('../inject-queue').InjectQueue,
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    spillToFile: () => null,
    isAlive: () => false,
    scheduleTrayRefresh: () => {}, refreshAppMenu: () => {}, refreshTrayMenu: () => {},
    INJECT_BOOT_MAXWAIT: 30, INJECT_QUIET_MAXWAIT: 0, INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0, LONG_TEXT_DELAY: 0, LONG_TEXT_THRESHOLD: 1e9,
    INJECT_HOLD_TIMEOUT: 60_000,
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    ...extraDeps,
  });

  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._applyTemplatePersistence = () => {};
  // Recorded, not swallowed. `_gatedDeliver` is the ONLY channel the lead ever
  // sees an alarm on, so a stub that discarded its argument would leave the t377
  // tests below structurally unable to observe the thing they measure — green
  // whether the detector fires, stays silent, or was never wired at all.
  const alarms = [];
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    alarms.push({ target, body });
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };

  return {
    m, root, alarms,
    setPending: (n) => { pending = n; },
    inlineFor: (n) => inline.get(n),
    bakedFor: (n) => realIpcFor.get(n),
    seen: (n) => writes.get(n) || '',
    stop: () => {
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
        clearTimeout(s._reviewStartTimer);
      }
    },
  };
}

// setImmediate + an awaited create() sit between the intent and the spawn.
async function settled(app, name, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (app.m.sessions.has(name)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('team-review: the scope reaches the reviewer as prompt, not as a delivery', async () => {
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');
    assert.ok(lead, 'ENTER: the lead seat must exist, or the intent below is handled for nobody');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    assert.ok(app.m.sessions.has('crew-reviewer-1'),
      'ENTER: the reviewer seat must actually spawn — every assertion below is vacuous against a seat that never existed');

    const baked = app.inlineFor('crew-reviewer-1');
    assert.ok(baked, 'the reviewer must be handed an inline prompt body at all');
    assert.ok(baked.includes(SCOPE),
      'the scope must be IN the constructed prompt: a dm is written at the seat\'s first turn and the '
      + 'boot re-render wipes it, which is the six-wedge failure this pins');
    assert.ok(/review-done/.test(baked),
      'and the brief must name the verdict channel — a reviewer that knows the scope but not how to '
      + 'report it stalls at the end instead of the start');

    // The end of the pipe, not the start of it. The reviewer spawns with
    // CLODEX_DISABLE_IPC_PROMPT=1 and takes its role brief as a REPLACEMENT system
    // prompt, so "was handed to the merge" and "reached the file the CLI reads" are
    // genuinely different claims here.
    const onDisk = app.bakedFor('crew-reviewer-1');
    assert.ok(typeof onDisk === 'string' && onDisk.length,
      'ENTER: the reviewer spawn must have baked a prompt at all, or the assertion below is vacuous');
    assert.ok(onDisk.includes(SCOPE),
      'the scope must survive into the BAKED prompt bytes: the reviewer disables the IPC prompt and '
      + 'replaces its system prompt, either of which could drop an inline body downstream of the merge');
  } finally { app.stop(); }
});

// The other half, and the one a well-meaning "make it robust" edit breaks: putting
// the scope back into the dm as well. Two copies disagree the moment one is edited,
// and the dm copy is precisely the losable one.
test('team-review: the nudge dm carries no scope of its own', async () => {
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');

    const parked = pendingStore.peekPending(path.join(app.root, 'pending'), 'crew-reviewer-1');
    const body = JSON.stringify(parked || null);
    assert.ok(parked, 'ENTER: a nudge must still be parked for the seat — without it the reviewer holds '
      + 'the scope and never takes a turn, because a prompt alone does not start one');
    assert.ok(!body.includes(SCOPE),
      'the nudge must NOT restate the scope: a second copy on the losable channel is what this change removes');
    assert.ok(/Begin/.test(body), 'and it must still be a start signal');
  } finally { app.stop(); }
});

// --- t377: a reviewer that never takes its first turn ------------------------
//
// Measured twice. `clodex-reviewer-365-r2` sat alive and idle for ~30 minutes
// and `clodex-reviewer-375-r1` for 4 — the second caught by the operator, not by
// any alarm. Both had their scope (it is in the prompt, per the tests above), so
// what went missing is the START NUDGE, and a reviewer has no other traffic to
// earn a turn from. Nothing detected either one.
//
// The tell is the TRANSCRIPT: the hook creates run/<name>/transcript.jsonl as a
// symlink at spawn, and its target appears only once the CLI writes a turn.
// Measured in both directions on the same night — t375's target still absent 4
// minutes in, while a healthy clodex-reviewer-371-r1 had 254KB with a moving
// mtime inside five. So these tests write (or do not write) that file and drive
// `_checkReviewStarted` directly, rather than waiting out a 90s window.
//
// The two tests are ONE UNIT: the firing test alone is green under a detector
// that alarms on EVERY reviewer, which would be worse than none.

// Everything the production arm does, minus the 90s wait. `_armReviewStartCheck`
// is exercised for real by the spawn (its timer is armed and unref'd); this is
// the timer's own callback, called at the moment it would have fired.
function reviewerSeat(app, { transcript }) {
  const s = app.m.sessions.get('crew-reviewer-1');
  s.activityState = 'idle';
  if (transcript != null) {
    const link = pathFor(app.root, 'crew-reviewer-1', 'transcript');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const target = path.join(app.root, 'real-transcript.jsonl');
    fs.writeFileSync(target, transcript);
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(target, link);
  }
  return s;
}

test('t377: a reviewer with no transcript is reported to the lead as never started', async () => {
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });
    // ENTER: the seat is in the measured shape — alive, idle, no transcript. A
    // check run against a seat that never spawned would alarm for the wrong
    // reason, and one against a busy seat would decline for the right one.
    assert.ok(s && !s._dead, 'ENTER: the reviewer seat is alive');
    assert.strictEqual(s.activityState, 'idle', 'ENTER: and idle — it has taken no turn');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: and has produced no transcript, which is the signal itself');
    // ENTER: the arm really happened at spawn. Without this the test would pass
    // against a detector that is never wired to anything.
    assert.ok(s._reviewStartTimer, 'ENTER: the spawn armed the check');

    app.alarms.length = 0;
    // TWO windows now: the first re-sends the nudge (t381), and only a seat still
    // silent after that redelivery is escalated. Driving the check once here would
    // assert the alarm against a state production never reaches.
    app.m._checkReviewStarted(s, 'lead');
    assert.deepStrictEqual(app.alarms, [],
      'ENTER: the first window redelivers instead of alarming — the lead is not woken for a seat that has not been re-nudged yet');
    app.m._checkReviewStarted(s, 'lead');

    assert.strictEqual(app.alarms.length, 1, 'the lead is told exactly once');
    assert.strictEqual(app.alarms[0].target, 'lead', 'and it goes to the lead, like a stall alarm');
    const body = app.alarms[0].body;
    assert.match(body, /crew-reviewer-1/, 'it names the seat');
    assert.match(body, /NO turn|never started/, 'and says what is wrong');
    // The recovery matters as much as the detection: a respawn is the intuitive
    // move and it is wrong — it mints a second seat while the first keeps its
    // born-stamped mail, which drainPending then discards.
    assert.match(body, /urgent dm/, 'it names the recovery that works');
    assert.match(body, /NOT a respawn/, 'and the one that does not');
  } finally { app.stop(); }
});

test('t377: a reviewer that HAS written a transcript is never reported', async () => {
  // The other direction, in the same unit. A detector that alarms on every
  // reviewer trains the lead to dismiss it, which is the failure defect 2 is
  // about — arriving here by a different road.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    // A seat that took a turn and came back to idle — the shape a pure
    // activityState test would misread as silent.
    const s = reviewerSeat(app, { transcript: '{"type":"assistant"}\n' });
    assert.strictEqual(s.activityState, 'idle',
      'ENTER: idle, so only the transcript can distinguish it from the silent seat above');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), true,
      'ENTER: and its transcript really is readable');

    app.alarms.length = 0;
    app.m._checkReviewStarted(s, 'lead');
    assert.deepStrictEqual(app.alarms, [],
      'a reviewer that started is silent, however long it then takes — this is not a stall detector');
  } finally { app.stop(); }
});

test('t377: a reviewer blocked on a permission dialog re-arms instead of alarming', async () => {
  // A dialog is an unbounded wait that produces no turn and no transcript, and it
  // is not this defect — the seat has its scope and is asking about it. Alarming
  // there reports the operator's own unanswered dialog back as a wedge.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });
    s.needsAttention = { kind: 'permission' };
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: no transcript — so the dialog check is the only thing that can hold the alarm');

    app.alarms.length = 0;
    clearTimeout(s._reviewStartTimer);
    s._reviewStartTimer = null;
    app.m._checkReviewStarted(s, 'lead');

    assert.deepStrictEqual(app.alarms, [], 'no alarm while the dialog is up');
    assert.ok(s._reviewStartTimer,
      're-armed rather than dropped: a dialog answered ten minutes later must still be checked afterwards');
  } finally { app.stop(); }
});

test('t377: a retired reviewer is not reported — the check outlives the seat', async () => {
  // The window is 90s and a fast review can finish inside it. An alarm about a
  // seat that already delivered its verdict is the same class of noise as t376's
  // alarm about a retired hand.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });
    assert.ok(app.m.sessions.has('crew-reviewer-1'), 'ENTER: it was there');
    app.m.sessions.delete('crew-reviewer-1');   // retired by review-done

    app.alarms.length = 0;
    app.m._checkReviewStarted(s, 'lead');
    assert.deepStrictEqual(app.alarms, [], 'nothing is owed about a seat that is gone');
    // Put it back before the teardown. `stop()` walks the sessions MAP, so a seat
    // deleted from it keeps every handle the spawn opened — watcher, sentinel and
    // timers alike — and the test file then hangs until node kills it rather than
    // failing. Production has no such gap: the real retire goes through _cleanup.
    app.m.sessions.set('crew-reviewer-1', s);
  } finally { app.stop(); }
});

// --- t381: the lost nudge is re-sent, not just reported ----------------------
//
// Measured against the real CLI (scripts/t381-injection-repro), 3/3: a seat
// sitting in a single modal swallows one delivery WHOLE — text and Enter both —
// and the NEXT delivery lands. So the recovery this check used to ask the lead to
// perform by hand ("recover with an urgent dm") is one the machine can do itself,
// and the operator's one-poke rescue of clodex-reviewer-377-r1 was exactly it.
//
// The nudge is contentless by construction, which is what makes redelivering it
// safe: it duplicates no scope, so the worst case is a reviewer told to begin
// twice. A SPEC redelivery would need _checkSpecConfirm's whole latch argument.

// How many start-nudges are parked for the seat right now. The park is the real
// channel (_deliverParkedActive), so counting parked bodies is what proves a
// redelivery was actually handed to the seat rather than merely decided on.
// The store's own counter, nothing else. An earlier version looped on
// `peekPending` and OR-ed the result in, which counted nothing: peek returns an
// ARRAY, `[]` is truthy, so the loop always yielded 1 and the `|| n` fallback
// reported 1 parked delivery when none existed — making the `before >= 1` ENTER
// guard below true regardless of whether the spawn parked anything.
function nudgeCount(app, name) {
  return pendingStore.countPending(path.join(app.root, 'pending'), name);
}

test('t381: a silent reviewer gets its start nudge RE-SENT before the lead is ever woken', async () => {
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });

    // ENTER: the seat is in the measured failure shape. Without these the test
    // could pass against a check that declines for an unrelated reason.
    assert.ok(s && !s._dead, 'ENTER: the reviewer seat is alive');
    assert.strictEqual(s.activityState, 'idle', 'ENTER: and idle — it has taken no turn');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: and has produced no transcript');
    const before = nudgeCount(app, 'crew-reviewer-1');
    assert.ok(before >= 1, 'ENTER: the spawn parked a first nudge — the redelivery below must be a SECOND one');

    app.alarms.length = 0;
    // Cleared FIRST, or the assertion below reads the timer the SPAWN armed and is
    // true no matter what the check does — a fire-and-forget retry would pass it.
    clearTimeout(s._reviewStartTimer);
    s._reviewStartTimer = null;
    app.m._checkReviewStarted(s, 'lead');

    // The redelivery itself, at the channel the seat actually reads.
    const after = nudgeCount(app, 'crew-reviewer-1');
    assert.strictEqual(after, before + 1,
      'the nudge is re-sent: exactly one more delivery is parked for the seat');
    assert.deepStrictEqual(app.alarms, [],
      'and the lead is NOT woken for it — a recovery the machine can perform is not an escalation');
    assert.ok(s._reviewNudgeRetried, 'the retry is latched, so it cannot repeat');
    assert.ok(s._reviewStartTimer,
      're-armed to watch the redelivery: a fire-and-forget retry would let a still-silent seat go quiet instead of escalating');
  } finally { app.stop(); }
});

test('t381: the re-sent nudge carries no scope — it is the same contentless start signal', async () => {
  // The nudge dm is deliberately contentless (the test above pins it for the
  // spawn). A redelivery that "helpfully" restated the scope would reintroduce
  // exactly the two-copies-disagree bug, on the losable channel, at the moment
  // the seat is least able to receive it.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });

    // Drain the spawn's nudge so what remains is unambiguously the redelivery.
    const dir = path.join(app.root, 'pending');
    const first = pendingStore.drainPending(dir, 'crew-reviewer-1', 'test-1', app.m._bornFor('crew-reviewer-1'));
    assert.ok(first.length >= 1, 'ENTER: the spawn nudge was there to drain, so the body below is the RE-SEND');

    app.m._checkReviewStarted(s, 'lead');

    const resent = pendingStore.drainPending(dir, 'crew-reviewer-1', 'test-2', app.m._bornFor('crew-reviewer-1'));
    assert.strictEqual(resent.length, 1, 'ENTER: exactly one redelivery to inspect');
    assert.ok(/Begin/.test(resent[0]), 'it is still a start signal');
    // The residual race this clause exists for: a nudge submitted just before the
    // window leaves the seat idle-with-no-transcript when the check fires, so the
    // retry drains AFTER the seat's first turn and reaches a reviewer mid-review.
    // Nothing outside the seat can close that, so the duplicate has to be harmless.
    assert.match(resent[0], /ignore this if you have already started/,
      'and it tells a seat that already started to drop it — a late-draining retry '
      + 'must not talk a mid-review reviewer into a second report');
    assert.ok(!resent[0].includes(SCOPE),
      'and it does NOT restate the scope — the prompt is the single source, on the channel that cannot be lost');
  } finally { app.stop(); }
});

test('t381: a reviewer that starts BECAUSE of the re-sent nudge is never escalated', async () => {
  // THE TRANSITION, which is the feature: the seat has no transcript at the first
  // window, is re-nudged, and takes its turn only afterwards. Asserting the two
  // end states from either side of this would be t377's own mistake — four states
  // pinned and the crossing between them untested, which is where the bug lives.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: silent at the first window — the state the redelivery exists for');

    app.alarms.length = 0;
    app.m._checkReviewStarted(s, 'lead');          // window 1: re-sends
    assert.ok(s._reviewNudgeRetried, 'ENTER: the redelivery really happened');
    assert.deepStrictEqual(app.alarms, [], 'ENTER: and nothing was escalated yet');

    // The nudge lands and the seat starts — the measured single-modal recovery.
    reviewerSeat(app, { transcript: '{"type":"assistant"}\n' });
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), true,
      'ENTER: the seat has now CROSSED the boundary — it took a turn after the re-send');

    app.m._checkReviewStarted(s, 'lead');          // window 2: sees the turn
    assert.deepStrictEqual(app.alarms, [],
      'a reviewer rescued by the redelivery is never reported: the recovery succeeded, so there is nothing to tell the lead');
  } finally { app.stop(); }
});

test('t381: a reviewer still silent after the re-send IS escalated, and the prose says it was re-sent', async () => {
  // The redelivery must not become a way to go quiet. A chained modal defeats it
  // (measured: first-run onboarding), so the second window has to be louder than
  // the first, not softer — and it must not repeat the old prose, which claimed
  // no redelivery had been attempted.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });

    // The SPAWN stamped this; backdate it so the elapsed figure has a value that
    // could only come from the stamp. Asserting it is a number first is the point:
    // without that, backdating a field nothing sets would still read as a pass.
    assert.ok(Number.isFinite(s._reviewStartArmedAt),
      'ENTER: the arm stamped a start time — the elapsed figure below is derived from it');
    s._reviewStartArmedAt = Date.now() - 180000;

    app.alarms.length = 0;
    app.m._checkReviewStarted(s, 'lead');
    assert.deepStrictEqual(app.alarms, [], 'ENTER: window 1 redelivered rather than alarming');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: and the seat is STILL silent — the redelivery did not take');

    app.m._checkReviewStarted(s, 'lead');

    assert.strictEqual(app.alarms.length, 1, 'the lead is told exactly once, at the second window');
    const body = app.alarms[0].body;
    // The VALUE, not "contains a number". The stale constant survived a whole
    // round underneath an assertion on the neighbouring clause of this sentence,
    // so a predicate that any figure satisfies would repeat that exactly.
    assert.match(body, /spawned 180s ago/,
      'the elapsed figure is measured from the arm, not the constant window length — '
      + 'the escalation fires at the SECOND window, and the dialog branch re-arms uncapped, '
      + 'so a constant here understates by however many windows have run');
    assert.match(body, /re-sent/, 'the prose says the nudge was already re-sent');
    assert.match(body, /STILL taken no turn/,
      'and that it did not help — the old wording claimed no redelivery was attempted, which is now false');
    assert.match(body, /urgent dm/, 'the human recovery is still named');
    assert.match(body, /NOT a respawn/, 'and the one that strands mail is still warned against');

    // A third window must not produce a second alarm or a third nudge.
    app.alarms.length = 0;
    app.m._checkReviewStarted(s, 'lead');
    assert.strictEqual(app.alarms.length, 1,
      'the escalation repeats at most once per window and never re-nudges — the latch is spent');
  } finally { app.stop(); }
});

test('t381: a reviewer on a permission dialog is re-armed, never re-nudged', async () => {
  // A dialog is not this defect: the seat has its scope and is asking about it.
  // Poking it would inject into the one non-composer state Clodex already knows
  // about — and shouldHoldDm deliberately holds for exactly this case.
  const app = boot();
  try {
    app.setPending('lead');
    await app.m.create('lead', 'claude', app.root, [], null, 'ws');
    const lead = app.m.sessions.get('lead');

    app.setPending('crew-reviewer-1');
    app.m._handleTeamReview(lead, SCOPE);
    await settled(app, 'crew-reviewer-1');
    const s = reviewerSeat(app, { transcript: null });
    s.needsAttention = { kind: 'permission' };
    const before = nudgeCount(app, 'crew-reviewer-1');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'ENTER: no transcript, so only the dialog check can hold the redelivery');

    app.alarms.length = 0;
    clearTimeout(s._reviewStartTimer);
    s._reviewStartTimer = null;
    app.m._checkReviewStarted(s, 'lead');

    assert.strictEqual(nudgeCount(app, 'crew-reviewer-1'), before,
      'nothing is re-sent to a seat blocked on a dialog');
    assert.ok(!s._reviewNudgeRetried,
      'and the one-shot retry is NOT spent — it must still be available once the dialog is answered');
    assert.deepStrictEqual(app.alarms, [], 'no alarm either');
    assert.ok(s._reviewStartTimer, 're-armed, so a dialog answered later is still checked');
  } finally { app.stop(); }
});

test('t384: an EMPTY transcript file is still "no transcript" — the boundary is > 0', () => {
  // t384 re-expressed `_seatHasTranscript` on top of a size probe, which makes
  // this boundary newly mutable: `>= 0` passes every test t377 wrote, because
  // those fixtures have NO FILE AT ALL (the probe throws) rather than an empty
  // one. The hook creates the link at spawn and its target only when the CLI
  // first writes, so an existing-but-empty transcript is exactly the
  // never-started seat the detector is for — and under `>= 0` it reads as
  // started and is never escalated.
  const app = boot();
  try {
    const link = pathFor(app.root, 'crew-reviewer-1', 'transcript');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const target = path.join(app.root, 'empty-transcript.jsonl');
    fs.writeFileSync(target, '');
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(target, link);

    assert.strictEqual(fs.statSync(target).size, 0, 'ENTER: the file really exists and is empty');
    assert.strictEqual(app.m._seatTranscriptSize('crew-reviewer-1'), 0,
      'ENTER: the probe READ it — this is not the throwing path t377 pinned');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'zero bytes is a seat that has taken no turn');
  } finally { app.stop(); }
});

test('t384: an UNREADABLE transcript probes to -1, which is not a byte count', () => {
  // The sentinel is load-bearing and its only defence is this assertion: 0 is a
  // REAL size (a seat that has written nothing), so a probe that returned 0 on
  // an fs error makes the two indistinguishable. Downstream that is phantom
  // growth — an unreadable baseline healing into a readable file reads as
  // `size > prevSize`, i.e. as a turn that never happened, and the stall alarm
  // is suppressed on a seat nobody has evidence about. Caught by a mutant that
  // survived every other test in this file.
  const app = boot();
  try {
    assert.strictEqual(app.m._seatTranscriptSize('crew-reviewer-1'), -1,
      'no link at all is unreadable, and says so distinctly from "empty"');
    assert.strictEqual(app.m._seatHasTranscript('crew-reviewer-1'), false,
      'and it still answers the t377 question the same way');
  } finally { app.stop(); }
});
