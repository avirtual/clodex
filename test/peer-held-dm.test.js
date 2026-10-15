'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mk } = require('./lib/session-fixtures');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ORIGIN = 'team-clodex';

function rig({ online = false, caps = ['dm'] } = {}) {
  const peer = { id: 'p1', label: ORIGIN, online, caps };
  const sent = [];
  const conn = { dm: (msg, cb) => { sent.push(msg); cb({ ok: true, delivered: true }); } };
  const pm = { statuses: () => [peer], get: (id) => (id === 'p1' ? conn : null) };
  const m = mk({ AGENT_NAME_RE: NAME_RE, getPeerManager: () => pm, getRemoteServer: () => null });
  const injected = [];
  m._injectText = (s, text) => injected.push([s.name, text]);
  m._broadcast = () => {};
  m.sessions.set('a', { name: 'a', agentType: 'claude', workspaceId: 'ws1' });
  const dm = (body) => m._handleIntent('a', { type: 'dm', target: `clodex@${ORIGIN}`, body });
  return { m, peer, sent, conn, pm, injected, dm };
}

function wireOnline(m, pm) {
  const { createPeerWiring } = require('../peer-wiring');
  let manager = null;
  const store = { peers: [], peerAttached: {}, peerControlled: {}, peerVisible: {} };
  const wiring = createPeerWiring({
    manager: m,
    log: { info() {}, error() {} },
    SELF_LABEL: 'laptop',
    scheduleAppMenuRefresh: () => {},
    getUiSettings: () => ({ get: () => store, set: (p) => Object.assign(store, p) }),
    getPeerManager: () => manager, setPeerManager: (v) => { manager = v; },
    getTunnelManager: () => ({ sync() {}, urlFor: () => null, statuses: () => [] }),
    setTunnelManager: () => {},
    getWebTunnelManager: () => ({ sync() {}, statuses: () => [] }),
    setWebTunnelManager: () => {},
  });
  wiring.syncPeerManager();
  return (id, status) => manager._emit('peer-state', id, status);
}

test('an offline dm-cap peer holds the dm, then the online peer-state flushes it once', async (t) => {
  const r = rig();
  t.after(() => { if (r.m._peerHeldSweep) clearInterval(r.m._peerHeldSweep); });
  await r.dm('hello box');

  const held = r.m._peerHeld.get('p1');
  assert.strictEqual(held.length, 1);
  assert.deepStrictEqual(
    { to: held[0].to, from: held[0].from, body: held[0].body, target: held[0].target, sessionName: held[0].sessionName },
    { to: 'clodex', from: 'a', body: 'hello box', target: `clodex@${ORIGIN}`, sessionName: 'a' });
  assert.strictEqual(r.injected.length, 1);
  assert.match(r.injected[0][1], /peer 'team-clodex' is offline — held; sent when it reconnects/);
  assert.doesNotMatch(r.injected[0][1], /try again/);
  assert.deepStrictEqual(r.sent, []);

  r.peer.online = true;
  const emit = wireOnline(r.m, r.pm);
  emit('p1', { id: 'p1', label: ORIGIN, online: true });
  assert.deepStrictEqual(r.sent, [{ to: 'clodex', from: 'a', body: 'hello box', urgent: false }]);
  assert.strictEqual(r.m._peerHeld.has('p1'), false);
  assert.strictEqual(r.m._peerHeldSweep, null);
  emit('p1', { id: 'p1', label: ORIGIN, online: true });
  assert.strictEqual(r.sent.length, 1, 'a second online event resends nothing');
});

test('an offline peer whose caps lack dm still bounces "predates dm federation"', async () => {
  const r = rig({ caps: ['tickets'] });
  await r.dm('x');
  assert.strictEqual(r.m._peerHeld.has('p1'), false);
  assert.strictEqual(r.injected.length, 1);
  assert.match(r.injected[0][1], /predates dm federation/);
});

test('the 21st held dm bounces "held queue is full" and is not queued', async (t) => {
  const r = rig({ caps: [] });
  t.after(() => { if (r.m._peerHeldSweep) clearInterval(r.m._peerHeldSweep); });
  for (let i = 0; i < 21; i += 1) await r.dm(`m${i}`);
  assert.strictEqual(r.m._peerHeld.get('p1').length, 20);
  assert.match(r.injected[20][1], /peer 'team-clodex' is offline and its held queue is full \(20\) — not queued\./);
});

test('a held dm older than 10 min at flush is dropped with "stayed offline" and not sent', async (t) => {
  const r = rig();
  t.after(() => { if (r.m._peerHeldSweep) clearInterval(r.m._peerHeldSweep); });
  await r.dm('old');
  await r.dm('fresh');
  r.m._peerHeld.get('p1')[0].ts = Date.now() - 10 * 60 * 1000 - 1;
  r.injected.length = 0;
  r.peer.online = true;
  r.m._flushPeerHeld('p1');
  assert.deepStrictEqual(r.sent.map((x) => x.body), ['fresh']);
  assert.deepStrictEqual(r.injected,
    [['a', `[agent:dm] NOT delivered to clodex@${ORIGIN}: peer '${ORIGIN}' stayed offline 10 min.`]]);
  assert.strictEqual(r.m._peerHeld.has('p1'), false);
});
