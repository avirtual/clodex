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

const SCOPE = 'diff at /tmp/t5.diff against 2b7179c — attn: the migration ordering';

function boot(extraDeps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-t5-'));
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
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {},
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
    buildAgentsArg: () => null, effectiveInjectedSkills: () => [],
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
