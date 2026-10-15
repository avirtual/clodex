'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');
const { enqueueOutbox } = require('../peer-outbox');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function captureDeliverDm(manager) {
  const { createRemoteWiring } = require('../remote-wiring');
  let srv = null;
  const deps = {
    path, fs, os: require('node:os'),
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'box',
    parseCtxFile: () => null, cachedMessages: () => [], sliceSince: () => ({ messages: [] }),
    ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: () => { throw new Error('no teams here'); },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash', 'Read'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getNotifications: () => null,
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; },
    setRemoteError: () => {}, getDrawerPtys: () => null,
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
    getWebInfo: () => null, getWirescopeInfo: () => null,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(deps).syncRemoteServer(); } finally { remoteMod.RemoteServer = orig; }
  return opts.deliverDm;
}

function post(server, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: server.port, path: '/api/dm', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

test('t1829 POST /api/dm dedupes a repeated ref per origin+from, echoes it, and 400s a bad one', async () => {
  const m = mk();
  const delivered = [];
  m._gatedDeliver = (to, from, body) => { delivered.push({ to, from, body }); return { queued: true }; };
  m._broadcast = () => {};
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    deliverDm: captureDeliverDm(m),
  });
  await server.start();
  try {
    const msg = { to: 'alpha', from: 'bob', origin: 'laptop', body: 'hi', ref: 'r1' };
    const first = await post(server, msg);
    assert.deepStrictEqual(first, { status: 200, json: { ok: true, delivered: true, ref: 'r1' } });
    const again = await post(server, msg);
    assert.deepStrictEqual(again, { status: 200, json: { ok: true, delivered: true, duplicate: true, ref: 'r1' } });
    assert.strictEqual(delivered.length, 1, 'a repeated ref is not redelivered');

    await post(server, { ...msg, ref: 'r2' });
    await post(server, { ...msg, from: 'carol' });
    assert.strictEqual(delivered.length, 3, 'a different ref, or the same ref from another sender, is delivered');

    const bad = await post(server, { ...msg, ref: 'a/b' });
    assert.deepStrictEqual(bad, { status: 400, json: { ok: false, error: 'bad ref' } });
    const plain = await post(server, { to: 'alpha', from: 'bob', origin: 'laptop', body: 'hi' });
    assert.deepStrictEqual(plain.json, { ok: true, delivered: true });
    assert.strictEqual(delivered.length, 4);
  } finally { server.stop(); }
});

test('t1829 a repeated ref older than 10 min is delivered again', () => {
  const m = mk();
  let n = 0;
  m._gatedDeliver = () => { n += 1; return { queued: true }; };
  m._broadcast = () => {};
  const deliverDm = captureDeliverDm(m);
  const msg = { to: 'alpha', from: 'bob', origin: 'laptop', body: 'hi', ref: 'r1' };
  deliverDm(msg);
  m._dmRefSeen.get('laptop\nbob\nr1').at -= 10 * 60 * 1000;
  deliverDm(msg);
  assert.strictEqual(n, 2);
});

test('t1829 _deliverClaimedDms delivers two claimed records sharing a ref once', () => {
  const m = mk({ getPeerManager: () => ({ statuses: () => [{ id: 'p1', label: 'hub' }] }) });
  m.sessions.set('alpha', { name: 'alpha', agentType: 'claude' });
  const calls = [];
  m._gatedDeliver = (...a) => { calls.push(a); return { queued: true }; };
  m._broadcast = () => {};
  const rec = { from: 'bob', to: 'alpha', body: 'hi', urgent: false, ref: 'r7' };
  m._deliverClaimedDms('p1', [rec, { ...rec }, { ...rec, ref: undefined }, { ...rec, ref: undefined }]);
  assert.strictEqual(calls.length, 3, 'the shared ref is delivered once; ref-less records are never deduped');
});

test('t1829 enqueueOutbox without a ref writes no ref key; with one it carries it', () => {
  const root = mkTmpRoot('clodex-dm-ref-');
  const a = enqueueOutbox(root, 'laptop', { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5 }, '1');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(a.file, 'utf8')), { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5 });
  const b = enqueueOutbox(root, 'laptop', { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5, ref: 'r1' }, '2');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.file, 'utf8')), { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5, ref: 'r1' });
});
