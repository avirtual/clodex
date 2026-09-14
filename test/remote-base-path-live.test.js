'use strict';
// Run: node --test test/remote-base-path-live.test.js
//
// t912 — the mount prefix has to reach the SERVING process, not just the
// settings file. t901 wired it into the RemoteServer constructor; what nothing
// covered was a change on a box already serving. `syncRemoteServer` decided
// whether to bounce the wire by comparing the PORT alone, so a saved prefix was
// written to disk and never served — no error, no indication, and the file
// disagreeing with the process until the next launch.
//
// ENTER: these drive the real store, the real `syncRemoteServer` and a real
// bound socket — no RemoteServer double. A double would pin that the wiring
// CALLS something; the failure was a live server still answering on the old
// prefix, and only a socket can see that.
//
// ENTER: both halves are asserted on every move. "The new prefix answers" alone
// passes against a server that never restarted whenever the new prefix equals
// the old one, and the absence alone passes on a server that simply died.

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRemoteWiring } = require('../remote-wiring');
const { initStores } = require('../stores');
const { mkTmpRoot } = require('./lib/tmp-roots');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function req(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
}

// syncRemoteServer's start() is fire-and-forget, so the socket is not bound the
// instant it returns. Poll the prefix that is supposed to answer rather than
// sleeping a guessed interval.
async function serving(port, pathname) {
  for (let i = 0; i < 200; i += 1) {
    try { if (await req(port, pathname) === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function mkWiring(uiSettings, info = () => {}) {
  let srv = null;
  const errors = [];
  const seen = new Set();
  const wiring = createRemoteWiring({
    path, fs, os,
    log: { info: (...a) => info(...a), error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'testbox',
    parseCtxFile: () => null, jsonlToMessages: () => [], ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager: { sessions: new Map(), create: async () => ({}) },
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
    getPersistence: () => ({ get: () => undefined, setStripLevel: () => {} }),
    getUiSettings: () => uiSettings,
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; if (v) seen.add(v); },
    setRemoteError: (e) => { if (e != null) errors.push(e); },
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  });
  // `stop` belongs in a finally: a failing subject otherwise leaves the bound
  // socket holding the event loop open and the runner hangs after reporting.
  // Measured while red-proofing this file — the process had to be killed.
  return {
    sync: () => wiring.syncRemoteServer(),
    server: () => srv,
    errors: () => errors,
    stop: () => { for (const s of seen) { try { s.stop(); } catch {} } },
  };
}

function mkStores() {
  const dir = mkTmpRoot('t912-live-');
  const had = process.env.CLODEX_REMOTE_BASE_PATH;
  delete process.env.CLODEX_REMOTE_BASE_PATH;
  after(() => {
    if (had === undefined) delete process.env.CLODEX_REMOTE_BASE_PATH;
    else process.env.CLODEX_REMOTE_BASE_PATH = had;
  });
  return initStores(dir, {
    log: { info() {}, error() {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  }).uiSettings;
}

test('a saved mount path takes effect on a RUNNING wire: the old prefix stops, the new one starts', async () => {
  const uiSettings = mkStores();
  const port = await freePort();
  uiSettings.set({ remoteEnabled: true, remotePort: port, remoteBasePath: '/c' });
  const { sync, stop } = mkWiring(uiSettings);
  try {
    sync();
    assert.ok(await serving(port, '/c/api/sessions'), 'ENTER: the wire came up serving /c');
    assert.equal(await req(port, '/i/phone/api/sessions'), 404,
      'ENTER: and /i/phone is not already answering, so the move below proves something');

    // The real operator action: Preferences writes the setting through the
    // store, then the ipc handler re-syncs. Nothing else changes — same port,
    // same box.
    uiSettings.set({ remoteBasePath: '/i/phone' });
    sync();
    assert.ok(await serving(port, '/i/phone/api/sessions'),
      'the new prefix is being SERVED, not merely written to the settings file');
    assert.equal(await req(port, '/c/api/sessions'), 404,
      'and the old prefix stopped — the server really restarted rather than gaining a second mount');
  } finally { stop(); }
});

test('a change that resolves to the SAME prefix does not bounce the wire', async () => {
  // A restart drops every SSE client on the box, so re-saving a prefix that is
  // already being served must not cost a phone its stream. The store coerces
  // before the wiring sees it, so this does NOT reach the resolver comparison
  // at remote-wiring.js — an unresolved spelling can only arrive there through
  // a getUiSettings stub returning the raw value, which nothing does yet.
  const uiSettings = mkStores();
  const port = await freePort();
  uiSettings.set({ remoteEnabled: true, remotePort: port, remoteBasePath: '/c' });
  const { sync, server, stop } = mkWiring(uiSettings);
  try {
    sync();
    assert.ok(await serving(port, '/c/api/sessions'), 'ENTER: serving /c');
    const before = server();

    uiSettings.set({ remoteBasePath: 'c/' });
    sync();
    assert.strictEqual(server(), before, 'same RemoteServer instance — nothing was stopped and rebuilt');
    assert.equal(await req(port, '/c/api/sessions'), 200, 'and it is still answering');
  } finally { stop(); }
});

test('the boot log names the prefix being served, once per start', async () => {
  // The operator whose route 404s reads the log, so the answer has to be in it:
  // before this nothing in the app mentioned the prefix at all, and the only
  // recovery was guessing at an environment variable.
  const uiSettings = mkStores();
  const port = await freePort();
  uiSettings.set({ remoteEnabled: true, remotePort: port, remoteBasePath: '/c' });
  const rows = [];
  const { sync, stop } = mkWiring(uiSettings, (tag, body) => rows.push([tag, body]));
  try {
    sync();
    assert.ok(await serving(port, '/c/api/sessions'), 'ENTER: serving /c');
    const said = rows.filter(([tag, body]) => tag === 'remote' && /serving on/.test(body));
    assert.equal(said.length, 1, 'one line per start');
    assert.match(said[0][1], /\/c/, 'and it names the prefix');
    assert.match(said[0][1], new RegExp(String(port)), 'alongside the port it is presumably read with');

    // A sync that changes nothing must not re-log: syncRemoteServer runs on
    // every settings write on the box, and a line per write is a line the
    // operator stops reading.
    sync();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rows.filter(([t, b]) => t === 'remote' && /serving on/.test(b)).length, 1,
      'a no-op sync is silent — the server did not restart, so nothing started');
  } finally { stop(); }
});

test('a box with no prefix says so rather than printing a bare port', async () => {
  const uiSettings = mkStores();
  const port = await freePort();
  uiSettings.set({ remoteEnabled: true, remotePort: port, remoteBasePath: '' });
  const rows = [];
  const { sync, stop } = mkWiring(uiSettings, (tag, body) => rows.push([tag, body]));
  try {
    sync();
    assert.ok(await serving(port, '/api/sessions'), 'ENTER: serving at the root');
    const said = rows.find(([t, b]) => t === 'remote' && /serving on/.test(b));
    assert.ok(said, 'the line is emitted for an unprefixed box too');
    assert.match(said[1], /no prefix/,
      '"no prefix" is the answer to the operator question, and silence is not one');
  } finally { stop(); }
});

test('a throwing boot log does not null a server whose socket is still listening', async () => {
  // The `.catch` behind that log is the BIND failure handler: it records a
  // remote error and drops the server. A throw from the injected `log.info`
  // reached it too, so the next sync built a second server on the same port and
  // got EADDRINUSE — from a logging fault, on a wire that was serving fine.
  const uiSettings = mkStores();
  const port = await freePort();
  uiSettings.set({ remoteEnabled: true, remotePort: port, remoteBasePath: '/c' });
  const w = mkWiring(uiSettings, (tag, body) => {
    if (tag === 'remote' && /serving on/.test(body)) throw new Error('log sink is down');
  });
  try {
    w.sync();
    assert.ok(await serving(port, '/c/api/sessions'),
      'ENTER: the socket is bound and answering — start() resolved, only the log threw');
    assert.ok(w.server(), 'the server is still held, not nulled underneath its own live socket');
    assert.deepStrictEqual(w.errors(), [],
      'and no remote error was recorded — a log sink is not a bind failure');

    const before = w.server();
    w.sync();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(w.server(), before,
      'so the next sync reuses it rather than racing a second bind on the same port');
    assert.equal(await req(port, '/c/api/sessions'), 200, 'and the wire is still up');
  } finally { w.stop(); }
});

test('the wire exposes its served base path read-only, like its port', () => {
  const { RemoteServer } = require('../remote');
  const srv = new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    basePath: 'i/phone/',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
  });
  assert.equal(srv.basePath, '/i/phone',
    'the getter reports the RESOLVED prefix, which is what a comparison must be made against');
  assert.equal(new RemoteServer({
    port: 0, pagePath: '/nonexistent',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
  }).basePath, '', 'and an unset prefix reads as the empty string, not undefined');
});
