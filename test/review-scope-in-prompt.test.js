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

function boot() {
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
  });

  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._applyTemplatePersistence = () => {};

  return {
    m, root,
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
