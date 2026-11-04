'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const osReal = require('node:os');
const pathReal = require('node:path');

const { intentEnabled } = require('../intent-catalog');
const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { processStubs } = require('./lib/process-stubs');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');
const { mergeClaudeSystemPrompt, mergeInstructionBodies } = require('../argv-merge');
const { classifyNotification } = require('../attention');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESUME = '6a1f0c2e-1111-4222-8333-944455556666';

function mkClay({ proxyBase = 'http://127.0.0.1:7811', sysFile = null } = {}) {
  const root = mkTmpRoot('clodex-clay-');
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
    writeAgentPlugin: () => { throw new Error('a clay seat writes no agent plugin'); },
    effectiveInjectedAgents: () => [],
    deliverSkills: () => { throw new Error('a clay seat is delivered no skills'); },
    skillDeliveryProviders: () => ['claude', 'codex', 'muse'],
    cleanupSkills: () => {}, cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupAgentPlugin: () => {}, cleanupMuseSeat: () => {},
    writeMcpConfig: () => { throw new Error('a clay seat writes no MCP config'); },
    writeMcpCatalog: () => { throw new Error('a clay seat writes no MCP catalog'); },
    crypto: require('node:crypto'),
    effectiveInjectedSkills: () => [],
    getPersistence: () => ({ list: () => [], get: () => null, upsert: () => {}, setSessionId: () => {}, remove: () => {} }),
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
  m._broadcast = () => {};
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
  const create = (name, { extraArgs = [], resumeId = null, fork = false, sessionEnv = { ANTHROPIC_API_KEY: 'sk-test' }, effort = null } = {}) => m.create(
    name, 'clay', cwd, extraArgs, resumeId, 'ws', null, fork, null,
    [], [], [], [], [], null, [], [], null, sessionEnv,
    false, false, null, null, null, 'pty', effort,
  );
  const settings = (name) => pathForReal(root, name, 'settings');
  const prompt = (name) => pathForReal(root, name, 'appendPrompt');
  const link = (name) => pathForReal(root, name, 'transcript');
  return { m, root, home, cwd, spawns, hooks, watchers, probes, registers, hints, create, stop, settings, prompt, link };
}

function noClaudeOnlyFlags(args) {
  for (const flag of ['--plugin-dir', '--mcp-config', '--strict-mcp-config', '--enable', '--dangerously-skip-permissions', '-p']) {
    assert.ok(!args.includes(flag), `a clay argv carries no ${flag}`);
  }
}

test('clay: a fresh seat spawns `clay` with a minted --session-id, Clodex hooks, both add-dirs and the baked prompt — whole argv and env', async () => {
  const f = mkClay();
  await f.create('seat', { extraArgs: ['--model', 'claude-haiku-5-5'] });
  try {
    assert.strictEqual(f.spawns.length, 1, 'ENTER: one PTY spawn');
    const { cmd, args, opts } = f.spawns[0];
    assert.strictEqual(cmd, 'clay');
    const sid = args[args.indexOf('--session-id') + 1];
    assert.match(sid, UUID_RE);
    assert.deepStrictEqual(args, [
      '--model', 'claude-haiku-5-5',
      '--settings', f.settings('seat'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--session-id', sid,
      '--append-system-prompt-file', f.prompt('seat'),
    ]);
    noClaudeOnlyFlags(args);
    assert.strictEqual(fsReal.readFileSync(f.prompt('seat'), 'utf-8'), 'IPC|freeze=false|snapshot=null');
    assert.strictEqual(fsReal.statSync(f.prompt('seat')).mode & 0o777, 0o600);
    assert.strictEqual(f.hooks.length, 1);
    const [hookName, hookProxy, hookAgent, , , , hookWire, , , hookStream, hookEffort] = f.hooks[0];
    assert.deepStrictEqual([hookName, hookProxy, hookAgent, hookWire, hookStream, hookEffort], ['seat', null, null, null, false, null],
      'the hook settings carry no proxy, no wire and no effort, so no ANTHROPIC_BASE_URL is written');
    assert.strictEqual(opts.cwd, f.cwd);
    assert.strictEqual(opts.env.TERM, 'xterm-256color');
    assert.strictEqual(opts.env.CLODEX_HOME, f.root);
    assert.strictEqual(opts.env.FORCE_HYPERLINK, '1');
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-test', 'the seat env key passes through');
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, undefined, 'm0 routes nothing through the wire');
    assert.strictEqual(opts.env.CLODEX_SEAT, 'seat', 'the seat gets the intent channel its hooks reach');
    assert.ok(opts.env.CLODEX_INTENT_SOCK && opts.env.CLODEX_INTENT_CRED);
    assert.strictEqual(opts.env.WB_WRAP_NAME, undefined);
    assert.deepStrictEqual([f.probes.length, f.registers.length, f.hints.length], [0, 0, 0], 'no proxy traffic for a clay seat');
    const s = f.m.sessions.get('seat');
    assert.strictEqual(s.agentType, 'clay');
    assert.strictEqual(s.sessionId, sid, 'the minted id is known before the first transcript record');
    assert.strictEqual(s.proxyBase, null);
    assert.strictEqual(s.selectionDrain, true);
    assert.deepStrictEqual(f.watchers.map((w) => [w.name, w.opts.reader.id]), [['seat', 'claude']]);
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')),
      pathReal.join(f.home, '.clay', 'projects', f.cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`),
      'CLAY_HOME unset: the link is the ~/.clay fallback path, slugged like Claude');
  } finally { f.stop('seat'); }
});

test('clay: CLAY_HOME in the seat env is the transcript home and reaches the PTY env', async () => {
  const f = mkClay();
  const clayHome = pathReal.join(f.root, 'clay-home');
  fsReal.mkdirSync(clayHome);
  await f.create('seat', { sessionEnv: { ANTHROPIC_API_KEY: 'sk-test', CLAY_HOME: clayHome } });
  try {
    const { args, opts } = f.spawns[0];
    const sid = args[args.indexOf('--session-id') + 1];
    assert.strictEqual(opts.env.CLAY_HOME, clayHome);
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')),
      pathReal.join(clayHome, 'projects', f.cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`));
    assert.strictEqual(f.m.sessions.get('seat').accountDir, clayHome);
  } finally { f.stop('seat'); }
});

test('clay: _claudeTranscriptPath resolves the home by adapter envKey — accountDir, else ~/.clay for clay and ~/.claude for claude', () => {
  const f = mkClay();
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', '/acct', 'S', 'clay'), '/acct/projects/-a-b-c/S.jsonl');
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', null, 'S', 'clay'), pathReal.join(f.home, '.clay', 'projects', '-a-b-c', 'S.jsonl'));
  assert.strictEqual(f.m._claudeTranscriptPath('/a/b.c', null, 'S'), pathReal.join(f.home, '.claude', 'projects', '-a-b-c', 'S.jsonl'));
});

test('clay: a resume passes --resume <id> and no --session-id, and links the resumed transcript', async () => {
  const f = mkClay();
  await f.create('seat', { resumeId: RESUME });
  try {
    const { args } = f.spawns[0];
    assert.deepStrictEqual(args, [
      '--settings', f.settings('seat'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--resume', RESUME,
      '--append-system-prompt-file', f.prompt('seat'),
    ]);
    assert.strictEqual(f.m.sessions.get('seat').sessionId, RESUME);
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')),
      pathReal.join(f.home, '.clay', 'projects', f.cwd.replace(/[/.]/g, '-'), `${RESUME}.jsonl`));
  } finally { f.stop('seat'); }
});

test('clay: a fork passes --resume <id> --fork-session --session-id <new> and links the new id', async () => {
  const f = mkClay();
  await f.create('seat', { resumeId: RESUME, fork: true });
  try {
    const { args } = f.spawns[0];
    const sid = args[args.indexOf('--session-id') + 1];
    assert.match(sid, UUID_RE);
    assert.notStrictEqual(sid, RESUME);
    assert.deepStrictEqual(args, [
      '--settings', f.settings('seat'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--resume', RESUME, '--fork-session', '--session-id', sid,
      '--append-system-prompt-file', f.prompt('seat'),
    ]);
    assert.strictEqual(f.m.sessions.get('seat').forked, true);
    assert.ok(fsReal.readlinkSync(f.link('seat')).endsWith(`${sid}.jsonl`));
  } finally { f.stop('seat'); }
});

test('clay: read-only and bypass postures ride the extra args; effort becomes --effort; a system prompt file is passed', async () => {
  const f = mkClay({ sysFile: '/lib/system.md' });
  await f.create('ro', { extraArgs: ['--read-only'], effort: 'high' });
  await f.create('yolo', { extraArgs: ['--yolo'] });
  try {
    const ro = f.spawns[0].args;
    const roSid = ro[ro.indexOf('--session-id') + 1];
    assert.deepStrictEqual(ro, [
      '--read-only',
      '--settings', f.settings('ro'),
      '--add-dir', pathReal.join(f.root, 'messages'),
      '--session-id', roSid,
      '--system-prompt-file', '/lib/system.md',
      '--effort', 'high',
      '--append-system-prompt-file', f.prompt('ro'),
    ]);
    const yolo = f.spawns[1].args;
    assert.strictEqual(yolo[0], '--yolo');
    assert.ok(!yolo.includes('--read-only'));
    noClaudeOnlyFlags(ro);
    noClaudeOnlyFlags(yolo);
  } finally { f.stop('ro'); f.stop('yolo'); }
});

test('clay: an effort the CLI does not take is a warning and no --effort', async () => {
  const f = mkClay();
  const res = await f.create('seat', { effort: 'max' });
  try {
    assert.ok(!f.spawns[0].args.includes('--effort'));
    assert.deepStrictEqual(res.warnings, ['effort "max" is not one of low, medium, high (clay), or default; spawned at the CLI\'s default effort.']);
  } finally { f.stop('seat'); }
});

test('clay: an own --settings in the extra args installs no Clodex hook', async () => {
  const f = mkClay();
  await f.create('seat', { extraArgs: ['--settings', '/mine.json'] });
  try {
    assert.strictEqual(f.hooks.length, 0);
    assert.strictEqual(f.spawns[0].args.filter((a) => a === '--settings').length, 1);
    assert.strictEqual(f.m.sessions.get('seat').selectionDrain, false);
  } finally { f.stop('seat'); }
});

test('clay: the Notification shape {notification_type:"permission"} classifies as a permission dialog', () => {
  assert.strictEqual(classifyNotification({ notification_type: 'permission', tool: 'Bash', id: 'toolu_1', message: 'rm -rf build' }), 'permission');
  assert.strictEqual(classifyNotification({ notification_type: 'idle', message: 'rm -rf build' }), 'other');
});
