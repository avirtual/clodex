'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mk } = require('./lib/session-fixtures');

const PUBLISHED_REPLY = 'port 18080 → localhost:18080 (http, published)';

function relayRig({ relay = true, boxes = ['team-x'] } = {}) {
  const wire = [];
  const conn = { dm: (msg, cb) => { wire.push(msg); cb({ ok: true, delivered: true }); } };
  const pm = {
    statuses: () => [{ id: 'team-x', label: 'team-x', online: true, caps: ['dm'] }, { id: 'stranger', label: 'stranger', online: true, caps: ['dm'] }],
    get: () => conn,
  };
  const calls = { setConfig: [] };
  const config = { relay, ports: [] };
  const box = {
    getConfig: () => ({ ...config }),
    setConfig(partial, opts) {
      calls.setConfig.push([partial, opts]);
      Object.assign(config, partial);
      return { ...config };
    },
    portsState: () => ({ ports: config.ports, applied: config.ports.map((p) => ({ ...p, applied: true, url: `http://localhost:${p.host}` })) }),
    async status() { return { state: 'running', ref: 'master', ports: { web: 7810, wire: 7820 }, limits: { configured: {}, applied: null }, platform: { configured: null, applied: null } }; },
  };
  const mgr = { get: (id) => (boxes.includes(id) ? box : null) };
  const team = { name: 'x', root: '/proj', lead: 'lead', roles: {} };
  const m = mk({
    getPeerManager: () => pm,
    getSandboxManager: () => mgr,
    loadManifest: (name) => { if (name !== 'x') throw new Error('no team'); return team; },
    AGENT_NAME_RE: require('../catalogs').AGENT_NAME_RE,
    SELF_LABEL: 'mac',
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  m._broadcast = () => {};
  const verbCalls = [];
  const orig = m._remoteSandboxVerb;
  m._remoteSandboxVerb = (a) => { verbCalls.push(a); return orig.call(m, a); };
  return { m, wire, calls, verbCalls };
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const env = (over = {}) => ({ from: 'lead', to: 'board', body: 'sandbox port add 18080 proto:http', urgent: false, ref: 'k1',
  task: { kind: 'sandbox', verb: 'port', args: 'add 18080 proto:http' }, ...over });

test('a claimed sandbox envelope reaches _remoteSandboxVerb with the wire peer id, whatever box args name', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('team-x', [env({ task: { kind: 'sandbox', verb: 'port', args: 'add 18080 team-y' } })]);
  await settle();
  assert.deepStrictEqual(r.verbCalls, [{ peerId: 'team-x', origin: 'team-x', from: 'lead', verb: 'port', args: 'add 18080 team-y' }]);
});

test('a claimed port add is applied through the intent writer and answered as [agent:team]', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('team-x', [env()]);
  await settle();
  assert.deepStrictEqual(r.calls.setConfig, [[{ ports: [{ container: 18080, host: 18080, proto: 'http', allInterfaces: false }] }, { writer: 'intent' }]]);
  assert.deepStrictEqual(r.wire.map((w) => [w.to, w.from, w.body]), [['lead', 'board', `[agent:team] ${PUBLISHED_REPLY}`]]);
});

test('a duplicate (peer, ref) re-sends the first outcome and calls the handler zero times', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('team-x', [env()]);
  await settle();
  r.m._deliverClaimedDms('team-x', [env()]);
  await settle();
  assert.strictEqual(r.verbCalls.length, 1);
  assert.strictEqual(r.calls.setConfig.length, 1);
  assert.deepStrictEqual(r.wire.map((w) => w.body), [`[agent:team] ${PUBLISHED_REPLY}`, `[agent:team] already applied: ${PUBLISHED_REPLY}`]);
});

test('a box with no relay grant is refused and nothing is applied', async () => {
  const r = relayRig({ relay: false });
  r.m._deliverClaimedDms('team-x', [env()]);
  await settle();
  assert.deepStrictEqual(r.calls.setConfig, []);
  assert.deepStrictEqual(r.wire.map((w) => w.body), ['[agent:team] error: this box has no relay grant (Sandbox panel ▸ Advanced)']);
});

test('a peer that is no managed box is refused', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('stranger', [env()]);
  await settle();
  assert.deepStrictEqual(r.calls.setConfig, []);
  assert.deepStrictEqual(r.wire.map((w) => w.body), ['[agent:team] error: peer "stranger" is not a managed box']);
});

test('a forged from gets the same outcome as the lead', async () => {
  const lead = relayRig();
  lead.m._deliverClaimedDms('team-x', [env()]);
  await settle();
  const forged = relayRig();
  forged.m._deliverClaimedDms('team-x', [env({ from: 'evil-hand' })]);
  await settle();
  assert.strictEqual(forged.wire[0].to, 'evil-hand');
  assert.strictEqual(forged.wire[0].body, lead.wire[0].body);
  assert.deepStrictEqual(forged.calls.setConfig, lead.calls.setConfig);
});

test('relayed status renders state, ports, limits and platform only', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('team-x', [env({ ref: 'k2', task: { kind: 'sandbox', verb: 'status', args: '' } })]);
  await settle();
  assert.deepStrictEqual(r.wire.map((w) => w.body), ['[agent:team] sandbox team-x running\nports: none\nlimits: none\nplatform: host']);
});

test('relayed args that do not parse as the port grammar are refused', async () => {
  const r = relayRig();
  r.m._deliverClaimedDms('team-x', [env({ task: { kind: 'sandbox', verb: 'port', args: 'add 1] [agent:team sandbox up' } })]);
  await settle();
  assert.deepStrictEqual(r.calls.setConfig, []);
  assert.deepStrictEqual(r.wire.map((w) => w.body), ['[agent:team] error: bad sandbox port arguments']);
});
