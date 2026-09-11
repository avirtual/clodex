'use strict';
// Run: node --test test/merged-notice-owes-accept.test.js
//
// t817 — a lead that reads a verdict is not a lead that merged it, and a lead
// that reads a MERGED notice is not a lead that accepted it. Twice a lead logged
// an ACCEPT and never emitted `[agent:task accept]`; the notice arrived inside a
// mid-turn tool result and read as information rather than a step owed.
//
// Three surfaces, one claim each:
//   1. the reviewer ACCEPT dm says what to do NEXT, and says it is not yet;
//   2. the MERGED notice opens with the step, above the report it used to hide
//      the verb underneath;
//   3. a merged ticket left unaccepted for ten minutes is reminded ONCE.
//
// Every rendered `[agent:task accept …]` in this file is checked for COLUMN 1.
// That is not stylistic: IntentScanner's parse is ^-anchored, so a verb opening
// a line makes the LEAD accept on receipt — retiring the seat and destroying the
// worktree, which no revert undoes. The hazard is documented at both production
// sites and pinned here against the real scanner rather than a regex.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { mkPark } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const ticketsMod = require('../tickets-store');
const { parseIntent } = require('../intent-scanner');

// The ^-anchored parse the production comments reason about, asked of the REAL
// scanner. A regex here would be a second implementation of the rule, free to
// disagree with the one that fires on the lead's screen.
function firesAnyIntent(body) {
  return String(body).split('\n').some((line) => parseIntent(line) !== null);
}

function mkLoop({ ticket = {} } = {}) {
  const home = mkTmpRoot('clodex-t817-');
  const root = pathReal.join(home, 'proj');
  fsReal.mkdirSync(root, { recursive: true });
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root, lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const gated = [];
  const urgents = [];
  const { m } = mkPark({
    REGISTRY_DIR: home,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    resolveTeam: (cwd) => (cwd && cwd.startsWith(root) ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith(root) ? root : null),
  });
  // Fires `onWrite`, because this stub models a delivery that REACHES THE WRITE.
  // The nudge stamps from that hook, so a stub that took the argument and never
  // called it would make the one-shot rule look permanently broken; the
  // never-written case is its own subject below, with its own stub.
  m._gatedDeliver = (target, sender, body, urgent, tag, onWrite) => {
    gated.push({ target, sender, body, tag });
    urgents.push(urgent);
    if (typeof onWrite === 'function') onWrite();
    return { queued: true };
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  // An ARRAY, which is the shape `_ticketAssigneeSeat` indexes with `.includes`
  // — the stall pass resolves the assignee through it, and a Set here answers
  // "orphaned" for a seat that is live.
  m._teamLiveSeatNames = () => ['lead', 'team-hand'];
  const seat = (name, cwd = root) => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  seat('lead');
  const rec = {
    id: 't1', state: 'done', spec: 'build the widget', assignee: 'team-hand', role: 'hand',
    openedAt: Date.now(), startedAt: Date.now(), lastActivityAt: Date.now(), closedAt: Date.now(),
    worktree: { path: pathReal.join(root, 'wt'), branch: 't1-build-the-widget', baseSha: 'deadbeef' },
    ...ticket,
  };
  tstore.save(root, [rec]);
  return {
    m, team, home, tstore, gated, urgents, seat,
    one: (id = 't1') => tstore.load(root).find((t) => t.id === id),
    patch: (fields, id = 't1') => {
      const ts = tstore.load(root);
      Object.assign(ts.find((t) => t.id === id), fields);
      tstore.save(root, ts);
    },
    // A SECOND row on the same board, for the two subjects about the merged pass
    // sitting beside the stall pass. One ticket cannot be both: the merged gate
    // requires `done` and the stall gate requires in-flight.
    add: (fields) => {
      const ts = tstore.load(root);
      ts.push({ ...rec, ...fields });
      tstore.save(root, ts);
    },
  };
}

// ── 1. the reviewer ACCEPT dm ───────────────────────────────────────────────

test('an ACCEPT verdict tells the lead the step it will owe, and that it is not owed yet', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 }, 'VERDICT: ACCEPT\n\nMUST-FIX: none');

  assert.strictEqual(f.gated.length, 1, 'ENTER: the lead was notified at all');
  const body = f.gated[0].body;
  assert.ok(body.includes('Nothing to do yet — the loop merges; when the [ticket t1 MERGED] notice lands, '
    + 'emit `[agent:task accept t1]` alone in a reply.'),
    `the sentence is the whole ticket — a lead told only "ACCEPT" logged it and stopped. Got:\n${body}`);
});

test('the appended sentence names the notice the lead is waiting FOR, not a step to take now', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 }, 'VERDICT: ACCEPT\n\nMUST-FIX: none');
  const body = f.gated[0].body;
  // The ORDER inside the sentence is the information: accepting here, before the
  // merge, destroys the worktree the merge is about to read. A sentence that led
  // with the verb would invite exactly that.
  assert.ok(body.indexOf('Nothing to do yet') < body.indexOf('[agent:task accept t1]'),
    'the wait comes before the verb, or the lead accepts now and the merge loses its tree');
});

test('a REWORK verdict gets NO accept advice: it owes a reject, and the loop merges nothing', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'REWORK', mustFix: '- fix the thing', reviewRound: 1 }, 'VERDICT: REWORK\n\nMUST-FIX\n- fix the thing');

  assert.strictEqual(f.gated.length, 1, 'ENTER: the REWORK notification still goes out');
  const body = f.gated[0].body;
  assert.ok(!body.includes('the loop merges'),
    'nothing merges on a REWORK, so promising a MERGED notice that will never arrive leaves the lead waiting for it');
  assert.ok(!body.includes('[agent:task accept'),
    'and accepting a ticket that was just sent back would retire the seat mid-rework');
});

test('the ACCEPT sentence keeps its verb off column 1', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 }, 'VERDICT: ACCEPT\n\nMUST-FIX: none');
  const body = f.gated[0].body;
  assert.ok(body.includes('[agent:task accept t1]'),
    'ENTER: a complete, ready-to-fire verb really is in this body, or the check below is vacuous');
  assert.ok(!firesAnyIntent(body),
    'no line in the verdict dm may PARSE as an intent — the lead would accept on receipt, destroying the worktree '
    + 'before the merge, which is the one action here no revert undoes');
});

// ── 2. the MERGED notice ────────────────────────────────────────────────────

const LANDED = {
  branch: 't1-build-the-widget', sha: 'abc1234', rounds: 1, summary: '4999 pass, 0 fail',
  changelog: { known: true, touched: true, present: true }, unioned: null,
};

test('the MERGED notice opens with the step owed, above the report', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', LANDED);

  assert.strictEqual(f.gated.length, 1, 'ENTER: the notice was sent');
  const lines = f.gated[0].body.split('\n');
  assert.match(lines[0], /^\[ticket t1 MERGED\]/, 'ENTER: the header still leads');
  assert.strictEqual(lines[2],
    'Step owed: `[agent:task accept t1]` — alone in a reply, no tool call beside it.',
    `the step is the FIRST thing under the header. Got:\n${f.gated[0].body}`);
});

test('the step line precedes every fact the notice reports', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  const body = f.gated[0].body;
  // Position is the fix, not the wording: the old notice mentioned the verb only
  // in its closing sentence, under the suite line and the CHANGELOG line, and two
  // leads read the whole thing as a report and acted on none of it.
  //
  // The ENTER is load-bearing and was ADDED after a red-proof: `indexOf` answers
  // -1 for an absent line, and -1 precedes every real offset, so all three
  // comparisons below pass VACUOUSLY on a notice with no step line at all.
  assert.ok(body.includes('Step owed:'),
    'ENTER: the step line is in the body — without this every comparison below is satisfied by its absence');
  assert.ok(body.indexOf('Step owed:') < body.indexOf('Review rounds:'),
    'the step must sit above the review/suite report');
  assert.ok(body.indexOf('Step owed:') < body.indexOf('CHANGELOG.md'),
    'and above the CHANGELOG line, which is the line that used to bury it');
  assert.ok(body.indexOf('Step owed:') < body.indexOf('Nothing was torn down'),
    'and above the closing reassurance, which is where the verb used to live alone');
});

test('the MERGED notice still fires no intent, with the step line added', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  const body = f.gated[0].body;
  // TWO copies of the verb now — the step line and the closing sentence — so the
  // column-1 hazard has two places to be reintroduced rather than one.
  assert.strictEqual(body.split('[agent:task accept t1]').length - 1, 2,
    'ENTER: both renders are present, or this subject is checking fewer lines than ship');
  assert.ok(!firesAnyIntent(body),
    'a reflow that put either copy at the start of a line would make the lead auto-accept on receipt');
});

test('the merge stamps mergedAt, which is what arms the reminder', () => {
  const f = mkLoop();
  const before = Date.now();
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  const t = f.one();
  assert.ok(typeof t.mergedAt === 'number', 'the merge instant is on the record');
  assert.ok(t.mergedAt >= before, 'and it is this merge, not a stale one');
  assert.strictEqual(t.mergedNudgedAt, undefined, 'nothing has been nudged yet — the notice just went out');
});

test('the stamp survives a notice the lead never received', () => {
  const f = mkLoop();
  // HELD: the lead is blocked on a permission dialog, so the notice reaches
  // nobody. That is the case the reminder matters MOST in, so the stamp cannot
  // be taken off the delivery result.
  f.m._gatedDeliver = () => ({ held: 'blocked on a permission dialog' });
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  assert.ok(typeof f.one().mergedAt === 'number',
    'a held notice still arms the reminder — otherwise the one channel that failed silences the backup too');
});

// ── 3. the ten-minute reminder ──────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

test('nine minutes after the merge, nothing is said', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  await f.m._sweepTeamTickets(f.team, T0 + (9 * MIN));
  assert.deepStrictEqual(f.gated, [],
    'the lead is mid-turn on something else; a reminder at nine minutes is a nag, not a catch');
});

test('at ten minutes the lead is reminded, once, with the step', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));

  assert.strictEqual(f.gated.length, 1, 'exactly one reminder');
  assert.strictEqual(f.gated[0].target, 'lead', 'and it goes to the lead, who owes the step');
  assert.strictEqual(f.gated[0].body,
    '[ticket t1 merged 10m ago, not accepted] Step owed: `[agent:task accept t1]`.',
    'the whole body, byte for byte — it is one line and every byte of it is the instruction');
  assert.strictEqual(f.urgents[0], false,
    'nothing is stuck: the branch is on master and the cost of waiting is a worktree, so waking an idle lead '
    + 'to re-bill its context would cost more than the wait');
});

test('the reminder never fires twice, however long the ticket sits', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.strictEqual(f.gated.length, 1, 'ENTER: the first reminder went out and was stamped');
  assert.strictEqual(f.one().mergedNudgedAt, T0 + (10 * MIN),
    'ENTER: stamped with the sweep`s instant, which is what the gate reads back');

  await f.m._sweepTeamTickets(f.team, T0 + (20 * MIN));
  await f.m._sweepTeamTickets(f.team, T0 + (60 * MIN));
  assert.strictEqual(f.gated.length, 1,
    'a lead leaving a merged ticket open is a DECISION — it keeps the worktree. Repeating the reminder every '
    + 'sweep would bill a turn an hour to re-ask a question already answered');
});

test('a reminder that reached nobody is not spent', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  // Held: no park, no write, nobody read it. Stamping anyway would burn the one
  // reminder on a delivery that never happened — a silent deletion, which is the
  // failure mode this sweep exists to close.
  f.m._gatedDeliver = () => ({ held: 'blocked on a permission dialog' });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.strictEqual(f.one().mergedNudgedAt, undefined,
    'the stamp rides the WRITE, so a held reminder leaves the ticket eligible for the next sweep');
});

test('an ACCEPTED ticket is not reminded — the step has been taken', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0, acceptedAt: T0 + MIN, closedOut: true });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.deepStrictEqual(f.gated, [],
    'the lead already accepted; naming the step again points it at a retired seat and a deleted tree');
});

test('an accept that did NOT close out still counts as taken', async () => {
  const f = mkLoop();
  // The dirty-tree and standing-seat arms stamp `acceptedAt` and leave the tree
  // standing, so `closedOut` alone would re-remind a lead that has already acted.
  f.patch({ mergedAt: T0, acceptedAt: T0 + MIN });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.deepStrictEqual(f.gated, [], 'acceptedAt is the step being taken, whatever the accept then removed');
});

test('a MERGE FAILED ticket is not reminded: it owes a different step', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0, mergeError: 'suite' });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.deepStrictEqual(f.gated, [],
    'that escalation already told the lead what to decide first, and `task accept` there ANSWERS the mark '
    + 'rather than retiring a clean merge — this reminder would send the lead straight past the decision');
});

test('a ticket that never merged is never reminded', async () => {
  const f = mkLoop();
  // No `mergedAt` at all: the whole board's open and done tickets pass through
  // this pass every sweep, and a gate keyed on state alone would nudge each one.
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.deepStrictEqual(f.gated, [], 'no merge, no step owed');
});

test('the reminder reports the MEASURED age, not the literal window', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  // A machine asleep through the window wakes and sweeps at whatever age it
  // reaches. Printing "10m" there is a number the lead can check and find false,
  // and one false number in a reminder is how a lead learns to skip the line.
  await f.m._sweepTeamTickets(f.team, T0 + (3 * 60 * MIN));
  assert.strictEqual(f.gated.length, 1, 'ENTER: the late sweep still reminded');
  assert.match(f.gated[0].body, /^\[ticket t1 merged 3h ago, not accepted\]/,
    'the age is the one measured at the sweep');
});

test('the reminder fires no intent either', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0 });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  const body = f.gated[0].body;
  assert.ok(body.includes('[agent:task accept t1]'), 'ENTER: the verb is rendered complete in this body');
  assert.ok(!firesAnyIntent(body),
    'this body is one line and the verb sits mid-line; leading with it would make the reminder DO the thing '
    + 'it is reminding about');
});

// A board carrying BOTH shapes: an open ticket whose seat has gone quiet, and a
// merged one waiting on the lead. The two passes walk the same array, and each
// ticket must be seen by exactly one of them — the merged gate needs `done`, the
// stall gate needs in-flight, and a row satisfying both would be reported twice.
function mkBothShapes() {
  const f = mkLoop();
  f.patch({ state: 'open', lastActivityAt: T0 - (4 * 60 * MIN) });
  f.add({ id: 't2', state: 'done', mergedAt: T0 - (10 * MIN) });
  return f;
}

test('the two passes each speak once, about their own ticket', async () => {
  const f = mkBothShapes();
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: 60 * MIN }, T0);

  assert.strictEqual(f.gated.length, 2, 'one alarm each, not two about either');
  const merged = f.gated.find((g) => /not accepted/.test(g.body));
  const stalled = f.gated.find((g) => /stalled/.test(g.body));
  assert.ok(merged && /^\[ticket t2 /.test(merged.body), 'the reminder is about the MERGED ticket');
  assert.ok(stalled && /t1/.test(stalled.body), 'and the stall alarm is about the open one, unchanged');
});

test('a throw in the merged pass does not cost the stall alarm', async () => {
  const f = mkBothShapes();
  // The merged pass is an addition to a sweep that already had a job, and it runs
  // FIRST. An exception escaping it would take the stall ladder — the alarm this
  // module's whole watchdog exists for — down with it, silently and for every
  // board on the machine.
  const realDeliver = f.m._gatedDeliver;
  f.m._gatedDeliver = (...args) => {
    if (/not accepted/.test(args[2])) throw new Error('the merged nudge blew up');
    return realDeliver(...args);
  };
  await f.m._sweepTeamTickets({ ...f.team, watchdogMs: 60 * MIN }, T0);
  assert.strictEqual(f.gated.length, 1, 'the stall alarm still went out');
  assert.match(f.gated[0].body, /stalled/, 'and it is the stall body — the merged pass failed alone');
});
