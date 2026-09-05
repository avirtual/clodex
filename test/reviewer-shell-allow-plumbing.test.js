'use strict';
// Run: node --test test/reviewer-shell-allow-plumbing.test.js
//
// t673 — the ONE line that carries the shell allowlist from create()'s options
// into the generated settings file.
//
// This file exists because of a red-proof that came back GREEN. Deleting the
// `shellAllow` argument at create()'s call to setupClaudeHook broke nothing:
// resolve-seat-shape.test.js pins the allowlist onto the resolved SHAPE,
// cli-hooks.test.js pins setupClaudeHook writing an allow block when handed
// one, and neither executes the line between them. The seat would have spawned
// with the shape carrying the allowlist, the settings file carrying no allow
// block, and a suite of 6,400 tests green over a reviewer whose shell was
// governed by nothing.
//
// So the subject here is the SEAM, not either end: drive the real create()
// claude arm and capture the arguments setupClaudeHook actually received.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SHELL_ALLOW = ['Bash(git diff:*)', 'Bash(ls:*)', 'Bash(node --test:*)'];

function mkManager() {
  const root = mkTmpRoot('clx-shellallow-');
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const store = new Map();
  // Every call, not just the last: create() must reach the hook exactly once per
  // spawn, and a second call with different arguments would overwrite the file.
  const hookCalls = [];

  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor, os,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir,
    getPersistence: () => ({
      list: () => [...store.values()], get: (n) => store.get(n) || null,
      upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
      remove: (n) => store.delete(n), setSessionId: () => {},
    }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
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
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    WIRE_SHADOW: false,
    WIRE_INTENTS_LIVE: false,
    // The capture. Named parameters rather than `...args` so a signature change
    // that reorders them fails here loudly instead of silently shifting which
    // value this test calls the allowlist.
    setupClaudeHook: (n, proxyBase, proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase, createdAt, allowRules) => {
      hookCalls.push({ name: n, disabledTools, allowRules });
      fs.mkdirSync(runDirFor(root, n), { recursive: true });
      return path.join(root, 'settings.json');
    },
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {},
    cleanupSkillPlugin: () => {}, cleanupAgentPlugin: () => {},
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: (names) => names || [],
    qualifiedAgentName: (n) => n,
    DROPPED_AGENT_FIELDS: [],
    BUILTIN_AGENTS: require('../agents-util').BUILTIN_AGENTS,
    effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    writeAgentPlugin: () => null,
    writeSkillPlugin: () => null,
    bakePrompt: () => '',
    nextIncarnation: () => 1,
    memLoad: { noteDigest: () => {}, noteSession: () => {} },
    tiersOf: () => ({}),
    arm: { onContextReset: () => {} },
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._ensureWire = async () => null;
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
  };
  // Not wrapped in try/catch: a create() that threw before reaching the hook
  // would satisfy an "allowlist absent" assertion for entirely the wrong reason.
  const spawn = async (name, { disabledTools = [], shellAllow = null } = {}) => {
    await m.create(name, 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
      [], [], disabledTools, [], [], null, [], [], null, null, true, true, null, shellAllow);
    stop(name);
  };
  return { m, spawn, hookCalls, root };
}

test('t673: create() carries shellAllow through to setupClaudeHook', async () => {
  const f = mkManager();
  await f.spawn('shell-seat', { disabledTools: ['Edit'], shellAllow: SHELL_ALLOW });
  assert.strictEqual(f.hookCalls.length, 1, 'ENTER: the hook was set up exactly once — the arguments below are that call\'s');
  // The LITERAL list, in order: this is the seam a green red-proof found
  // unguarded, so an assertion that only checked truthiness would leave the
  // interesting failure (a truncated or reordered list) unpinned.
  assert.deepStrictEqual(f.hookCalls[0].allowRules, SHELL_ALLOW);
  // The neighbouring argument, asserted in the same call: both ride the same
  // parameter list, and a shift of one is the failure mode a single-argument
  // assertion cannot see.
  assert.deepStrictEqual(f.hookCalls[0].disabledTools, ['Edit']);
});

test('t673: a seat with no shellAllow hands the hook an empty list, never undefined', async () => {
  // Every non-reviewer spawn takes this path. `undefined` would reach
  // setupClaudeHook's default and behave the same today — but the default is
  // one edit away from mattering, and an explicit [] is what the parameter
  // means here.
  const f = mkManager();
  await f.spawn('plain-seat');
  assert.strictEqual(f.hookCalls.length, 1);
  assert.deepStrictEqual(f.hookCalls[0].allowRules, [],
    'no allowlist means an empty list, which setupClaudeHook writes as no allow block at all');
});
