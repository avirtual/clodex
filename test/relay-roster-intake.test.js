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

const { mkTmpRoot } = require('./lib/tmp-roots');
const { enqueueOutbox, claimOutbox, markOutboxOrigin } = require('../peer-outbox');

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

test('the who-list prints the hub\'s own rows BARE and a third-box row with its via', async () => {
  const injected = [];
  const m = mk({
    AGENT_NAME_RE: NAME_RE,
    registry: { listPeers: () => [] },
    peerStatusLabel: () => 'idle',
    getPeerManager: () => ({ statuses: () => [] }),
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  // ENTER: one roster carrying BOTH shapes. A fixture with only the third-box row
  // renders identically before and after the fix, so the hub-local row is the
  // whole proof; one assertion over the whole line keeps the two from drifting.
  m._setRelayRoster(HUB, [
    { name: 'clodex', origin: HUB, type: 'claude' },
    { name: 'worker', origin: 'remote-linux', type: 'claude' },
  ]);

  await m._handleIntent('a', { type: 'who' });

  assert.strictEqual(injected.length, 1);
  assert.strictEqual(
    injected[0],
    `[agent:peers] clodex@${HUB}, worker@remote-linux (via ${HUB})`,
    'a hub-local row is reached over the outbox, not a relay hop — the suffix would state a hop that does not exist',
  );
});

test('_rememberDmOrigin writes the marker once per process, and a fresh process writes it again', () => {
  const outboxDir = mkTmpRoot('clodex-t911-mark-');
  const marks = [];
  const counting = (root, origin) => { marks.push(origin); return markOutboxOrigin(root, origin); };
  const mkMarker = () => mk({ OUTBOX_DIR: outboxDir, markOutboxOrigin: counting });

  const m = mkMarker();
  m._rememberDmOrigin(HUB);
  m._rememberDmOrigin(HUB);
  assert.deepStrictEqual(marks, [HUB],
    'receiveRoster calls this every 15s hello tick; the in-memory Set is what stops a mkdir+write per tick');

  // ENTER: the guard must sit BEFORE the Set add and must read the Set, never the
  // disk. Moving it onto outboxKnowsOrigin would pass the half above and make this
  // half zero — a fresh process would never write the marker it restarts without.
  const restarted = mkMarker();
  assert.strictEqual(restarted._knownDmOrigins.has(HUB), false, 'the Set died with the process');
  restarted._rememberDmOrigin(HUB);
  assert.deepStrictEqual(marks, [HUB, HUB], 'first call after a boot still writes');
});

test('_routeFederatedDm sends an origin that is both a known dm origin and relay-reachable out the OUTBOX, not the relay', async () => {
  const outboxDir = mkTmpRoot('clodex-t911-route-');
  const injected = [];
  const m = mk({
    AGENT_NAME_RE: NAME_RE,
    OUTBOX_DIR: outboxDir,
    SELF_LABEL: 'spoke',
    enqueueOutbox,
    getPeerManager: () => ({ statuses: () => [] }),
    getRemoteServer: () => null,
  });
  m._injectText = (_s, text) => injected.push(text);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });

  m._rememberDmOrigin(HUB);
  m._setRelayRoster(HUB, [{ name: 'clodex', origin: HUB, type: 'claude' }]);
  m._setRelayRoster('other-hub', [{ name: 'clodex', origin: HUB, type: 'claude' }]);

  // ENTER: the precondition is built from two INDEPENDENT pieces of state, and the
  // branch race only exists while both hold. The second roster is what makes the
  // relay branch live for HUB at all (the first is refused by the via === origin
  // guard), so without this line the absence below is vacuous and a reordering of
  // the two branches goes unnoticed.
  assert.strictEqual(m._relayViaForOrigin(HUB), 'other-hub', 'the relay branch is reachable for HUB');
  assert.strictEqual(m._knownDmOrigins.has(HUB), true, 'and so is the outbox branch');

  await m._handleIntent('a', { type: 'dm', target: `clodex@${HUB}`, body: 'hi' });

  const mine = claimOutbox(outboxDir, HUB);
  assert.strictEqual(mine.length, 1, `expected one queued dm for ${HUB}, got ${JSON.stringify(mine)}`);
  assert.deepStrictEqual(
    { from: mine[0].from, to: mine[0].to, body: mine[0].body, finalTarget: mine[0].finalTarget },
    { from: 'a', to: 'clodex', body: 'hi', finalTarget: undefined },
    'a plain direct dm — no finalTarget, so the hub delivers it locally instead of trying to relay to itself',
  );
  assert.deepStrictEqual(claimOutbox(outboxDir, 'other-hub'), [],
    'nothing went to the third box, which would resolve findPeerByOrigin for HUB against the hub itself and drop it');
  assert.deepStrictEqual(injected, [],
    'no bounce and no "relayed via" notice — the outbox branch delivers silently');
});
