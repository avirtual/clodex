'use strict';
// Run: node --test
// t403 — the subagent overlay moved off the command line. It used to spawn as
// `--agents <the whole JSON blob>`, which put every enabled agent's prompt in
// the seat's `ps` line; it now scaffolds a second plugin dir and passes
// `--plugin-dir`.
//
// This file drives the REAL create() claude arm with the REAL scaffolders over
// a temp ~/.clodex, so the argv asserted below is the argv a spawn builds and
// the files asserted are the files a spawn writes. The engine's writeAgentPlugin
// is module-private, so it is reconstructed here from the same two public parts
// it composes (buildAgentPlugin + confine) — the confinement ordering itself is
// pinned separately, at source level, in test/skill-plugin-confine.test.js.
//
// The central property is an ABSENCE (`--agents` is gone from argv), and an
// absence passes trivially against a create() that threw or a fixture with no
// agents enabled. So every absence arm below is paired with the positive fact
// that the overlay still arrived — via --plugin-dir, with the files on disk.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { confine } = require('../path-confine');
const { buildAgentPlugin, qualifiedAgentName, DROPPED_AGENT_FIELDS, BUILTIN_AGENTS } = require('../agents-util');
const { buildSkillPlugin, unresolvedSubagentRefs } = require('../skills-util');
const { mkTmpRoot } = require('./lib/tmp-roots');

// The library every arm resolves against. `meta` mirrors what stores.js hands
// over: raw frontmatter strings, not coerced values.
const LIB = [
  { name: 'test-runner', meta: { description: 'Runs the suite.', tools: 'Bash, Read', model: 'haiku' }, body: 'You run tests.' },
  { name: 'dist-builder', meta: { description: 'Builds the DMG.', tools: 'Bash' }, body: 'You build.' },
];

function mkManager({ library = LIB, skills = [], enabledAgents = [], injectSkills = [] } = {}) {
  const root = mkTmpRoot('clx-agentplugin-');
  const AGENT_PLUGINS_DIR = path.join(root, 'agent-plugins');
  const SKILL_PLUGINS_DIR = path.join(root, 'skill-plugins');
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const store = new Map();
  let spawnArgs = null;
  const warnings = [];

  // Faithful re-creations of the engine's two private scaffolders: same compose
  // (buildX + confine + rebuild-from-scratch), over a temp root.
  const scaffold = (rootDir, name, plugin, write) => {
    const dir = confine(rootDir, name);
    if (dir === null) throw new Error(`invalid session name: ${name}`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!plugin) return null;
    ensureDir(path.join(dir, '.claude-plugin'));
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(plugin.manifest, null, 2));
    write(dir, plugin);
    return dir;
  };
  const effectiveInjectedAgents = (name, agents) => {
    const byName = new Map(library.map((a) => [a.name, a]));
    return (agents || []).map((n) => byName.get(n)).filter(Boolean);
  };
  const effectiveInjectedSkills = () => skills;

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
    pty: { spawn: (_cmd, args) => { spawnArgs = args; return { onData() {}, onExit() {}, pid: 999 }; } },
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    WIRE_SHADOW: false,
    WIRE_INTENTS_LIVE: false,
    setupClaudeHook: (n) => {
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
    getAgentLibrary: () => ({ list: () => library }),
    unionEnabled: (names) => names || [],
    qualifiedAgentName,
    DROPPED_AGENT_FIELDS,
    // REAL, not a stub: the skill-ref check runs inside a try/catch, so an
    // undefined dep here does not fail the fixture — it swallows the whole
    // check and every "no warning" assertion downstream passes vacuously.
    BUILTIN_AGENTS,
    effectiveInjectedAgents,
    effectiveInjectedSkills,
    unresolvedSubagentRefs,
    writeAgentPlugin: (name, agents) => {
      const records = effectiveInjectedAgents(name, agents);
      const plugin = buildAgentPlugin(records.map((a) => a.name), records);
      return scaffold(AGENT_PLUGINS_DIR, name, plugin, (dir, p) => {
        ensureDir(path.join(dir, 'agents'));
        for (const a of p.agents) fs.writeFileSync(path.join(dir, 'agents', `${a.name}.md`), a.md);
      });
    },
    writeSkillPlugin: (name) => {
      const plugin = buildSkillPlugin(skills.map((s) => s.name), skills);
      return scaffold(SKILL_PLUGINS_DIR, name, plugin, (dir, p) => {
        for (const s of p.skills) {
          ensureDir(path.join(dir, 'skills', s.name));
          fs.writeFileSync(path.join(dir, 'skills', s.name, 'SKILL.md'), s.skillMd);
        }
      });
    },
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
  // Not wrapped in try/catch, deliberately: a create() that threw before the
  // argv was built would satisfy every absence assertion in this file.
  const spawn = async (name, extraArgs = []) => {
    const res = await m.create(name, 'claude', os.tmpdir(), extraArgs, null, 'ws', null, false, null,
      enabledAgents, [], [], [], injectSkills, null, [], [], null, null, true, true);
    stop(name);
    for (const w of (res && res.warnings) || []) warnings.push(w);
    return res;
  };
  return { m, spawn, args: () => spawnArgs, warnings, root, AGENT_PLUGINS_DIR, SKILL_PLUGINS_DIR };
}

// Every --plugin-dir VALUE in an argv, in order.
const pluginDirs = (args) => args.reduce(
  (acc, a, i) => (a === '--plugin-dir' ? [...acc, args[i + 1]] : acc), []);

test('t403: the agent overlay rides --plugin-dir, and --agents is gone from argv', async () => {
  const f = mkManager({ enabledAgents: ['test-runner'] });
  await f.spawn('seat');
  const args = f.args();

  // ENTER: the spawn must have reached the PTY with a real argv, or every
  // assertion below is about null.
  assert.ok(Array.isArray(args) && args.length, 'ENTER: create() reached pty.spawn with an argv');

  // The property the ticket exists for. Asserted on the whole argv, not just
  // the flag: the point is that no fragment of the definition is on the command
  // line at all, so a future mapper that inlined the prompt some other way
  // fails here too.
  assert.ok(!args.includes('--agents'), 'the --agents flag is gone');
  assert.ok(!args.some((a) => String(a).includes('You run tests.')),
    'no agent PROMPT appears anywhere in argv — that is the ps-visibility this fixes');

  // Control: the overlay still arrived, by the new route.
  const dirs = pluginDirs(args);
  assert.strictEqual(dirs.length, 1, 'exactly one plugin dir (agents; no skills enabled here)');
  assert.strictEqual(dirs[0], path.join(f.AGENT_PLUGINS_DIR, 'seat'));
  const md = fs.readFileSync(path.join(dirs[0], 'agents', 'test-runner.md'), 'utf-8');
  assert.match(md, /^name: "test-runner"$/m, 'the scaffolded file carries the canonical name');
  assert.match(md, /You run tests\./, 'and the prompt, on DISK rather than in argv');
  const manifest = JSON.parse(fs.readFileSync(path.join(dirs[0], '.claude-plugin', 'plugin.json'), 'utf-8'));
  assert.strictEqual(manifest.name, 'clodex-agents');
});

test('t403: agents and skills arrive as TWO plugin dirs, distinct roots and manifests', async () => {
  const f = mkManager({
    enabledAgents: ['test-runner'],
    skills: [{ name: 'deploy', content: '---\ndescription: d\n---\nbody' }],
    injectSkills: ['deploy'],
  });
  await f.spawn('seat');
  const dirs = pluginDirs(f.args());

  assert.strictEqual(dirs.length, 2, 'both overlays present — enabling an agent must not cost the skills');
  assert.deepStrictEqual(dirs, [
    path.join(f.AGENT_PLUGINS_DIR, 'seat'),
    path.join(f.SKILL_PLUGINS_DIR, 'seat'),
  ], 'each overlay scaffolds under its OWN root, so neither rebuild deletes the other');

  const nameOf = (d) => JSON.parse(fs.readFileSync(path.join(d, '.claude-plugin', 'plugin.json'), 'utf-8')).name;
  assert.deepStrictEqual(dirs.map(nameOf), ['clodex-agents', 'clodex-skills'],
    'distinct manifest names — sharing one makes the two dirs collide silently, last wins');
});

test('t403: a user-supplied --plugin-dir suppresses the skills dir but NOT the agents', async () => {
  // The skills overlay treats a hand-passed plugin dir as a replacement; the
  // agents overlay cannot, because that dir has no way to express the agent
  // library. Gating both on the same flag would silently drop the agents.
  const f = mkManager({
    enabledAgents: ['test-runner'],
    skills: [{ name: 'deploy', content: '---\ndescription: d\n---\nbody' }],
    injectSkills: ['deploy'],
  });
  await f.spawn('seat', ['--plugin-dir', '/tmp/theirs']);
  const dirs = pluginDirs(f.args());

  assert.ok(dirs.includes('/tmp/theirs'), 'ENTER: the user flag survived into argv');
  assert.ok(dirs.includes(path.join(f.AGENT_PLUGINS_DIR, 'seat')), 'the agent overlay still ships');
  assert.ok(!dirs.some((d) => d.startsWith(f.SKILL_PLUGINS_DIR)), 'the skills overlay stands down');
});

test('t403: enabling an agent does not cost the session its skills (the gate-order regression)', async () => {
  // The skills gate reads `args.includes('--plugin-dir')`. Once the agents
  // block pushes one first, a gate sampled AFTER it reads clodex's own flag as
  // the user's and silently drops every injected skill.
  const f = mkManager({
    enabledAgents: ['test-runner'],
    skills: [{ name: 'deploy', content: '---\ndescription: d\n---\nbody' }],
    injectSkills: ['deploy'],
  });
  await f.spawn('seat');
  assert.ok(fs.existsSync(path.join(f.SKILL_PLUGINS_DIR, 'seat', 'skills', 'deploy', 'SKILL.md')),
    'the skill was scaffolded even though an agent was enabled');
});

test('t403: no agents enabled => no agent plugin dir, and no empty scaffold left behind', async () => {
  const f = mkManager({ enabledAgents: [] });
  await f.spawn('seat');
  const dirs = pluginDirs(f.args());
  assert.deepStrictEqual(dirs, [], 'nothing to inject, no flag');
  assert.ok(!fs.existsSync(path.join(f.AGENT_PLUGINS_DIR, 'seat')),
    'and no manifest-only dir the CLI would load as an empty plugin');
});

test('t403: a spawn warns about frontmatter the plugin loader silently ignores', async () => {
  // permissionMode/initialPrompt were mapped by the flag-era encoder and are
  // dropped by the plugin loader. Silent, the operator keeps believing a
  // permissionMode they authored is in force.
  const f = mkManager({
    library: [{ name: 'picky', meta: { description: 'd', permissionMode: 'dontAsk', initialPrompt: 'go' }, body: 'b' }],
    enabledAgents: ['picky'],
  });
  const res = await f.spawn('seat');
  const warns = (res && res.warnings) || [];
  assert.strictEqual(warns.length, 1, 'one warning naming the agent');
  assert.match(warns[0], /"picky"/);
  assert.match(warns[0], /permissionMode, initialPrompt/, 'both dropped fields named, in list order');
  // And the file really does omit them — a warning about a field that shipped
  // anyway would be worse than none.
  const md = fs.readFileSync(path.join(f.AGENT_PLUGINS_DIR, 'seat', 'agents', 'picky.md'), 'utf-8');
  assert.ok(!md.includes('permissionMode') && !md.includes('initialPrompt'));
});

test('t403: an agent with only loader-read fields warns about nothing', async () => {
  // ENTER for the test above: the warning must be caused by the dropped
  // fields, not emitted for every agent.
  const f = mkManager({ enabledAgents: ['test-runner'] });
  const res = await f.spawn('seat');
  assert.deepStrictEqual((res && res.warnings) || [], []);
});

test('t403: a skill calling a library agent by BARE name is warned, with the qualified name', async () => {
  // The live migration case: ~/.clodex/skills/clodex-test-green.md ships
  // `subagent_type: "test-runner"`, which the plugin loader does not resolve —
  // it registers no bare alias. The spawn warning is the only thing that tells
  // the operator before the delegation fails at runtime.
  const f = mkManager({
    enabledAgents: ['test-runner'],
    skills: [{ name: 'test-green', content: 'Spawn subagent_type: "test-runner" to verify.' }],
    injectSkills: ['test-green'],
  });
  const res = await f.spawn('seat');
  const warns = (res && res.warnings) || [];
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /Skill "test-green" calls subagent "test-runner"/);
  assert.match(warns[0], /clodex-agents:test-runner/, 'the warning names the form that actually dispatches');
});

test('t403: the same skill using the QUALIFIED name is silent', async () => {
  // ENTER for the test above: the warning tracks the name FORM, not merely the
  // presence of a subagent_type in an injected skill.
  const f = mkManager({
    enabledAgents: ['test-runner'],
    skills: [{ name: 'test-green', content: 'Spawn subagent_type: "clodex-agents:test-runner" to verify.' }],
    injectSkills: ['test-green'],
  });
  const res = await f.spawn('seat');
  assert.deepStrictEqual((res && res.warnings) || [], []);
});
