'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');

const T0 = 1_700_000_000_000;

function row(id, fields = {}) {
  return {
    id, title: `title ${id}`, spec: `spec ${id}`, state: 'open', team: 'team', assignee: null,
    openedAt: T0, lastActivityAt: T0, events: [{ at: T0, kind: 'add', by: 'lead' }], ...fields,
  };
}

function mkBoard({ board = [], archived = [] } = {}) {
  const home = mkTmpRoot('clodex-t2213-');
  const root = pathReal.join(home, 'proj');
  fsReal.mkdirSync(root, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home, warn: () => {} });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
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
    lastOp: (id) => fsReal.readFileSync(tstore.archivePath(root), 'utf-8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((r) => (r.row ? r.row.id : r.id) === id).pop().op,
  };
}

function assertRestored(f, id) {
  const back = f.board().find((t) => t.id === id);
  assert.ok(back, `${id} is back on the board. Replies: ${f.replies.join(' | ')}`);
  assert.strictEqual(f.lastOp(id), 'restore', `the archive's last op for ${id} is restore`);
  assert.strictEqual(f.tstore.readArchive(f.root).has(id), false, `${id} no longer reads as archived`);
  return back;
}

test('archive restore: task reject on an archived done ticket restores it and reopens it', () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t4', { state: 'done', closedAt: T0, closedBy: 'team-hand' })] });
  f.m._taskReject(f.lead, f.team, { type: 'task', sub: 'reject', id: 't4', who: null, body: 'one more round' }, f.reply);
  const back = assertRestored(f, 't4');
  assert.strictEqual(back.state, 'open', 'the reject then acted on the restored row');
  assert.ok(!f.replies.some((r) => /no ticket t4/.test(r)), `not refused as missing: ${f.replies.join(' | ')}`);
});

test('archive restore: task accept on an archived branchless done ticket restores and accepts it', async () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t5', { state: 'done', closedAt: T0, closedBy: 'lead' })] });
  await f.m._taskAccept(f.lead, f.team, { type: 'task', sub: 'accept', id: 't5', who: null, body: 'fine' }, f.reply);
  const back = assertRestored(f, 't5');
  assert.ok(back.acceptedAt, `the accept stamped the restored row: ${f.replies.join(' | ')}`);
});

test('archive restore: task respec on an archived open ticket restores it and replaces the spec', () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t6')] });
  f.m._taskRespec(f.lead, f.team, { type: 'task', sub: 'respec', id: 't6', who: null, body: 'the corrected spec' }, f.reply);
  const back = assertRestored(f, 't6');
  assert.strictEqual(back.spec, 'the corrected spec', `respec acted: ${f.replies.join(' | ')}`);
});

test('archive restore: task cancel on an archived open ticket restores it and cancels it', () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t7')] });
  f.m._taskCancel(f.lead, f.team, { type: 'task', sub: 'cancel', id: 't7', who: null, body: 'not needed' }, f.reply);
  const back = assertRestored(f, 't7');
  assert.strictEqual(back.state, 'cancelled', `cancel acted: ${f.replies.join(' | ')}`);
});

test('archive restore: the lead\'s task done on an archived open ticket restores it and closes it', () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t8', { assignee: 'lead' })] });
  f.m._taskDone(f.lead, f.team, { type: 'task', sub: 'done', id: 't8', who: null, body: 'did it myself' }, f.reply);
  const back = assertRestored(f, 't8');
  assert.strictEqual(back.state, 'done', `done acted: ${f.replies.join(' | ')}`);
});

test('archive restore: the row comes back with its id and every field', () => {
  const archived = row('t4', { state: 'done', closedAt: T0, report: 'r', worktree: { path: '/x', branch: 't4-x' } });
  const f = mkBoard({ board: [row('t9')], archived: [archived] });
  assert.deepStrictEqual(f.tstore.restore(f.root, 't4'), archived);
  assert.deepStrictEqual(f.board(), [row('t9'), archived]);
  assert.strictEqual(f.tstore.restore(f.root, 't4'), null, 'a row already on the board is not restored twice');
  assert.strictEqual(f.tstore.restore(f.root, 't77'), null, 'an id in neither place is null');
});

test('archive restore: a crash after the restore line and before the board save is repaired by restore', () => {
  const archived = row('t4', { state: 'done', closedAt: T0 });
  const f = mkBoard({ board: [row('t9')], archived: [archived] });
  f.tstore.appendRestore(f.root, 't4');
  assert.strictEqual(f.lastOp('t4'), 'restore', 'ENTER: the restore line is the last op');
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t9'], 'ENTER: and the row is on neither side');
  const lines = () => fsReal.readFileSync(f.tstore.archivePath(f.root), 'utf-8').trim().split('\n').length;
  const before = lines();
  assert.deepStrictEqual(f.tstore.restore(f.root, 't4'), archived);
  assert.deepStrictEqual(f.board(), [row('t9'), archived]);
  assert.strictEqual(lines(), before, 'the repair writes no second restore line');
});

test('archive: _loadTicket falls back to the archived row without restoring it', () => {
  const archived = row('t4', { state: 'done', closedAt: T0 });
  const f = mkBoard({ board: [row('t9')], archived: [archived] });
  const before = f.board();
  assert.deepStrictEqual(f.m._loadTicket(f.team, 't4'), archived);
  assert.strictEqual(f.m._loadTicket(f.team, 't4', { boardOnly: true }), null);
  assert.deepStrictEqual(f.board(), before);
  assert.strictEqual(f.tstore.readArchive(f.root).has('t4'), true, 'still archived');
});

test('archive: readArchive rows are frozen', () => {
  const f = mkBoard({ archived: [row('t4', { worktree: { path: '/x' } })] });
  const got = f.tstore.readArchive(f.root).get('t4');
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.worktree) && Object.isFrozen(got.events[0]));
});

test('archive: task list all shows a live and an archived row, the open list only the live one', () => {
  const f = mkBoard({ board: [row('t9', { title: 'live one' })], archived: [row('t4', { title: 'archived one', state: 'done', closedAt: T0 })] });
  const later = T0 + 30 * 24 * 60 * 60 * 1000;
  const all = f.m._taskListText(f.team, 'all', later, 'team');
  assert.ok(all.includes('t9') && all.includes('live one'), `ENTER: the live row is listed:\n${all}`);
  assert.ok(all.includes('t4') && all.includes('archived one'), `the archived row is listed too:\n${all}`);
  const open = f.m._taskListText(f.team, 'open', later, 'team');
  assert.ok(open.includes('live one'), `ENTER: the open list shows the live row:\n${open}`);
  assert.ok(!open.includes('archived one'), `and not the archived one:\n${open}`);
  assert.ok(open.includes('(1 done, 0 cancelled'), `the open view's tail counts the archived row:\n${open}`);
});

test('archive: _taskAdd allocates above the meta floor, not the board max', () => {
  const f = mkBoard({ board: [row('t1'), row('t3', { state: 'done', closedAt: T0 })] });
  f.tstore.writeMeta(f.root, { maxId: 40 });
  f.m._taskAdd(f.lead, f.team, { type: 'task', sub: 'add', who: null, body: 'next ticket', park: true }, f.reply);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't3', 't41'], f.replies.join(' | '));
});

test('archive: _taskAdd refuses when the meta file exists but cannot be read', { skip: process.getuid && process.getuid() === 0 }, (t) => {
  const f = mkBoard({ board: [row('t1')] });
  f.tstore.writeMeta(f.root, { maxId: 40 });
  fsReal.chmodSync(f.tstore.metaPath(f.root), 0o000);
  t.after(() => fsReal.chmodSync(f.tstore.metaPath(f.root), 0o600));
  assert.throws(() => f.tstore.readMeta(f.root), { code: 'EACCES' });
  assert.throws(() => f.m._taskAdd(f.lead, f.team, { type: 'task', sub: 'add', who: null, body: 'next ticket', park: true }, f.reply),
    { code: 'EACCES' });
  assert.deepStrictEqual(f.board().map((x) => x.id), ['t1'], 'no id was issued');
});

test('archive: a crashed half-restore stays visible to task list all and _loadTicket, and restore repairs it', () => {
  const archived = row('t4', { title: 'archived one', state: 'done', closedAt: T0 });
  const f = mkBoard({ board: [row('t9', { title: 'live one' })], archived: [archived] });
  f.tstore.appendRestore(f.root, 't4');
  assert.strictEqual(f.lastOp('t4'), 'restore', 'ENTER: the restore line is the last op');
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t9'], 'ENTER: and the board was never saved with the row');
  const all = f.m._taskListText(f.team, 'all', T0 + 30 * 24 * 60 * 60 * 1000, 'team');
  assert.ok(all.includes('live one'), `ENTER: the live row is listed:\n${all}`);
  assert.ok(all.includes('t4') && all.includes('archived one'), `the half-restored row is listed:\n${all}`);
  assert.deepStrictEqual(f.m._loadTicket(f.team, 't4'), archived);
  assert.deepStrictEqual(f.tstore.restore(f.root, 't4'), archived);
  assert.deepStrictEqual(f.board(), [row('t9', { title: 'live one' }), archived]);
});

test('archive: _taskAdd floors the id at the highest id ever archived when the meta is garbage', () => {
  const f = mkBoard({ board: [row('t1'), row('t3', { state: 'done', closedAt: T0 })], archived: [row('t20'), row('t50')] });
  f.tstore.appendRestore(f.root, 't50');
  fsReal.writeFileSync(f.tstore.metaPath(f.root), 'garbage');
  assert.deepStrictEqual(f.tstore.readMeta(f.root), { maxId: 0 }, 'ENTER: the meta reads as no floor');
  f.m._taskAdd(f.lead, f.team, { type: 'task', sub: 'add', who: null, body: 'next ticket', park: true }, f.reply);
  assert.deepStrictEqual(f.board().map((t) => t.id), ['t1', 't3', 't51'], f.replies.join(' | '));
});

test('archive: _stampTicketRevival by seat restores the seat\'s archived row and stamps it', () => {
  const f = mkBoard({ board: [row('t9')], archived: [row('t4', { assignee: 'team-hand-t4', state: 'done', closedAt: T0 })] });
  const out = f.m._stampTicketRevival(f.team, 'team-hand-t4');
  assert.ok(out, 'a ticket was stamped');
  const back = assertRestored(f, 't4');
  assert.strictEqual(back.revival.seat, 'team-hand-t4');
});
