'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const NOW = T0 + 30 * DAY;
const WEEK = 7 * DAY;

function row(id, fields = {}) {
  return {
    id, title: `title ${id}`, spec: `spec ${id}`, state: 'open', team: 'team', assignee: null,
    openedAt: T0, lastActivityAt: T0, events: [{ at: T0, kind: 'add', by: 'lead' }], ...fields,
  };
}

function mkTeam(home, root, name) {
  return {
    name, root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', name, 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
}

function mkBoard({ board = [], archived = [] } = {}) {
  const home = mkTmpRoot('clodex-t2215-');
  const root = pathReal.join(home, 'proj');
  fsReal.mkdirSync(root, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home, warn: () => {} });
  const team = mkTeam(home, root, 'team');
  const { m } = mkPark({
    REGISTRY_DIR: home,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    gitWorktree: require('../git-worktree'),
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
  });
  m._gatedDeliver = () => ({ queued: true });
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._teamLiveSeatNames = () => ['lead'];
  m.sessions.set('lead', { name: 'lead', type: 'claude', agentType: 'claude', cwd: root, pty: { pid: 1 }, activityState: 'idle' });
  tstore.save(root, board);
  if (archived.length) tstore.appendArchive(root, archived);
  const replies = [];
  return {
    m, team, home, root, tstore, replies,
    lead: m.sessions.get('lead'),
    reply: (msg) => replies.push(msg),
    board: () => tstore.load(root),
    archiveLines: () => {
      let raw = '';
      try { raw = fsReal.readFileSync(tstore.archivePath(root), 'utf-8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    },
  };
}

const PREDICATE_ROWS = [
  { name: 'cancelled, closed 30d ago', t: { state: 'cancelled', closedAt: T0, events: [] }, want: true },
  { name: 'done + acceptedAt, 30d ago', t: { state: 'done', closedAt: T0, acceptedAt: T0, events: [] }, want: true },
  { name: 'done + closedOut, 30d ago', t: { state: 'done', closedAt: T0, closedOut: true, events: [] }, want: true },
  { name: 'done + loopClosedOut, 30d ago', t: { state: 'done', closedAt: T0, loopClosedOut: { at: T0, text: 'x' }, events: [] }, want: true },
  { name: 'done with no acceptance stamp', t: { state: 'done', closedAt: T0, events: [] }, want: false },
  { name: 'open, 30d quiet', t: { state: 'open', closedAt: null, events: [{ at: T0 }] }, want: false },
  { name: 'done + acceptedAt + loopStep', t: { state: 'done', closedAt: T0, acceptedAt: T0, loopStep: 'verify', events: [] }, want: false },
  { name: 'done + acceptedAt + verifyHold', t: { state: 'done', closedAt: T0, acceptedAt: T0, verifyHold: true, events: [] }, want: false },
  { name: 'done + acceptedAt + verifyPhase', t: { state: 'done', closedAt: T0, acceptedAt: T0, verifyPhase: 'suite', events: [] }, want: false },
  { name: 'done + acceptedAt + mergeWaiting', t: { state: 'done', closedAt: T0, acceptedAt: T0, mergeWaiting: true, events: [] }, want: false },
  { name: 'cancelled 6d ago', t: { state: 'cancelled', closedAt: NOW - 6 * DAY, events: [] }, want: false },
  { name: 'cancelled exactly 7d ago', t: { state: 'cancelled', closedAt: NOW - 7 * DAY, events: [] }, want: true },
  { name: 'cancelled old, an event 1d ago', t: { state: 'cancelled', closedAt: T0, events: [{ at: NOW - DAY }] }, want: false },
  { name: 'done old, accepted 2d ago', t: { state: 'done', closedAt: T0, acceptedAt: NOW - 2 * DAY, events: [] }, want: false },
  { name: 'cancelled, ISO closedAt 30d ago', t: { state: 'cancelled', closedAt: new Date(T0).toISOString(), events: [] }, want: true },
  { name: 'cancelled, ISO event 1d ago', t: { state: 'cancelled', closedAt: T0, events: [{ at: new Date(NOW - DAY).toISOString() }] }, want: false },
  { name: 'cancelled with no timestamp at all', t: { state: 'cancelled' }, want: false },
];

for (const r of PREDICATE_ROWS) {
  test(`archivable: ${r.name} → ${r.want}`, () => {
    assert.strictEqual(ticketsMod.archivable({ id: 't1', ...r.t }, NOW, WEEK), r.want);
  });
}

test('archive pass: moves only eligible rows, oldest first, capped at maxRows, and writes meta at the board max', () => {
  const f = mkBoard({
    board: [
      row('t1'),
      row('t2', { state: 'cancelled', closedAt: T0 + 3 * DAY, events: [] }),
      row('t3', { state: 'done', closedAt: T0 + DAY, acceptedAt: T0 + DAY, events: [] }),
      row('t4', { state: 'done', closedAt: T0, events: [] }),
      row('t5', { state: 'cancelled', closedAt: NOW - DAY, events: [] }),
      row('t9', { state: 'cancelled', closedAt: T0, events: [] }),
    ],
  });
  const res = f.tstore.archiveOldTickets(f.root, { now: NOW, maxRows: 2 });
  assert.strictEqual(res.moved, 2);
  assert.strictEqual(res.remaining, 1);
  assert.strictEqual(typeof res.ms, 'number');
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't2', 't4', 't5']);
  assert.deepStrictEqual(f.archiveLines().map((l) => [l.op, l.row.id]), [['archive', 't9'], ['archive', 't3']]);
  assert.deepStrictEqual(f.tstore.readMeta(f.root), { maxId: 9 });

  const again = f.tstore.archiveOldTickets(f.root, { now: NOW, maxRows: 2 });
  assert.deepStrictEqual([again.moved, again.remaining], [1, 0]);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't4', 't5']);

  f.m._taskAdd(f.lead, f.team, { type: 'task', sub: 'add', who: null, body: 'next ticket', park: true }, f.reply);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't4', 't5', 't10'], f.replies.join(' | '));
});

test('archive pass: meta never drops below an existing higher floor', () => {
  const f = mkBoard({ board: [row('t3', { state: 'cancelled', closedAt: T0, events: [] })] });
  f.tstore.writeMeta(f.root, { maxId: 70 });
  f.tstore.archiveOldTickets(f.root, { now: NOW });
  assert.deepStrictEqual(f.tstore.readMeta(f.root), { maxId: 70 });
});

test('archive pass: nothing eligible writes nothing', () => {
  const f = mkBoard({ board: [row('t1'), row('t2', { state: 'done', closedAt: T0, events: [] })] });
  const before = fsReal.statSync(f.tstore.ticketsPath(f.root)).mtimeMs;
  assert.deepStrictEqual(f.tstore.archiveOldTickets(f.root, { now: NOW }).moved, 0);
  assert.strictEqual(fsReal.existsSync(f.tstore.archivePath(f.root)), false);
  assert.strictEqual(fsReal.existsSync(f.tstore.metaPath(f.root)), false);
  assert.strictEqual(fsReal.statSync(f.tstore.ticketsPath(f.root)).mtimeMs, before);
});

test('archive pass: a crash between append and save leaves the row on both sides; readers show it once and the next pass drops it with no second line', () => {
  const old = row('t3', { state: 'cancelled', closedAt: T0, events: [] });
  const f = mkBoard({ board: [row('t1'), old] });
  f.tstore.appendArchive(f.root, [f.board()[1]]);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't3'], 'ENTER: the row is still on the board');
  assert.strictEqual(f.archiveLines().length, 1, 'ENTER: and archived once');
  assert.strictEqual(f.tstore.withArchive(f.root).filter((t) => t.id === 't3').length, 1, 'withArchive shows it once');
  const all = f.m._taskListText(f.team, 'all', NOW, 'team');
  assert.strictEqual(all.split('title t3').length - 1, 1, `task list all shows it once:\n${all}`);

  const res = f.tstore.archiveOldTickets(f.root, { now: NOW });
  assert.strictEqual(res.moved, 1);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1']);
  assert.deepStrictEqual(f.archiveLines().map((l) => [l.op, l.row.id]), [['archive', 't3']], 'no second archive line');
  assert.deepStrictEqual(f.m._loadTicket(f.team, 't3'), old);
});

test('archive pass: a board row that changed since its archive line is archived again', () => {
  const f = mkBoard({ board: [row('t3', { state: 'cancelled', closedAt: T0, events: [], title: 'new title' })], archived: [row('t3', { state: 'cancelled', closedAt: T0, events: [] })] });
  f.tstore.archiveOldTickets(f.root, { now: NOW });
  assert.deepStrictEqual(f.archiveLines().map((l) => l.row.title), ['title t3', 'new title']);
  assert.strictEqual(f.m._loadTicket(f.team, 't3').title, 'new title');
});

test('archive pass: task reject on a ticket the pass moved restores and reopens it', () => {
  const f = mkBoard({ board: [row('t1'), row('t4', { state: 'done', closedAt: T0, acceptedAt: T0, closedBy: 'team-hand', events: [] })] });
  assert.strictEqual(f.tstore.archiveOldTickets(f.root, { now: NOW }).moved, 1);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1'], 'ENTER: the pass moved t4');
  f.m._taskReject(f.lead, f.team, { type: 'task', sub: 'reject', id: 't4', who: null, body: 'one more round' }, f.reply);
  const back = f.board().find((t) => t.id === 't4');
  assert.ok(back, `t4 is back on the board. Replies: ${f.replies.join(' | ')}`);
  assert.strictEqual(back.state, 'open');
  assert.deepStrictEqual(f.archiveLines().map((l) => l.op), ['archive', 'restore']);
  assert.strictEqual(f.tstore.readArchive(f.root).has('t4'), false);
});

test('archive: _taskAdd refuses when the archive file exists but cannot be read', { skip: process.getuid && process.getuid() === 0 }, (t) => {
  const f = mkBoard({ board: [row('t1')], archived: [row('t40', { state: 'cancelled', closedAt: T0 })] });
  fsReal.chmodSync(f.tstore.archivePath(f.root), 0o000);
  t.after(() => fsReal.chmodSync(f.tstore.archivePath(f.root), 0o600));
  assert.throws(() => f.tstore.archiveMaxId(f.root), { code: 'EACCES' });
  assert.throws(() => f.m._taskAdd(f.lead, f.team, { type: 'task', sub: 'add', who: null, body: 'next ticket', park: true }, f.reply),
    { code: 'EACCES' });
  assert.deepStrictEqual(f.board().map((x) => x.id), ['t1'], 'no id was issued');
});

function mkSweep(f) {
  const teamB = mkTeam(f.home, f.root, 'beta');
  f.m._teamOf = (s) => s._team;
  f.m._sweepTeamTickets = async () => {};
  f.m._reconcileTickets = () => {};
  f.m._resumeOrphanedVerify = () => {};
  f.m._startCapParked = () => {};
  f.m.sessions.clear();
  const seat = (name, team) => f.m.sessions.set(name, { name, agentType: 'claude', cwd: f.root, _team: team });
  return { teamB, seat };
}

test('archive hook: the pass runs once per root per day, across two teams sharing the root', async () => {
  const f = mkBoard({ board: [row('t1'), row('t2', { state: 'cancelled', closedAt: T0, events: [] })] });
  const { teamB, seat } = mkSweep(f);
  seat('a-lead', f.team);
  await f.m._sweepTickets(NOW);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1'], 'the first sweep after boot runs the pass');

  f.tstore.save(f.root, f.board().concat([row('t3', { state: 'cancelled', closedAt: T0, events: [] })]));
  seat('b-lead', teamB);
  await f.m._sweepTickets(NOW + 60 * 60 * 1000);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't3'], 'an hour later neither team re-runs it');

  await f.m._sweepTickets(NOW + DAY + 1);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1'], 'a day later it runs again');
  assert.deepStrictEqual(f.archiveLines().map((l) => l.row.id), ['t2', 't3']);
});

test('archive hook: a pass that left rows past the cap runs again on the next sweep', async () => {
  const board = [row('t1')];
  for (let i = 2; i <= 202; i++) board.push(row(`t${i}`, { state: 'cancelled', closedAt: T0 + i, events: [] }));
  const f = mkBoard({ board });
  const { seat } = mkSweep(f);
  seat('a-lead', f.team);
  await f.m._sweepTickets(NOW);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't202'], 'ENTER: the cap left one row');
  await f.m._sweepTickets(NOW + 60 * 1000);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1']);
});

test('archive hook: _archivePassFor reports the pass, then returns null inside the day', () => {
  const f = mkBoard({ board: [row('t1'), row('t2', { state: 'cancelled', closedAt: T0, events: [] })] });
  assert.deepStrictEqual([f.m._archivePassFor(f.root, NOW)].map((r) => [r.moved, r.remaining]), [[1, 0]]);
  assert.strictEqual(f.m._archivePassFor(f.root, NOW + DAY - 1), null);
  assert.notStrictEqual(f.m._archivePassFor(f.root, NOW + DAY), null);
});
