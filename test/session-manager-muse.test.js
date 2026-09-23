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
const { createCliHooks } = require('../cli-hooks');

const PROXY = 'http://127.0.0.1:7811';
const SID = '01a0c97b-13a9-7aab-ab19-6f4f701b254d';
const ROTATED = '01a0c9ff-0000-7000-8000-000000000001';

function writeConfigFixture(root, { withAuth = true, settings = '{"schema_version":1,"provider":"meta"}\n' } = {}) {
  const source = pathReal.join(root, 'config');
  fsReal.mkdirSync(pathReal.join(source, 'gh'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(source, 'gh', 'hosts.yml'), 'github.com: {}\n');
  fsReal.mkdirSync(pathReal.join(source, 'muse'), { recursive: true });
  if (withAuth) fsReal.writeFileSync(pathReal.join(source, 'muse', 'auth.json'), '{"schema_version":2}\n');
  fsReal.writeFileSync(pathReal.join(source, 'muse', 'trust.json'), '{"projects":{}}\n');
  fsReal.writeFileSync(pathReal.join(source, 'muse', 'settings.json'), settings);
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

function writeRegistry(dataHome, sid, pid = 999) {
  const regDir = pathReal.join(dataHome, 'muse', 'runtime', 'muse', 'sessions');
  fsReal.mkdirSync(regDir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(regDir, `${sid}.json`),
    JSON.stringify({ schema_version: 1, session_id: sid, process_generation_hint: `pid=${pid}` }));
}

function mkMuse({ proxyBase = PROXY, probeAnswer = { capabilities: { muse: true } }, skills = null, teamBlock = '', settings, roster = null } = {}) {
  const root = mkTmpRoot('clodex-muse-');
  const source = writeConfigFixture(root, settings === undefined ? {} : { settings });
  const dataHome = pathReal.join(root, 'data');
  fsReal.mkdirSync(dataHome, { recursive: true });
  const order = [];
  const execs = [];
  const spawns = [];
  const watchers = [];
  const warns = [];
  const infos = [];
  const rosterCalls = [];
  const linkFail = { n: 0 };
  const fs = {
    ...fsReal,
    renameSync: (a, b) => {
      if (linkFail.n > 0) { linkFail.n -= 1; throw Object.assign(new Error('EACCES: stub'), { code: 'EACCES' }); }
      order.push('link');
      return fsReal.renameSync(a, b);
    },
  };
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    platformSkills: (adapter, opts) => { rosterCalls.push({ id: adapter.id, ...opts }); return roster || []; },
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
    cleanupMuseSeat: createCliHooks({ REGISTRY_DIR: root, memoryStore: { list: () => [] }, getUiSettings: () => ({ get: () => ({}) }), nodeInterp: process.execPath }).cleanupMuseSeat,
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
      spawnerHint: () => Promise.resolve({ status: 200 }),
      probe: () => Promise.resolve(probeAnswer),
      registerAccount: () => Promise.resolve({ status: 200 }),
    },
    childProcess: {
      execFile: (cmd, args, opts, cb) => {
        if (cmd === 'ps') { cb(null, '', ''); return; }
        order.push('exec');
        execs.push({ cmd, args, opts });
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
        let exit = null;
        return { onData() {}, onExit(fn) { exit = fn; }, pid: 999, kill() { if (exit) exit({ exitCode: 0, signal: null }); } };
      },
    },
    notifyOS: () => {},
    collectSystemDiagnostics: () => ({}),
    whichBin: () => null,
    diagWarning: () => '',
    diagSummary: () => '',
    log: { info: (scope, msg) => infos.push(msg), warn: (scope, msg) => warns.push(msg), error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  m._museLinkPollMs = 0;
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._bootSettleTimer);
    clearTimeout(s._bootNudgeTimer);
    m.sessions.delete(name);
    return s._museLinkDone;
  };
  const env = { XDG_CONFIG_HOME: source, XDG_DATA_HOME: dataHome };
  const create = (name, { extraArgs = [], resumeId = null, fork = false, sessionEnv = env, disabledSkills = [], injectSkills = [] } = {}) => m.create(
    name, 'muse', osReal.tmpdir(), extraArgs, resumeId, 'ws', null, fork, null,
    [], [], [], disabledSkills, injectSkills, null, [], [], null, sessionEnv,
  );
  const link = (name) => pathForReal(root, name, 'transcript');
  return { m, root, source, dataHome, env, order, execs, spawns, watchers, warns, infos, linkFail, rosterCalls, create, stop, link };
}

test('m2: a fresh muse seat spawns at once; the registry poller links its transcript — whole-array argv, AGENTS.md bytes, overlay, env', async () => {
  const f = mkMuse();
  const res = await f.create('seat', { extraArgs: ['--model', 'm1'] });
  try {
    assert.deepStrictEqual(f.order, ['spawn'], 'ENTER: no exec and no link before the PTY');
    assert.deepStrictEqual(f.execs, [], 'a fresh seat runs no `muse exec`');
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');

    assert.strictEqual(f.spawns.length, 1);
    assert.strictEqual(f.spawns[0].cmd, 'muse');
    assert.deepStrictEqual(f.spawns[0].args, [
      '--model', 'm1', '--trust-workspace', '--provider', 'meta',
      '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`,
    ], 'root flags only: no resume subcommand, no --session-id');
    assert.strictEqual(f.spawns[0].opts.cwd, osReal.tmpdir());
    assert.strictEqual(f.spawns[0].opts.env.XDG_CONFIG_HOME, seatDir);
    assert.strictEqual(f.spawns[0].opts.env.MUSE_NO_AUTO_UPDATE, '1');
    assert.strictEqual(f.spawns[0].opts.env.WB_WRAP_NAME, undefined, 'the codex env key is arm-local');

    assert.deepStrictEqual(fsReal.readdirSync(seatDir).sort(), ['gh', 'muse']);
    assert.ok(fsReal.lstatSync(pathReal.join(seatDir, 'gh')).isSymbolicLink());
    assert.strictEqual(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'AGENTS.md'), 'utf-8'),
      'You are the clodex agent named \'seat\'.\n\nIPC\n\n\nAPPEND');
    assert.strictEqual(fsReal.statSync(pathReal.join(seatDir, 'muse', 'AGENTS.md')).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8')), {
      schema_version: 1,
      provider: 'meta',
      permissions: {
        schema_version: 1,
        profiles: { reviewer: { extends: ':read-only', approval: 'allow_all', reviewer: 'none', network: { mode: 'enabled' } } },
      },
      run: {
        workflow_trigger_mode: 'off',
        reminder_roster: { agents: [] },
        context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
      },
    }, 'the readOnlyCap profile DEFINITION is merged into every muse seat, inert until --permission-profile selects it');

    const s = f.m.sessions.get('seat');
    assert.strictEqual(s.sessionId, null, 'no id until the CLI registers one');
    assert.strictEqual(s.accountDir, seatDir);
    assert.strictEqual(s.agentType, 'muse');
    assert.ok(s.watcher && !s.sentinel, 'a muse seat takes the JsonlWatcher branch, never the wire sentinel');
    assert.deepStrictEqual(f.watchers.map((w) => [w.name, w.opts.reader.id]), [['seat', 'muse']]);
    assert.strictEqual(res.warnings, undefined, 'routed: nothing to warn about');
    assert.ok(fsReal.existsSync(runDirForReal(f.root, 'seat')), 'run/<name>/ exists for the link to land in');
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'ENTER: nothing to link yet');

    writeRegistry(f.dataHome, SID);
    await new Promise((r) => setTimeout(r, 10));
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'a registry record whose session.jsonl is not there yet is not a link');
    const target = writeTranscript(f.dataHome, SID);
    assert.strictEqual(await s._museLinkDone, 'linked');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), target);
    assert.deepStrictEqual(f.order, ['spawn', 'link']);
    assert.strictEqual(s.sessionId, null, 'the id is the watcher retarget\'s to report, not the poller\'s');
  } finally { await f.stop('seat'); }
});

test('m2: no capabilities.muse on the proxy → direct to Meta, no --base-url, one warning', async () => {
  const f = mkMuse({ probeAnswer: { capabilities: { accounts: true } } });
  const res = await f.create('seat');
  try {
    assert.deepStrictEqual(f.execs, []);
    assert.deepStrictEqual(f.spawns[0].args, ['--trust-workspace', '--provider', 'meta']);
    assert.deepStrictEqual(res.warnings, [
      `muse: wirescope at ${PROXY} does not report capabilities.muse — this seat talks to Meta directly, unrouted.`,
    ]);
  } finally { await f.stop('seat'); }
});

test('m2: no proxy at all → direct, and no warning either', async () => {
  const f = mkMuse({ proxyBase: null, probeAnswer: null });
  const res = await f.create('seat');
  try {
    assert.deepStrictEqual(f.spawns[0].args, ['--trust-workspace', '--provider', 'meta']);
    assert.strictEqual(res.warnings, undefined);
  } finally { await f.stop('seat'); }
});

test('t1097: delivered skills link into the overlay as muse/skills; AGENTS.md carries the team block and no catalog', async () => {
  const skillsDir = pathReal.join(mkTmpRoot('clodex-muse-skills-'), 'skill-plugins', 'seat', 'skills');
  fsReal.mkdirSync(pathReal.join(skillsDir, 'a'), { recursive: true });
  fsReal.writeFileSync(pathReal.join(skillsDir, 'a', 'SKILL.md'), '---\nname: a\n---\nx\n');
  const f = mkMuse({ skills: { args: [], instructions: null, skillsDir }, teamBlock: 'TEAM' });
  await f.create('seat', { sessionEnv: { ...f.env, CLODEX_DISABLE_IPC_PROMPT: '1' } });
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    const link = pathReal.join(seatDir, 'muse', 'skills');
    assert.ok(fsReal.lstatSync(link).isSymbolicLink(), 'muse/skills is a symlink, not a copy');
    assert.strictEqual(fsReal.readlinkSync(link), skillsDir, 'pointing at the delivered tree');
    assert.strictEqual(fsReal.readFileSync(pathReal.join(link, 'a', 'SKILL.md'), 'utf-8'), '---\nname: a\n---\nx\n',
      'so $XDG_CONFIG_HOME/muse/skills/a/SKILL.md resolves to the delivered file');
    const body = fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'AGENTS.md'), 'utf-8');
    assert.match(body, /^You are the clodex agent named 'seat'\.\n\nAPPEND\n\n# Team\nYou are on team team \(root \/t\)\./,
      'header, appends, then the real team block — formatTeamBlock is not a seam');
    assert.doesNotMatch(body, /Clodex skills/, 'no catalog: the roster is the CLI\'s own');
    assert.ok(body.endsWith('\n'), 'the team block is the last paragraph and closes with a newline, as codex writes it');
  } finally { await f.stop('seat'); }

  const g = mkMuse();
  await g.create('seat');
  try {
    const museDir = pathReal.join(pathForReal(g.root, 'seat', 'seatConfig'), 'muse');
    assert.deepStrictEqual(fsReal.readdirSync(museDir).sort(), ['AGENTS.md', 'auth.json', 'settings.json', 'trust.json'],
      'nothing delivered: no skills entry at all, not a dangling link');
  } finally { await g.stop('seat'); }
});

test('m2: a restore links before the spawn and resumes the persisted id; fork is a warning, not a subcommand', async () => {
  const f = mkMuse();
  const target = writeTranscript(f.dataHome, SID);
  const res = await f.create('seat', { resumeId: SID, fork: true });
  try {
    assert.deepStrictEqual(f.order, ['link', 'spawn'], 'the link is on disk before the PTY');
    assert.deepStrictEqual(f.execs, []);
    assert.deepStrictEqual(f.spawns[0].args, [
      '--trust-workspace', '--provider', 'meta', '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`, 'resume', SID,
    ]);
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), target);
    assert.strictEqual(f.m.sessions.get('seat').sessionId, SID);
    assert.deepStrictEqual(res.warnings, [`muse has no fork: resuming session ${SID} instead.`]);
  } finally { await f.stop('seat'); }
});

test('m2: a restore whose transcript is gone throws before any PTY, like a missing account dir', async () => {
  const f = mkMuse();
  await assert.rejects(() => f.create('seat', { resumeId: SID }), /has no transcript under/);
  assert.deepStrictEqual(f.order, []);
  assert.ok(!f.m.sessions.has('seat'));
  assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'no link was written before the throw');
});

test('m2: a missing auth.json throws before any overlay or PTY', async () => {
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
  await f.stop('seat');
  await f.create('seat');
  try {
    assert.deepStrictEqual(fsReal.readdirSync(seatDir).sort(), ['gh', 'muse']);
  } finally { await f.stop('seat'); }
});

test('m2: kill() drops run/<name>/ — the overlay, the transcript link and the AGENTS.md copy do not outlive the seat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  writeTranscript(f.dataHome, SID);
  await f.create('seat', { resumeId: SID });
  const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
  assert.ok(fsReal.existsSync(pathReal.join(seatDir, 'muse', 'auth.json')), 'ENTER: the 0600 auth copy is on disk before the kill');
  assert.ok(fsReal.lstatSync(f.link('seat')).isSymbolicLink(), 'ENTER: the link is on disk before the kill');
  await f.m.kill('seat');
  assert.ok(!f.m.sessions.has('seat'), 'ENTER: the pty exit reached _cleanup');
  assert.ok(!fsReal.existsSync(seatDir), `run/seat/xdg survived kill(): ${seatDir}`);
  assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'the transcript symlink survived kill()');
  assert.ok(!fsReal.existsSync(runDirForReal(f.root, 'seat')), 'run/seat/ itself survived kill()');
});

test('m2: a second create() of the same name while the first is still probing the proxy is refused, not a second overlay', async () => {
  let release = null;
  const f = mkMuse({ probeAnswer: new Promise((r) => { release = r; }) });
  const first = f.create('seat');
  await assert.rejects(f.create('seat'), /Session "seat" already exists/);
  release({ capabilities: { muse: true } });
  await first;
  try {
    assert.strictEqual(f.spawns.length, 1, 'the refused create never spawned');
    assert.deepStrictEqual(f.spawns[0].args, ['--trust-workspace', '--provider', 'meta', '--base-url', `${PROXY}/agent/clodex-seat-rt/meta`]);
  } finally { await f.stop('seat'); }
});

test('m2 poller: a registry record for the pty pid carrying a different id repoints a resumed link', async () => {
  const f = mkMuse();
  writeTranscript(f.dataHome, SID);
  const rotatedPath = writeTranscript(f.dataHome, ROTATED);
  writeRegistry(f.dataHome, ROTATED);
  await f.create('seat', { resumeId: SID });
  try {
    const s = f.m.sessions.get('seat');
    assert.strictEqual(await s._museLinkDone, 'linked');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), rotatedPath);
    assert.deepStrictEqual(f.order, ['link', 'spawn', 'link'], 'the resume link first, the repoint after the PTY');
  } finally { await f.stop('seat'); }
});

test('m2 poller: a registry record that agrees with the resumed id leaves the link alone', async () => {
  const f = mkMuse();
  const target = writeTranscript(f.dataHome, SID);
  writeRegistry(f.dataHome, SID);
  await f.create('seat', { resumeId: SID });
  try {
    const s = f.m.sessions.get('seat');
    assert.strictEqual(await s._museLinkDone, 'agreed');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), target);
    assert.deepStrictEqual(f.order, ['link', 'spawn'], 'no second link write');
  } finally { await f.stop('seat'); }
});

test('m2 poller: a record for another pid is not this seat\'s', async () => {
  const f = mkMuse();
  writeTranscript(f.dataHome, SID);
  writeRegistry(f.dataHome, SID, 1000);
  await f.create('seat');
  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/);
    assert.deepStrictEqual(f.order, ['spawn']);
  } finally { await f.stop('seat'); }
});

test('m2 poller: a deadline miss warns once, keeps the PTY, and links nothing that lands later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  await f.create('seat');
  try {
    const s = f.m.sessions.get('seat');
    t.mock.timers.tick(60000);
    assert.strictEqual(await s._museLinkDone, 'deadline');
    assert.deepStrictEqual(f.warns.filter((w) => w.includes('transcript link pending')),
      ['seat: no session registered for pid 999 within 60000 ms — transcript link pending']);
    assert.ok(f.m.sessions.has('seat'), 'the seat lives on: a miss is not a throw');
    writeRegistry(f.dataHome, SID);
    writeTranscript(f.dataHome, SID);
    t.mock.timers.tick(5000);
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'the poller stopped at the deadline');
    assert.deepStrictEqual(f.order, ['spawn']);
  } finally { await f.stop('seat'); }
});

test('m2 poller: stops when the seat leaves the session map before its id lands', async () => {
  const f = mkMuse();
  await f.create('seat');
  const s = f.m.sessions.get('seat');
  await f.stop('seat');
  writeRegistry(f.dataHome, SID);
  writeTranscript(f.dataHome, SID);
  assert.strictEqual(await s._museLinkDone, 'gone');
  assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'a dead seat is never linked');
  assert.deepStrictEqual(f.order, ['spawn']);
});

const setMtime = (p, ms) => { fsReal.utimesSync(p, ms / 1000, ms / 1000); return p; };

test('t1095: fallback — no registry record ever lands; the deadline links the newest post-spawn session.jsonl and resolves fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  await f.create('seat');
  try {
    const s = f.m.sessions.get('seat');
    const older = setMtime(writeTranscript(f.dataHome, ROTATED), s.spawnedAt + 1000);
    const newest = setMtime(writeTranscript(f.dataHome, SID), s.spawnedAt + 2000);
    t.mock.timers.tick(59999);
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/, 'ENTER: nothing linked before the deadline');
    t.mock.timers.tick(1);
    assert.strictEqual(await s._museLinkDone, 'fallback');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), newest);
    assert.notStrictEqual(fsReal.readlinkSync(f.link('seat')), older);
    assert.deepStrictEqual(f.order, ['spawn', 'link']);
    assert.deepStrictEqual(f.warns, [], 'a fallback link is info, not a warn');
    assert.deepStrictEqual(f.infos.filter((m) => m.includes('linked newest transcript')),
      [`seat: no session registered for pid 999 within 60000 ms — linked newest transcript ${newest}`]);
    assert.strictEqual(s.sessionId, null, 'the id is the watcher retarget\'s to report, not the fallback\'s');
  } finally { await f.stop('seat'); }
});

test('t1095: fallback skips a session.jsonl another live muse seat already links', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  const linkedByA = writeTranscript(f.dataHome, SID);
  await f.create('a', { resumeId: SID });
  await f.create('b');
  try {
    const a = f.m.sessions.get('a');
    const b = f.m.sessions.get('b');
    setMtime(linkedByA, b.spawnedAt + 2000);
    const free = setMtime(writeTranscript(f.dataHome, ROTATED), b.spawnedAt + 1000);
    assert.strictEqual(fsReal.readlinkSync(f.link('a')), linkedByA, 'ENTER: a already links the newest file');
    t.mock.timers.tick(60000);
    assert.strictEqual(await a._museLinkDone, 'deadline');
    assert.strictEqual(await b._museLinkDone, 'fallback');
    assert.strictEqual(fsReal.readlinkSync(f.link('b')), free, 'the newest file is a\'s; b takes the next newest');
    assert.strictEqual(fsReal.readlinkSync(f.link('a')), linkedByA);
    assert.deepStrictEqual(f.warns, []);
  } finally { await f.stop('a'); await f.stop('b'); }
});

test('t1104: two fresh seats — a file newer than the later seat\'s spawn is not the earlier seat\'s; a resolves deadline, b takes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  await f.create('a');
  await f.create('b');
  try {
    const a = f.m.sessions.get('a');
    const b = f.m.sessions.get('b');
    b.spawnedAt = a.spawnedAt + 100;
    const only = setMtime(writeTranscript(f.dataHome, SID), b.spawnedAt + 2000);
    assert.ok(fsReal.statSync(only).mtimeMs > b.spawnedAt, 'ENTER: the only file postdates b\'s spawn');
    t.mock.timers.tick(60000);
    assert.strictEqual(await a._museLinkDone, 'deadline');
    assert.strictEqual(await b._museLinkDone, 'fallback');
    assert.throws(() => fsReal.lstatSync(f.link('a')), /ENOENT/, 'a links nothing: the file may be b\'s');
    assert.strictEqual(fsReal.readlinkSync(f.link('b')), only);
    assert.deepStrictEqual(f.warns, ['a: no session registered for pid 999 within 60000 ms — transcript link pending']);
  } finally { await f.stop('a'); await f.stop('b'); }
});

test('t1095: fallback — a session.jsonl older than the spawn is no candidate; the deadline warns and links nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  await f.create('seat');
  try {
    const s = f.m.sessions.get('seat');
    const stale = setMtime(writeTranscript(f.dataHome, SID), s.spawnedAt - 5000);
    assert.ok(fsReal.statSync(stale).mtimeMs < s.spawnedAt, 'ENTER: the only file predates the spawn');
    t.mock.timers.tick(60000);
    assert.strictEqual(await s._museLinkDone, 'deadline');
    assert.throws(() => fsReal.lstatSync(f.link('seat')), /ENOENT/);
    assert.deepStrictEqual(f.warns, ['seat: no session registered for pid 999 within 60000 ms — transcript link pending']);
    assert.deepStrictEqual(f.infos.filter((m) => m.includes('linked newest transcript')), []);
    assert.deepStrictEqual(f.order, ['spawn']);
  } finally { await f.stop('seat'); }
});

test('t1095: a linkTranscript throw on one tick is retried on the next — linked, no warn', async () => {
  const f = mkMuse();
  f.linkFail.n = 1;
  writeRegistry(f.dataHome, SID);
  const target = writeTranscript(f.dataHome, SID);
  await f.create('seat');
  try {
    const s = f.m.sessions.get('seat');
    assert.strictEqual(await s._museLinkDone, 'linked');
    assert.strictEqual(f.linkFail.n, 0, 'ENTER: the first rename threw');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), target);
    assert.deepStrictEqual(f.order, ['spawn', 'link']);
    assert.deepStrictEqual(f.warns, []);
  } finally { await f.stop('seat'); }
});

test('t1095: restore-path deadline — the link already exists, so the miss is one info naming the sid, never a warn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = mkMuse();
  f.m._museLinkPollMs = 250;
  const target = writeTranscript(f.dataHome, SID);
  await f.create('seat', { resumeId: SID });
  try {
    const s = f.m.sessions.get('seat');
    assert.strictEqual(s.sessionId, SID, 'ENTER: a restore carries its id');
    t.mock.timers.tick(60000);
    assert.strictEqual(await s._museLinkDone, 'deadline');
    assert.strictEqual(fsReal.readlinkSync(f.link('seat')), target, 'the resume link stands');
    assert.deepStrictEqual(f.warns, []);
    assert.deepStrictEqual(f.infos.filter((m) => m.includes('registry never confirmed')),
      [`seat: registry never confirmed ${SID} for pid 999 within 60000 ms`]);
    assert.deepStrictEqual(f.order, ['link', 'spawn']);
  } finally { await f.stop('seat'); }
});

test('m2: the muse adapter row is what the arm reads — envKey XDG_CONFIG_HOME, bootstrap xdg-overlay', () => {
  assert.deepStrictEqual(adapterFor('muse').account, { envKey: 'XDG_CONFIG_HOME', bootstrap: 'xdg-overlay' });
});

test('m3: the profile merge is a deepMerge — a permissions.profiles.other entry in the source settings survives', async () => {
  const f = mkMuse({ settings: '{"schema_version":1,"provider":"meta","permissions":{"schema_version":1,"profiles":{"other":{"extends":":read-only"}}}}\n' });
  await f.create('seat');
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8')), {
      schema_version: 1,
      provider: 'meta',
      permissions: {
        schema_version: 1,
        profiles: {
          other: { extends: ':read-only' },
          reviewer: { extends: ':read-only', approval: 'allow_all', reviewer: 'none', network: { mode: 'enabled' } },
        },
      },
      run: {
        workflow_trigger_mode: 'off',
        reminder_roster: { agents: [] },
        context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
      },
    });
  } finally { await f.stop('seat'); }
});

test('t1100: the adapter seatSettings win per leaf over the source run block — the operator\'s roster is emptied, its sibling key survives', async () => {
  const f = mkMuse({ settings: '{"schema_version":1,"provider":"meta","run":{"reminder_roster":{"agents":["keep"]},"other":1}}\n' });
  await f.create('seat');
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    const written = JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8'));
    assert.deepStrictEqual(written.run, {
      reminder_roster: { agents: [] },
      other: 1,
      workflow_trigger_mode: 'off',
      context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
    });
  } finally { await f.stop('seat'); }
});

const MUSE_ROSTER = [
  { id: 'bundled:git', scope: 'bundled', path: 'bundled://muse-core/skills/git/SKILL.md', activation: 'on' },
  { id: 'bundled:workflow-authoring', scope: 'bundled', path: 'bundled://muse-core/skills/workflow-authoring/SKILL.md', activation: 'on' },
  { id: 'plugin:threejs:threejs', scope: 'plugin', path: 'plugin://threejs/skills/threejs/SKILL.md', activation: 'on' },
  { id: 'foo', scope: 'user', path: '$CONFIG_DIR/skills/foo/SKILL.md', activation: 'on' },
  { id: 'bar', scope: 'project', path: '.agents/skills/bar/SKILL.md', activation: 'on' },
];

test('t1090: disabledSkills becomes skills.activation in the overlay, beside the reviewer profile — whole file', async () => {
  const f = mkMuse({ roster: MUSE_ROSTER });
  await f.create('seat', { disabledSkills: ['git', 'plugin:threejs:threejs', 'foo', 'bar', 'nope'] });
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    assert.deepStrictEqual(f.rosterCalls, [{ id: 'muse', configDir: f.source }],
      'the roster is read once, from the SOURCE config the seat copies, never the overlay');
    assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8')), {
      schema_version: 1,
      provider: 'meta',
      permissions: {
        schema_version: 1,
        profiles: { reviewer: { extends: ':read-only', approval: 'allow_all', reviewer: 'none', network: { mode: 'enabled' } } },
      },
      run: {
        workflow_trigger_mode: 'off',
        reminder_roster: { agents: [] },
        context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
      },
      skills: {
        activation: {
          bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'off' },
          plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' },
          user: { '$CONFIG_DIR/skills/foo/SKILL.md': 'off' },
        },
      },
    });
  } finally { await f.stop('seat'); }
});

test('t1090: "*" sweeps every listed skill except the injected ones; the source file\'s own activation entries survive the merge', async () => {
  const f = mkMuse({
    roster: MUSE_ROSTER,
    settings: '{"schema_version":1,"provider":"meta","skills":{"activation":{"bundled":{"bundled://muse-core/skills/plan/SKILL.md":"user-invocable-only"}}}}\n',
  });
  await f.create('seat', { disabledSkills: ['*'], injectSkills: ['foo'] });
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    assert.deepStrictEqual(JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8')), {
      schema_version: 1,
      provider: 'meta',
      permissions: {
        schema_version: 1,
        profiles: { reviewer: { extends: ':read-only', approval: 'allow_all', reviewer: 'none', network: { mode: 'enabled' } } },
      },
      run: {
        workflow_trigger_mode: 'off',
        reminder_roster: { agents: [] },
        context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
      },
      skills: {
        activation: {
          bundled: {
            'bundled://muse-core/skills/plan/SKILL.md': 'user-invocable-only',
            'bundled://muse-core/skills/git/SKILL.md': 'off',
            'bundled://muse-core/skills/workflow-authoring/SKILL.md': 'off',
          },
          plugin: { 'plugin://threejs/skills/threejs/SKILL.md': 'off' },
        },
      },
    });
  } finally { await f.stop('seat'); }
});

test('t1090: disabledSkills [] writes no skills key at all, and never asks for the roster', async () => {
  const f = mkMuse({ roster: MUSE_ROSTER });
  await f.create('seat', { disabledSkills: [] });
  try {
    const seatDir = pathForReal(f.root, 'seat', 'seatConfig');
    const parsed = JSON.parse(fsReal.readFileSync(pathReal.join(seatDir, 'muse', 'settings.json'), 'utf-8'));
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['permissions', 'provider', 'run', 'schema_version']);
    assert.deepStrictEqual(f.rosterCalls, []);
  } finally { await f.stop('seat'); }
});
