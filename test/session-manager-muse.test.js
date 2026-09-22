'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const osReal = require('node:os');
const pathReal = require('node:path');

const { intentEnabled } = require('../intent-catalog');
const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { pathFor: pathForReal, runDirFor: runDirForReal } = require('../clodex-paths');
const { mergeInstructionBodies } = require('../argv-merge');
const { adapterFor } = require('../cli-adapters');

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROXY = 'http://127.0.0.1:7811';

function writeConfigFixture(root, { withAuth = true } = {}) {
  const source = pathReal.join(root, 'config');
  fsReal.mkdirSync(pathReal.join(source, 'gh'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(source, 'gh', 'hosts.yml'), 'github.com: {}\n');
  fsReal.mkdirSync(pathReal.join(source, 'muse'), { recursive: true });
  if (withAuth) fsReal.writeFileSync(pathReal.join(source, 'muse', 'auth.json'), '{"schema_version":2}\n');
  fsReal.writeFileSync(pathReal.join(source, 'muse', 'trust.json'), '{"projects":{}}\n');
  fsReal.writeFileSync(pathReal.join(source, 'muse', 'settings.json'), '{"schema_version":1,"provider":"meta"}\n');
  return source;
}

function transcriptPathFor(dataHome, sid) {
  return pathReal.join(dataHome, 'muse', 'sessions', '2026', '09', '22', sid, 'session.jsonl');
}

function writeTranscript(dataHome, sid) {
  const p = transcriptPathFor(dataHome, sid);
  fsReal.mkdirSync(pathReal.dirname(p), { recursive: true });
  fsReal.writeFileSync(p, '{"record_type":"session.opened.observed"}\n');
  return p;
}

function mkMuse({ proxyBase = PROXY, probeAnswer = { capabilities: { muse: true } }, mintFails = false, skills = null, teamBlock = '' } = {}) {
  const root = mkTmpRoot('clodex-muse-');
  const source = writeConfigFixture(root);
  const dataHome = pathReal.join(root, 'data');
  fsReal.mkdirSync(dataHome, { recursive: true });
  const order = [];
  const mints = [];
  const spawns = [];
  const watchers = [];
  const warns = [];
  const fs = {
    ...fsReal,
    renameSync: (a, b) => { order.push('link'); return fsReal.renameSync(a, b); },
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    MSG_DIR: pathReal.join(root, 'messages'),
    PENDING_DIR: pathReal.join(root, 'pending'),
    fs, path: pathReal, os: osReal,
    pathFor: pathForReal, runDirFor: runDirForReal,
    ensureDir: (d) => fsReal.mkdirSync(d, { recursive: true }),
    setupClaudeHook: () => null,
    bakePrompt: (_r, _n, realIpc) => realIpc,
    promptCacheDir: () => pathReal.join(root, 'cache'),
    readCache: () => null,
    buildIpcPrompt: () => 'IPC\n',
    mergeClaudeSystemPrompt: (extraArgs, ipcPrompt) => ({ cleaned: [...extraArgs], append: ipcPrompt }),
    mergeCodexInstructions: (a) => ({ cleaned: [...a], merged: '' }),
    mergeInstructionBodies,
    readAppendBodies: () => ['APPEND'],
    resolveSystemPromptFile: () => null,
    pluginGrammarLines: () => [], intentEnabled,
    resolveTeam: () => (teamBlock ? { name: 'team', root: '/t', roles: {} } : null),
    formatTeamBlock: () => teamBlock,
    matchSeatRole: () => null,
    getAgentLibrary: () => ({ list: () => [] }),
    unionEnabled: () => [],
    writeAgentPlugin: () => null, effectiveInjectedAgents: () => [],
    deliverSkills: () => skills, skillDeliveryProviders: () => ['claude', 'codex', 'muse'],
    cleanupSkills: () => {}, cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupAgentPlugin: () => {},
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
      spawnerHint: () => Promise.resolve({ status: 200 }),
      probe: () => Promise.resolve(probeAnswer),
      registerAccount: () => Promise.resolve({ status: 200 }),
    },
    childProcess: {
      execFile: (cmd, args, opts, cb) => {
        order.push('mint');
        mints.push({ cmd, args, opts });
        if (mintFails) { cb(new Error('muse exec exited 1')); return; }
        const sid = args[args.indexOf('--session-id') + 1];
        writeTranscript(opts.env.XDG_DATA_HOME, sid);
        cb(null, '', '');
      },
    },
    registry: { register: () => {}, unregister: () => {} },
    Transport: class {
      static async isSocketLive() { return false; }
      async start() {}
      stop() {}
    },
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompact, onTouches, opts) { watchers.push({ name, opts }); }
      start() {}
      stop() {}
    },
    pty: {
      spawn: (cmd, args, opts) => {
        order.push('spawn');
        spawns.push({ cmd, args, opts });
        return { onData() {}, onExit() {}, pid: 999, kill() {} };
      },
    },
    notifyOS: () => {},
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    log: { info() {}, warn: (scope, msg) => warns.push(msg), error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._museBackstopMs = 0;
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._bootSettleTimer);
    clearTimeout(s._bootNudgeTimer);
  };
  const env = { XDG_CONFIG_HOME: source, XDG_DATA_HOME: dataHome };
  const create = (name, { extraArgs = [], resumeId = null, fork = false, sessionEnv = env } = {}) => m.create(
    name, 'muse', osReal.tmpdir(), extraArgs, resumeId, 'ws', null, fork, null,
    [], [], [], [], [], null, [], [], null, sessionEnv,
  );
  return { m, root, source, dataHome, env, order, mints, spawns, watchers, warns, create, stop };
}

test('m2: a fresh muse seat mints, links, then spawns — whole-array argv, AGENTS.md bytes, overlay, env', async () => {
  const f = mkMuse();
  const res = await f.create('seat', { extraArgs: ['--model', 'm1'] });
  try {
    assert.deepStrictEqual(f.order, ['mint', 'link', 'spawn'], 'ENTER: all three seen, in that order');
    assert.strictEqual(f.mints.length, 1);
    const sid = f.mints[0].args[f.mints[0].args.indexOf('--session-id') + 1];
    assert.match(sid, UUID7_RE, 'the seat mints its own v7 id up front');
    assert.strictEqual(f.mints[0].cmd, 'muse');
    assert.deepStrictEqual(f.mints[0].args, [
      'exec', '--provider', 'meta', '--approval-mode', 'never', '--disable-sandbox', '--trust-workspace',
      '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`, '--session-id', sid, 'Clodex seat "seat" initialized.',
    ]);
    assert.strictEqual(f.mints[0].opts.timeout, 120000);
    assert.strictEqual(f.mints[0].opts.cwd, osReal.tmpdir());
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    assert.strictEqual(f.mints[0].opts.env.XDG_CONFIG_HOME, seatDir, 'the mint already reads the overlay');
    assert.strictEqual(f.mints[0].opts.env.MUSE_NO_AUTO_UPDATE, '1');

    assert.strictEqual(f.spawns.length, 1);
    assert.strictEqual(f.spawns[0].cmd, 'muse');
    assert.deepStrictEqual(f.spawns[0].args, [
      '--model', 'm1', '--trust-workspace', '--provider', 'meta',
      '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`, 'resume', sid,
    ]);
    assert.strictEqual(f.spawns[0].opts.env.XDG_CONFIG_HOME, seatDir);
    assert.strictEqual(f.spawns[0].opts.env.MUSE_NO_AUTO_UPDATE, '1');
    assert.strictEqual(f.spawns[0].opts.env.WB_WRAP_NAME, undefined, 'the codex env key is arm-local');

    assert.deepStrictEqual(fsReal.readdirSync(seatDir).sort(), ['gh', 'muse']);
    assert.ok(fsReal.lstatSync(pathReal.join(seatDir, 'gh')).isSymbolicLink());
    assert.strictEqual(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'AGENTS.md'), 'utf-8'),
      'You are the clodex agent named \'seat\'.\n\nIPC\n\n\nAPPEND');
    assert.strictEqual(fsReal.statSync(pathReal.join(seatDir, 'muse', 'AGENTS.md')).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8')),
      { schema_version: 1, provider: 'meta' }, 'readOnlyCap is null this round, so no profile is merged');

    const link = pathForReal(f.root, 'seat', 'transcript');
    assert.strictEqual(fsReal.readlinkSync(link), transcriptPathFor(f.dataHome, sid));
    const s = f.m.sessions.get('seat');
    assert.strictEqual(s.sessionId, sid);
    assert.strictEqual(s.accountDir, seatDir);
    assert.strictEqual(s.agentType, 'muse');
    assert.ok(s.watcher && !s.sentinel, 'a muse seat takes the JsonlWatcher branch, never the wire sentinel');
    assert.deepStrictEqual(f.watchers.map((w) => [w.name, w.opts.reader.id]), [['seat', 'muse']]);
    assert.strictEqual(res.warnings, undefined, 'routed: nothing to warn about');
  } finally { f.stop('seat'); }
});

test('m2: no capabilities.muse on the proxy → direct to Meta, no --base-url on mint or resume, one warning', async () => {
  const f = mkMuse({ probeAnswer: { capabilities: { accounts: true } } });
  const res = await f.create('seat');
  try {
    const sid = f.mints[0].args[f.mints[0].args.indexOf('--session-id') + 1];
    assert.deepStrictEqual(f.mints[0].args, [
      'exec', '--provider', 'meta', '--approval-mode', 'never', '--disable-sandbox', '--trust-workspace',
      '--session-id', sid, 'Clodex seat "seat" initialized.',
    ]);
    assert.deepStrictEqual(f.spawns[0].args, ['--trust-workspace', '--provider', 'meta', 'resume', sid]);
    assert.deepStrictEqual(res.warnings, [
      `muse: wirescope at ${PROXY} does not report capabilities.muse — this seat talks to Meta directly, unrouted.`,
    ]);
  } finally { f.stop('seat'); }
});

test('m2: no proxy at all → direct, and no warning either', async () => {
  const f = mkMuse({ proxyBase: null, probeAnswer: null });
  const res = await f.create('seat');
  try {
    const sid = f.spawns[0].args.at(-1);
    assert.deepStrictEqual(f.spawns[0].args, ['--trust-workspace', '--provider', 'meta', 'resume', sid]);
    assert.strictEqual(res.warnings, undefined);
  } finally { f.stop('seat'); }
});

test('m2: CLODEX_DISABLE_IPC_PROMPT=1 drops the IPC block; skills catalog and team block append in codex order', async () => {
  const f = mkMuse({ skills: { args: [], instructions: '# Clodex skills\n\n- a: x — /p' }, teamBlock: 'TEAM' });
  await f.create('seat', { sessionEnv: { ...f.env, CLODEX_DISABLE_IPC_PROMPT: '1' } });
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    const body = fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'AGENTS.md'), 'utf-8');
    assert.match(body, /^You are the clodex agent named 'seat'\.\n\nAPPEND\n\n# Clodex skills\n\n- a: x — \/p\n\n# Team\nYou are on team team \(root \/t\)\./,
      'header, appends, catalog, then the real team block — formatTeamBlock is not a seam');
    assert.ok(body.endsWith('\n'), 'the team block is the last paragraph and closes with a newline, as codex writes it');
  } finally { f.stop('seat'); }
});

test('m2: a restore resumes the persisted id without minting; fork is a warning, not a subcommand', async () => {
  const f = mkMuse();
  const sid = '01a0c97b-13a9-7aab-ab19-6f4f701b254d';
  const target = writeTranscript(f.dataHome, sid);
  const res = await f.create('seat', { resumeId: sid, fork: true });
  try {
    assert.deepStrictEqual(f.order, ['link', 'spawn'], 'no mint on a restore');
    assert.deepStrictEqual(f.mints, []);
    assert.deepStrictEqual(f.spawns[0].args, [
      '--trust-workspace', '--provider', 'meta', '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`, 'resume', sid,
    ]);
    assert.strictEqual(fsReal.readlinkSync(pathForReal(f.root, 'seat', 'transcript')), target);
    assert.strictEqual(f.m.sessions.get('seat').sessionId, sid);
    assert.deepStrictEqual(res.warnings, [`muse has no fork: resuming session ${sid} instead.`]);
  } finally { f.stop('seat'); }
});

test('m2: a restore whose transcript is gone throws before any PTY, like a missing account dir', async () => {
  const f = mkMuse();
  await assert.rejects(() => f.create('seat', { resumeId: '01a0c97b-13a9-7aab-ab19-6f4f701b254d' }), /has no transcript under/);
  assert.deepStrictEqual(f.order, []);
  assert.ok(!f.m.sessions.has('seat'));
});

test('m2: a failing mint throws before any PTY; a missing auth.json throws before the mint', async () => {
  const f = mkMuse({ mintFails: true });
  await assert.rejects(() => f.create('seat'), /muse mint failed for seat: muse exec exited 1/);
  assert.deepStrictEqual(f.order, ['mint']);
  assert.ok(!f.m.sessions.has('seat'));

  const g = mkMuse();
  fsReal.unlinkSync(pathReal.join(g.source, 'muse', 'auth.json'));
  await assert.rejects(() => g.create('seat'), /muse is not logged in/);
  assert.deepStrictEqual(g.order, []);
  assert.ok(!fsReal.existsSync(pathForReal(g.root, 'seat', 'seatConfig')));
});

test('m2: a second create() of the same name rebuilds the overlay from scratch', async () => {
  const f = mkMuse();
  await f.create('seat');
  const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
  fsReal.writeFileSync(pathReal.join(seatDir, 'stale'), 'left over');
  f.stop('seat');
  f.m.sessions.delete('seat');
  await f.create('seat');
  try {
    assert.deepStrictEqual(fsReal.readdirSync(seatDir).sort(), ['gh', 'muse']);
  } finally { f.stop('seat'); }
});

test('m2 backstop: a registry record for the pty pid carrying a different id repoints the transcript link', async () => {
  const f = mkMuse();
  const rotated = '01a0c9ff-0000-7000-8000-000000000001';
  const rotatedPath = writeTranscript(f.dataHome, rotated);
  const regDir = pathReal.join(f.dataHome, 'muse', 'runtime', 'muse', 'sessions');
  fsReal.mkdirSync(regDir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(regDir, `${rotated}.json`),
    JSON.stringify({ schema_version: 1, session_id: rotated, process_generation_hint: 'pid=999' }));
  await f.create('seat');
  try {
    const link = pathForReal(f.root, 'seat', 'transcript');
    assert.notStrictEqual(fsReal.readlinkSync(link), rotatedPath, 'ENTER: the link starts on the minted session');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fsReal.readlinkSync(link), rotatedPath);
  } finally { f.stop('seat'); }
});

test('m2 backstop: a registry record that agrees with the minted id leaves the link alone', async () => {
  const f = mkMuse();
  await f.create('seat');
  try {
    const sid = f.m.sessions.get('seat').sessionId;
    const regDir = pathReal.join(f.dataHome, 'muse', 'runtime', 'muse', 'sessions');
    fsReal.mkdirSync(regDir, { recursive: true });
    fsReal.writeFileSync(pathReal.join(regDir, `${sid}.json`), JSON.stringify({ session_id: sid, process_generation_hint: 'pid=999' }));
    const link = pathForReal(f.root, 'seat', 'transcript');
    const before = fsReal.readlinkSync(link);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fsReal.readlinkSync(link), before);
    assert.deepStrictEqual(f.order, ['mint', 'link', 'spawn'], 'no second link write');
  } finally { f.stop('seat'); }
});

test('m2: the muse adapter row is what the arm reads — envKey XDG_CONFIG_HOME, bootstrap xdg-overlay', () => {
  assert.deepStrictEqual(adapterFor('muse').account, { envKey: 'XDG_CONFIG_HOME', bootstrap: 'xdg-overlay' });
});
