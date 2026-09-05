'use strict';
// plugin-bundle-spawn.test.js — t672 phase A, the spawn half: a plugin's own
// skills and agents reach a seat as one extra --plugin-dir, and ONLY when that
// seat has the plugin.
//
// This drives the REAL create() claude arm with the REAL writeBundlePlugins
// over a temp ~/.clodex, so the argv asserted is the argv a spawn builds and
// the files asserted are the files a spawn writes. writeBundlePlugins is
// module-private in engine.js, so it is reconstructed here from the same public
// parts it composes — exactly as test/agent-plugin-spawn.test.js does for the
// two flat scaffolders — and the confinement ordering is pinned at source level
// in test/skill-plugin-confine.test.js.
//
// The gate's central property is an ABSENCE (a non-member seat gets no dir),
// and an absence passes trivially against a create() that threw or a fixture
// with no bundles at all. So every absence arm is paired with the positive fact
// that a MEMBER seat did get the dir from the same fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { confine } = require('../path-confine');
const { buildAgentPlugin, parseAgentFrontmatter, qualifiedAgentName, DROPPED_AGENT_FIELDS, BUILTIN_AGENTS } = require('../agents-util');
const { buildSkillPlugin, unresolvedSubagentRefs } = require('../skills-util');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SKILL_MD = '---\ndescription: Research a ticker.\n---\nGo look it up.\n';
const AGENT_MD = '---\ndescription: Assesses.\nmodel: haiku\n---\nYou assess.\n';

// What plugin-host-engine's bundles() hands the spawn.
const STOCKS = {
  id: 'stocks', shipped: false,
  skills: [{ name: 'foo', content: SKILL_MD }],
  agents: [{ name: 'bar', content: AGENT_MD }],
};

function mkManager({ bundles = [STOCKS], seatPlugins = null, skills = [], injectSkills = [], omitWriter = false } = {}) {
  const root = mkTmpRoot('clx-bundle-');
  const SKILL_PLUGINS_DIR = path.join(root, 'skill-plugins');
  const AGENT_PLUGINS_DIR = path.join(root, 'agent-plugins');
  const BUNDLES_SUBDIR = 'bundles';
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const store = new Map();
  let spawnArgs = null;

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
  // A faithful re-creation of engine.js's writeBundlePlugins: same compose
  // (buildSkillPlugin + buildAgentPlugin into ONE dir named for the plugin id,
  // confined twice), over a temp root.
  const writeBundlePlugins = (name, wanted) => {
    const seatDir = confine(SKILL_PLUGINS_DIR, name);
    if (seatDir === null) throw new Error(`invalid session name: ${name}`);
    const out = [];
    for (const b of wanted || []) {
      const skillRecords = (b.skills || []).map((s) => ({ name: s.name, content: s.content }));
      const agentRecords = (b.agents || []).map((a) => {
        const { meta, body } = parseAgentFrontmatter(a.content);
        return { name: a.name, meta, body };
      });
      const sp = buildSkillPlugin(skillRecords.map((s) => s.name), skillRecords, b.id);
      const ap = buildAgentPlugin(agentRecords.map((a) => a.name), agentRecords, b.id);
      if (!sp && !ap) continue;
      const dir = confine(path.join(seatDir, BUNDLES_SUBDIR), b.id);
      if (dir === null) throw new Error(`invalid plugin id: ${b.id}`);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      ensureDir(path.join(dir, '.claude-plugin'));
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify((sp || ap).manifest, null, 2));
      for (const s of (sp ? sp.skills : [])) {
        ensureDir(path.join(dir, 'skills', s.name));
        fs.writeFileSync(path.join(dir, 'skills', s.name, 'SKILL.md'), s.skillMd);
      }
      if (ap) {
        ensureDir(path.join(dir, 'agents'));
        for (const a of ap.agents) fs.writeFileSync(path.join(dir, 'agents', `${a.name}.md`), a.md);
      }
      out.push({ id: b.id, dir, skills: sp ? skillRecords : [], agents: ap ? agentRecords : [] });
    }
    return out;
  };

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
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: (names) => names || [],
    qualifiedAgentName,
    DROPPED_AGENT_FIELDS,
    // REAL, not stubs: the ref check runs inside a try/catch, so an undefined
    // dep swallows the whole check and every "no warning" assertion below
    // passes vacuously.
    BUILTIN_AGENTS,
    unresolvedSubagentRefs,
    effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => skills,
    writeAgentPlugin: () => null,
    writeSkillPlugin: (name) => {
      const plugin = buildSkillPlugin(skills.map((s) => s.name), skills);
      return scaffold(SKILL_PLUGINS_DIR, name, plugin, (dir, p) => {
        for (const s of p.skills) {
          ensureDir(path.join(dir, 'skills', s.name));
          fs.writeFileSync(path.join(dir, 'skills', s.name, 'SKILL.md'), s.skillMd);
        }
      });
    },
    ...(omitWriter ? {} : { writeBundlePlugins }),
    getPluginBundles: () => bundles,
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
      [], [], [], [], injectSkills, null, [], [], null, null, true, true, seatPlugins);
    stop(name);
    return res;
  };
  // Drops the in-memory row only, leaving the scaffolded tree on disk — which
  // is the state a real re-spawn of a dead seat finds.
  const forget = (name) => { m.sessions.delete(name); };
  return { m, spawn, forget, args: () => spawnArgs, root, SKILL_PLUGINS_DIR, AGENT_PLUGINS_DIR, BUNDLES_SUBDIR };
}

const pluginDirs = (args) => args.reduce(
  (acc, a, i) => (a === '--plugin-dir' ? [...acc, args[i + 1]] : acc), []);
const bundleDir = (f, seat, id) => path.join(f.SKILL_PLUGINS_DIR, seat, f.BUNDLES_SUBDIR, id);

test('t672: a seat WITH the plugin gets one --plugin-dir per bundle, named for the plugin id', async () => {
  const f = mkManager({ seatPlugins: ['stocks'] });
  await f.spawn('seat');
  const args = f.args();
  assert.ok(Array.isArray(args) && args.length, 'ENTER: create() reached pty.spawn with an argv');

  const dirs = pluginDirs(args);
  const dir = bundleDir(f, 'seat', 'stocks');
  assert.ok(dirs.includes(dir), `the bundle rode --plugin-dir (got ${JSON.stringify(dirs)})`);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf-8'));
  assert.strictEqual(manifest.name, 'stocks',
    'the CLI plugin name IS the Clodex plugin id — that is what namespaces /stocks:foo');
  assert.match(fs.readFileSync(path.join(dir, 'skills', 'foo', 'SKILL.md'), 'utf-8'), /Go look it up/);
  assert.match(fs.readFileSync(path.join(dir, 'agents', 'bar.md'), 'utf-8'), /You assess\./,
    'skills and agents share ONE dir — a Claude plugin may carry both');
});

test('t672: a seat WITHOUT the plugin gets no bundle dir, and none is written', async () => {
  const f = mkManager({ seatPlugins: [] });
  await f.spawn('seat');
  const args = f.args();
  assert.ok(Array.isArray(args) && args.length, 'ENTER: create() reached pty.spawn with an argv');
  assert.ok(!pluginDirs(args).some((d) => d.includes('bundles')), 'no bundle on the command line');
  assert.ok(!fs.existsSync(bundleDir(f, 'seat', 'stocks')),
    'and nothing on disk — the gate is not a display filter over a written dir');

  // CONTROL, same fixture: the bundle exists and a member seat does get it, so
  // the absence above is the gate and not an empty catalog.
  const g = mkManager({ seatPlugins: ['stocks'] });
  await g.spawn('seat');
  assert.ok(pluginDirs(g.args()).includes(bundleDir(g, 'seat', 'stocks')));
});

test('t672: a null seat list withholds an unshipped bundle and grants a shipped one', async () => {
  // seatHasPlugin's absent case: null means "shipped-only default", so origin
  // decides. An unshipped plugin nobody chose must not widen its own reach.
  const bundles = [STOCKS, { ...STOCKS, id: 'builtin', shipped: true }];
  const f = mkManager({ bundles, seatPlugins: null });
  await f.spawn('seat');
  const dirs = pluginDirs(f.args());
  assert.ok(dirs.includes(bundleDir(f, 'seat', 'builtin')), 'the shipped one ships');
  assert.ok(!dirs.includes(bundleDir(f, 'seat', 'stocks')), 'the custom one does not');
});

test('t672: a user-supplied --plugin-dir stands the bundles down with the flat skills', async () => {
  // Bundles ARE skills, so they inherit the skills gate: a hand-passed plugin
  // dir replaces the injected library by intent.
  const f = mkManager({ seatPlugins: ['stocks'] });
  await f.spawn('seat', ['--plugin-dir', '/tmp/theirs']);
  const dirs = pluginDirs(f.args());
  assert.ok(dirs.includes('/tmp/theirs'), 'ENTER: the user flag survived into argv');
  assert.deepStrictEqual(dirs, ['/tmp/theirs'], 'and it is the only one');
});

test('t672: --agents does NOT stand the bundles down', async () => {
  // The --agents gate exists because that flag can express the agent library
  // and so replaces it. It cannot express a plugin's bundle, and the CLI
  // accepts --plugin-dir alongside --agents, so gating bundles on it would
  // drop a plugin's skills for a reason that has nothing to do with them.
  const f = mkManager({ seatPlugins: ['stocks'] });
  await f.spawn('seat', ['--agents', '{}']);
  const dirs = pluginDirs(f.args());
  assert.ok(dirs.includes(bundleDir(f, 'seat', 'stocks')), 'the bundle still ships');
  assert.ok(fs.existsSync(path.join(bundleDir(f, 'seat', 'stocks'), 'agents', 'bar.md')),
    'including its agents half');
});

test('t672: the flat skills scaffold and a bundle coexist under one seat dir', async () => {
  // writeSkillPlugin rm -rf's skill-plugins/<seat>, which CONTAINS bundles/.
  // Writing a bundle before it deletes the bundle; this is that ordering.
  const f = mkManager({
    seatPlugins: ['stocks'],
    skills: [{ name: 'deploy', content: '---\ndescription: d\n---\nbody' }],
    injectSkills: ['deploy'],
  });
  await f.spawn('seat');
  assert.ok(fs.existsSync(path.join(f.SKILL_PLUGINS_DIR, 'seat', 'skills', 'deploy', 'SKILL.md')),
    'the flat scaffold survived');
  assert.ok(fs.existsSync(path.join(bundleDir(f, 'seat', 'stocks'), 'skills', 'foo', 'SKILL.md')),
    'and so did the bundle written into the same seat dir');
  const dirs = pluginDirs(f.args());
  assert.deepStrictEqual(dirs, [
    path.join(f.SKILL_PLUGINS_DIR, 'seat'),
    bundleDir(f, 'seat', 'stocks'),
  ], 'both dirs on the command line, the seat dir first');
});

test('t672: a bundle rebuilds from scratch, so a skill removed from the plugin is gone next spawn', async () => {
  const f = mkManager({ seatPlugins: ['stocks'] });
  await f.spawn('seat');
  const stale = path.join(bundleDir(f, 'seat', 'stocks'), 'skills', 'gone');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'SKILL.md'), 'left over');
  assert.ok(fs.existsSync(stale), 'ENTER: the stale skill is on disk before the second spawn');
  f.forget('seat');
  await f.spawn('seat');
  assert.ok(!fs.existsSync(stale), 'the rebuild removed it');
  assert.ok(fs.existsSync(path.join(bundleDir(f, 'seat', 'stocks'), 'skills', 'foo', 'SKILL.md')),
    'and the real one is back');
});

test('t672: a bundle with only skills, or only agents, still ships', async () => {
  const f = mkManager({
    bundles: [
      { id: 'skillonly', shipped: false, skills: [{ name: 'foo', content: SKILL_MD }], agents: [] },
      { id: 'agentonly', shipped: false, skills: [], agents: [{ name: 'bar', content: AGENT_MD }] },
      { id: 'neither', shipped: false, skills: [], agents: [] },
    ],
    seatPlugins: ['skillonly', 'agentonly', 'neither'],
  });
  await f.spawn('seat');
  const dirs = pluginDirs(f.args());
  assert.ok(dirs.includes(bundleDir(f, 'seat', 'skillonly')));
  assert.ok(dirs.includes(bundleDir(f, 'seat', 'agentonly')));
  assert.ok(!dirs.includes(bundleDir(f, 'seat', 'neither')),
    'an empty bundle gets no manifest-only dir the CLI would load as an empty plugin');
  assert.ok(!fs.existsSync(bundleDir(f, 'seat', 'neither')));
});

test('t672: the subagent-reference check runs over BUNDLE skills, with the plugin-id namespace', async () => {
  // Same code path as the flat library's check, not a copy — a bundle skill
  // calling its own bundle agent by bare name fails at runtime just the same.
  const f = mkManager({
    seatPlugins: ['stocks'],
    bundles: [{
      ...STOCKS,
      skills: [{ name: 'foo', content: 'Delegate with subagent_type: "bar" when asked.' }],
    }],
  });
  const res = await f.spawn('seat');
  const warns = (res && res.warnings) || [];
  assert.strictEqual(warns.length, 1, 'one warning');
  assert.match(warns[0], /Skill "stocks:foo" calls subagent "bar"/,
    'the skill is named by its namespaced form, which is how the operator sees it');
  assert.match(warns[0], /"stocks:bar"/, 'and the hint names the form that actually dispatches');
});

test('t672: the same bundle skill using the QUALIFIED name is silent', async () => {
  // ENTER for the test above: the warning tracks the name FORM, not merely the
  // presence of a subagent_type in a bundle skill.
  const f = mkManager({
    seatPlugins: ['stocks'],
    bundles: [{
      ...STOCKS,
      skills: [{ name: 'foo', content: 'Delegate with subagent_type: "stocks:bar" when asked.' }],
    }],
  });
  const res = await f.spawn('seat');
  assert.deepStrictEqual((res && res.warnings) || [], []);
});

test('t672: a bundle agent with frontmatter the plugin loader drops is warned about', async () => {
  const f = mkManager({
    seatPlugins: ['stocks'],
    bundles: [{
      ...STOCKS,
      agents: [{ name: 'bar', content: '---\ndescription: d\npermissionMode: dontAsk\n---\nbody' }],
    }],
  });
  const res = await f.spawn('seat');
  const warns = (res && res.warnings) || [];
  assert.strictEqual(warns.length, 1);
  // Namespaced, unlike a flat-library agent: two plugins may each ship a `bar`,
  // and a bare name makes those two warnings indistinguishable. Flat agents
  // stay bare (agent-plugin-spawn.test.js pins /"picky"/).
  assert.match(warns[0], /Agent "stocks:bar" sets permissionMode/);
  const md = fs.readFileSync(path.join(bundleDir(f, 'seat', 'stocks'), 'agents', 'bar.md'), 'utf-8');
  assert.ok(!md.includes('permissionMode'), 'and the scaffolded file really omits it');
});

test('t672: a plugin id cannot escape bundles/', () => {
  // isValidPluginId already forbids `..`, so this is the belt to that brace:
  // the MINTED path is confined, not merely the id validated upstream.
  const { confine: c } = require('../path-confine');
  const seat = '/tmp/skill-plugins/seat';
  const bundles = path.join(seat, 'bundles');
  assert.strictEqual(c(bundles, '..'), null, 'a parent escape is refused');
  assert.strictEqual(c(bundles, '../..'), null);
  assert.strictEqual(c(bundles, 'a/b'), null, 'and so is a multi-segment id');
  assert.strictEqual(c(bundles, 'stocks'), path.join(bundles, 'stocks'), 'CONTROL: a real id resolves');
});

test('t672: a deps object with the catalog read but no writer is SILENT, not sorry', async () => {
  // Both-or-neither. Partial deps objects are the norm here (45 fixtures build
  // one), and every one of them carries the plugin catalog by way of a
  // getPersistence fake. Reading the catalog without the writer present sends
  // the scaffold loop into a TypeError, which the arm's catch turns into an
  // operator-facing warning on a spawn that was never going to have bundles —
  // so the guard is what keeps a harness from apologising for its own gaps.
  const f = mkManager({ seatPlugins: ['stocks'], omitWriter: true });
  const res = await f.spawn('seat');
  const args = f.args();
  assert.ok(Array.isArray(args) && args.length, 'ENTER: create() reached pty.spawn with an argv');
  assert.deepStrictEqual((res && res.warnings) || [], [],
    'no warning about a scaffolder this deps object never claimed to have');
  assert.deepStrictEqual(pluginDirs(args).filter((d) => d.includes('bundles')), [],
    'and no bundle flag either');
});
