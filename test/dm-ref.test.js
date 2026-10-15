'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { RemoteServer } = require('../remote');
const { enqueueOutbox, claimOutbox } = require('../peer-outbox');
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
  m._dmRefSeen.get('w\nlaptop\nbob\nr1').at -= 10 * 60 * 1000;
  deliverDm(msg);
  assert.strictEqual(n, 2);
});

test('t1829 a failed first delivery is not remembered: the same ref resent is delivered again', () => {
  const m = mk();
  const results = [{ held: 'x' }, { queued: true }, { queued: true }];
  let n = 0;
  m._gatedDeliver = () => results[n++];
  m._broadcast = () => {};
  const deliverDm = captureDeliverDm(m);
  const msg = { to: 'alpha', from: 'bob', origin: 'laptop', body: 'hi', ref: 'r1' };
  assert.deepStrictEqual(deliverDm(msg), { ok: false, error: 'x' });
  assert.deepStrictEqual(deliverDm(msg), { ok: true, delivered: true });
  assert.deepStrictEqual(deliverDm(msg), { ok: true, delivered: true, duplicate: true });
  assert.strictEqual(n, 2);
});

test('t1829 a claimed record whose delivery failed is not remembered', () => {
  const m = mk({ getPeerManager: () => ({ statuses: () => [{ id: 'p1', label: 'hub' }] }), log: { info() {}, warn() {}, error() {} } });
  m.sessions.set('alpha', { name: 'alpha', agentType: 'claude' });
  const results = [{ held: 'x' }, { queued: true }, { queued: true }];
  let n = 0;
  m._gatedDeliver = () => results[n++];
  m._broadcast = () => {};
  const rec = { from: 'bob', to: 'alpha', body: 'hi', urgent: false, ref: 'r8' };
  m._deliverClaimedDms('p1', [rec, { ...rec }, { ...rec }]);
  assert.strictEqual(n, 2);
});

test('t1829 _deliverClaimedDms delivers two claimed records sharing a ref once', () => {
  const m = mk({ getPeerManager: () => ({ statuses: () => [{ id: 'p1', label: 'hub' }] }), log: { info() {}, warn() {}, error() {} } });
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
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'laptop', a.file), 'utf8')), { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5 });
  const b = enqueueOutbox(root, 'laptop', { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5, ref: 'r1' }, '2');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'laptop', b.file), 'utf8')), { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5, ref: 'r1' });
});

function boardRig() {
  const home = mkTmpRoot('clodex-ts-');
  const tstore = require('../tickets-store').createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: path.join(home, 'teams', 'team', 'team.json'),
    roles: { lead: { instantiate: 'session', brief: 'the lead' }, hand: { instantiate: 'session', brief: 'the hand' } },
  };
  const wire = [];
  const conn = { dm: (msg, cb) => { wire.push(msg); cb({ ok: true, delivered: true }); } };
  const pm = { statuses: () => [{ id: 'p', label: 'p', online: true, caps: ['dm'] }], get: (id) => (id === 'p' ? conn : null) };
  const m = mk({ REGISTRY_DIR: home, listTeams: () => ['team'], loadManifest: () => team, getPeerManager: () => pm, AGENT_NAME_RE: require('../catalogs').AGENT_NAME_RE, SELF_LABEL: 'laptop', log: { info() {}, warn() {}, error() {}, debug() {} } });
  const leadGot = [];
  m._gatedDeliver = (to, from, body) => { leadGot.push({ to, from, body }); return { queued: true }; };
  m._broadcast = () => {};
  tstore.save(team.root, [{ id: 't7', state: 'open', assignee: 'x@p', spec: 'do it', createdAt: 1, events: [] }]);
  const one = () => tstore.load(team.root).find((t) => t.id === 't7');
  return { m, team, tstore, leadGot, one, wire };
}

async function withBoard(r, fn) {
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    deliverDm: captureDeliverDm(r.m),
  });
  await server.start();
  try { await fn(server); } finally { server.stop(); }
}

test('C1b (c) a task envelope from the recorded assignee closes the ticket on the board', async () => {
  const r = boardRig();
  await withBoard(r, async (server) => {
    const res = await post(server, { to: 'board', from: 'x', origin: 'p', body: 'all built', task: { kind: 'done', id: 't7' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.task.id, 't7');
    assert.match(res.json.task.reply, /ticket t7 closed \(done\) — report delivered to lead/);
    const t = r.one();
    assert.strictEqual(t.state, 'done');
    assert.strictEqual(t.reportedBy, 'x@p');
    assert.deepStrictEqual(r.leadGot.map((d) => [d.to, d.from, d.body]), [['lead', 'x@p', '[ticket t7 done] all built']]);
  });
});

test('C1b (d) a task envelope from anyone but the recorded assignee is refused', async () => {
  const r = boardRig();
  await withBoard(r, async (server) => {
    const wrongName = await post(server, { to: 'board', from: 'y', origin: 'p', body: 'r', task: { kind: 'done', id: 't7' } });
    assert.strictEqual(wrongName.json.ok, false);
    assert.match(wrongName.json.task.reply, /^no ticket t7 assigned to y@p on this host$/);
    const wrongOrigin = await post(server, { to: 'board', from: 'x', origin: 'q', body: 'r', task: { kind: 'done', id: 't7' } });
    assert.strictEqual(wrongOrigin.json.ok, false);
    assert.match(wrongOrigin.json.error, /^no ticket t7 assigned to x@q on this host$/);
    assert.strictEqual(r.one().state, 'open');
    assert.deepStrictEqual(r.leadGot, []);
  });
});

test('C1b (e) a repeated task ref answers duplicate and closes once', async () => {
  const r = boardRig();
  await withBoard(r, async (server) => {
    const msg = { to: 'board', from: 'x', origin: 'p', body: 'r', ref: 'k1', task: { kind: 'done', id: 't7' } };
    const first = await post(server, msg);
    assert.strictEqual(first.json.ok, true);
    const events = (r.one().events || []).length;
    const again = await post(server, msg);
    assert.strictEqual(again.json.duplicate, true);
    assert.strictEqual(again.json.task.id, 't7');
    assert.strictEqual((r.one().events || []).length, events);
    assert.strictEqual(r.leadGot.length, 1);
  });
});

test('C1b (g) a malformed task envelope is a 400', async () => {
  const r = boardRig();
  await withBoard(r, async (server) => {
    const base = { to: 'board', from: 'x', origin: 'p', body: 'r' };
    for (const task of [{ kind: 'reject', id: 't7' }, { kind: 'done', id: 'x' }, 'done', [1]]) {
      assert.deepStrictEqual(await post(server, { ...base, task }), { status: 400, json: { ok: false, error: 'bad task envelope' } });
    }
    assert.strictEqual(r.one().state, 'open');
  });
});

test('C1b (g) a board whose deliverDm predates task fails it as a dm to a seat named board', async () => {
  const m = mk();
  m._broadcast = () => {};
  m._gatedDeliver = (to) => ({ error: `no such agent "${to}"` });
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    deliverDm: ({ to, from, origin, body, urgent }) => captureDeliverDm(m)({ to, from, origin, body, urgent }),
  });
  await server.start();
  try {
    const res = await post(server, { to: 'board', from: 'x', origin: 'p', body: 'r', task: { kind: 'done', id: 't7' } });
    assert.deepStrictEqual(res.json, { ok: false, error: 'no such agent "board"' });
  } finally { server.stop(); }
});

test('C1b a claimed record with a task closes through _remoteTaskDone', () => {
  const r = boardRig();
  const m = r.m;
  const calls = [];
  const orig = m._remoteTaskDone;
  m._remoteTaskDone = (a) => { calls.push(a); return orig.call(m, a); };
  m._deliverClaimedDms('p', [{ from: 'x', to: 'board', body: 'via outbox', urgent: false, task: { kind: 'done', id: 't7' } }]);
  assert.deepStrictEqual(calls.map((c) => [c.senderTag, c.ticketId]), [['x@p', 't7']]);
  assert.strictEqual(r.one().state, 'done');
  assert.deepStrictEqual(r.wire.map((w) => [w.to, w.from, w.body]), [['x', 'board', '[agent:task] ticket t7 closed (done) — report delivered to lead — closed WITHOUT review: the ticket records no branch, so the loop had nothing to verify']]);
});

test('C1b a refused claimed done is answered over the dial back to its sender', () => {
  const r = boardRig();
  r.m._deliverClaimedDms('p', [{ from: 'y', to: 'board', body: 'r', urgent: false, task: { kind: 'done', id: 't7' } }]);
  assert.strictEqual(r.one().state, 'open');
  assert.strictEqual(r.wire.length, 1);
  assert.strictEqual(r.wire[0].to, 'y');
  assert.strictEqual(r.wire[0].body, '[agent:task] no ticket t7 assigned to y@p on this host');
});

test('C1b a repeated claimed done ref closes once and answers already-answered', () => {
  const r = boardRig();
  const rec = { from: 'x', to: 'board', body: 'r', urgent: false, ref: 'k2', task: { kind: 'done', id: 't7' } };
  r.m._deliverClaimedDms('p', [rec, { ...rec }]);
  assert.strictEqual(r.leadGot.length, 1);
  assert.strictEqual(r.wire.length, 2);
  assert.match(r.wire[1].body, /^\[agent:task\] the board already answered ref k2: ticket t7 closed \(done\)/);
});

test('C1b a claimed record with a malformed task envelope is dropped', () => {
  const r = boardRig();
  r.m._deliverClaimedDms('p', [{ from: 'x', to: 'board', body: 'r', urgent: false, task: { kind: 'reject', id: 't7' } }]);
  assert.strictEqual(r.one().state, 'open');
  assert.deepStrictEqual(r.wire, []);
  assert.deepStrictEqual(r.leadGot, []);
});

test('C1b enqueueOutbox carries task only when present', () => {
  const root = mkTmpRoot('clodex-dm-ref-');
  const a = enqueueOutbox(root, 'laptop', { from: 'a', to: 'board', body: 'x', urgent: false, ts: 5, task: { kind: 'done', id: 't7' } }, '1');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'laptop', a.file), 'utf8')).task, { kind: 'done', id: 't7' });
  const b = enqueueOutbox(root, 'laptop', { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5, task: null }, '2');
  assert.strictEqual('task' in JSON.parse(fs.readFileSync(path.join(root, 'laptop', b.file), 'utf8')), false);
});

test('t1835 claimOutbox reads back ref and task only when the enqueued record had them', () => {
  const root = mkTmpRoot('clodex-dm-ref-');
  enqueueOutbox(root, 'laptop', { from: 'a', to: 'board', body: 'x', urgent: false, ts: 5, ref: 'r1', task: { kind: 'done', id: 't7' } }, '1');
  assert.deepStrictEqual(claimOutbox(root, 'laptop'), [{ from: 'a', to: 'board', body: 'x', urgent: false, ts: 5, ref: 'r1', task: { kind: 'done', id: 't7' } }]);
  enqueueOutbox(root, 'laptop', { from: 'a', to: 'b', body: 'x', urgent: false, ts: 5 }, '2');
  assert.deepStrictEqual(claimOutbox(root, 'laptop'), [{ from: 'a', to: 'b', body: 'x', urgent: false, ts: 5 }]);
});
