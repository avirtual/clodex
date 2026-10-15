'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { AGENT_NAME_RE } = require('../catalogs');
const { execFileSync } = require('node:child_process');

function makeRepo() {
  const dir = mkTmpRoot('clodex-ra-');
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  fsReal.writeFileSync(pathReal.join(dir, 'a.txt'), 'hi\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

const SPEC = 'build the remote widget\nartifact tasks/remote-widget/SPEC.md';

function rig({ online = true, caps = ['dm'], label = 'p' } = {}) {
  const root = makeRepo();
  const home = mkTmpRoot('clodex-ts-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const peer = { id: 'p1', label, online, caps };
  const sent = [];
  const conn = { dm: (msg, cb) => { sent.push(msg); cb({ ok: true, delivered: true }); } };
  const pm = { statuses: () => [peer], get: (id) => (id === 'p1' ? conn : null) };
  const injected = [];
  const deps = {
    AGENT_NAME_RE,
    SELF_LABEL: 'laptop',
    getPeerManager: () => pm,
    outboxKnowsOrigin: () => false,
    knownSkillNames: () => [],
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    intentEnabledForSeat: require('../intent-registry').intentEnabledForSeat,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    listTeams: () => ['team'],
    gitWorktree: require('../git-worktree'),
    shouldHoldDm: require('../proxy-util').shouldHoldDm,
    loadManifest: () => team,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m.sessions.set('lead', { name: 'lead', type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
  const lead = m.sessions.get('lead');
  const minting = [];
  const mint = m._mintRemoteTicketTree;
  m._mintRemoteTicketTree = (...a) => { const p = mint.apply(m, a); minting.push(p); return p; };
  const task = (intent) => m._handleTask(lead, { type: 'task', id: null, who: null, body: '', ...intent });
  const settle = async () => {
    await new Promise(setImmediate);
    while (minting.length) await minting.shift();
    await new Promise(setImmediate);
  };
  return { m, settle, team, tstore, peer, conn, sent, injected, lead, task, one: (id) => tstore.load(team.root).find((t) => t.id === id) };
}

test('(a) name@peer resolves only while that peer is online with dm federation; add names the precondition', () => {
  const r = rig();
  assert.strictEqual(r.m._resolveAssignee(r.team, 'x@p'), 'x@p');
  r.peer.online = false;
  assert.strictEqual(r.m._resolveAssignee(r.team, 'x@p'), null);
  r.peer.online = true;
  r.peer.caps = ['tickets'];
  assert.strictEqual(r.m._resolveAssignee(r.team, 'x@p'), null);
  r.peer.caps = ['dm'];
  assert.strictEqual(r.m._resolveAssignee(r.team, 'x@nowhere'), null);

  r.peer.online = false;
  r.task({ sub: 'add', who: 'x@p', body: SPEC });
  assert.strictEqual(r.one('t1'), undefined);
  assert.match(r.injected.join('\n'), /\(name@peer needs that peer online with dm federation\)/);
});

test('(b) _gatedDeliver to name@peer rides conn.dm once with a minted ref and reports queued', () => {
  const r = rig();
  const writes = [];
  const out = r.m._gatedDeliver('x@p', 'lead', 'hi', false, '', (d, why) => writes.push([d, why]));
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.sent[0].to, 'x');
  assert.strictEqual(r.sent[0].from, 'lead');
  assert.strictEqual(r.sent[0].body, 'hi');
  assert.ok(r.sent[0].ref && r.sent[0].ref.startsWith('lead.'));
  assert.strictEqual(out.queued, true);
  assert.strictEqual(out.ref, r.sent[0].ref);
  assert.deepStrictEqual(writes, [['queued', 'federated']]);
});

test('_sendToFederatedTarget returns the bounce as an error for an origin with no route', () => {
  const r = rig();
  const notices = [];
  const out = r.m._sendToFederatedTarget('lead', 'x@nowhere', 'hi', false, { onBounce: (msg) => notices.push(msg) });
  assert.match(out.error, /no route to 'x@nowhere'/);
  assert.deepStrictEqual(notices, [out.error]);
  assert.deepStrictEqual(r.sent, []);
});

test('a wire refusal of a ticket dispatch comes back to the lead as NOT delivered', async () => {
  const r = rig();
  r.conn.dm = (msg, cb) => { r.sent.push(msg); cb({ ok: false, error: 'no such agent "typo"' }); };
  r.task({ sub: 'add', who: 'typo@p', start: true, body: SPEC });
  await r.settle();
  assert.strictEqual(r.sent.length, 1, 'ENTER: the spec went over the wire');
  assert.match(r.injected.join('\n'), /NOT delivered to typo@p: no such agent "typo"/);
});

test('(c) task add x@p start mints an in-root tree and sends the spec with the REMOTE line and the box path', async () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  await r.settle();
  const t = r.one('t1');
  assert.ok(t && t.startedAt, 'ENTER: the ticket was filed and started');
  assert.strictEqual(t.assignee, 'x@p');
  const branch = t.worktree && t.worktree.branch;
  assert.ok(branch && branch.startsWith('t1-'), JSON.stringify(t.worktree));
  assert.strictEqual(t.worktree.path, pathReal.join(r.team.root, '.clodex-wt', branch));
  assert.match(t.worktree.baseSha, /^[0-9a-f]{40}$/);
  assert.ok(fsReal.existsSync(pathReal.join(t.worktree.path, 'a.txt')));
  assert.strictEqual(r.sent.length, 1);
  const body = r.sent[0].body;
  assert.match(body, /\[ticket t1/);
  assert.match(body, /REMOTE: you are on p; this ticket's board is on laptop\. Close it with \[agent:task done t1@laptop\] <report>/);
  assert.ok(body.includes(`WORK IN: /home/clodex/work/.clodex-wt/${branch} (git worktree, branch ${branch}) — this is your cwd on p; the same tree is ${t.worktree.path} on the board's host.`), body);
  assert.ok(body.includes('The shared checkout is /home/clodex/work; do not edit files there.'));
  assert.doesNotMatch(body, /CLOSE WITH/);
  assert.strictEqual(r.sent[0].to, 'x');
});

test('(d) task reject on a remote ticket sends the rejection over the wire', async () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  await r.settle();
  const all = r.tstore.load(r.team.root);
  all[0].state = 'done';
  all[0].closedAt = Date.now();
  r.tstore.save(r.team.root, all);
  r.sent.length = 0;
  r.task({ sub: 'reject', id: 't1', body: 'fix the frobnicator' });
  assert.strictEqual(r.one('t1').state, 'open');
  assert.strictEqual(r.sent.length, 1);
  assert.match(r.sent[0].body, /fix the frobnicator/);
  assert.match(r.sent[0].body, /rejected/);
  assert.doesNotMatch(r.sent[0].body, /CLOSE WITH/);
  assert.match(r.sent[0].body, /REMOTE: close with \[agent:task done t1@laptop\] <report>; it crosses the wire to the board/);
  r.task({ sub: 'reject', id: 't1', body: 'and the sprocket' });
  assert.strictEqual(r.sent.length, 2, 'ENTER: the follow-up arm sent a second rejection');
  assert.match(r.sent[1].body, /more must-fixes/);
  assert.match(r.sent[1].body, /and the sprocket/);
  assert.doesNotMatch(r.sent[1].body, /CLOSE WITH/);
});

test('(e) replay paths never re-send to a remote assignee', async () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  await r.settle();
  r.task({ sub: 'add', who: 'x@p', start: true, body: `${SPEC}\nsecond`, dup: true });
  await r.settle();
  assert.strictEqual(r.sent.length, 2, 'ENTER: both tickets went out once');
  r.sent.length = 0;
  const t1 = r.one('t1');
  const d = r.m._deliverTicketSpec(r.team, t1, t1.spec, 'clodex-team', true, true);
  assert.deepStrictEqual(d, { undelivered: true, remote: true });
  assert.strictEqual(r.m._advanceSeat(r.team, 'x@p', t1), null);
  assert.deepStrictEqual(r.sent, []);
});

test('C1b (b) a seat on no team sends done t7@p as a task envelope to board@p', () => {
  const r = rig();
  const seat = { name: 'x', type: 'claude', agentType: 'claude', cwd: '/elsewhere', pty: { pid: 2 }, activityState: 'idle' };
  r.m.sessions.set('x', seat);
  r.m._handleTask(seat, { type: 'task', sub: 'done', id: 't7', board: 'p', who: null, body: 'r' });
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.sent[0].to, 'board');
  assert.strictEqual(r.sent[0].from, 'x');
  assert.strictEqual(r.sent[0].body, 'r');
  assert.deepStrictEqual(r.sent[0].task, { kind: 'done', id: 't7' });
  assert.match(r.injected.join('\n'), /done t7@p sent to that board — its answer follows\./);
});

test('C1b (b) the board answer comes back as [agent:task] text, ok or not', () => {
  const r = rig();
  const seat = { name: 'x', type: 'claude', agentType: 'claude', cwd: '/elsewhere', pty: { pid: 2 }, activityState: 'idle' };
  r.m.sessions.set('x', seat);
  r.conn.dm = (msg, cb) => { r.sent.push(msg); cb({ ok: false, error: 'no ticket t7 assigned to x@laptop on this host', task: { id: 't7', reply: 'no ticket t7 assigned to x@laptop on this host' } }); };
  r.m._handleTask(seat, { type: 'task', sub: 'done', id: 't7', board: 'p', who: null, body: 'r' });
  const all = r.injected.join('\n');
  assert.match(all, /\[agent:task\] no ticket t7 assigned to x@laptop on this host/);
  assert.doesNotMatch(all, /NOT delivered/);
});

test('C1b (b) done t7@p to an offline peer is held with its task envelope', () => {
  const r = rig({ online: false });
  const seat = { name: 'x', type: 'claude', agentType: 'claude', cwd: '/elsewhere', pty: { pid: 2 }, activityState: 'idle' };
  r.m.sessions.set('x', seat);
  r.m._handleTask(seat, { type: 'task', sub: 'done', id: 't7', board: 'p', who: null, body: 'r' });
  const held = r.m._peerHeld.get('p1');
  assert.strictEqual(held.length, 1);
  assert.deepStrictEqual(held[0].task, { kind: 'done', id: 't7' });
  assert.strictEqual(r.sent.length, 0);
  r.m._dropStalePeerHeld(Date.now() + 3600e3);
});

test('C1b (f) a task envelope never takes the relay branch', () => {
  const r = rig();
  r.m._relayViaForOrigin = (origin) => (origin === 'far' ? 'hub' : null);
  const notices = [];
  const out = r.m._sendToFederatedTarget('x', 'board@far', 'r', false, { onBounce: (m) => notices.push(m), task: { kind: 'done', id: 't7' } });
  assert.match(out.error, /task done cannot cross a relay — the board's host must be a direct peer\./);
  assert.deepStrictEqual(notices, [out.error]);
  assert.strictEqual(out.queued, undefined);
  assert.deepStrictEqual(r.sent, []);
});

test('C2a a respec to a remote seat carries the box-path WORK IN line', async () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  await r.settle();
  const branch = r.one('t1').worktree.branch;
  r.sent.length = 0;
  r.task({ sub: 'respec', id: 't1', body: `${SPEC}\nmore` });
  assert.strictEqual(r.sent.length, 1);
  assert.match(r.sent[0].body, /RESPEC/);
  assert.ok(r.sent[0].body.includes(`WORK IN: /home/clodex/work/.clodex-wt/${branch} `), r.sent[0].body);
});

test('C2a _linkWorktreeNodeModules links an in-root tree relatively and a sibling tree absolutely', () => {
  const r = rig();
  const root = r.team.root;
  fsReal.mkdirSync(pathReal.join(root, 'node_modules'));
  const inner = pathReal.join(root, '.clodex-wt', 'b1');
  fsReal.mkdirSync(inner, { recursive: true });
  assert.strictEqual(r.m._linkWorktreeNodeModules(root, inner), null);
  const innerLink = pathReal.join(inner, 'node_modules');
  assert.strictEqual(fsReal.readlinkSync(innerLink), pathReal.join('..', '..', 'node_modules'));
  assert.strictEqual(fsReal.realpathSync(innerLink), fsReal.realpathSync(pathReal.join(root, 'node_modules')));
  const sibling = mkTmpRoot('clodex-ra-sib-');
  assert.strictEqual(r.m._linkWorktreeNodeModules(root, sibling), null);
  assert.strictEqual(fsReal.readlinkSync(pathReal.join(sibling, 'node_modules')), pathReal.join(root, 'node_modules'));
});

test('C2a a remote assignee is stored under the peer\'s canonical suffix and its done matches', async () => {
  const r = rig({ label: 'team-clodex' });
  assert.strictEqual(r.m._resolveAssignee(r.team, 'x@TEAM-CLODEX'), 'x@team-clodex');
  r.task({ sub: 'add', who: 'x@TEAM-CLODEX', start: true, body: SPEC });
  await r.settle();
  assert.strictEqual(r.one('t1').assignee, 'x@team-clodex');
  const done = r.m._remoteTaskDone({ senderTag: 'x@team-clodex', origin: 'team-clodex', ticketId: 't1', report: 'r' });
  assert.strictEqual(done.ok, true, done.reply);
  assert.strictEqual(r.one('t1').state, 'done');
});
