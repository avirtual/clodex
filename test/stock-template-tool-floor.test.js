'use strict';
// Run: node --test test/stock-template-tool-floor.test.js
//
// t772 — the two stock team templates (hand and lead) carry a tool DENYLIST
// partitioned against the live catalog, and an empty plugin list.
//
// The defect this pins: `disabledTools` is a denylist (cli-hooks.js renders it
// into settings.permissions.deny), so every tool Claude Code adds after the
// list was written arrives ON. teamlab-lead, spawned on the 5.47.0 lead
// template, had CronCreate/CronDelete/CronList/ScheduleWakeup/PushNotification/
// RemoteTrigger/AskUserQuestion/EndConversation/SendFeedback all enabled. The
// partition assertion is what makes a catalog addition LOUD: a new CLAUDE_TOOLS
// entry is in neither KEEP nor either template, so this file reds until a human
// decides which side it belongs on.
//
// Second, `plugins`: a template with NO plugins key resolves to null, and
// seatHasPlugin (plugin-api.js) reads null as "every SHIPPED plugin" — so
// clodex-plugin-builder's bundle rode onto every stock hand and lead. `[]` is a
// real value distinct from absent, and the create()-level test below drives the
// REAL create() over both values on one fixture so the difference is measured
// on argv, not asserted about the JSON.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');
const { confine } = require('../path-confine');
const { CLAUDE_TOOLS, AGENT_NAME_RE } = require('../catalogs');
const { buildAgentPlugin, parseAgentFrontmatter, qualifiedAgentName, DROPPED_AGENT_FIELDS, BUILTIN_AGENTS } = require('../agents-util');
const { buildSkillPlugin, unresolvedSubagentRefs } = require('../skills-util');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A literal, not derived from either template: deriving it would make the
// partition below a tautology. These nine are what a ticket seat actually uses
// — read/write files, search, shell, and the subagent/teammate trio.
const KEEP = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'SendMessage', 'ListAgents'];

const TPL_DIR = path.join(__dirname, '..', 'resources', 'library', 'templates');
const readTpl = (stem) => JSON.parse(fs.readFileSync(path.join(TPL_DIR, `${stem}.json`), 'utf-8'));
const STEMS = ['clodex-team-hand', 'clodex-team-lead'];

test('ENTER: the catalog is populated and every KEEP name is really in it', () => {
  // A KEEP name the catalog does not contain would make the partition
  // unsatisfiable and every message below misleading; an empty catalog would
  // make the partition trivially true of an empty denylist.
  assert.ok(CLAUDE_TOOLS.length > 20, `CLAUDE_TOOLS has ${CLAUDE_TOOLS.length} entries — the catalog collapsed`);
  assert.deepStrictEqual(KEEP.filter((t) => !CLAUDE_TOOLS.includes(t)), [],
    'a KEEP name is not in CLAUDE_TOOLS — rename or drop it');
});

for (const stem of STEMS) {
  test(`${stem}: KEEP plus disabledTools is exactly the tool catalog`, () => {
    const tpl = readTpl(stem);
    assert.ok(Array.isArray(tpl.disabledTools), `${stem} has no disabledTools array`);
    assert.deepStrictEqual(
      new Set([...KEEP, ...tpl.disabledTools]),
      new Set(CLAUDE_TOOLS),
      `${stem}'s denylist does not partition the catalog with KEEP. A tool Claude Code `
      + 'added is neither kept nor denied, so it comes up ON for every ticket seat: put it '
      + 'in KEEP here, or in disabledTools in BOTH stock templates.');
  });

  test(`${stem}: KEEP and disabledTools are disjoint`, () => {
    const tpl = readTpl(stem);
    const both = KEEP.filter((t) => tpl.disabledTools.includes(t));
    assert.deepStrictEqual(both, [],
      `${stem} denies a tool the seat is meant to keep: ${both.join(', ')}`);
  });

  test(`${stem}: every disabledTools name is a real catalog entry`, () => {
    const tpl = readTpl(stem);
    // cli-hooks.js filters the deny rules against the catalog, so a stale name
    // is not merely inert — the CLI warns "matches no known tool" on every
    // startup of every seat.
    const stale = tpl.disabledTools.filter((t) => !CLAUDE_TOOLS.includes(t));
    assert.deepStrictEqual(stale, [], `${stem} names tools the catalog does not have: ${stale.join(', ')}`);
  });

  test(`${stem}: disabledTools is ordered as the catalog orders it, with no duplicates`, () => {
    const tpl = readTpl(stem);
    assert.strictEqual(new Set(tpl.disabledTools).size, tpl.disabledTools.length,
      `${stem} repeats a name in disabledTools`);
    assert.deepStrictEqual(tpl.disabledTools, CLAUDE_TOOLS.filter((t) => !KEEP.includes(t)),
      `${stem}'s denylist is not in catalog order — a hand-appended addition reads as a diff `
      + 'against a list nobody can scan beside catalogs.js');
  });

  test(`${stem}: plugins is an empty list, not an absent key`, () => {
    const raw = fs.readFileSync(path.join(TPL_DIR, `${stem}.json`), 'utf-8');
    assert.ok(/"plugins"\s*:/.test(raw), `${stem}.json has no plugins key — absent resolves to every SHIPPED plugin`);
    assert.deepStrictEqual(readTpl(stem).plugins, [],
      `${stem}'s plugins must be [] — the seat is meant to carry no bundle`);
  });
}

test('the two stock templates deny the same tools', () => {
  // team-lead-template-portable.test.js already pins lead-equals-hand for this
  // field; repeated here so a failure in THIS file names the partition it broke
  // rather than sending the reader to another file first.
  assert.deepStrictEqual(readTpl('clodex-team-lead').disabledTools, readTpl('clodex-team-hand').disabledTools);
});

// ---------------------------------------------------------------------------
// The create()-level pin: [] and absent are different values on argv.

const SKILL_MD = '---\ndescription: Does a thing.\n---\nGo do it.\n';
const AGENT_MD = '---\ndescription: Assesses.\nmodel: haiku\n---\nYou assess.\n';
// SHIPPED, which is the only kind the absent case grants: an unshipped stand-in
// would be withheld from both arms and the contrast would prove nothing.
const BUILDER = {
  id: 'builder', shipped: true,
  skills: [{ name: 'builder-skill', content: SKILL_MD }],
  agents: [{ name: 'builder-agent', content: AGENT_MD }],
};

// A faithful re-creation of engine.js's writeBundlePlugins, as
// test/plugin-bundle-spawn.test.js and test/ticket-seat-plugins.test.js both
// reconstruct it: the real one is module-private, and what is under test is
// which bundles reach it.
function mkBundleWriter(skillPluginsDir, bundlesSubdir, ensureDir) {
  return (name, wanted) => {
    const seatDir = confine(skillPluginsDir, name);
    if (seatDir === null) throw new Error(`invalid session name: ${name}`);
    const out = [];
    for (const b of wanted || []) {
      const skillRecords = (b.skills || []).map((s) => ({ name: s.name, content: s.content, files: {} }));
      const agentRecords = (b.agents || []).map((a) => {
        const { meta, body } = parseAgentFrontmatter(a.content);
        return { name: a.name, meta, body };
      });
      const opts = { version: '0.0.0', description: `Clodex plugin ${b.id}` };
      const sp = buildSkillPlugin(skillRecords.map((s) => s.name), skillRecords, b.id, opts);
      const ap = buildAgentPlugin(agentRecords.map((a) => a.name), agentRecords, b.id, opts);
      if (!sp && !ap) continue;
      const dir = confine(path.join(seatDir, bundlesSubdir), b.id);
      if (dir === null) throw new Error(`invalid plugin id: ${b.id}`);
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
}

function mkManager() {
  const root = mkTmpRoot('clx-t772-');
  const SKILL_PLUGINS_DIR = path.join(root, 'skill-plugins');
  const BUNDLES_SUBDIR = 'bundles';
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const store = new Map();
  let spawnArgs = null;

  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
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
    cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
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
    BUILTIN_AGENTS,
    unresolvedSubagentRefs,
    effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    writeAgentPlugin: () => null,
    deliverSkills: () => null,
    skillDeliveryProviders: () => ['claude', 'codex'],
    writeBundlePlugins: mkBundleWriter(SKILL_PLUGINS_DIR, BUNDLES_SUBDIR, ensureDir),
    getPluginBundles: () => [BUILDER],
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
  // Not wrapped in try/catch, deliberately: a create() that threw before argv
  // was built would satisfy the absence assertion below for the wrong reason.
  // `tpl.plugins` is threaded exactly as the ticket loop threads it, so the
  // absent-key case arrives as undefined and takes create()'s null default —
  // which is the resolution seatHasPlugin reads as "every shipped plugin".
  const spawn = async (name, tpl) => {
    await m.create(name, 'claude', os.tmpdir(), [], null, 'ws', null, false, null,
      [], [], tpl.disabledTools || [], [], [], null, [], [], null, null, true, true, tpl.plugins);
    stop(name);
    return spawnArgs;
  };
  return { spawn, SKILL_PLUGINS_DIR, BUNDLES_SUBDIR };
}

const pluginDirs = (args) => (args || []).reduce(
  (acc, a, i) => (a === '--plugin-dir' ? [...acc, args[i + 1]] : acc), []);

test('a seat spawned from the shipped lead template carries no bundle on argv', async () => {
  const f = mkManager();
  const tpl = readTpl('clodex-team-lead');

  // The ENTER arm first: the SAME fixture, the same template with only the
  // plugins key removed, must put the shipped bundle on argv. Without it the
  // absence asserted below is true of a fixture with no bundles at all.
  const { plugins, ...noKey } = tpl;
  assert.deepStrictEqual(plugins, [], 'ENTER: the shipped template must carry plugins: [] for this contrast to be about the key');
  const anchorDir = path.join(f.SKILL_PLUGINS_DIR, 'anchor-seat', f.BUNDLES_SUBDIR, 'builder');
  assert.deepStrictEqual(pluginDirs(await f.spawn('anchor-seat', noKey)), [anchorDir],
    'ENTER: with NO plugins key the shipped bundle must ride --plugin-dir — otherwise the absence below proves nothing');

  const dirs = pluginDirs(await f.spawn('lead-seat', tpl));
  assert.deepStrictEqual(dirs, [],
    'the shipped lead template put a --plugin-dir on argv: a stock lead is inheriting every shipped '
    + `plugin's bundle again (got ${JSON.stringify(dirs)})`);
});
