'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');
const HUB = 'hub-label';

async function withServer(receiveRoster, fn) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    receiveRoster,
  });
  await server.start();
  try { return await fn(server); } finally { server.stop(); }
}

function post(server, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: server.port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

const PUSH = {
  rv: 1,
  via: HUB,
  roster: [
    { name: 'clodex', origin: HUB, type: 'claude' },
    { name: 'Codex', origin: HUB, type: 'codex' },
    { name: 'worker', origin: 'remote-linux', type: 'claude' },
  ],
};

test('POST /api/peer/roster KEEPS the hub\'s own rows (origin === via) and caches them', async () => {
  const seen = [];
  await withServer((arg) => seen.push(arg), async (server) => {
    const { status, json } = await post(server, '/api/peer/roster', PUSH);
    assert.strictEqual(status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].via, HUB);
    assert.deepStrictEqual(seen[0].roster, [
      { name: 'clodex', origin: HUB, type: 'claude' },
      { name: 'Codex', origin: HUB, type: 'codex' },
      { name: 'worker', origin: 'remote-linux', type: 'claude' },
    ], 'the hub\'s own agents survive intake — dropping them made the feature a no-op on the wire');
  });
});

test('POST /api/peer/roster still sanitizes name and origin charset on local rows', async () => {
  const seen = [];
  await withServer((arg) => seen.push(arg), async (server) => {
    await post(server, '/api/peer/roster', {
      rv: 1,
      via: HUB,
      roster: [
        { name: 'bad name', origin: HUB, type: 'claude' },
        { name: 'ok', origin: 'bad origin', type: 'claude' },
        { name: '..', origin: HUB, type: 'claude' },
        { name: 'good', origin: HUB, type: 'claude' },
      ],
    });
    assert.deepStrictEqual(seen[0].roster, [{ name: 'good', origin: HUB, type: 'claude' }],
      'keeping origin === via must not relax the charset gate — these become dm targets');
  });
});

const { RELAY_ROSTER_TTL_MS } = require('../relay-protocol');
const { mk } = require('./lib/session-fixtures');

function withRoster(roster, at = Date.now()) {
  const m = mk();
  m._setRelayRoster(HUB, roster);
  m._relayRosters.get(HUB).at = at;
  return m;
}

test('_relayViaForOrigin REFUSES the hub\'s own origin — those rows are never relay-routable', () => {
  const m = withRoster([
    { name: 'clodex', origin: HUB, type: 'claude' },
    { name: 'worker', origin: 'remote-linux', type: 'claude' },
  ]);
  assert.strictEqual(m._relayViaForOrigin(HUB), null,
    'a relay envelope back to the hub resolves findPeerByOrigin against the hub itself and is dropped');
  assert.strictEqual(m._relayViaForOrigin('remote-linux'), HUB,
    'a genuine third-party origin still relays via the hub');
});

test('the hub\'s own rows still render in the who-list', () => {
  const m = withRoster([{ name: 'clodex', origin: HUB, type: 'claude' }]);
  assert.deepStrictEqual(m._relayRosterEntries(),
    [{ name: 'clodex', origin: HUB, via: HUB, type: 'claude' }],
    'refusing to RELAY these rows must not hide them — naming them is the ticket');
});

test('an expired roster stops advertising the hub\'s own agents too', () => {
  const m = withRoster([{ name: 'clodex', origin: HUB, type: 'claude' }],
    Date.now() - RELAY_ROSTER_TTL_MS - 1);
  assert.deepStrictEqual(m._relayRosterEntries(), []);
  assert.strictEqual(m._relayViaForOrigin(HUB), null);
});

function captureReceiveRoster(manager) {
  const { createRemoteWiring } = require('../remote-wiring');
  let srv = null;
  const deps = {
    path, fs: require('node:fs'), os: require('node:os'),
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: '/tmp/reg', OUTBOX_DIR: '/tmp/outbox', SELF_LABEL: 'spoke',
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
  return opts.receiveRoster;
}

test('receiveRoster marks via as a dm origin, putting the outbox branch ahead of the relay branch', () => {
  const m = mk();
  const remembered = [];
  m._rememberDmOrigin = (o) => remembered.push(o);
  const receiveRoster = captureReceiveRoster(m);

  receiveRoster({ via: HUB, roster: [{ name: 'worker', origin: 'remote-linux', type: 'claude' }] });
  assert.deepStrictEqual(remembered, [],
    'a roster of third-party agents only says nothing about dm-ing the hub itself');

  receiveRoster({ via: HUB, roster: [{ name: 'clodex', origin: HUB, type: 'claude' }] });
  assert.deepStrictEqual(remembered, [HUB],
    'once the hub advertises its OWN agents, the outbox route to it is the live one');
  assert.strictEqual(m._relayViaForOrigin(HUB), null,
    'and that origin is still refused the relay path, so the dm cannot take the dropping route');
});
