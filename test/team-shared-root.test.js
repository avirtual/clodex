'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTeamManifest, ROSTER_FILE } = require('../team-manifest');
const { createTicketsStore } = require('../tickets-store');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mkPark } = require('./lib/session-fixtures');

const ROLES = { lead: { brief: 'lead' }, hand: { brief: 'hand', dispatch: 'spawn' }, scout: { brief: 'scout' } };

function mkHome(t) {
  const home = mkTmpRoot('clodex-shared-');
  const root = mkTmpRoot('clodex-shared-root-');
  t.after(() => { for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true }); });
  const tm = createTeamManifest({ fs, clodexHome: home });
  const records = new Map();
  const live = new Set();
  tm.setSeatLookup({ record: (n) => records.get(n) || null, live: (n) => live.has(n) });
  const store = createTicketsStore({ fs, clodexHome: home });
  const writeTeam = (name, lead) => {
    fs.mkdirSync(path.join(home, 'teams', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'teams', name, 'team.json'), JSON.stringify({ version: 3, lead, root, roles: ROLES }));
  };
  const writeRoster = (name, seats) => {
    fs.writeFileSync(path.join(home, 'teams', name, ROSTER_FILE),
      JSON.stringify({ version: 1, seats: seats.map(([seat, role]) => ({ seat, role, gen: 1, since: 1, by: 'test' })) }));
  };
  return { tm, home, root, records, live, store, writeTeam, writeRoster };
}

function mkShared(t, { teams = ['a', 'b'] } = {}) {
  const h = mkHome(t);
  for (const n of teams) h.writeTeam(n, `${n}-lead`);
  const persistence = {
    list: () => [...h.records.values()],
    get: (n) => h.records.get(n) || null,
    upsert: (e) => h.records.set(e.name, { ...(h.records.get(e.name) || {}), ...e }),
  };
  const { m, injected } = mkPark({
    fs, path, os: require('node:os'), REGISTRY_DIR: h.home, teamsDir: path.join(h.home, 'teams'),
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/, DEFAULT_WORKSPACE_ID: 'default', ensureDir: () => {},
    getPersistence: () => persistence,
    resolveTeam: h.tm.resolveTeam, teamOf: h.tm.teamOf, teamsOfCwd: h.tm.teamsOfCwd,
    bindSeat: h.tm.bindSeat, unbindSeat: h.tm.unbindSeat, rosterOf: h.tm.rosterOf,
    loadManifest: h.tm.loadManifest, listTeams: h.tm.listTeams, teamOfSeat: h.tm.teamOfSeat,
  });
  m._sendToSession = () => {};
  const acks = [];
  m._taskAck = (_s, line) => acks.push(line);
  const seat = (name, rec = {}) => {
    h.records.set(name, { name, cwd: h.root, createdAt: 1, ...rec });
    const s = { name, type: 'claude', agentType: 'claude', cwd: h.root, activityState: 'idle', workspaceId: 'default' };
    m.sessions.set(name, s);
    h.live.add(name);
    return s;
  };
  return { h, m, injected, acks, seat };
}

const row = (id, team, extra = {}) => ({
  id, title: `${id} title`, spec: `${id} spec`, assignee: 'hand', opener: 'x', state: 'open',
  openedAt: 1, closedAt: null, lastActivityAt: 1, nudgedAt: null, startedAt: null,
  ...(team ? { team } : {}), ...extra,
});

test('a second createTeam on an owned root is refused without shareRoot, and the refusal names share-root:yes', (t) => {
  const h = mkHome(t);
  h.tm.createTeam({ name: 'a', root: h.root, lead: 'a-lead' });
  assert.throws(() => h.tm.createTeam({ name: 'b', root: h.root, lead: 'b-lead' }),
    { message: `team "a" already owns root ${h.root} — add share-root:yes to share it` });
  assert.ok(!fs.existsSync(path.join(h.home, 'teams', 'b', 'team.json')));
});

test('createTeam with shareRoot: true shares the root and records sharedRoot on the manifest', (t) => {
  const h = mkHome(t);
  h.tm.createTeam({ name: 'a', root: h.root, lead: 'a-lead' });
  const b = h.tm.createTeam({ name: 'b', root: h.root, lead: 'b-lead', shareRoot: true });
  assert.strictEqual(b.sharedRoot, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.home, 'teams', 'b', 'team.json'), 'utf-8')).sharedRoot, true);
  assert.strictEqual(h.tm.loadManifest('a').sharedRoot, false);
  assert.deepStrictEqual(h.tm.teamsOfCwd(h.root), ['a', 'b']);
});

test('sharing is refused while the board holds rows without a team, naming the count and the owner', (t) => {
  const h = mkHome(t);
  h.tm.createTeam({ name: 'a', root: h.root, lead: 'a-lead' });
  h.store.save(h.root, [row('t1', null), row('t2', 'a'), row('t3', null)]);
  assert.throws(() => h.tm.createTeam({ name: 'b', root: h.root, lead: 'b-lead', shareRoot: true }),
    { message: `team "a" owns root ${h.root} and its board holds 2 ticket row(s) without a team — the root cannot be shared until team a's board reconciles and stamps them` });
});

test('_reconcileTickets stamps legacy rows only while the team is alone on its root', (t) => {
  const { h, m } = mkShared(t, { teams: ['a'] });
  h.store.save(h.root, [row('t1', null), row('t2', 'a')]);
  m._reconcileTickets(h.tm.loadManifest('a'));
  assert.deepStrictEqual(h.store.load(h.root).map((r) => [r.id, r.team]), [['t1', 'a'], ['t2', 'a']]);

  h.writeTeam('b', 'b-lead');
  h.store.save(h.root, [row('t1', null), row('t2', 'a')]);
  m._reconcileTickets(h.tm.loadManifest('a'));
  const after = h.store.load(h.root);
  assert.strictEqual(after.find((r) => r.id === 't2').team, 'a', 'ENTER: the stamped row survives');
  assert.ok(!('team' in after.find((r) => r.id === 't1')), 'a two-team root leaves the legacy row untouched');
});

test('task add writes the team on the new row', (t) => {
  const { h, m, seat } = mkShared(t);
  const lead = seat('a-lead');
  m._handleTask(lead, { type: 'task', sub: 'add', who: null, park: true, body: 'Do the thing' });
  const rows = h.store.load(h.root);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.team]), [['t1', 'a']]);
});

test('a lead\'s mutating verbs on the other team\'s row are refused naming that team\'s lead; so is a hand\'s done', (t) => {
  const { h, m, injected, seat } = mkShared(t);
  h.writeRoster('b', [['b-hand-1', 'hand']]);
  h.store.save(h.root, [row('t1', 'a'), row('t2', 'b')]);
  const leadA = seat('a-lead');
  const handB = seat('b-hand-1');
  m._handleTask(leadA, { type: 'task', sub: 'start', id: 't2' });
  m._handleTask(leadA, { type: 'task', sub: 'assign', id: 't2', who: 'hand' });
  m._handleTask(leadA, { type: 'task', sub: 'cancel', id: 't2', body: '' });
  m._handleTask(handB, { type: 'task', sub: 'done', id: 't1', body: 'did it' });
  assert.deepStrictEqual(injected.slice(0, 3), [
    '[agent:task] error: t2 belongs to team b — its lead (b-lead) dispatches it',
    '[agent:task] error: t2 belongs to team b — its lead (b-lead) dispatches it',
    '[agent:task] error: t2 belongs to team b — its lead (b-lead) dispatches it',
  ]);
  assert.match(injected[3], /^\[agent:task\] error: t1 belongs to team a — its lead \(a-lead\) dispatches it/);
  assert.deepStrictEqual(h.store.load(h.root).map((r) => [r.id, r.state]), [['t1', 'open'], ['t2', 'open']]);
});

test('task list from team a lists only a\'s rows and ends with the other team\'s count', (t) => {
  const { h, m, injected, seat } = mkShared(t);
  h.store.save(h.root, [row('t1', 'a'), row('t2', 'b'), row('t3', 'a')]);
  m._handleTask(seat('a-lead'), { type: 'task', sub: 'list' });
  const lines = injected[0].split('\n');
  assert.strictEqual(lines[0], '[agent:task] tickets on a:');
  assert.deepStrictEqual(lines.slice(1, -1).map((l) => l.split(' ')[0]), ['t1', 't3']);
  assert.strictEqual(lines[lines.length - 1], '(+1 rows of team b)');
});

test('retire refuses the other team\'s seat on the same root', async (t) => {
  const { h, m, seat } = mkShared(t);
  h.writeRoster('b', [['b-scout', 'scout']]);
  seat('a-lead');
  seat('b-scout');
  const sent = [];
  m._deliverMessage = (to, from, body) => sent.push([to, from, body]);
  await m._handleTeamRetire('b-scout', 'a-lead');
  assert.deepStrictEqual(sent, [['a-lead', 'clodex-team', 'retire b-scout refused: b-scout is on team b, not yours']]);
  assert.ok(m.sessions.has('b-scout'));
});

test('the hand cap counts each team\'s hands alone on a shared root', (t) => {
  const { h, m, seat } = mkShared(t);
  h.writeRoster('a', [['a-hand-1', 'hand'], ['a-hand-2', 'hand']]);
  h.writeRoster('b', [['b-hand-1', 'hand']]);
  seat('a-hand-1');
  seat('a-hand-2');
  seat('b-hand-1');
  assert.strictEqual(m._liveHandCount(h.tm.loadManifest('a')), 2);
  assert.strictEqual(m._liveHandCount(h.tm.loadManifest('b')), 1);
});

test('a seat cost stamp lands one row in each team\'s own ledger on a shared root', (t) => {
  const { h, m, seat } = mkShared(t);
  h.writeRoster('a', [['a-scout', 'scout']]);
  h.writeRoster('b', [['b-scout', 'scout']]);
  m._seatLedger = () => ({ ledger: { usd: 1.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 2, turns: 1 } });
  assert.strictEqual(m._stampSeatCost(seat('a-scout'), 'exit').ok, true);
  assert.strictEqual(m._stampSeatCost(seat('b-scout'), 'exit').ok, true);
  const rows = (n) => fs.readFileSync(path.join(h.home, 'teams', n, 'cost.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(rows('a').map((r) => [r.seat, r.team]), [['a-scout', 'a']]);
  assert.deepStrictEqual(rows('b').map((r) => [r.seat, r.team]), [['b-scout', 'b']]);
});

test('two teams\' merges on one root serialise on the merge chain, in order', async (t) => {
  const { h, m } = mkShared(t);
  const events = [];
  const gates = {};
  m._autoMergeTicket = (team, id) => {
    events.push(`start ${team.name}/${id}`);
    return new Promise((resolve) => { gates[id] = () => { events.push(`end ${team.name}/${id}`); resolve(); }; });
  };
  const first = m._queueAutoMerge(h.tm.loadManifest('a'), 't1', null, '');
  const second = m._queueAutoMerge(h.tm.loadManifest('b'), 't2', null, '');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(events, ['start a/t1']);
  gates.t1();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(events, ['start a/t1', 'end a/t1', 'start b/t2']);
  gates.t2();
  await second;
  assert.deepStrictEqual(events, ['start a/t1', 'end a/t1', 'start b/t2', 'end b/t2']);
});
