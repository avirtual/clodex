'use strict';
// Run: node --test test/merged-notice-owes-accept.test.js
//
// t817, rewritten at t825 — a lead that reads a MERGED notice is not a lead that
// accepted it. Twice a lead logged an ACCEPT and never emitted
// `[agent:task accept]`; the notice arrived inside a mid-turn tool result and
// read as information rather than a step owed. t817 answered that by putting the
// step at the top. t825 answers it better: on the happy path there is no step —
// a green merge is closed out by the loop, and the notice REPORTS that.
//
// Four surfaces, one claim each:
//   1. the verdict dm names no step and carries no reply address;
//   2. a green merge's notice says `Closed out:` and tears the reassurance out
//      with it; a close-out that could not finish still says `Step owed:`;
//   3. a `task accept` on a ticket the loop closed out changes nothing;
//   4. a merged ticket the loop did NOT close out is still reminded ONCE.
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

const { mk, mkPark } = require('./lib/session-fixtures');
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

// ── 1. the verdict dm ───────────────────────────────────────────────────────

test('an ACCEPT verdict names NO step: the loop merges, then closes the ticket out itself', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 1 }, 'VERDICT: ACCEPT\n\nMUST-FIX: none');

  assert.strictEqual(f.gated.length, 1, 'ENTER: the lead was notified at all');
  const body = f.gated[0].body;
  assert.ok(body.includes('ACCEPT on ticket t1'),
    `ENTER: this really is the verdict body, or every absence below is about the wrong message. Got:\n${body}`);
  assert.ok(!body.includes('Nothing to do yet'),
    'the sentence promised a step the lead would owe LATER; on a green merge no step is ever owed, so promising '
    + 'one trains the lead to go looking for a verb the MERGED notice will not ask for');
  assert.ok(!body.includes('[agent:task accept'),
    'and naming the verb at all invites an accept BEFORE the merge, which destroys the worktree the merge reads');
});

test('the verdict dm still says what landed and where the full text is', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'ACCEPT', mustFix: null, reviewRound: 2 }, 'VERDICT: ACCEPT\n\nMUST-FIX: none');
  const body = f.gated[0].body;
  // Removing the step must not turn the summary into a bare verdict word: the
  // round and the must-fix count are what a lead reads to decide whether to open
  // the full verdict at all.
  assert.match(body, /^ACCEPT on ticket t1 \(review round 2, no must-fixes\)\./m,
    `the summary line survives the step's removal. Got:\n${body}`);
  assert.ok(body.includes('Full verdict ('), 'and the pointer to the full prose does too');
});

test('a REWORK verdict is unchanged: its own body already says what to do', () => {
  const f = mkLoop();
  f.m._notifyLeadOfVerdict(f.seat('lead'), 'lead', 't1',
    { verdict: 'REWORK', mustFix: '- fix the thing', reviewRound: 1 }, 'VERDICT: REWORK\n\nMUST-FIX\n- fix the thing');

  assert.strictEqual(f.gated.length, 1, 'ENTER: the REWORK notification still goes out');
  const body = f.gated[0].body;
  assert.ok(body.includes('REWORK on ticket t1 (review round 1, 1 must-fix)'),
    `the summary is the message on this arm. Got:\n${body}`);
  assert.ok(!body.includes('[agent:task accept'),
    'accepting a ticket that was just sent back would retire the seat mid-rework');
});

test('both verdicts are sent as ticket-loop, so the footer cannot name a seat about to be reaped', () => {
  for (const verdict of ['ACCEPT', 'REWORK']) {
    const f = mkLoop();
    // The reviewer seat is LIVE at this moment — `_handleReviewDone` retires it a
    // few lines after this call — so sending under its own name passes
    // `_isDmReachable` and the delivery collects a reply address that is dead by
    // the time the lead reads it.
    f.seat('clodex-reviewer-t1');
    f.m._notifyLeadOfVerdict(f.m.sessions.get('clodex-reviewer-t1'), 'lead', 't1',
      { verdict, mustFix: verdict === 'REWORK' ? '- x' : null, reviewRound: 1 }, `VERDICT: ${verdict}`);
    assert.strictEqual(f.gated[0].sender, 'ticket-loop',
      `the ${verdict} verdict rides the loop's name, not the reviewer's`);
  }
});

test('a dm from ticket-loop carries no reply address, however reachable that name is', () => {
  // The footer path itself, through the REAL `_buildDeliveryText`. Checking the
  // sender string alone would go green on a name that was never added to
  // SYSTEM_SENDERS — the sender would be right and the trailer would still be
  // attached, which is the entire defect.
  const RE = /\(reply: start a line with \[agent:dm .+?\]/;
  const m = mk({
    getPeerManager: () => ({ statuses: () => [] }),
    getPersistence: () => ({ list: () => [], get: () => null }),
  });
  const target = { name: 'lead', agentType: 'claude' };
  m.sessions.set('ticket-loop', { name: 'ticket-loop', agentType: 'claude' });
  assert.strictEqual(m._isDmReachable('ticket-loop'), true,
    'ENTER: the name is reachable, or the guard is never reached and this subject proves nothing');
  assert.doesNotMatch(m._buildDeliveryText(target, 'ticket-loop', 'ACCEPT on ticket t1', 'dm'), RE,
    'nothing is on the other end of ticket-loop: a lead that replies to it is talking to a label');
  // Not a blanket mute: an ordinary sender still advertises its address.
  m.sessions.set('clodex-hand-1', { name: 'clodex-hand-1', agentType: 'claude' });
  assert.match(m._buildDeliveryText(target, 'clodex-hand-1', 'done', 'dm'), RE,
    'a live seat is still answerable, or the guard was widened into a mute');
});

// ── 2. the MERGED notice ────────────────────────────────────────────────────

const LANDED = {
  branch: 't1-build-the-widget', sha: 'abc1234', rounds: 1, summary: '4999 pass, 0 fail',
  changelog: { known: true, touched: true, present: true }, unioned: null,
};

// What `_closeOutMergedTicket` hands back on the row-1 teardown: seat retired,
// worktree removed, branch deleted, nothing left for anyone to do.
const CLOSED = {
  ok: true,
  closedOut: true,
  text: 'ticket t1 accepted — merged into master; team-hand retired and its worktree removed; '
    + 'branch t1-build-the-widget deleted.',
};

test('a green merge that closed out REPORTS the final state, and owes nothing', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: CLOSED });

  assert.strictEqual(f.gated.length, 1, 'ENTER: the notice was sent');
  const lines = f.gated[0].body.split('\n');
  assert.match(lines[0], /^\[ticket t1 MERGED\]/, 'ENTER: the header still leads');
  assert.strictEqual(lines[2],
    'Closed out: merged into master; team-hand retired and its worktree removed; '
    + 'branch t1-build-the-widget deleted.',
    `the final state is the FIRST thing under the header, in the accept's own words. Got:\n${f.gated[0].body}`);
});

test('the close-out line drops the ticket id the header already carries', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: CLOSED });
  const body = f.gated[0].body;
  // `ticket t1 accepted — ` restated under a header that opens `[ticket t1
  // MERGED]` reads as a second event, which is the one thing this message exists
  // to stop being: it is ONE final report.
  assert.ok(!body.includes('ticket t1 accepted —'),
    `the accept's own opening is stripped, not repeated. Got:\n${body}`);
  assert.ok(body.includes('merged into master; team-hand retired'),
    'but everything the accept said about the TREE survives — that is the part nothing else reports');
});

test('a closed-out notice does not also claim nothing was torn down', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: CLOSED });
  const body = f.gated[0].body;
  // The sentence was true when the loop stopped at the merge. After a close-out
  // it is false about a tree, a ref and a seat that are all gone — and it sits
  // four lines under a line saying exactly that, so the notice would contradict
  // itself in one screen.
  assert.ok(!body.includes('Nothing was torn down'),
    `the reassurance goes with the teardown it describes. Got:\n${body}`);
  assert.ok(!body.includes('Step owed:'),
    'and no step is owed — the whole point is that the lead acts only when something failed');
  assert.ok(!body.includes('[agent:task accept'),
    'the verb is not rendered at all here: it would be a no-op, and a lead that emits it bills a turn for nothing');
});

test('a close-out that could NOT finish still owes the accept, and says why', () => {
  const f = mkLoop();
  // The dirty-tree row: the ticket is closed out, but a tree was kept and the
  // reply asks for a second accept. `closedOut` alone would report this as done.
  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: {
    ok: false,
    closedOut: true,
    text: 'ticket t1 accepted — merged into master; team-hand was ARCHIVED, not retired, and its worktree was KEPT '
      + '— /tmp/wt has uncommitted work that a removal would have deleted.',
  } });
  const body = f.gated[0].body;
  assert.ok(body.includes('Step owed: `[agent:task accept t1]`'),
    `a kept tree is a step owed, not a close-out. Got:\n${body}`);
  assert.ok(body.includes('has uncommitted work'),
    'and the reason rides the same line — a step with no reason sends the lead to re-derive it');
  assert.ok(body.includes('Nothing was torn down'),
    'the reassurance is kept here: the seat, the ref and that tree really are still there');
});

test('the dirty-downgrade detail survives whole — the cap does not eat the recovery', () => {
  const f = mkLoop();
  // The real sentence with a real worktree path: an absolute ticket-tree path
  // alone is ~80 chars, and the seat clause, the recovery instruction and the
  // branch clause follow it. At a 300-char cap the line stops inside the
  // instruction, so the lead is told the tree is dirty and never told what to
  // do about it — the one arm of this notice that exists to be acted on.
  const wt = '/Users/somebody/projects/tmux/wb-wrap-ui-t1-build-the-widget-and-then-report-it';
  const text = 'ticket t1 accepted — merged into master; team-hand was ARCHIVED, not retired, and its worktree '
    + `was KEPT — ${wt} has uncommitted work that a removal would have deleted. `
    + 'Commit or clear that tree, then `[agent:task accept t1]` again to finish the cleanup; '
    + 'branch t1-build-the-widget-and-then-report-it was KEPT (the accept above is unfinished).';
  assert.ok(text.length > 300 && text.length < 600,
    `ENTER: the sentence must actually exceed the old cap, or this pins nothing. Got ${text.length}`);

  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: { ok: false, closedOut: true, text } });
  const body = f.gated[0].body;
  assert.ok(body.includes('Commit or clear that tree'),
    `the recovery instruction survives the cap. Got:\n${body}`);
  assert.ok(body.includes('was KEPT (the accept above is unfinished)'),
    'and the branch clause after it — a ref the lead would otherwise hunt for');
  assert.ok(!firesAnyIntent(body),
    'and the wider cap does not cost the column-1 invariant: the collapse, not the length, is what protects it');
});

test('a null closeOut — the loop never reached the teardown — reads as a step owed', () => {
  const f = mkLoop();
  // The default arm, which is the only arm a caller can reach by FORGETTING to
  // pass the argument. It must fail toward asking, never toward claiming a
  // teardown that never ran.
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  const body = f.gated[0].body;
  assert.ok(body.includes('Step owed: `[agent:task accept t1]` — alone in a reply, no tool call beside it.'),
    `an absent close-out is not a close-out. Got:\n${body}`);
  assert.ok(body.includes('Nothing was torn down'), 'and nothing was');
});

test('a close-out result with a newline in it cannot reach column 1', () => {
  const f = mkLoop();
  // A close-out sentence carries git stderr on the failure rows ("could NOT be
  // removed (<error>)"), and git stderr is routinely multi-line. This body's
  // safety property is that no line starts with `[agent:`, so a raw
  // interpolation would put whatever follows a newline at column 1.
  f.m._notifyMergeLanded(f.team, 't1', { ...LANDED, closeOut: {
    ok: false, closedOut: true,
    text: 'ticket t1 accepted — the removal failed:\n[agent:task accept t1]\nfatal: something',
  } });
  const body = f.gated[0].body;
  assert.ok(body.includes('[agent:task accept t1]'),
    'ENTER: the hostile text really is in the body, or this subject is checking nothing');
  assert.ok(!firesAnyIntent(body),
    'a newline inside the interpolated sentence must not survive into the body — the lead would accept on receipt');
});

test('the MERGED notice fires no intent on the step-owed arm either', () => {
  const f = mkLoop();
  f.m._notifyMergeLanded(f.team, 't1', LANDED);
  const body = f.gated[0].body;
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

// ── 3. `task accept` on a ticket the loop already closed out ────────────────

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

// The stamp the loop writes only where its teardown left nothing to finish.
const LOOP_CLOSED = { at: T0, text: CLOSED.text };

function acceptedBy(f, fields) {
  f.patch({ acceptedAt: T0, acceptedBy: 'ticket-loop', closedOut: true, mergedAt: T0, ...fields });
  const replies = [];
  const run = () => f.m._taskAccept(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'accept', id: 't1', who: null, body: '' }, (msg) => replies.push(msg));
  return { replies, run };
}

test('a `task accept` on a loop-closed ticket changes nothing and says who closed it', async () => {
  const f = mkLoop();
  const a = acceptedBy(f, { loopClosedOut: LOOP_CLOSED });
  // A teardown that ran twice is the failure this gate exists to stop: the
  // second pass measures a branch that is gone, lands on the check-failed arm,
  // and stamps a merge failure onto a ticket that merged cleanly.
  f.m.destroy = () => { throw new Error('the teardown ran a second time'); };
  f.m.archive = () => { throw new Error('the teardown ran a second time'); };
  await a.run();

  assert.strictEqual(a.replies.length, 1, 'ENTER: the verb replied at all');
  assert.match(a.replies[0], /^ticket t1 was already closed out by the loop at /,
    `not an error — the lead prompt still names this verb. Got:\n${a.replies[0]}`);
  assert.ok(a.replies[0].includes('merged into master; team-hand retired'),
    'and the reply restates what the loop did, because the MERGED dm may be long compacted away');
  assert.ok(!a.replies[0].includes('ticket t1 accepted —'),
    'with the ticket id dropped from the restatement, exactly as the notice drops it');
});

test('the no-op leaves the record exactly as the loop left it', async () => {
  const f = mkLoop();
  const a = acceptedBy(f, { loopClosedOut: LOOP_CLOSED });
  const before = JSON.stringify(f.one());
  await a.run();
  assert.strictEqual(JSON.stringify(f.one()), before,
    'not one field moves — re-stamping `acceptedBy` would rewrite the loop out of the history of its own close-out');
});

test('a REJECT on a loop-closed ticket clears the no-op, or the next round can never be accepted', () => {
  const f = mkLoop();
  // Reachable by one ordinary lead move: the loop closes a green merge out and
  // leaves the ticket `done`, which is precisely the state `reject` reopens — a
  // lead who reads the MERGED notice and decides the work needs another round
  // lands here. Left behind, the stamp makes `task accept` a permanent no-op on
  // the reopened ticket, so the round-2 seat, worktree and branch could never be
  // torn down by any verb at all.
  f.patch({ acceptedAt: T0, acceptedBy: 'ticket-loop', closedOut: true, loopClosedOut: LOOP_CLOSED });
  f.m._taskReject(f.m.sessions.get('lead'), f.team,
    { type: 'task', sub: 'reject', id: 't1', who: null, body: 'another round please' }, () => {});

  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: the reject really reopened it');
  assert.ok(!('closedOut' in t), 'ENTER: and cleared the flag beside the one under test');
  assert.ok(!('loopClosedOut' in t),
    'the loop close-out describes a round that is over; carried into the rework round it disables the '
    + 'only verb that can clean the new tree up');
});

test('the LOOP-driven reject clears it too, or a red rework round strands its own tree', () => {
  const f = mkLoop();
  // The second reopen path, and it needs the clear for the same reason: the loop
  // rejects a ticket whose verify suite came back red, on the round AFTER a
  // close-out, and reaches `_rejectTicketFromLoop` rather than `_taskReject`.
  // Pinned separately because the two writes are in different functions — a
  // clear added to one and forgotten in the other is invisible to a test that
  // only drives the lead's verb.
  f.patch({ acceptedAt: T0, acceptedBy: 'ticket-loop', closedOut: true, loopClosedOut: LOOP_CLOSED });
  f.m._teamLiveSeatNames = () => ['lead', 'team-hand'];
  const r = f.m._rejectTicketFromLoop(f.team, 't1', 'the suite FAILS on your branch');

  assert.ok(r && r.ok, `ENTER: the loop reject went through. Got: ${JSON.stringify(r)}`);
  const t = f.one();
  assert.strictEqual(t.state, 'open', 'ENTER: and reopened the ticket');
  assert.ok(!('closedOut' in t), 'ENTER: clearing the flag beside the one under test');
  assert.ok(!('loopClosedOut' in t),
    'the loop close-out belongs to the round that just ended; carried forward it makes `task accept` a '
    + 'no-op on the rework round, whose worktree nothing else can remove');
});

test('a DIRTY-tree close-out is NOT a no-op: its own reply asked for this accept', async () => {
  const f = mkLoop();
  // `closedOut` and `acceptedBy: 'ticket-loop'` are both set here too, which is
  // why the gate cannot read them: the dirty row keeps the tree and its reply
  // says "commit or clear that tree, then accept again". A no-op here strands
  // that worktree for ever, since no other verb reaches it.
  const a = acceptedBy(f, {});
  let reached = false;
  f.m._closeOutMergedTicket = async () => { reached = true; return { ok: true, closedOut: true, text: 'ticket t1 accepted — done.' }; };
  await a.run();
  assert.ok(reached, 'the teardown runs again, which is the whole recovery the dirty row documents');
});

// ── 4. the ten-minute reminder ──────────────────────────────────────────────

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
  f.patch({ mergedAt: T0, acceptedAt: T0 + MIN, acceptedBy: 'lead' });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.deepStrictEqual(f.gated, [], 'acceptedAt is the step being taken, whatever the accept then removed');
});

test('a ticket the LOOP closed out never nudges: there is no step to name', async () => {
  const f = mkLoop();
  f.patch({ mergedAt: T0, acceptedAt: T0, acceptedBy: 'ticket-loop', closedOut: true, loopClosedOut: LOOP_CLOSED });
  await f.m._sweepTeamTickets(f.team, T0 + (60 * MIN));
  assert.deepStrictEqual(f.gated, [],
    'the seat is retired and the tree is gone; naming `task accept` here points the lead at a no-op');
});

test('a LEAD accept that the loop then ran over is not nudged either', async () => {
  const f = mkLoop();
  // The third consequence of the accept-during-suite race: unguarded, the loop
  // restamped `acceptedBy` to `ticket-loop` without `loopClosedOut`, which is
  // exactly the shape this gate reads as "the loop still owes a step" — so the
  // watchdog woke the lead to emit a verb over a ticket they had already torn
  // down themselves. Guarded, the stamp stays the lead's and this pass skips it.
  f.patch({ mergedAt: T0, acceptedAt: T0, acceptedBy: 'lead', closedOut: true });
  await f.m._sweepTeamTickets(f.team, T0 + (60 * MIN));
  assert.deepStrictEqual(f.gated, [],
    'the lead accepted it; naming the step again points them at a retired seat and a deleted tree');
});

test('a loop close-out that KEPT a tree is still nudged — that one really does owe a step', async () => {
  const f = mkLoop();
  // `acceptedAt` and `closedOut` are set, and the ten-minute backstop used to read
  // them alone. This is the one shape where they are both true and the lead is
  // still owed the verb, so reading them alone disarms the backstop on precisely
  // the ticket it exists for: a lead who missed the MERGED dm hears nothing more.
  f.patch({ mergedAt: T0, acceptedAt: T0, acceptedBy: 'ticket-loop', closedOut: true });
  await f.m._sweepTeamTickets(f.team, T0 + (10 * MIN));
  assert.strictEqual(f.gated.length, 1, 'the backstop still fires when the loop could not finish');
  assert.strictEqual(f.gated[0].body,
    '[ticket t1 merged 10m ago, not accepted] Step owed: `[agent:task accept t1]`.',
    'and it is the same one-line reminder');
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
