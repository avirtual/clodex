'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const osReal = require('node:os');
const pathReal = require('node:path');

const { intentEnabled } = require('../intent-catalog');
const { createSessionManager, clodentVersionOk } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { processStubs } = require('./lib/process-stubs');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');
const { mergeClaudeSystemPrompt, mergeInstructionBodies } = require('../argv-merge');
const { classifyNotification } = require('../attention');

const RESUME = '6a1f0c2e-1111-4222-8333-944455556666';

function mkClodent({ proxyBase = 'http://127.0.0.1:7811', sysFile = null, entries = {}, probeClodentVersion = () => 'clodent 0.5.2\n' } = {}) {
  const root = mkTmpRoot('clodex-clodent-');
  const home = pathReal.join(root, 'home');
  fsReal.mkdirSync(home, { recursive: true });
  const cwd = pathReal.join(root, 'proj.x');
  fsReal.mkdirSync(cwd, { recursive: true });
  const spawns = [];
  const hooks = [];
  const watchers = [];
  const probes = [];
  const registers = [];
  const hints = [];
  const skillCalls = [];
  const mcpWrites = [];
  const cleanups = [];
  const SessionManager = createSessionManager({
    killPid: processStubs().killPid,
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    MSG_DIR: pathReal.join(root, 'messages'),
    PENDING_DIR: pathReal.join(root, 'pending'),
    fs: fsReal, path: pathReal, os: { ...osReal, homedir: () => home },
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: (d) => fsReal.mkdirSync(d, { recursive: true }),
    setupClaudeHook: (...a) => { hooks.push(a); return pathForReal(root, a[0], 'settings'); },
    bakePrompt: (_r, _n, realIpc, freeze, opts) => `${realIpc}|freeze=${freeze}|snapshot=${opts.snapshot}`,
    promptCacheDir: () => pathReal.join(root, 'cache'),
    readCache: () => null,
    buildIpcPrompt: () => 'IPC',
    mergeClaudeSystemPrompt,
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    mergeInstructionBodies,
    readAppendBodies: () => [],
    resolveSystemPromptFile: () => sysFile,
    pluginGrammarLines: () => [], intentEnabled,
    resolveTeam: () => null,
    formatTeamBlock: () => '',
    matchSeatRole: () => null,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: (name) => pathReal.join(root, 'agent-plugins', name),
    effectiveInjectedAgents: () => [],
    deliverSkills: (provider, name, records) => { skillCalls.push([provider, name, records.length]); return null; },
    skillDeliveryProviders: () => ['claude', 'codex', 'muse'],
    getPluginBundles: () => [{ id: 'bundle-a', shipped: true, skills: [], agents: [] }],
    writeBundlePlugins: (name, bundles) => bundles.map((b) => ({ dir: pathReal.join(root, 'bundles', name, b.id), skills: [], agents: [] })),
    cleanupSkills: (provider, name) => { cleanups.push(['skills', provider, name]); }, cleanupClaudeHook: (name) => { cleanups.push(['hook', name]); }, cleanupCodexHook: () => {}, cleanupAgentPlugin: (name) => { cleanups.push(['agents', name]); }, cleanupMuseSeat: () => {},
    writeMcpConfig: (name) => { mcpWrites.push(['config', name]); },
    writeMcpCatalog: (name) => { mcpWrites.push(['catalog', name]); },
    crypto: require('node:crypto'),
    effectiveInjectedSkills: () => [],
    probeClodentVersion,
    getPersistence: () => ({ list: () => [], get: (n) => entries[n] || null, upsert: () => {}, setSessionId: () => {}, remove: () => {} }),
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getUserDataPath: () => root,
    getRemoteServer: () => null,
    getPromptLibrary: () => ({ raw: () => null }),
    memoryStore: { list: () => [] },
    composeDigest: () => null,
    resolveProxyBase: () => proxyBase,
    resolveProxyAgentId: ({ name }) => `clodex-${name}-rt`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    ProxyClient: {
      spawnerHint: (...a) => { hints.push(a); return Promise.resolve({ status: 200 }); },
      probe: (...a) => { probes.push(a); return Promise.resolve({ capabilities: { accounts: true } }); },
      registerAccount: (...a) => { registers.push(a); return Promise.resolve({ status: 200 }); },
    },
    childProcess: { execFile: (cmd, args, opts, cb) => cb(null, '', '') },
    registry: { register: () => {}, unregister: () => {} },
    Transport: class {
      static async isSocketLive() { return false; }
      async start() {}
      stop() {}
    },
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompact, onTouches, opts) { watchers.push({ name, onActivity, opts }); }
      start() {}
      stop() {}
    },
    pty: {
      spawn: (cmd, args, opts) => {
        spawns.push({ cmd, args, opts });
        let exit = null;
        return { onData() {}, onExit(fn) { exit = fn; }, pid: 999, kill() { if (exit) exit({ exitCode: 0, signal: null }); } };
      },
    },
    notifyOS: () => {},
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  const broadcasts = [];
  m._broadcast = (ch, msg) => broadcasts.push([ch, msg]);
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    try { if (s.intentSocket) s.intentSocket.stop(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._bootSettleTimer);
    clearTimeout(s._bootNudgeTimer);
    clearTimeout(s._replayFallbackTimer);
    m.sessions.delete(name);
  };
  const create = (name, { type = 'clodent', extraArgs = [], resumeId = null, fork = false, sessionEnv = { ANTHROPIC_API_KEY: 'sk-test' }, effort = null, denyBuiltins = [], disabledTools = [], shellDeny = null, protectCredentials = null } = {}) => m.create(
    name, type, cwd, extraArgs, resumeId, 'ws', null, fork, null,
    [], denyBuiltins, disabledTools, [], [], null, [], [], null, sessionEnv,
    false, false, null, shellDeny, null, 'pty', effort, protectCredentials,
  );
  const settings = (name) => pathForReal(root, name, 'settings');
  const prompt = (name) => pathForReal(root, name, 'appendPrompt');
  const link = (name) => pathForReal(root, name, 'transcript');
  const agentDir = (name) => pathReal.join(root, 'agent-plugins', name);
  const bundleDir = (name) => pathReal.join(root, 'bundles', name, 'bundle-a');
  return { m, root, home, cwd, spawns, hooks, watchers, probes, registers, hints, broadcasts, skillCalls, mcpWrites, cleanups, create, stop, settings, prompt, link, agentDir, bundleDir };
}

function noMcpFlags(args) {
  for (const flag of ['--mcp-config', '--strict-mcp-config', '-p']) {
    assert.ok(!args.includes(flag), `a clodent argv carries no ${flag}`);
  }
}

async function claudeAndClodent(f, opts) {
  await f.create('seat', { ...opts, type: 'claude' });
  const claudeSessionId = f.m.sessions.get('seat').sessionId;
  f.stop('seat');
  await f.create('seat', { ...opts, type: 'clodent' });
  const clodentSessionId = f.m.sessions.get('seat').sessionId;
  f.stop('seat');
  assert.strictEqual(f.spawns.length, 2, 'ENTER: one claude and one clodent PTY spawn');
  assert.strictEqual(f.hooks.length, 2, 'ENTER: both arms wrote Clodex hook settings');
  return { claude: f.spawns[0], clodent: f.spawns[1], hooks: f.hooks, sessionIds: [claudeSessionId, clodentSessionId] };
}

function withoutMcp(args, mcpPath) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--strict-mcp-config') continue;
    if (args[i] === '--mcp-config' && args[i + 1] === mcpPath) { i += 1; continue; }
    out.push(args[i]);
  }
  return out;
}

test('clodent: a fresh seat spawns `clodent` with Clodex hooks, the messages add-dir, the agent and bundle plugin dirs and the baked prompt — whole argv and env', async () => {
  const f = mkClodent();
  const runnerBaseUrl = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  try {
    await f.create('seat', { extraArgs: ['--model', 'claude-haiku-5-5'] });
  } finally {
    if (runnerBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = runnerBaseUrl;
  }
  try {
    assert.strictEqual(f.spawns.length, 1, 'ENTER: one PTY spawn');
    const { cmd, args, opts } = f.spawns[0];
    assert.strictEqual(cmd, 'clodent');
    assert.deepStrictEqual(args, [
      '--model', 'claude-haiku-5-5',
      '--settings', f.settings('seat'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--plugin-dir', f.agentDir('seat'),
      '--plugin-dir', f.bundleDir('seat'),
      '--append-system-prompt-file', f.prompt('seat'),
    ]);
    noMcpFlags(args);
    assert.deepStrictEqual(f.mcpWrites, [], 'no MCP config and no MCP catalog for a clodent seat');
    assert.strictEqual(fsReal.readFileSync(f.prompt('seat'), 'utf-8'), 'IPC|freeze=false|snapshot=null');
    assert.strictEqual(fsReal.statSync(f.prompt('seat')).mode & 0o777, 0o600);
    assert.strictEqual(f.hooks.length, 1);
    const [hookName, hookProxy, , , , , hookWire, , , hookStream, hookEffort] = f.hooks[0];
    assert.deepStrictEqual([hookName, hookProxy, hookWire, hookStream, hookEffort], ['seat', null, null, false, null],
      'the hook settings carry no proxy, no wire and no effort, so no ANTHROPIC_BASE_URL is written');
    assert.strictEqual(opts.cwd, f.cwd);
    assert.strictEqual(opts.env.TERM, 'xterm-256color');
    assert.strictEqual(opts.env.CLODEX_HOME, f.root);
    assert.strictEqual(opts.env.FORCE_HYPERLINK, '1');
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-test', 'a seat env key passes through');
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, undefined, 'nothing routes through the wire');
    assert.strictEqual(opts.env.CLODEX_SEAT, 'seat', 'the seat gets the intent channel its hooks reach');
    assert.ok(opts.env.CLODEX_INTENT_SOCK && opts.env.CLODEX_INTENT_CRED);
    assert.strictEqual(opts.env.WB_WRAP_NAME, undefined);
    assert.deepStrictEqual([f.probes.length, f.registers.length, f.hints.length], [0, 0, 0], 'no proxy traffic for a clodent seat');
    const s = f.m.sessions.get('seat');
    assert.strictEqual(s.agentType, 'clodent');
    assert.strictEqual(s.sessionId, null, 'the SessionStart hook reports the id, as for Claude');
    assert.strictEqual(s.proxyBase, null);
    assert.strictEqual(s.wireRouted, false);
    assert.strictEqual(s.selectionDrain, true);
    assert.deepStrictEqual(f.watchers.map((w) => [w.name, w.opts.reader.id]), [['seat', 'claude']]);
  } finally { f.stop('seat'); }
});

test('clodent: the argv is the claude PTY argv apart from cmd and the MCP flags, fresh, resumed and forked, with denies and a credential sandbox', async () => {
  for (const opts of [
    { extraArgs: ['--model', 'claude-haiku-5-5'] },
    { resumeId: RESUME, extraArgs: ['--dangerously-skip-permissions'] },
    { resumeId: RESUME, fork: true },
    { protectCredentials: ['~/.ssh'], disabledTools: ['WebFetch'], shellDeny: ['Bash(rm:*)'], denyBuiltins: ['Explore'] },
  ]) {
    const f = mkClodent();
    const { claude, clodent, hooks, sessionIds } = await claudeAndClodent(f, opts);
    const label = JSON.stringify(opts);
    assert.deepStrictEqual([claude.cmd, clodent.cmd], ['claude', 'clodent'], label);
    const mcpPath = pathForReal(f.root, 'seat', 'mcpConfig');
    assert.ok(claude.args.includes('--mcp-config') && claude.args.includes('--strict-mcp-config'), `ENTER: the claude argv carries its MCP flags ${label}`);
    assert.deepStrictEqual(clodent.args, withoutMcp(claude.args, mcpPath), label);
    const sansProxyAndClock = (h) => h.filter((_, i) => i !== 1 && i !== 7 && i !== 16);
    assert.deepStrictEqual([hooks[0][16], hooks[1][16]], [null, '1h'], `only the standing clodent seat asks for the one-hour cache ${label}`);
    assert.deepStrictEqual([hooks[0][1], hooks[1][1]], ['http://127.0.0.1:7811', null], `only the claude seat routes through the proxy ${label}`);
    assert.deepStrictEqual(sansProxyAndClock(hooks[1]), sansProxyAndClock(hooks[0]), `the settings file is written from the same setupClaudeHook arguments ${label}`);
    assert.deepStrictEqual(sessionIds[1], sessionIds[0], label);
    assert.deepStrictEqual(clodent.opts.env.CLODEX_SEAT, claude.opts.env.CLODEX_SEAT);
  }
});

test('clodent: protectCredentials and every deny reach the settings file; the seat spawns with no warning', async () => {
  const f = mkClodent();
  const res = await f.create('seat', { protectCredentials: ['~/.ssh'], disabledTools: ['WebFetch'], shellDeny: ['Bash(rm:*)'], denyBuiltins: ['Explore'] });
  try {
    assert.strictEqual(f.spawns.length, 1, 'spawned, not refused');
    assert.strictEqual(res.warnings, undefined);
    assert.deepStrictEqual(f.broadcasts.filter(([ch, msg]) => ch === 'ipc-message' && msg.type === 'system'), []);
    const [, , , denyBuiltins, disabledTools, , , , shellDeny, , , protectCredentials] = f.hooks[0];
    assert.deepStrictEqual([denyBuiltins, disabledTools, shellDeny, protectCredentials], [['Explore'], ['WebFetch'], ['Bash(rm:*)'], ['~/.ssh']]);
  } finally { f.stop('seat'); }
});

test('clodent: CLODENT_HOME in the seat env reaches the PTY env and is the account dir', async () => {
  const f = mkClodent();
  const clodentHome = pathReal.join(f.root, 'clodent-home');
  fsReal.mkdirSync(clodentHome);
  await f.create('seat', { sessionEnv: { CLODENT_HOME: clodentHome } });
  try {
    const { opts } = f.spawns[0];
    assert.strictEqual(opts.env.CLODENT_HOME, clodentHome);
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY, 'Clodex adds no key of its own');
    assert.strictEqual(f.m.sessions.get('seat').accountDir, clodentHome);
    assert.strictEqual(f.hooks[0][15], clodentHome, 'the seat CLODENT_HOME reaches setupClaudeHook, which sandboxes it');
  } finally { f.stop('seat'); }
});

test('clodent: the kill cleanup removes the hook settings, the agent plugin and the claude skill and bundle plugin dir it wrote', async () => {
  const f = mkClodent();
  await f.create('seat');
  assert.strictEqual(f.spawns.length, 1, 'ENTER: spawned');
  f.m._cleanup('seat');
  assert.deepStrictEqual(f.cleanups, [['hook', 'seat'], ['agents', 'seat'], ['skills', 'claude', 'seat']]);
  assert.strictEqual(f.m.sessions.has('seat'), false);
});

test('clodent: _claudeTranscriptPath resolves the home by adapter envKey — accountDir, else ~/.clodent for clodent and ~/.claude for claude', () => {
  const f = mkClodent();
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', '/acct', 'S', 'clodent'), '/acct/projects/-a-b-c/S.jsonl');
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', null, 'S', 'clodent'), pathReal.join(f.home, '.clodent', 'projects', '-a-b-c', 'S.jsonl'));
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', null, 'S'), pathReal.join(f.home, '.claude', 'projects', '-a-b-c', 'S.jsonl'));
});

test('clodent: a resume passes --resume <id>, a fork adds --fork-session, neither mints --session-id', async () => {
  const f = mkClodent();
  await f.create('r', { resumeId: RESUME });
  await f.create('k', { resumeId: RESUME, fork: true });
  try {
    const [r, k] = f.spawns.map((s) => s.args);
    assert.deepStrictEqual(r, [
      '--settings', f.settings('r'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--plugin-dir', f.agentDir('r'),
      '--plugin-dir', f.bundleDir('r'),
      '--resume', RESUME,
      '--append-system-prompt-file', f.prompt('r'),
    ]);
    assert.deepStrictEqual(k.slice(k.indexOf('--resume')), ['--resume', RESUME, '--fork-session', '--append-system-prompt-file', f.prompt('k')]);
    assert.ok(!r.includes('--session-id') && !k.includes('--session-id'));
    assert.strictEqual(f.m.sessions.get('r').sessionId, RESUME);
    assert.strictEqual(f.m.sessions.get('k').forked, true);
    assert.strictEqual(fsReal.readFileSync(f.prompt('r'), 'utf-8'), 'IPC|freeze=false|snapshot=null', 'a clodent resume rebakes, never freezes');
  } finally { f.stop('r'); f.stop('k'); }
});

test('clodent: postures ride the extra args — --permission-mode plan is the read-only cap, --dangerously-skip-permissions and --yolo are bypass', async () => {
  const { ADAPTERS, postureOf } = require('../cli-adapters');
  const f = mkClodent({ sysFile: '/lib/system.md' });
  await f.create('ro', { extraArgs: ['--permission-mode', 'plan'] });
  await f.create('skip', { extraArgs: ['--dangerously-skip-permissions'] });
  await f.create('yolo', { extraArgs: ['--yolo'] });
  try {
    const [ro, skip, yolo] = f.spawns.map((s) => s.args);
    assert.deepStrictEqual(ro.slice(0, 2), ['--permission-mode', 'plan']);
    assert.deepStrictEqual(ro.slice(-4), ['--system-prompt-file', '/lib/system.md', '--append-system-prompt-file', f.prompt('ro')]);
    assert.strictEqual(skip[0], '--dangerously-skip-permissions');
    assert.strictEqual(yolo[0], '--yolo');
    assert.deepStrictEqual([ro, skip, yolo].map((a) => postureOf(ADAPTERS.clodent, a)), ['read-only', 'bypass', 'bypass']);
  } finally { f.stop('ro'); f.stop('skip'); f.stop('yolo'); }
});

test('clodent: effort xhigh becomes --effort xhigh before the append prompt, not a settings effort', async () => {
  const f = mkClodent();
  const res = await f.create('seat', { effort: 'xhigh' });
  try {
    const { args } = f.spawns[0];
    assert.deepStrictEqual(args.slice(-4), ['--effort', 'xhigh', '--append-system-prompt-file', f.prompt('seat')]);
    assert.strictEqual(f.hooks[0][10], null, 'no effortLevel in the settings file');
    assert.strictEqual(res.warnings, undefined);
  } finally { f.stop('seat'); }
});

test('clodent: an effort the CLI does not take is a warning and no --effort', async () => {
  const f = mkClodent();
  const res = await f.create('seat', { effort: 'ultra' });
  try {
    assert.ok(!f.spawns[0].args.includes('--effort'));
    assert.deepStrictEqual(res.warnings, ['effort "ultra" is not one of low, medium, high, xhigh, max (clodent), or default; spawned at the CLI\'s default effort.']);
  } finally { f.stop('seat'); }
});

test('clodent: an own --settings in the extra args installs no Clodex hook', async () => {
  const f = mkClodent();
  await f.create('seat', { extraArgs: ['--settings', '/mine.json'] });
  try {
    assert.strictEqual(f.hooks.length, 0);
    assert.strictEqual(f.spawns[0].args.filter((a) => a === '--settings').length, 1);
    assert.strictEqual(f.m.sessions.get('seat').selectionDrain, false);
  } finally { f.stop('seat'); }
});

test('clodent: the 0.3.0 Notification shape {notification_type:"permission_prompt"} classifies as a permission dialog', () => {
  assert.strictEqual(classifyNotification({ notification_type: 'permission_prompt', tool: 'Bash', id: 'toolu_1', message: 'rm -rf build' }), 'permission');
  assert.strictEqual(classifyNotification({ notification_type: 'permission', message: 'rm -rf build' }), 'other');
  assert.strictEqual(classifyNotification({ notification_type: 'idle', message: 'rm -rf build' }), 'other');
});

test('clodent: a resume seeds activityTs from the resumed transcript mtime, not now', async () => {
  const f = mkClodent();
  const p = pathReal.join(f.home, '.clodent', 'projects', f.cwd.replace(/[/.]/g, '-'), `${RESUME}.jsonl`);
  fsReal.mkdirSync(pathReal.dirname(p), { recursive: true });
  fsReal.writeFileSync(p, '{}\n');
  const old = new Date('2026-01-02T03:04:05Z');
  fsReal.utimesSync(p, old, old);
  await f.create('seat', { resumeId: RESUME });
  try { assert.strictEqual(f.m.sessions.get('seat').activityTs, old.getTime()); } finally { f.stop('seat'); }
});

test('clodent: a ticket-loop seat (ephemeral record) asks for no cache TTL, a standing one for 1h, a claude seat for none', async () => {
  const f = mkClodent({ entries: { hand: { name: 'hand', ephemeral: true }, lead: { name: 'lead' } } });
  await f.create('hand');
  f.stop('hand');
  await f.create('lead');
  f.stop('lead');
  await f.create('cl', { type: 'claude' });
  f.stop('cl');
  assert.deepStrictEqual(f.hooks.map((h) => [h[0], h[16]]), [['hand', null], ['lead', '1h'], ['cl', null]]);
});

test('clodent: below 0.5.2 or off PATH the seat refuses to spawn, naming what it found; a passing probe runs once per manager', async () => {
  for (const [out, found] of [['clodent 0.5.1\n', 'found 0.5.1'], [null, 'not on PATH']]) {
    const f = mkClodent({ probeClodentVersion: () => { if (out == null) throw Object.assign(new Error('spawn clodent ENOENT'), { code: 'ENOENT' }); return out; } });
    await assert.rejects(f.create('seat'), { message: `clodent 0.5.2 or newer is required (${found}): clone github.com/avirtual/clodent and \`npm link\`` });
    assert.deepStrictEqual([f.spawns.length, f.hooks.length], [0, 0]);
  }
  let calls = 0;
  const f = mkClodent({ probeClodentVersion: () => { calls++; return 'clodent 0.10.0\n'; } });
  await f.create('a');
  f.stop('a');
  await f.create('b');
  f.stop('b');
  await f.create('c', { type: 'claude' });
  f.stop('c');
  assert.deepStrictEqual([calls, f.spawns.length], [1, 3]);
});

test('clodentVersionOk: 0.5.2 is the floor, compared numerically; garbage fails', () => {
  for (const [out, ok] of [['0.5.1', false], ['0.5.2', true], ['0.10.0', true], ['clodent 0.5.2\n', true], ['clodent 0.4.9', false], ['1.0.0', true], ['garbage', false], ['', false], [null, false], ['clodent v0.6', false]]) {
    assert.strictEqual(clodentVersionOk(out), ok, JSON.stringify(out));
  }
});
