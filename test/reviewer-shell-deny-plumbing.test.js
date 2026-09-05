'use strict';
// Run: node --test test/reviewer-shell-deny-plumbing.test.js
//
// t673 — the ONE line that carries the shell deny rules from create()'s options
// into the generated settings file.
//
// This file exists because of a red-proof that came back GREEN. Deleting the
// shell-rules argument at create()'s call to setupClaudeHook broke nothing:
// resolve-seat-shape.test.js pins the rules onto the resolved SHAPE,
// cli-hooks.test.js pins setupClaudeHook merging rules it is handed, and neither
// executes the line between them. The seat would have spawned with the shape
// carrying the rules, the settings file carrying none of them, and a suite of
// 6,400 tests green over a reviewer whose shell was governed by nothing.
//
// So the subject here is the SEAM, not either end: drive the real create()
// claude arm into the real setupClaudeHook and read the settings file it wrote.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SHELL_DENY = ['Bash(rm:*)', 'Bash(touch:*)', 'Bash(git commit:*)'];
const TOOL_DENY = ['Edit', 'Write'];

function mkManager() {
  const root = mkTmpRoot('clx-shelldeny-');
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const store = new Map();
  // Every call, not just the last: create() must reach the hook exactly once per
  // spawn, and a second call with different arguments would overwrite the file.
  const hookCalls = [];
  // The REAL hook, wrapped only to count: a stub would pin create() handing off
  // an argument and prove nothing about the settings file, which is the artifact
  // the CLI actually reads.
  const hooks = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });

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
    // Named parameters rather than `...args` so a signature change that reorders
    // them fails here loudly instead of silently shifting which value this test
    // calls the shell rules.
    setupClaudeHook: (n, proxyBase, proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase, createdAt, extraDenyRules) => {
      hookCalls.push({ name: n, disabledTools, extraDenyRules });
      return hooks.setupClaudeHook(n, proxyBase, proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase, createdAt, extraDenyRules);
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
  // would satisfy a "rules absent" assertion for entirely the wrong reason.
  const spawn = async (name, { disabledTools = [], shellDeny = null } = {}) => {
    await m.create(name, 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
      [], [], disabledTools, [], [], null, [], [], null, null, true, true, null, shellDeny);
    stop(name);
  };
  const settingsOf = (name) => JSON.parse(fs.readFileSync(pathFor(root, name, 'settings'), 'utf-8'));
  const record = (name) => store.get(name) || null;
  // kill()'s record drop, which every re-create path runs before create(). The
  // session must go too, or create() refuses the name as already live.
  const forget = (name) => { m.sessions.delete(name); store.delete(name); };
  return { m, spawn, hookCalls, settingsOf, record, forget, root };
}

test('t673: create() carries shellDeny into the settings file deny block', async () => {
  const f = mkManager();
  await f.spawn('shell-seat', { disabledTools: TOOL_DENY, shellDeny: SHELL_DENY });
  assert.strictEqual(f.hookCalls.length, 1, 'ENTER: the hook was set up exactly once — the settings file below is that call\'s');
  // The literal union, in order: this is the seam a green red-proof found
  // unguarded, so an assertion that only checked truthiness would leave the
  // interesting failure (a truncated, reordered or separately-keyed list)
  // unpinned.
  const settings = f.settingsOf('shell-seat');
  assert.deepStrictEqual(settings.permissions.deny, ['Edit', 'Write', 'Bash(rm:*)', 'Bash(touch:*)', 'Bash(git commit:*)']);
  // An allow block is PRE-APPROVAL, not a wall — a command absent from it still
  // runs. Writing one here would look like a tightening and be a widening.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(settings.permissions, 'allow'), false);
  // The neighbouring argument, asserted in the same call: both ride the same
  // parameter list, and a shift of one is the failure mode a single-argument
  // assertion cannot see.
  assert.deepStrictEqual(f.hookCalls[0].disabledTools, TOOL_DENY);
});

test('t673: the deny rules are PERSISTED, so a re-created seat rebuilds the same wall', async () => {
  // The wall survived only the FIRST spawn: `shellDeny` reached create() as an
  // argument and nothing wrote it to the record, so every kill()+create() path
  // (reload, restart, retry, restore-on-launch) re-ran setupClaudeHook with an
  // empty list. The regenerated settings.json then had NO shell rules while the
  // record still carried Bash in the tools and the lead's bypass in extraArgs —
  // a reviewer with an unrestricted shell, reached by a GUI button.
  const f = mkManager();
  await f.spawn('shell-seat', { disabledTools: TOOL_DENY, shellDeny: SHELL_DENY });
  const rec = f.record('shell-seat');
  assert.deepStrictEqual(rec.shellDeny, SHELL_DENY,
    'ENTER: the record itself carries the rules — every re-create site reads them from here');

  // The re-create, spelled exactly as the five callers spell it. Driving the
  // record through the same real hook is the point: asserting the argument was
  // passed would pin the call, not the settings file the CLI actually reads.
  f.forget('shell-seat');
  await f.spawn('shell-seat', {
    disabledTools: rec.disabledTools,
    shellDeny: Array.isArray(rec.shellDeny) ? rec.shellDeny : null,
  });
  assert.deepStrictEqual(f.settingsOf('shell-seat').permissions.deny,
    ['Edit', 'Write', 'Bash(rm:*)', 'Bash(touch:*)', 'Bash(git commit:*)'],
    'the rebuilt settings file carries the same wall as the first spawn');
});

test('t673: a seat with no shellDeny persists no key, so a re-create adds none', async () => {
  // Absent, not `[]`: every record predating this field omits the key, and an
  // empty array stored on every ordinary seat would be a second spelling of the
  // same state for the re-create sites to get wrong.
  const f = mkManager();
  await f.spawn('plain-seat', { disabledTools: TOOL_DENY });
  assert.ok(!Object.prototype.hasOwnProperty.call(f.record('plain-seat'), 'shellDeny'));
});

test('t673: a seat with no shellDeny hands the hook an empty list, never undefined', async () => {
  // Every non-reviewer spawn takes this path. `undefined` would reach
  // setupClaudeHook's default and behave the same today — but the default is
  // one edit away from mattering, and an explicit [] is what the parameter
  // means here.
  const f = mkManager();
  await f.spawn('plain-seat', { disabledTools: TOOL_DENY });
  assert.strictEqual(f.hookCalls.length, 1);
  assert.deepStrictEqual(f.hookCalls[0].extraDenyRules, []);
  assert.deepStrictEqual(f.settingsOf('plain-seat').permissions.deny, TOOL_DENY,
    'no shell rules means the deny block is exactly what the tool cap produced');
});
