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

const SPEC = 'build the remote widget\nartifact tasks/remote-widget/SPEC.md';

function rig({ online = true, caps = ['dm'] } = {}) {
  const home = mkTmpRoot('clodex-ts-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const peer = { id: 'p1', label: 'p', online, caps };
  const sent = [];
  const conn = { dm: (msg, cb) => { sent.push(msg); cb({ ok: true, delivered: true }); } };
  const pm = { statuses: () => [peer], get: (id) => (id === 'p1' ? conn : null) };
  const injected = [];
  const deps = {
    AGENT_NAME_RE,
    SELF_LABEL: 'laptop',
    getPeerManager: () => pm,
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
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
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
  m.sessions.set('lead', { name: 'lead', type: 'claude', agentType: 'claude', cwd: '/proj', pty: { pid: 1 }, activityState: 'idle' });
  const lead = m.sessions.get('lead');
  const task = (intent) => m._handleTask(lead, { type: 'task', id: null, who: null, body: '', ...intent });
  return { m, team, tstore, peer, sent, injected, lead, task, one: (id) => tstore.load(team.root).find((t) => t.id === id) };
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

test('(c) task add x@p start sends the spec over the wire with the REMOTE line and no WORK IN', () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  const t = r.one('t1');
  assert.ok(t && t.startedAt, 'ENTER: the ticket was filed and started');
  assert.strictEqual(t.assignee, 'x@p');
  assert.strictEqual(t.worktree, undefined);
  assert.strictEqual(r.sent.length, 1);
  const body = r.sent[0].body;
  assert.match(body, /\[ticket t1/);
  assert.match(body, /REMOTE: you are on p; this ticket's board is on laptop; report by dm to lead@laptop/);
  assert.doesNotMatch(body, /WORK IN:/);
  assert.strictEqual(r.sent[0].to, 'x');
});

test('(d) task reject on a remote ticket sends the rejection over the wire', () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
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
});

test('(e) replay paths never re-send to a remote assignee', () => {
  const r = rig();
  r.task({ sub: 'add', who: 'x@p', start: true, body: SPEC });
  r.task({ sub: 'add', who: 'x@p', start: true, body: `${SPEC}\nsecond`, dup: true });
  assert.strictEqual(r.sent.length, 2, 'ENTER: both tickets went out once');
  r.sent.length = 0;
  r.m._replayOpenTickets(r.lead);
  const t1 = r.one('t1');
  const d = r.m._deliverTicketSpec(r.team, t1, t1.spec, 'clodex-team', true, true);
  assert.deepStrictEqual(d, { undelivered: true, remote: true });
  assert.strictEqual(r.m._advanceSeat(r.team, 'x@p', t1), null);
  assert.deepStrictEqual(r.sent, []);
});
