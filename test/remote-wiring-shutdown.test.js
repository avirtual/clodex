'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRemoteWiring } = require('../remote-wiring');
const { mkTmpRoot } = require('./lib/tmp-roots');

function fixture() {
  const tmp = mkTmpRoot('remote-wiring-shutdown-');
  let srv = null;
  const infos = [];
  const deps = {
    path, fs, os,
    log: { info: (tag, msg) => { infos.push(msg); }, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: tmp, OUTBOX_DIR: path.join(tmp, 'outbox'), SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map(), windowForWorkspace: () => null, _broadcast() {} },
    proxyPoller: { snapshot: () => null },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0, peerShellEnabled: false, peers: [] }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getDrawerPtys: () => null,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };

  const starts = [];
  let constructed = 0;
  let stops = 0;
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  remoteMod.RemoteServer = function () {
    constructed++;
    let stopped = false;
    const fake = {
      running: false,
      start() {
        let resolve;
        const p = new Promise((r) => { resolve = r; });
        starts.push(() => { fake.running = !stopped; resolve(); });
        return p;
      },
      stop() { stops++; stopped = true; fake.running = false; },
      port: 0, basePath: '', notifySessions() {}, setWtermCallbacks() {},
    };
    return fake;
  };
  const wiring = createRemoteWiring(deps);
  return {
    wiring,
    starts,
    constructed: () => constructed,
    stops: () => stops,
    server: () => srv,
    servingLines: () => infos.filter((m) => /serving on/.test(m)),
    restore() {
      remoteMod.RemoteServer = orig;
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('an engine shutdown during a pending start with a queued resync does not rebuild the server', async () => {
  const f = fixture();
  try {
    f.wiring.syncRemoteServer();
    assert.strictEqual(f.constructed(), 1);
    f.wiring.syncRemoteServer();
    assert.strictEqual(f.constructed(), 1, 'the second sync queued behind the pending start');

    f.wiring.shutdownRemoteServer();
    assert.strictEqual(f.stops(), 1);
    assert.strictEqual(f.server(), null);

    f.starts[0]();
    await settle();
    assert.strictEqual(f.constructed(), 1, 'no RemoteServer was built after shutdown');
    assert.strictEqual(f.stops(), 1, 'stop ran once');
    assert.strictEqual(f.server(), null);
  } finally { f.restore(); }
});

test('a sync or token refresh arriving after shutdown builds nothing, pending start or not', async () => {
  const f = fixture();
  try {
    f.wiring.syncRemoteServer();
    f.wiring.shutdownRemoteServer();
    f.wiring.syncRemoteServer();
    f.wiring.refreshRemoteToken();

    f.starts[0]();
    await settle();
    assert.strictEqual(f.constructed(), 1, 'the queued late callers did not rebuild at settle');

    f.wiring.syncRemoteServer();
    f.wiring.refreshRemoteToken();
    assert.strictEqual(f.constructed(), 1, 'nor did callers after the start settled');
    assert.strictEqual(f.stops(), 1);
    assert.strictEqual(f.server(), null);
  } finally { f.restore(); }
});

test('a start stopped before it resolved logs no serving-on line; a start that completes logs one', async () => {
  const f = fixture();
  try {
    f.wiring.syncRemoteServer();
    f.wiring.shutdownRemoteServer();
    f.starts[0]();
    await settle();
    assert.deepStrictEqual(f.servingLines(), []);
  } finally { f.restore(); }

  const g = fixture();
  try {
    g.wiring.syncRemoteServer();
    g.starts[0]();
    await settle();
    assert.strictEqual(g.servingLines().length, 1);
  } finally { g.restore(); }
});
