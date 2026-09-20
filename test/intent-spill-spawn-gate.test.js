'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { buildIpcPrompt } = require('../ipc-prompt');
const { intentEnabled } = require('../intent-catalog');
const { mkTmpRoot } = require('./lib/tmp-roots');

const GRAMMAR = 'Bodies of task add/respec/reject, shout, and context compact/clear/reload longer than 800 bytes';

function mkManager({ intentSpill = 'off', backend = null } = {}) {
  const root = mkTmpRoot('clx-spillgate-');
  const store = new Map();
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
  };
  const registered = [];
  const prompts = [];
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({ intentSpill }) }),
    resolveProxyBase: () => null,
    normalizeProxyBase: (v) => v,
    resolveProxyAgentId: () => null,
    lastTranscriptWrite: () => null,
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { start() {} stop() {} },
    JsonlWatcher: class { start() {} stop() {} },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999 }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    WIRE_SHADOW: true,
    WIRE_INTENTS_LIVE: true,
    setupClaudeHook: () => {},
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    buildIpcPrompt, writeClaudeDigestFile: () => false,
    getEnvScopes: () => ({
      all: () => ({
        global: backend ? { CLAUDE_CODE_USE_BEDROCK: '1' } : {},
        workspaces: {},
      }),
    }),
    getUserDataPath: () => root,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a, ipcPrompt) => { prompts.push(ipcPrompt); return { cleaned: [...a], append: null }; },
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    intentEnabled,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    bakePrompt: () => '',
    nextIncarnation: () => 1,
    memLoad: { noteDigest: () => {}, noteSession: () => {} },
    tiersOf: () => ({}),
    arm: { onContextReset: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._ensureWire = async () => ({
    registerAgent: (name, opts) => {
      registered.push({ name, spill: (opts && opts.spill) || null });
      return 'http://127.0.0.1:9/wire';
    },
  });
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  return { m, persistence, registered, prompts, root, stop };
}

function spawn(m, name, intents = null) {
  return m.create(name, 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
    [], [], [], [], [], null, [], [], intents, null, true, false);
}

test('a Claude seat spawned with the setting OFF still registers spill on the wire', async () => {
  const h = mkManager({ intentSpill: 'off' });
  try {
    await spawn(h.m, 'seat');
    assert.equal(h.registered.length, 1, 'ENTER: the spawn reached the wire registration');
    const spill = h.registered[0].spill;
    assert.ok(spill, 'the registration is no longer gated on the setting — the proxy gates per request');
    assert.equal(spill.root, h.root);
    assert.deepEqual([...spill.verbs].sort(),
      ['context.clear', 'context.compact', 'context.reload', 'shout',
        'task.add', 'task.reject', 'task.respec']);
  } finally { h.stop('seat'); }
});

test('the grammar line is in the prompt with the setting OFF, so a flip changes no bytes', async () => {
  const off = mkManager({ intentSpill: 'off' });
  const on = mkManager({ intentSpill: 'on' });
  try {
    await spawn(off.m, 'seat');
    await spawn(on.m, 'seat');
    assert.ok(off.prompts[0].includes(GRAMMAR),
      'the prompt is captured at spawn and replayed on clear/compact, so it must not track the setting');
    assert.ok(off.prompts[0].includes('Never type `@spill:` yourself'));
    assert.ok(off.prompts[0].includes("your transcript keeps the body's first line and `@spill:<id>` in their place"),
      'the seat is told the title rides along, so it does not read a titled pointer as a corrupted emission');
    assert.ok(off.prompts[0].includes(
      'On a turn Clodex injected (a dm, a ticket or exec reply, a reminder), prose after your last '
      + 'intent — or a whole reply with no intent — is spilled the same way once it passes 800 bytes: '
      + 'what the operator must know goes inside an intent, not after it — a dm from your '
      + 'operator counts as typed.'),
    'and that its trailing prose on an injected turn goes the same way, so a pointer where its '
    + 'sign-off was does not read as the wire having eaten something');
    const norm = (s, r) => s.split(r).join('<root>');
    assert.equal(norm(off.prompts[0], off.root), norm(on.prompts[0], on.root),
      'flipping the setting changes zero prompt bytes');
  } finally { off.stop('seat'); on.stop('seat'); }
});

test('a Bedrock seat registers spill: null and carries no grammar line', async () => {
  const h = mkManager({ intentSpill: 'on', backend: 'bedrock' });
  try {
    await spawn(h.m, 'seat');
    assert.equal(h.registered.length, 1);
    assert.equal(h.registered[0].spill, null,
      'a tee-blind seat never reaches the wire, so arming it would promise a rewrite that cannot happen');
    assert.ok(!h.prompts[0].includes(GRAMMAR));
  } finally { h.stop('seat'); }
});

test('a seat whose stored allowlist still says notify-user is armed and prompted for shout', async () => {
  const h = mkManager({ intentSpill: 'on' });
  try {
    await spawn(h.m, 'seat', ['dm', 'who', 'notify-user', 'context', 'exec', 'remind', 'file', 'spawn', 'memory', 'resend']);
    assert.equal(h.registered.length, 1, 'ENTER: the spawn reached the wire registration');
    assert.ok([...h.registered[0].spill.verbs].includes('shout'),
      't1016 renamed the catalog key with no alias, but `intents` is stored capability DATA that '
      + 'every pre-flag-day seat and ~/.clodex/teams template still spells the old way; without the '
      + 'legacy mapping the wire is unarmed here and a long note is emitted whole');
    assert.ok(h.prompts[0].includes('[agent:shout] message'),
      'and the same stale data decides whether the seat is even told the verb exists');
  } finally { h.stop('seat'); }
});

test('a seat that really gated the inbox note off keeps it off', async () => {
  const h = mkManager({ intentSpill: 'on' });
  try {
    await spawn(h.m, 'seat', ['dm', 'who']);
    assert.equal(h.registered.length, 1, 'ENTER: the spawn reached the wire registration');
    assert.ok(!(h.registered[0].spill.verbs || []).includes('shout'),
      'the canonicalisation must not become a blanket grant, or the flag day silently RE-ENABLES '
      + 'the channel on every seat whose operator deliberately switched it off');
    assert.ok(!h.prompts[0].includes('[agent:shout] message'));
  } finally { h.stop('seat'); }
});
