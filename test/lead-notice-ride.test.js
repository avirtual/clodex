'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');
const ps = require('../pending-store');

const THIRTY_ONE_MIN = 31 * 60 * 1000;
const TWENTY_NINE_MIN = 29 * 60 * 1000;

function mkLoop({ ticket = {}, leadType = 'claude', overrides = {} } = {}) {
  const home = mkTmpRoot('clodex-t2224-');
  const root = pathReal.join(home, 'proj');
  fsReal.mkdirSync(root, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: { lead: { instantiate: 'session', brief: 'the lead' }, hand: { instantiate: 'session', brief: 'the hand' } },
  };
  const gated = [];
  const infos = [];
  const { m, PENDING_DIR, injected } = mkPark({
    REGISTRY_DIR: home,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    gitWorktree: require('../git-worktree'),
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
    countPending: ps.countPending,
    oldestActiveParkTs: ps.oldestActiveParkTs,
    oldestDueRide: ps.oldestDueRide,
    log: { info: (_c, msg) => infos.push(msg), warn: () => {}, error: () => {}, debug: () => {} },
    ...overrides,
  });
  m._gatedDeliver = (target, sender, body, urgent, tag) => {
    gated.push({ target, sender, body, urgent, tag });
    return { queued: true };
  };
  m._sendToSession = () => {};
  m._teamLiveSeatNames = () => ['lead', 'team-hand'];
  m.sessions.set('lead', { name: 'lead', type: leadType, agentType: leadType, cwd: root, pty: { pid: 1 }, activityState: 'idle' });
  const rec = {
    id: 't1', state: 'done', spec: 'build the widget', assignee: 'team-hand', role: 'hand',
    openedAt: Date.now(), startedAt: Date.now(), lastActivityAt: Date.now(), closedAt: Date.now(),
    worktree: { path: pathReal.join(root, 'wt'), branch: 't1-build-the-widget', baseSha: 'deadbeef' },
    ...ticket,
  };
  tstore.save(root, [rec]);
  const lead = m.sessions.get('lead');
  const parked = () => { try { return fsReal.readdirSync(pathReal.join(PENDING_DIR, 'lead')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  const written = { ok: true, path: '/tmp/verdict.md' };
  const verdict = (v, dispatch = null) => m._notifyLeadOfVerdict(lead, 'lead', 't1',
    { verdict: v, mustFix: v === 'REWORK' ? '- fix it' : null, mustFixHeader: v === 'REWORK', reviewRound: 1 },
    `VERDICT: ${v}`, written, dispatch);
  return { m, team, lead, gated, infos, injected, PENDING_DIR, parked, verdict };
}

test('(a) an ACCEPT with its merge queued parks, does not wake, and arrives with the lead\'s next turn', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' } });
  f.verdict('ACCEPT');
  assert.deepStrictEqual(f.gated, [], 'a queued-merge ACCEPT must not wake the lead');
  assert.strictEqual(f.parked().length, 1);
  assert.ok(f.parked()[0].endsWith('.passive.json'), f.parked()[0]);
  f.m._drainPendingAtIdle(f.lead);
  assert.deepStrictEqual(f.injected, [], 'a ride never earns a turn at the idle edge');
  const texts = ps.drainPending(f.PENDING_DIR, 'lead', ps.claimTag('hook'));
  assert.strictEqual(texts.length, 1);
  assert.ok(texts[0].includes('[ticket t1 ACCEPT] review round 1, no must-fixes.'), texts[0]);
  assert.ok(f.infos.includes('notice-ride lead t1 ACCEPT'), f.infos.join('\n'));
});

test('a report-mode ACCEPT rides', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT', done: 'report' } });
  f.verdict('ACCEPT');
  assert.deepStrictEqual(f.gated, []);
  assert.strictEqual(f.parked().length, 1);
});

test('an ACCEPT with no merge queued and no report wakes', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT' } });
  f.verdict('ACCEPT');
  assert.strictEqual(f.gated.length, 1);
  assert.strictEqual(f.gated[0].tag, '[ticket t1 ACCEPT]');
  assert.deepStrictEqual(f.parked(), []);
});

test('a REWORK already dispatched to the hand rides', () => {
  const f = mkLoop();
  f.verdict('REWORK', { ok: true, seat: 'team-hand' });
  assert.deepStrictEqual(f.gated, []);
  assert.strictEqual(f.parked().length, 1);
  assert.ok(f.infos.includes('notice-ride lead t1 REWORK'), f.infos.join('\n'));
});

test('(d) a REWORK whose dispatch failed wakes', () => {
  const f = mkLoop();
  f.verdict('REWORK', { ok: false, error: 'seat gone' });
  assert.strictEqual(f.gated.length, 1);
  assert.strictEqual(f.gated[0].tag, '[ticket t1 REWORK]');
  assert.deepStrictEqual(f.parked(), []);
});

test('a loop rejection rides', () => {
  const f = mkLoop();
  f.m._notifyLeadOfLoopRejection(f.team, { id: 't1', reworkRound: 2 }, 'team-hand', 'suite red');
  assert.deepStrictEqual(f.gated, []);
  assert.strictEqual(f.parked().length, 1);
  assert.ok(f.infos.includes('notice-ride lead t1 REJECTED'), f.infos.join('\n'));
});

test('(b) an ESCALATED notice wakes, urgent', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' } });
  f.m._escalateTicket(f.team, 't1', 'merge', 'conflict', 'nothing');
  assert.strictEqual(f.gated.length, 1);
  assert.strictEqual(f.gated[0].tag, '[ticket t1 ESCALATED]');
  assert.strictEqual(f.gated[0].urgent, true);
  assert.deepStrictEqual(f.parked(), []);
});

test('(c) a ride past due is flushed by the ticket sweep, not before', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' } });
  for (const k of ['_sweepTeamTickets', '_reconcileTickets', '_resumeOrphanedVerify', '_startCapParked', '_archivePassFor']) {
    f.m[k] = () => Promise.resolve();
  }
  f.verdict('ACCEPT');
  const t0 = Date.now();
  f.m._sweepTickets(t0 + TWENTY_NINE_MIN);
  assert.deepStrictEqual(f.injected, [], 'a ride inside its window stays parked');
  assert.strictEqual(f.parked().length, 1);
  f.m._sweepTickets(t0 + THIRTY_ONE_MIN);
  assert.strictEqual(f.injected.length, 1);
  assert.ok(f.injected[0].includes('[ticket t1 ACCEPT]'), f.injected[0]);
  assert.deepStrictEqual(f.parked(), []);
  assert.ok(f.infos.some((l) => /^notice-ride-cap lead t1 age=\d+$/.test(l)), f.infos.join('\n'));
});

test('an overdue ride counts as an active park for the park cap', () => {
  const f = mkLoop({ ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' } });
  f.verdict('ACCEPT');
  const now = Date.now();
  assert.strictEqual(ps.oldestActiveParkTs(f.PENDING_DIR, 'lead', now + TWENTY_NINE_MIN), null);
  assert.strictEqual(ps.oldestActiveParkTs(f.PENDING_DIR, 'lead', now + THIRTY_ONE_MIN), 0);
});

test('(e) a park that throws falls back to a wake', () => {
  const f = mkLoop({
    ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' },
    overrides: { parkDelivery: () => { throw new Error('disk full'); } },
  });
  f.verdict('ACCEPT');
  assert.strictEqual(f.gated.length, 1);
  assert.strictEqual(f.gated[0].tag, '[ticket t1 ACCEPT]');
});

test('(f) seat-type gate: a clodent lead rides, a codex lead wakes', () => {
  const rows = [
    { leadType: 'clodent', gated: 0, parked: 1 },
    { leadType: 'codex', gated: 1, parked: 0 },
  ];
  for (const row of rows) {
    const f = mkLoop({ leadType: row.leadType, ticket: { verdict: 'ACCEPT', mergeWaiting: 'queued' } });
    f.verdict('ACCEPT');
    assert.deepStrictEqual({ leadType: row.leadType, gated: f.gated.length, parked: f.parked().length }, row);
  }
});

test('(f) seat-type gate: a passive delivery to a clodent seat parks', () => {
  const f = mkLoop({ leadType: 'clodent' });
  let woke = 0;
  f.m._deliverMessage = () => { woke += 1; };
  f.m._deliverPassive('lead', 'team', 'seat x spawned', 'dm');
  assert.strictEqual(woke, 0);
  assert.strictEqual(f.parked().length, 1);
});

test('_deliverRide to a lead behind a permission dialog wakes instead of parking', () => {
  const f = mkLoop();
  f.lead.needsAttention = { kind: 'permission' };
  const r = f.m._deliverRide('lead', 'ticket-loop', '[ticket t1 ACCEPT] x', { tag: '[ticket t1 ACCEPT]', ticket: 't1', kind: 'ACCEPT' });
  assert.deepStrictEqual(r, { queued: true });
  assert.strictEqual(f.gated.length, 1);
  assert.deepStrictEqual(f.parked(), []);
});

test('_flushDueRides holds an overdue ride while the lead is busy, then flushes it', () => {
  const f = mkLoop();
  f.m._deliverRide('lead', 'ticket-loop', '[ticket t1 REJECTED] x', { tag: 't', ticket: 't1', kind: 'REJECTED' });
  const late = Date.now() + THIRTY_ONE_MIN;
  f.lead.activityState = 'thinking';
  assert.strictEqual(f.m._flushDueRides(f.lead, late), null);
  assert.strictEqual(f.parked().length, 1);
  f.lead.activityState = 'idle';
  assert.deepStrictEqual(f.m._flushDueRides(f.lead, late), { ok: true, count: 1 });
  assert.strictEqual(f.injected.length, 1);
  assert.deepStrictEqual(f.parked(), []);
});

test('_verdictOwesLeadNothing: one route per verdict row', () => {
  const rows = [
    { ticket: { mergeWaiting: 'queued' }, verdict: 'ACCEPT', dispatch: null, rides: true },
    { ticket: { done: 'report' }, verdict: 'ACCEPT', dispatch: null, rides: true },
    { ticket: {}, verdict: 'ACCEPT', dispatch: null, rides: false },
    { ticket: {}, verdict: 'REWORK', dispatch: { ok: true }, rides: true },
    { ticket: {}, verdict: 'REWORK', dispatch: { ok: false }, rides: false },
    { ticket: {}, verdict: 'REWORK', dispatch: null, rides: false },
    { ticket: { mergeWaiting: 'queued' }, verdict: 'ESCALATED', dispatch: { ok: true }, rides: false },
  ];
  for (const row of rows) {
    const f = mkLoop({ ticket: row.ticket });
    const rides = f.m._verdictOwesLeadNothing(f.lead, 't1', { verdict: row.verdict }, row.dispatch);
    assert.deepStrictEqual({ ...row, rides }, row);
  }
});
