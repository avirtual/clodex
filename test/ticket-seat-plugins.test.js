'use strict';
// Run: node --test test/ticket-seat-plugins.test.js
//
// t738 — a ticket seat (hand or reviewer) loads exactly the plugins its
// template checks.
//
// The defect: none of the three ticket-loop create() calls passed the
// template's `plugins`, so create() received null in the 22nd positional and
// seatHasPlugin resolved that to "every SHIPPED bundle". A template whose
// checklist left clodex-plugin-builder unchecked still got it — a core bundle,
// so shipped — with its agent, in every hand and every reviewer.
//
// The fixture drives the REAL create() claude arm over a temp ~/.clodex, so the
// `--plugin-dir` list asserted is the one a spawn actually builds; the pattern
// is test/plugin-bundle-spawn.test.js's, which does the same for the direct
// create() path. Both ticket entry points are parameterised over the SAME three
// template rows, because the defect was one missing argument repeated at each
// call site and a fixture that only modelled one of them would have shipped
// green for the other.
//
// Every row's central claim is an ABSENCE — a bundle dir the seat must NOT
// carry — and an absence is true of a create() that threw, of a spawn that
// never happened, and of a fixture with no bundles at all. So each row opens by
// asserting that EXACTLY ONE pty spawn happened and that the seat name it was
// for is in the sessions map, and the listing row additionally asserts the
// LISTED bundle did arrive from the same fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const clodexPaths = require('../clodex-paths');
const { pathFor, runDirFor } = require('../clodex-paths');
const { confine } = require('../path-confine');
const { AGENT_NAME_RE, DEFAULT_WORKSPACE_ID } = require('../catalogs');
const { buildAgentPlugin, parseAgentFrontmatter, qualifiedAgentName, DROPPED_AGENT_FIELDS, BUILTIN_AGENTS } = require('../agents-util');
const { buildSkillPlugin, unresolvedSubagentRefs } = require('../skills-util');
const { intentEnabled } = require('../intent-catalog');
const intentRegistry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { assertTicketDepsCovered } = require('./lib/loop-fixture-deps');

const SKILL_MD = '---\ndescription: Does a thing.\n---\nGo do it.\n';
const AGENT_MD = '---\ndescription: Assesses.\nmodel: haiku\n---\nYou assess.\n';

const mkBundle = (id) => ({
  id, shipped: true,
  skills: [{ name: `${id}-skill`, content: SKILL_MD }],
  agents: [{ name: `${id}-agent`, content: AGENT_MD }],
});
// BOTH shipped, which is the shape that made the defect invisible: the unlisted
// one is `clodex-plugin-builder`'s stand-in and rode in on the shipped default,
// and a fixture whose unlisted bundle was unshipped would pass with the bug in
// place.
const BUILDER = mkBundle('builder');
const LISTED = mkBundle('github');

function mkRepo() {
  const dir = mkTmpRoot('clx-t738-repo-');
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

// A faithful re-creation of engine.js's writeBundlePlugins, as
// test/plugin-bundle-spawn.test.js reconstructs it: the real one is
// module-private, and the property under test is which bundles reach it.
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

// `tplPlugins === undefined` means the template carries NO plugins key, which is
// a third value distinct from `[]` — never collapse the two here, that identity
// is the thing under test.
function mkWorld({ tplPlugins } = {}) {
  const home = mkTmpRoot('clx-t738-home-');
  const userData = mkTmpRoot('clx-t738-ud-');
  const repo = mkRepo();
  const SKILL_PLUGINS_DIR = path.join(home, 'skill-plugins');
  const BUNDLES_SUBDIR = 'bundles';
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });

  const tplBase = { type: 'claude', cwd: repo, tools: ['Read', 'Grep', 'Glob'], intents: [] };
  const handTpl = { name: 'hand-tpl', ...tplBase, ...(tplPlugins === undefined ? {} : { plugins: tplPlugins }) };
  const rvTpl = { name: 'rv-tpl', ...tplBase, systemPromptFile: 'rv-brief', ...(tplPlugins === undefined ? {} : { plugins: tplPlugins }) };
  ensureDir(path.join(home, 'library', 'prompts', 'system'));
  fs.writeFileSync(path.join(home, 'library', 'prompts', 'system', 'rv-brief.md'), 'review it\n');

  const team = {
    name: 'team', root: repo, lead: 'lead', watchdogMs: null,
    file: path.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead', dispatch: 'standing' },
      // 'spawn', not 'worktree': the tree acquisition is skipped entirely, so no
      // git call sits between the dispatch and the create() this file measures.
      // The create() call site is the same one either way.
      hand: { instantiate: 'session', brief: 'the hand', dispatch: 'spawn', template: 'hand-tpl' },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer', prompt: 'rv-brief', template: 'rv-tpl' },
    },
  };

  const store = new Map();
  const setPluginsCalls = [];
  const persistence = {
    list: () => [...store.values()],
    get: (n) => store.get(n) || null,
    upsert: (e) => store.set(e.name, { ...(store.get(e.name) || {}), ...e }),
    remove: (n) => store.delete(n),
    setSessionId: () => {},
    setWorktree: () => {},
    setStripLevel: () => {},
    setAutoCompact: () => {},
    setPlugins: (n, p) => {
      setPluginsCalls.push([n, p]);
      const e = store.get(n);
      if (!e) return;
      if (Array.isArray(p)) e.plugins = p.map(String); else delete e.plugins;
    },
  };

  const spawns = [];
  const deps = {
    knownSkillNames: () => [],
    REGISTRY_DIR: home,
    fs, path, os, pathFor, runDirFor,
    PENDING_DIR: path.join(home, 'pending'),
    MSG_DIR: path.join(home, 'messages'),
    ensureDir,
    AGENT_NAME_RE, DEFAULT_WORKSPACE_ID,
    getPersistence: () => persistence,
    getAccounts: () => ({ list: () => [{ label: 'default', configDir: '/home/u/.claude' }], configDirFor: (l) => (l === 'default' ? '/home/u/.claude' : null) }),
    getTemplates: () => ({ list: () => [handTpl, rvTpl] }),
    listAllTemplates: () => [handTpl, rvTpl],
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
    pty: { spawn: (_cmd, args) => { spawns.push(args); return { onData() {}, onExit() {}, pid: 999 }; } },
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    WIRE_SHADOW: false, WIRE_INTENTS_LIVE: false,
    setupClaudeHook: (n) => { fs.mkdirSync(runDirFor(home, n), { recursive: true }); return path.join(home, 'settings.json'); },
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {},
    cleanupSkills: () => {}, cleanupAgentPlugin: () => {},
    buildIpcPrompt: () => '', writeClaudeDigestFile: () => false,
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => userData,
    resolveTeam: (cwd) => (cwd && cwd.startsWith(repo) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(repo) ? repo : null),
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: (stem) => (stem ? path.join(home, 'library', 'prompts', 'system', `${stem}.md`) : null),
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: (names) => names || [],
    qualifiedAgentName, DROPPED_AGENT_FIELDS,
    BUILTIN_AGENTS, unresolvedSubagentRefs,
    effectiveInjectedAgents: () => [],
    effectiveInjectedSkills: () => [],
    writeAgentPlugin: () => null,
    deliverSkills: () => null, skillDeliveryProviders: () => ['claude', 'codex'],
    writeBundlePlugins: mkBundleWriter(SKILL_PLUGINS_DIR, BUNDLES_SUBDIR, ensureDir),
    getPluginBundles: () => [BUILDER, LISTED],
    bakePrompt: () => '',
    nextIncarnation: () => 1,
    memLoad: { noteDigest: () => {}, noteSession: () => {} },
    tiersOf: () => ({}),
    arm: { onContextReset: () => {} },
    intentEnabled,
    withoutPrivilegedIntentsFor: intentRegistry.withoutPrivilegedIntentsFor,
    bodyModeFor: intentRegistry.bodyModeFor,
    intentEnabledFor: intentRegistry.intentEnabledFor,
    intentEnabledForSeat: intentRegistry.intentEnabledForSeat,
    pluginRowFor: intentRegistry.pluginRowFor,
    validIntentNames: intentRegistry.validIntentNames,
    fencedLines: require('../intent-scanner').fencedLines,
    childProcess: require('node:child_process'),
    countPending: require('../pending-store').countPending,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    gitWorktree: require('../git-worktree'),
    isAlive: () => true,
    getRemindScheduler: () => ({ cancelFor: () => [], list: () => [] }),
    gatherTeam: () => null,
    addRole: () => {}, setRole: () => {}, removeRole: () => {}, renameRole: () => {},
    setTeamWatchdog: () => {},
  };
  // The team-metadata deps: createTeam, kitCatalog and resolveKit are read only
  // by _handleTeamCreate, setLead only by _handleTeam's set-lead case, teamsDir
  // and listTeams only by its four template/prompt file verbs, loadManifest only
  // by the read-only teamActivity channel (t785), none of which a
  // plugin-inheritance subject drives. refreshAppMenu is optional in a stronger
  // sense — the call site guards on typeof for the headless host.
  assertTicketDepsCovered(assert, deps, {
      // getSandboxManager is optional in that same sense: it is read only by
      // _handleTeam's sandbox case, which no subject here drives — and a fixture
      // that DID inject one would have to fake docker to say anything. `fetch`
      // rides with it for the same reason: the only reader is that case seeding
      // the box's starting seats over its wire port.
    optional: ['ticketSuiteTimeoutMs', 'createTeam', 'kitCatalog', 'resolveKit', 'setLead', 'teamsDir', 'listTeams', 'loadManifest', 'refreshAppMenu',
        'getSandboxManager', 'fetch'],
  });

  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._gatedDeliver = () => ({ queued: true });
  m._deliverMessage = () => {};
  m._injectText = () => {};
  m._ensureWire = async () => null;
  m._reconcileTickets = () => {};
  m._writeTicketCost = () => {};
  const lead = { name: 'lead', type: 'claude', agentType: 'claude', cwd: repo, pty: { pid: 1 }, activityState: 'idle', workspaceId: 'ws' };
  m.sessions.set('lead', lead);
  persistence.upsert({ name: 'lead', extraArgs: [] });

  const stop = () => {
    for (const s of m.sessions.values()) {
      try { if (s.sentinel) s.sentinel.stop(); } catch {}
      try { if (s.watcher) s.watcher.stop(); } catch {}
      try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
      clearTimeout(s._bootDrainTimer);
    }
  };
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  };
  return { m, lead, team, home, repo, tstore, persistence, setPluginsCalls, spawns, stop, until, SKILL_PLUGINS_DIR, BUNDLES_SUBDIR };
}

const pluginDirs = (args) => (args || []).reduce(
  (acc, a, i) => (a === '--plugin-dir' ? [...acc, args[i + 1]] : acc), []);
const bundleDir = (w, seat, id) => path.join(w.SKILL_PLUGINS_DIR, seat, w.BUNDLES_SUBDIR, id);

// Dispatches a ticket to the hand role and returns the spawned seat's name.
async function spawnHand(w) {
  w.m._handleTask(w.lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'shaped work' });
  const ts = w.tstore.load(w.repo);
  for (const t of ts) {
    if (!t.taskDir) t.taskDir = path.join(clodexPaths.projectDirFor(w.home, w.repo), 'tasks', `${t.id}-fixture`, 'SPEC.md');
  }
  w.tstore.save(w.repo, ts);
  w.m._handleTask(w.lead, { type: 'task', sub: 'start', who: null, id: ts[0].id, body: '' });
  const name = `team-hand-${String(ts[0].id).replace(/^t/, '')}`;
  await w.until(() => w.spawns.length > 0);
  return name;
}

async function spawnReviewer(w) {
  w.m._handleTeamReview(w.lead, 'review the branch', { onReply: () => {} });
  const name = 'team-reviewer-1';
  await w.until(() => w.spawns.length > 0);
  return name;
}

const ENTRY = [
  { label: 'ticket seat (_spawnTicketSeat)', spawn: spawnHand },
  { label: 'reviewer (_handleTeamReview)', spawn: spawnReviewer },
];

for (const entry of ENTRY) {
  test(`t738: ${entry.label} — a template listing one bundle gets THAT bundle and no other shipped one`, async () => {
    const w = mkWorld({ tplPlugins: ['github'] });
    try {
      const seat = await entry.spawn(w);
      const args = w.spawns[0];
      assert.ok(w.spawns.length === 1 && w.m.sessions.has(seat),
        `ENTER: exactly one spawn named ${seat} was expected — every absence below would pass vacuously (spawns ${w.spawns.length}, sessions ${JSON.stringify([...w.m.sessions.keys()])})`);

      const dirs = pluginDirs(args);
      assert.ok(dirs.includes(bundleDir(w, seat, 'github')),
        `the LISTED bundle must ride --plugin-dir, or the absence below proves nothing (got ${JSON.stringify(dirs)})`);
      assert.ok(!dirs.includes(bundleDir(w, seat, 'builder')),
        `an unlisted SHIPPED bundle rode in anyway — this is the defect (got ${JSON.stringify(dirs)})`);
    } finally { w.stop(); }
  });

  test(`t738: ${entry.label} — a template with plugins: [] gets no bundle dirs at all`, async () => {
    const w = mkWorld({ tplPlugins: [] });
    try {
      const seat = await entry.spawn(w);
      const args = w.spawns[0];
      assert.ok(w.spawns.length === 1 && w.m.sessions.has(seat),
        `ENTER: exactly one spawn named ${seat} was expected (spawns ${w.spawns.length}, sessions ${JSON.stringify([...w.m.sessions.keys()])})`);
      assert.deepStrictEqual(pluginDirs(args).filter((d) => d.includes(w.BUNDLES_SUBDIR)), [],
        'an EMPTY list is a real value meaning none — collapsing it into the absent case gives the seat everything shipped');
    } finally { w.stop(); }
  });

  test(`t738: ${entry.label} — a template with NO plugins key keeps the shipped-only default`, async () => {
    const w = mkWorld({});
    try {
      const seat = await entry.spawn(w);
      const args = w.spawns[0];
      assert.ok(w.spawns.length === 1 && w.m.sessions.has(seat),
        `ENTER: exactly one spawn named ${seat} was expected (spawns ${w.spawns.length}, sessions ${JSON.stringify([...w.m.sessions.keys()])})`);
      assert.deepStrictEqual(pluginDirs(args).filter((d) => d.includes(w.BUNDLES_SUBDIR)).sort(),
        [bundleDir(w, seat, 'builder'), bundleDir(w, seat, 'github')].sort(),
        'absent is not empty: a template that never listed plugins keeps every shipped bundle');
    } finally { w.stop(); }
  });

  test(`t738: ${entry.label} — the seat's record carries the template's list`, async () => {
    const w = mkWorld({ tplPlugins: ['github'] });
    try {
      const seat = await entry.spawn(w);
      assert.ok(w.spawns.length === 1 && w.m.sessions.has(seat),
        `ENTER: exactly one spawn named ${seat} was expected (spawns ${w.spawns.length}, sessions ${JSON.stringify([...w.m.sessions.keys()])})`);
      assert.deepStrictEqual((w.persistence.get(seat) || {}).plugins, ['github'],
        'the grants editor reads this record — a record disagreeing with the argv shows checkboxes the seat did not boot with');
      assert.deepStrictEqual(w.setPluginsCalls, [[seat, ['github']]],
        '_applyTemplatePersistence writes it too, so a caller that does not thread the list still leaves record and argv agreeing');
    } finally { w.stop(); }
  });
}

test('t738: every ticket-loop create() call site threads the template plugin list', () => {
  // A source pin because the spawn-intent call site (`[agent:spawn
  // template:X]`) has no ticket to dispatch and so is unreachable from the two
  // fixtures above; without it that third caller could lose its argument and
  // nothing here would go red.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  const calls = src.split(/this\.create\(/).slice(1);
  assert.strictEqual(calls.length, 3,
    `ENTER: expected 3 this.create( call sites in team-tickets.js, found ${calls.length} — a new one is unmeasured, or the shape moved`);
  for (const [i, tail] of calls.entries()) {
    const end = tail.indexOf('\n          );');
    // Comment lines stripped BEFORE the match: every one of these call sites is
    // commented, and prose about plugins would satisfy an argument-shaped regex
    // that no argument satisfies.
    const argv = tail.slice(0, end >= 0 ? end : 2000).split('\n')
      .filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(argv, /(^|[\s(])(shape\.)?plugins\s*[,)]/m,
      `create() call site ${i + 1} in team-tickets.js passes no plugin list — its seat falls back to every shipped bundle`);
  }
});
