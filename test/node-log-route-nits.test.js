'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createEngine } = require('../engine');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer, readLogTail, NODE_LOG_MAX_LINES } = require('../remote');
const { mkTmpRoot } = require('./lib/tmp-roots');

const NUL = String.fromCharCode(0);

function req(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function seedLog(count) {
  const dir = mkTmpRoot('t959-nodelog-');
  const file = path.join(dir, 'clodex.log');
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`2026-09-17T00:00:00.000Z  INFO  [app] line ${i}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { file, lines };
}

async function withRoute(nodeLogFile, fn) {
  const s = new RemoteServer({ nodeLogFile, host: '127.0.0.1', port: 0 });
  await s.start();
  try { return await fn(s.port); } finally { s.stop(); }
}

test('P4a ?limit=-1 and ?limit=0 return at most the cap, never the whole window', async () => {
  const { file } = seedLog(NODE_LOG_MAX_LINES + 20);
  await withRoute(() => file, async (port) => {
    for (const q of ['-1', '0']) {
      const body = JSON.parse((await req(port, `/api/node/logs?limit=${q}`)).body);
      assert.strictEqual(body.ok, true, `limit=${q} is answered, not an error`);
      assert.ok(body.lines.length >= 1,
        `limit=${q} must still be a page — a clamp to zero would make the route useless`);
      assert.ok(body.lines.length <= NODE_LOG_MAX_LINES,
        `limit=${q} handed back ${body.lines.length} lines — the cap is ${NODE_LOG_MAX_LINES}`);
    }
    const ok = JSON.parse((await req(port, '/api/node/logs?limit=3')).body);
    assert.strictEqual(ok.lines.length, 3, 'ENTER: an ordinary limit is still honoured exactly');
  });
});

test('P4b a read shorter than the stat size yields no NUL bytes in any line', () => {
  const survivors = Buffer.from('2026-09-17T00:00:02.000Z  INFO  [app] after rotation\n', 'utf8');
  const claimedSize = survivors.length + 4096;
  const io = {
    statSync: () => ({ size: claimedSize }),
    openSync: () => 7,
    closeSync: () => {},
    readSync: (fd, buf) => { survivors.copy(buf); return survivors.length; },
  };
  const lines = readLogTail(io, '/nowhere/clodex.log', 100);
  assert.deepStrictEqual(lines, ['2026-09-17T00:00:02.000Z  INFO  [app] after rotation'],
    'only the bytes readSync actually delivered become lines');
  for (const l of lines) {
    assert.ok(!l.includes(NUL), `a NUL reached the wire in ${JSON.stringify(l)}`);
  }
});

test('P4b ENTER: the same double with a FULL read still returns the line', () => {
  const buf = Buffer.from('2026-09-17T00:00:02.000Z  INFO  [app] intact\n', 'utf8');
  const io = {
    statSync: () => ({ size: buf.length }),
    openSync: () => 7,
    closeSync: () => {},
    readSync: (fd, b) => { buf.copy(b); return buf.length; },
  };
  assert.deepStrictEqual(readLogTail(io, '/nowhere/clodex.log', 100),
    ['2026-09-17T00:00:02.000Z  INFO  [app] intact'],
    'the slice must not truncate an honest read');
});

function wiringDeps(getNodeLogFile) {
  let srv = null;
  return {
    path, fs, os,
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map(), create: async () => ({}) },
    proxyPoller: { snapshot: () => null },
    gitWorktree: { listWorktrees: async () => ({ ok: true, repo: '/repo', worktrees: [] }) },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined, setStripLevel: () => {} }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
    getNodeLogFile,
  };
}

function captureOptions(getNodeLogFile) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(wiringDeps(getNodeLogFile)).syncRemoteServer(); }
  finally { remoteMod.RemoteServer = orig; }
  assert.ok(opts, 'ENTER: the wire was constructed');
  return opts;
}

function mkEngine(seams) {
  const tmp = mkTmpRoot('t959-eng-');
  return createEngine({
    userDataPath: tmp,
    seams: { registryDir: path.join(tmp, 'clodex-home'), ...seams },
    log: { info() {}, warn() {}, error() {} },
  });
}

function engineRemoteOptions(seams) {
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  const hadEnv = process.env.CLODEX_REMOTE_ENABLE;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  process.env.CLODEX_REMOTE_ENABLE = '1';
  try { mkEngine(seams).syncRemoteServer(); }
  finally {
    remoteMod.RemoteServer = orig;
    if (hadEnv === undefined) delete process.env.CLODEX_REMOTE_ENABLE;
    else process.env.CLODEX_REMOTE_ENABLE = hadEnv;
  }
  assert.ok(opts, 'ENTER: the peer wire was constructed');
  return opts;
}

test('P5 an engine built with no seams.logFile gives the wire no nodeLogFile', () => {
  assert.strictEqual(engineRemoteOptions({}).nodeLogFile, null,
    'a getter that exists and returns null still reads as "this host has a log path" at every gate downstream');
  const opts = engineRemoteOptions({ logFile: '/tmp/some-clodex.log' });
  assert.strictEqual(typeof opts.nodeLogFile, 'function', 'ENTER: a host that HAS one still reaches the wire');
  assert.strictEqual(opts.nodeLogFile(), '/tmp/some-clodex.log');
});

test('P5 no getNodeLogFile ⇒ remote-wiring passes no nodeLogFile', () => {
  assert.strictEqual(captureOptions(undefined).nodeLogFile, null,
    'the wiring must not mint a callable around an absent getter');
  const opts = captureOptions(() => '/tmp/some-clodex.log');
  assert.strictEqual(typeof opts.nodeLogFile, 'function', 'ENTER: with the getter, the callable is threaded');
  assert.strictEqual(opts.nodeLogFile(), '/tmp/some-clodex.log');
});

test('P5 the route answers 501 and node/logs is absent from /api/resources', async () => {
  await withRoute(captureOptions(undefined).nodeLogFile, async (port) => {
    const r = await req(port, '/api/node/logs');
    assert.strictEqual(r.status, 501, 'a host with no log path refuses rather than guessing ~/.clodex');
    assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'node logs not available' });
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map((x) => x.name);
    assert.ok(!names.includes('node/logs'), 'and it drops out of the catalog, so the CLI says upgrade');
  });
  const { file } = seedLog(2);
  await withRoute(captureOptions(() => file).nodeLogFile, async (port) => {
    assert.strictEqual((await req(port, '/api/node/logs')).status, 200, 'ENTER: the wired host still serves');
    const names = JSON.parse((await req(port, '/api/resources')).body).resources.map((x) => x.name);
    assert.ok(names.includes('node/logs'), 'and advertises the resource');
  });
});

after(() => { setImmediate(() => process.exit(0)); });
