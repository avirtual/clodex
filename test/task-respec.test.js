'use strict';
// Run: node --test test/task-respec.test.js
//
// t339 — `task respec` is the correction path for a ticket that is STILL OPEN.
// `reject` cannot serve it: reject's entire body undoes a close (state,
// closedAt, closedBy, loopStep), and every one of those writes is a no-op on a
// ticket that never closed — so it is gated to `done` and bounces on exactly the
// state the dispatch format's own "STOP AND REPORT IF MY ACCOUNT IS WRONG"
// produces. Before this verb the only correction was cancel-and-refile, which
// burns the ticket id, its history and its artifact link.
//
// The assertion that matters most here is DELIVERY. A respec that updates the
// board but never reaches the assignee is worse than the DM it replaces: the
// hand keeps building the superseded spec while the board asserts the new one.
// Every state test below therefore checks the seat's inbox, not just the record.
//
// Fixture mirrors task-start.test.js's (a real temp clodex HOME so the board
// round-trips to disk), rebuilt rather than imported for the same reason that
// file gives: these assertions are about this verb.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { ticketStarted } = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');
const { mkTmpRoot } = require('./lib/tmp-roots');

function mkRespec(extra = {}) {
  const home = mkTmpRoot('clodex-respec-');
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
    },
  };
  const injected = [];
  const gated = [];
  const urgents = [];
  const broadcasts = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
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
    ...extra,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._sendToSession = () => {};
  m._gatedDeliver = (target, sender, body, urgent) => {
    gated.push({ target, sender, body }); urgents.push(urgent);
    return { queued: true };
  };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, tstore, injected, gated, urgents, broadcasts, seat,
    load: () => tstore.load(team.root),
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
    reply: () => injected[injected.length - 1],
  };
}

// A ticket open, DISPATCHED, and pinned to a live seat — the state the whole
// verb is for. Asserts the seat really resolves, so a delivery assertion below
// cannot pass vacuously against a ticket nobody holds.
//
// This fixture NORMALISES two things — it pins `assignee` to a concrete seat and
// stamps `startedAt` — and that normalisation is exactly what hid the r1
// must-fix: every delivery assertion ran on the one shape where role resolution
// is harmless. The role-key and unstarted shapes are built explicitly below, by
// `openRolePinned`, and must stay that way.
function openPinned(f, spec = 'the original spec\nwith detail') {
  const lead = f.seat('lead');
  f.seat('team-hand');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  const t = f.one('t1');
  t.assignee = 'team-hand';
  t.startedAt = Date.now();   // dispatched — `add` alone files it unstarted
  delete t.role;
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), 'team-hand',
    'ENTER: the ticket resolves to a live seat — otherwise every delivery assertion below is vacuous');
  assert.ok(ticketStarted(f.one('t1')), 'ENTER: the ticket is dispatched — otherwise the delivery gate, not the seat, decides');
  f.gated.length = 0;
  f.injected.length = 0;
  return f.one('t1');
}

// The shape `[agent:task add <role>]` actually produces: `assignee` is the ROLE
// KEY and `startedAt` is null. `_ticketAssigneeSeat` resolves a bare role key to
// the first live seat holding that role, so a sibling hand — mid-work in another
// ticket's tree — is what this ticket resolves to. `started` stamps the dispatch
// without touching the role pin, which is the only difference that may gate
// delivery.
function openRolePinned(f, { started }, spec = 'the original spec\nwith detail') {
  const lead = f.seat('lead');
  const sibling = f.seat('team-hand-999');   // a live seat filling role `hand`
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'hand', 'ENTER: add pinned the ROLE KEY, not a seat');
  assert.strictEqual(t.startedAt, null, 'ENTER: add files unstarted');
  if (started) t.startedAt = Date.now();
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  // The hazard, asserted as a PRECONDITION: this ticket resolves to a seat that
  // was never given it. If this stops holding the test below proves nothing.
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), sibling.name,
    'ENTER: the role key resolves to the sibling seat — the misdelivery target');
  assert.strictEqual(ticketStarted(f.one('t1')), !!started, `ENTER: started=${!!started}`);
  f.gated.length = 0;
  f.injected.length = 0;
  return f.one('t1');
}

// ── the grammar ────────────────────────────────────────────────────────────

test('grammar: [agent:task respec <id>] takes an id and a GREEDY body', () => {
  assert.deepStrictEqual(parseIntent('[agent:task respec t7] the new spec'),
    { type: 'task', sub: 'respec', id: 't7', who: null, body: 'the new spec' });
  // The body IS a spec, so it must survive multi-line capture intact. A
  // line-scoped respec would dispatch the first line as the whole task.
  assert.deepStrictEqual(parseIntent('[agent:task respec t7] first\nsecond\nthird'),
    { type: 'task', sub: 'respec', id: 't7', who: null, body: 'first\nsecond\nthird' });
  assert.deepStrictEqual(parseIntent('[agent:task respec]'),
    { type: 'task', sub: 'respec', id: null, who: null, body: '' });
});

// ── the record ─────────────────────────────────────────────────────────────

test('respec replaces the spec AND re-derives title and taskDir from it', () => {
  const f = mkRespec();
  const before = openPinned(f, 'old title\ntasks/old-dir — notes');
  assert.strictEqual(before.title, 'old title', 'ENTER: the ticket starts on the OLD spec');

  f.m._handleTask(f.seat('lead'), {
    type: 'task', sub: 'respec', who: null, id: 't1',
    body: 'new title\ntasks/new-dir — the corrected account',
  });

  const t = f.one('t1');
  assert.match(t.spec, /the corrected account/, 'the new spec is on the record');
  assert.doesNotMatch(t.spec, /old title/, 'the superseded spec text is gone');
  assert.strictEqual(t.title, 'new title', 'title re-derived — a stale one describes a spec that no longer exists');
  assert.strictEqual(t.taskDir, 'tasks/new-dir', 'taskDir re-derived');
  assert.strictEqual(t.state, 'open', 'respec is not a lifecycle change');
});

// The same rule editSpec follows: a taskDir left at its old value after the new
// spec names none points the seat's journal at ANOTHER ticket's artifacts.
test('respec DELETES taskDir when the new spec names none', () => {
  const f = mkRespec();
  const before = openPinned(f, 'has a dir\ntasks/some-dir — notes');
  assert.strictEqual(before.taskDir, 'tasks/some-dir', 'ENTER: the ticket starts WITH a taskDir');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'no dir now\njust prose' });

  assert.ok(!('taskDir' in f.one('t1')), 'stale taskDir dropped, not carried');
});

// Dropping it is correct; dropping it SILENTLY is not. The loop hard-fails on a
// missing task dir several steps downstream and routes the lead to `reject`.
test('dropping the artifact link is REPORTED, not silent', () => {
  const f = mkRespec();
  openPinned(f, 'has a dir\ntasks/some-dir — notes');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'no dir now' });
  assert.match(f.reply(), /artifact link was dropped/, 'the lead learns it here, not three steps later');

  // And no false alarm when the new spec keeps one, or when there was none.
  const f2 = mkRespec();
  openPinned(f2, 'has a dir\ntasks/some-dir — notes');
  f2.m._handleTask(f2.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'still\ntasks/other-dir — x' });
  assert.doesNotMatch(f2.reply(), /artifact link was dropped/, 'kept a dir — no note');

  const f3 = mkRespec();
  openPinned(f3, 'no dir at all\nprose');
  f3.m._handleTask(f3.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'still none' });
  assert.doesNotMatch(f3.reply(), /artifact link was dropped/, 'never had one — no note');
});

// The supersession record has to be VISIBLE, or it satisfies the requirement
// literally and not actually.
test('the board row shows a corrected ticket as respec`d, with a count', () => {
  const f = mkRespec();
  openPinned(f);
  const lead = f.seat('lead');

  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.doesNotMatch(f.reply(), /respec/, 'ENTER: an uncorrected ticket carries no suffix');

  f.m._handleTask(lead, { type: 'task', sub: 'respec', who: null, id: 't1', body: 'first correction' });
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /respec'd ×1/, 'one correction shown on the row');

  f.m._handleTask(lead, { type: 'task', sub: 'respec', who: null, id: 't1', body: 'second correction' });
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /respec'd ×2/, 'the count tracks');
});

// ── t531: the merge-waiting mark on the same rows ──────────────────────────
// Filed here rather than in ticket-auto-merge.test.js, which owns the STAMP's
// lifecycle: this is the reader, and its precedent in both mechanism and shape
// is the respec suffix above — a board fact riding the title on both row shapes.
//
// Driven through `_stampMergeWaiting` rather than by writing `mergeWaiting` onto
// the record by hand. A hand-written field would pin the renderer against this
// test's belief about the field name, which is the one thing a rename breaks
// invisibly; going through the writer makes the two halves fail together.
test('t531: a deferred merge is VISIBLE on the board — open row and closed row', () => {
  const f = mkRespec();
  openPinned(f);
  const lead = f.seat('lead');

  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.doesNotMatch(f.reply(), /merge waiting/, 'ENTER: a ticket with no deferred merge carries no mark');

  // The OPEN row. Rare in practice (the ticket was reopened while the merge was
  // deferred) but it is the shape `row` renders.
  f.m._stampMergeWaiting(f.team, 't1', 'suite-in-flight');
  assert.strictEqual(f.one('t1').mergeWaiting, 'suite-in-flight',
    'ENTER: the stamp really landed on the record — otherwise the assertion below reads an unstamped board');
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /t1 \[open\].*merge waiting: suite-in-flight/,
    'the open row states the deferred merge');

  // The CLOSED row, which is the shape that actually occurs: the loop stamps
  // after `task done` has already written state `done`, so a lead judging
  // ACCEPT freshness reads it in the recently-closed block.
  const t = f.one('t1');
  t.state = 'done';
  t.closedAt = Date.now();
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /recently closed:/, 'ENTER: the row reached the recently-closed block, not the open list');
  assert.match(f.reply(), /t1 \[done\].*closed.*merge waiting: suite-in-flight/,
    'the closed row states it too — this is the row the lead actually reads');

  // And it goes away with the stamp: a mark that outlived the field would tell
  // the lead to wait forever for a merge that already landed.
  f.m._stampMergeWaiting(f.team, 't1', null);
  assert.ok(!('mergeWaiting' in f.one('t1')), 'ENTER: the stamp was cleared');
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.doesNotMatch(f.reply(), /merge waiting/, 'the mark is gone once the merge is no longer deferred');
});

// ── t533: the merge-ERROR mark, the louder half of the same gap ────────────
// Filed beside t531's for the same reason it was: this is the READER, and its
// precedent in mechanism and shape is the two marks above. ticket-auto-merge
// .test.js keeps owning the stamp's lifecycle.
//
// Driven through `_stampMergeError`, not a hand-written `mergeError` field: a
// hand-written one pins the renderer against this test's belief about the field
// name, which is what a rename breaks invisibly.
test('t533: a FAILED merge is visible on the board — open row and closed row', () => {
  const f = mkRespec();
  openPinned(f);
  const lead = f.seat('lead');

  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.doesNotMatch(f.reply(), /MERGE FAILED/, 'ENTER: a ticket whose merge never failed carries no mark');

  f.m._stampMergeError(f.team, 't1', 'clean-tree');
  assert.strictEqual(f.one('t1').mergeError, 'clean-tree',
    'ENTER: the stamp really landed on the record — otherwise the assertion below reads an unstamped board');
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /t1 \[open\].*MERGE FAILED: clean-tree/,
    'the open row states the failed merge, with the step verbatim');

  // The CLOSED row, which is the shape that actually occurs: the merge runs
  // after `task done`, so the failure lands on a ticket already closed and the
  // lead reads it in the recently-closed block.
  const t = f.one('t1');
  t.state = 'done';
  t.closedAt = Date.now();
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.match(f.reply(), /recently closed:/, 'ENTER: the row reached the recently-closed block, not the open list');
  assert.match(f.reply(), /t1 \[done\].*closed.*MERGE FAILED: clean-tree/,
    'the closed row states it too — this is the row the lead actually reads');

  // And it goes away with the stamp: `_stampMergeError(…, null)` is the green
  // path's clear, and a mark outliving the field would send the lead after a
  // merge that has already landed.
  f.m._stampMergeError(f.team, 't1', null);
  assert.ok(!('mergeError' in f.one('t1')), 'ENTER: the stamp was cleared');
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  assert.doesNotMatch(f.reply(), /MERGE FAILED/, 'the mark is gone once the merge no longer needs a human');
});

// The two merge marks mean OPPOSITE things to a lead — "wait, this is coming"
// versus "this stopped and needs you" — and `_autoMergeTicket`'s deferred arm
// keeps them apart in the record on purpose. A board that renders them alike
// throws that distinction away at the last step, so the shapes are pinned as
// DIFFERENT here rather than left to whichever wording a later edit prefers.
//
// The record built below is SYNTHETIC and the loop cannot produce it:
// `_autoMergeTicket`'s `finally` clears `mergeWaiting` on every non-defer exit,
// so the two stamps never coexist in the wild, and ticket-auto-merge.test.js
// pins that they must not. Setting both here is legitimate for its own purpose
// — comparing the two mark SHAPES needs them on ONE line — but it is not
// licence to treat the pair as a reachable state anywhere else.
test('t533: waiting and failed are visually distinguishable on one row', () => {
  const f = mkRespec();
  openPinned(f);
  const lead = f.seat('lead');

  f.m._stampMergeWaiting(f.team, 't1', 'suite-in-flight');
  f.m._stampMergeError(f.team, 't1', 'suite-red');
  f.m._handleTask(lead, { type: 'task', sub: 'list', who: null, id: null, body: '' });
  const line = f.reply().split('\n').find((l) => /^t1 /.test(l));
  assert.ok(line, `ENTER: the t1 row is in the listing: ${f.reply()}`);
  assert.match(line, /\(merge waiting: suite-in-flight\) !! MERGE FAILED: suite-red/,
    'both marks render, in that order, and the failure does not read as a third parenthetical aside');
});

// The guard t339 must not lose: an open ticket silently rewritten into
// different work, with no record that it changed, is the failure mode.
test('respec records the supersession — that it happened, and by whom', () => {
  const f = mkRespec();
  openPinned(f, 'first spec\ndetail');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'second spec' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'third spec' });

  const t = f.one('t1');
  assert.strictEqual(t.respecs.length, 2, 'both corrections recorded, not just the last');
  assert.strictEqual(t.respecs[0].by, 'lead', 'names who superseded it');
  assert.strictEqual(t.respecs[0].title, 'first spec', 'names what was superseded');
  assert.strictEqual(t.respecs[1].title, 'second spec');
  assert.ok(t.respecs[0].at > 0 && t.respecs[1].at >= t.respecs[0].at, 'stamped in order');
});

// t392: the title alone was not enough. A respec is written as a delta against
// the spec the seat is holding, and `ticket.spec` — the only copy of that
// antecedent — is overwritten on the next line. The replay path delivers
// `ticket.spec` and nothing else, so a seat replayed after a respec received a
// delta whose antecedent existed nowhere: a well-formed, self-consistent-looking
// document with most of the job missing and no signal it was.
test('respec keeps the superseded BODY, not just its title', () => {
  const f = mkRespec();
  openPinned(f, 'first spec\ntasks/widget — the ORIGINAL BODY\nstep one\nstep two');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'second spec\nalso do the other thing' });

  const t = f.one('t1');
  assert.strictEqual(t.respecs.length, 1, 'ENTER: the supersession was recorded at all');
  // The whole body, byte for byte. A prefix or a title-line match would pass on a
  // truncation, which is the failure being guarded: a partial antecedent is
  // exactly as unusable to the replayed seat as none.
  assert.strictEqual(t.respecs[0].spec, 'first spec\ntasks/widget — the ORIGINAL BODY\nstep one\nstep two',
    'the superseded body is recoverable in full — this is the record the replay path had no copy of');
  assert.strictEqual(t.spec, 'second spec\nalso do the other thing', 'and the ticket carries the NEW spec');
});

// The shape decision, pinned as a shape rather than as prose: appending to
// `ticket.spec` was the alternative, and it is wrong here because `title`,
// `taskDir` and the branch slug are all RE-DERIVED from the spec. An accumulated
// document freezes the title at the first revision forever and lets extractTaskDir
// pick a path out of a superseded one. Both derived fields are asserted, since
// either alone would pass against half the mistake.
test('the superseded body goes to respecs[] — never appended to the spec', () => {
  const f = mkRespec();
  openPinned(f, 'tasks/old-dir — the OLD title\nold body');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'tasks/new-dir — the NEW title\nnew body' });

  const t = f.one('t1');
  assert.doesNotMatch(t.spec, /old body/, 'the spec is REPLACED, not grown — an accumulated spec corrupts everything derived from it');
  assert.strictEqual(t.title, 'tasks/new-dir — the NEW title', 'the title tracks the current revision');
  assert.strictEqual(t.taskDir, 'tasks/new-dir', 'and so does the artifact dir');
  assert.strictEqual(t.respecs[0].spec, 'tasks/old-dir — the OLD title\nold body', 'the old body survives in the record instead');
});

// Repeated corrections keep EVERY antecedent, in order. A single `previousSpec`
// field would satisfy the one-respec case above and silently lose the original on
// the second correction — which is the ticket that most needs it, since a spec
// corrected twice is one nobody remembers the start of.
test('every superseded body is kept, in order, across repeated corrections', () => {
  const f = mkRespec();
  openPinned(f, 'revision one');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'revision two' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'revision three' });

  const t = f.one('t1');
  assert.deepStrictEqual(t.respecs.map((r) => r.spec), ['revision one', 'revision two'],
    'both antecedents, oldest first — the ORIGINAL is the one a `previousSpec` field would have dropped');
  assert.strictEqual(t.spec, 'revision three');
});

// Same reasoning _taskAssign applies to a fresh assignment: a corrected spec is
// changed work, so the stall clock restarts rather than counting from the
// dispatch the hand is no longer working to.
test('respec starts a new stall episode, as assign does', () => {
  const f = mkRespec();
  const t = openPinned(f);
  t.nudgedAt = 12345;
  t.lastActivityAt = 1;
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  assert.strictEqual(f.one('t1').nudgedAt, 12345, 'ENTER: the ticket carries a nudge from its previous episode');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected' });

  assert.strictEqual(f.one('t1').nudgedAt, null, 'nudge cleared — new episode');
  assert.ok(f.one('t1').lastActivityAt > 1, 'activity stamped');
});

// ── FALSIFICATION: it must actually reach the hand ─────────────────────────

test('respec DELIVERS the new spec to the assignee seat, urgently', () => {
  const f = mkRespec();
  openPinned(f);
  assert.strictEqual(f.gated.length, 0, 'ENTER: nothing delivered before the respec — the delivery below is the respec`s');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'THE CORRECTED SPEC\nwith new detail' });

  assert.strictEqual(f.gated.length, 1, 'exactly one delivery');
  assert.strictEqual(f.gated[0].target, 'team-hand', 'to the seat holding the ticket');
  assert.match(f.gated[0].body, /THE CORRECTED SPEC/, 'carrying the NEW spec text');
  assert.doesNotMatch(f.gated[0].body, /the original spec/, 'not the superseded one');
  assert.strictEqual(f.urgents[0], true, 'urgent — the hand is building the wrong thing right now');
  assert.match(f.reply(), /respec/, 'the lead is told it went out');
});

// The r1 must-fix, and the reason the delivery gate is `ticketStarted` and not
// `parked`. `add` files a role ticket with `assignee` = the role key and
// `startedAt` = null; the resolver maps that key to the FIRST live seat holding
// the role. Deliver on that and this ticket's spec lands in a sibling hand
// already mid-work in a different ticket's worktree — the failure `add` was
// stripped of its own delivery to prevent.
test('respec does NOT deliver an UNSTARTED role ticket into a sibling seat', () => {
  const f = mkRespec();
  openRolePinned(f, { started: false });

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected, undispatched' });

  assert.strictEqual(f.gated.length, 0, 'NOTHING delivered — the sibling is not this ticket`s hand');
  assert.match(f.one('t1').spec, /corrected, undispatched/, 'the record was still corrected');
  assert.match(f.reply(), /not started/, 'the lead is told it was not dispatched');
  assert.match(f.reply(), /task start t1/, 'and which verb dispatches it');
});

// The other half of the same gate: once dispatched, a role-pinned ticket DOES
// deliver. Without this the fix could be "never deliver a role ticket" and the
// test above would still pass.
test('respec DOES deliver a STARTED role-pinned ticket', () => {
  const f = mkRespec();
  openRolePinned(f, { started: true });

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected, dispatched' });

  assert.strictEqual(f.gated.length, 1, 'exactly one delivery');
  assert.strictEqual(f.gated[0].target, 'team-hand-999', 'to the seat the role resolves to');
  assert.match(f.gated[0].body, /corrected, dispatched/);
});

// Neither arm may stamp `startedAt` or re-pin: that would make respec a third
// dispatch path, which is the seam the add/start split exists to create.
test('respec never stamps startedAt nor re-pins the role — it is not a dispatch path', () => {
  const f = mkRespec();
  openRolePinned(f, { started: false });

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'still not dispatched' });

  const t = f.one('t1');
  assert.strictEqual(t.startedAt, null, 'startedAt untouched — start alone dispatches');
  assert.strictEqual(t.assignee, 'hand', 'still on the role key, not re-pinned to a seat');
  assert.strictEqual(ticketStarted(t), false, 'still undispatched');
});

// ── MUST-FIX 2: the delivered spec must announce itself as a REPLACEMENT ────
// Over ~500 bytes the body spills and the seat sees only "Message (N bytes)
// attached" — identical in shape to a fresh dispatch. A hand reading it as one
// follows its brief (compact, start clean) and discards the in-flight work of
// the ticket being corrected. So the marker must be in BOTH the body text and
// the tag, because the tag is the half that survives a spill.

test('a respec delivery is MARKED in the body, and tells the hand not to start over', () => {
  const f = mkRespec();
  openPinned(f);

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'the corrected spec' });

  const body = f.gated[0].body;
  assert.match(body, /\[ticket t1 RESPEC\]/, 'marked as a respec, not as a fresh dispatch');
  assert.match(body, /SUPERSEDES/, 'says the new text replaces the old');
  assert.match(body, /do NOT start over and do NOT compact/, 'countermands the hand brief`s start-clean rule');
  assert.doesNotMatch(body, /REPLAY/, 'not confused with the replay path');
  // t392: this is the ONE arm the supersession clause is excluded from, and this
  // is the assertion that guards the exclusion. The predicate is `!respec` — it
  // rides every other dispatch, replay and first-assign alike — so the exclusion
  // is now the only thing standing between this seat and a count restating what
  // the arm above just told it directly. This seat is live, holds the previous
  // text, and is watching the transition happen.
  assert.doesNotMatch(body, /REPLACED once|REPLACED \d+ times/,
    'the seat WATCHING the correction is told by the arm above, not by a census of its own history — this is '
    + 'the sole exclusion from a clause that otherwise rides every dispatch');
});

// The assertion that matters when the body spills: the tag is all the seat sees.
test('the RESPEC marker rides the TAG too, which is what survives a spill', () => {
  const f = mkRespec();
  openPinned(f);
  const tags = [];
  f.m._gatedDeliver = (target, sender, body, urgent, tag) => { tags.push(tag); return { queued: true }; };

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'x'.repeat(2000) });

  assert.strictEqual(tags.length, 1, 'ENTER: one delivery — otherwise the tag below is nobody`s');
  assert.strictEqual(tags[0], '[ticket t1 RESPEC] close with [agent:task done t1]',
    'a spilled respec announces itself as a respec AND carries the close verb; either half '
    + 'missing is a silent loss — an empty marker reads as a fresh dispatch, and a bare close '
    + 'verb loses the only signal that this supersedes a spec the seat already has');
});

// A fresh dispatch must NOT acquire the marker — otherwise the discriminator is
// a constant and proves nothing.
test('an ordinary dispatch carries no RESPEC marker', () => {
  const f = mkRespec();
  const lead = f.seat('lead');
  f.seat('team-hand');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: 'a fresh spec\ntasks/fresh/SPEC.md' });
  f.m._handleTask(lead, { type: 'task', sub: 'start', who: null, id: 't1', body: '' });

  assert.ok(f.gated.length >= 1, 'ENTER: start dispatched it');
  assert.doesNotMatch(f.gated[0].body, /RESPEC/, 'a first dispatch is not a respec');
});

// ── the state gate ─────────────────────────────────────────────────────────
// respec DELIVERS, unlike the board's state-agnostic editSpec. Re-dispatching a
// closed ticket would restart work on it without reopening it — a lifecycle
// change by the back door, leaving the board reading `done` over a live hand.

for (const state of ['done', 'accepted', 'cancelled']) {
  test(`respec refuses a ${state} ticket, and delivers nothing`, () => {
    const f = mkRespec();
    const t = openPinned(f);
    t.state = state;
    f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
    assert.strictEqual(f.one('t1').state, state, `ENTER: the ticket really is ${state}`);

    f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'a new spec' });

    assert.match(f.reply(), /is (done|accepted|cancelled)/, 'the refusal names the state');
    assert.strictEqual(f.gated.length, 0, 'nothing dispatched to the seat');
    assert.match(f.one('t1').spec, /the original spec/, 'the record is untouched');
  });
}

// The refusal has to name the route, or the lead is left where t319 found it:
// a verb that says no and no verb that says yes.
test('the refusal on a DONE ticket points at reject as the route', () => {
  const f = mkRespec();
  const t = openPinned(f);
  t.state = 'done';
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'x' });

  assert.match(f.reply(), /reject/, 'names the verb that DOES move a done ticket backwards');
});

// ── refusals must not eat the spec ─────────────────────────────────────────
// The loss mode t175 was filed for. A rejected respec carries a full spec in its
// body; dropping it on the floor is the cancel-and-refile loss in a new place.

test('a refused respec SPILLS the spec body rather than dropping it', () => {
  const f = mkRespec();
  openPinned(f);
  const spills = [];
  const f2 = mkRespec({ spillToFile: (label, body) => { spills.push({ label, body }); return '/tmp/spilled.txt'; } });
  openPinned(f2);

  // Not the lead — the refusal that costs a non-lead its whole spec.
  f2.m._handleTask(f2.seat('team-hand'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'a long and costly spec' });

  assert.match(f2.reply(), /only the team lead/, 'refused as lead-only');
  assert.strictEqual(spills.length, 1, 'the body was spilled, not lost');
  assert.match(spills[0].body, /a long and costly spec/);
});

test('respec is lead-only, and a non-lead changes nothing', () => {
  const f = mkRespec();
  openPinned(f);

  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'sneaky rewrite' });

  assert.match(f.one('t1').spec, /the original spec/, 'record untouched');
  assert.strictEqual(f.gated.length, 0, 'nothing delivered');
});

test('respec needs an id and a spec', () => {
  const f = mkRespec();
  openPinned(f);

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: null, body: 'a spec with no id' });
  assert.match(f.reply(), /needs a ticket id/);

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: '   ' });
  assert.match(f.reply(), /needs a new spec/, 'an empty body would blank the spec');
  assert.match(f.one('t1').spec, /the original spec/, 'the record survived both refusals');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't99', body: 'x' });
  assert.match(f.reply(), /no ticket t99/);
});

// ── parked ─────────────────────────────────────────────────────────────────
// `parked` is a flag on an OPEN ticket, so it reaches this verb. Unlike assign,
// respec is not a dispatch path: a parked ticket has never been sent, so there
// is nothing to re-deliver, and unparking here would dispatch work the lead
// filed as not-yet-started.

test('respec corrects a PARKED ticket without dispatching or unparking it', () => {
  const f = mkRespec();
  const t = openPinned(f);
  t.parked = true;
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  assert.strictEqual(f.one('t1').parked, true, 'ENTER: the ticket really is parked');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected while parked' });

  assert.match(f.one('t1').spec, /corrected while parked/, 'the record was corrected');
  assert.strictEqual(f.one('t1').parked, true, 'still parked — respec is not a dispatch');
  assert.strictEqual(f.gated.length, 0, 'nothing delivered to the seat');
  assert.match(f.reply(), /parked/, 'the lead is told it was not dispatched');
  // `openPinned` stamps startedAt, so this ticket is started AND parked — the
  // state where `start` refuses. The route must therefore be `assign`.
  assert.match(f.reply(), /task assign t1/, 'a STARTED parked ticket routes to assign, which start would refuse');
});

// The other side of the route predicate: genuinely unstarted and pinned, where
// `start` IS the working verb. Without this the fix could be "always say assign"
// and the bouncing-verb tests above would still pass.
test('an UNSTARTED pinned ticket is routed to `start`, which is the verb that dispatches it', () => {
  const f = mkRespec();
  const t = openRolePinned(f, { started: false });
  assert.ok(!ticketStarted(f.one('t1')) && f.one('t1').assignee,
    'ENTER: unstarted AND assigned — the one shape `start` accepts');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected' });

  assert.match(f.reply(), /task start t1/, 'start is correct here and must not be replaced by assign');
  void t;
});

// The reply must name a verb that RUNS. `_taskStart` refuses a started ticket
// and refuses a backlog one, both redirecting to `assign` — so a note fixed at
// `start` hands back a bouncing command in exactly the states this arm covers.
test('the undispatched note names `assign`, not `start`, where start would bounce', () => {
  // (a) started-then-parked: park accepts a started ticket, so this arm is
  // reachable with startedAt set, and _taskStart refuses it.
  const f = mkRespec();
  const t = openPinned(f);            // openPinned stamps startedAt
  t.parked = true;
  t.role = 'hand';
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  assert.ok(ticketStarted(f.one('t1')) && f.one('t1').parked,
    'ENTER: started AND parked — the state where `start` refuses but this arm is reached');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected' });

  assert.match(f.reply(), /task assign t1 hand/, 'routes to assign, which re-sends a started ticket');
  assert.doesNotMatch(f.reply(), /task start t1/, '`start` would bounce: "already started"');

  // (b) backlog: no assignee at all, and _taskStart refuses with the same redirect.
  const f2 = mkRespec();
  const lead = f2.seat('lead');
  f2.m._handleTask(lead, { type: 'task', sub: 'add', who: null, id: null, body: 'backlog spec' });
  assert.strictEqual(f2.one('t1').assignee, null, 'ENTER: genuinely backlog');

  f2.m._handleTask(lead, { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected backlog' });

  assert.match(f2.reply(), /task assign t1 <role\|name>/, 'backlog routes to assign, which files AND dispatches');
  assert.doesNotMatch(f2.reply(), /task start t1/, '`start` bounces on a backlog ticket');
});

// A backlog ticket has no assignee to deliver to; the correction must still
// land, and the lead must not be told it went somewhere.
test('respec corrects an UNASSIGNED backlog ticket, reporting no delivery', () => {
  const f = mkRespec();
  const lead = f.seat('lead');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: null, id: null, body: 'backlog spec' });
  assert.strictEqual(f.one('t1').assignee, null, 'ENTER: unassigned');
  f.gated.length = 0;

  f.m._handleTask(lead, { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected backlog spec' });

  assert.match(f.one('t1').spec, /corrected backlog spec/);
  assert.strictEqual(f.gated.length, 0, 'nobody to deliver to');
  assert.match(f.reply(), /unassigned/);
  // Pins the ROUTE, not just the absence of delivery: `start` refuses a backlog
  // ticket, so naming it here would be an unusable recovery.
  assert.match(f.reply(), /task assign t1/, 'names assign, the verb that files AND dispatches a backlog ticket');
});

// ── t632: the respec route must not name an assign target that bounces ──────
//
// The same defect t629 fixed on `_taskStart`'s two refusals, on this verb's
// `sendVerb`. The old expression was `ticket.role || ticket.assignee ||
// '<role|name>'`, and that tail placeholder only covers the EMPTY case. It does
// nothing for the STALE one: `_resolveAssignee` accepts exactly a key of
// `team.roles` or a live seat name, and neither field is constrained to be
// either — `team role-remove` deletes the roles key out from under tickets that
// still carry it, and a pinned seat dies. Both routes handed the lead a command
// `assign` then refuses, in the one clause whose entire job is to name the way
// out of an undelivered respec.
//
// Assertions run the emitted target back through `_resolveAssignee` rather than
// matching its spelling, so a rewording that reintroduces a bouncing target reds
// however it is phrased.

// The target out of `[agent:task assign <id> <target>]`, deliberately scoped to
// that bracket. A whole-reply scan for the seat name would be satisfied by a
// bouncing command and an honest one alike — this verb's replies name the
// assignee elsewhere in the same sentence.
function respecAssignTarget(said, id) {
  const m = said.match(new RegExp(`\\[agent:task assign ${id} ([^\\]]+)\\]`));
  assert.ok(m, `the respec reply should name an assign command for ${id} — got: ${said}`);
  return m[1];
}

// Started, then parked: the only shape that reaches the assign arm of `sendVerb`
// with both fields populated. `start` is what records `role`, and `parked` is
// what makes `dispatched` false so the reply carries `sendVerb` at all.
function startedThenParked(f) {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'the spec\ntasks/t1-dir — notes' });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const t = f.one('t1');
  assert.strictEqual(t.role, 'hand', 'ENTER: start recorded the role the ticket was filed under');
  assert.strictEqual(t.assignee, 'team-hand', 'ENTER: and re-pinned the assignee to the live seat');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'park', id: 't1', who: null, body: '' });
  assert.strictEqual(f.one('t1').parked, true, 'ENTER: parked, so respec reports NOT dispatched and names a send verb');
  assert.ok(ticketStarted(f.one('t1')),
    'ENTER: and STARTED — that is the term routing sendVerb to `assign` rather than `start`, which is the clause under test');
  f.injected.length = 0;
  return t;
}

test('t632: respec on a ticket carrying a REMOVED role key names a target that resolves', () => {
  const f = mkRespec();
  startedThenParked(f);

  // `team role-remove` deletes the key outright (team-manifest.js), so a ticket
  // outliving its role needs no fixture surgery to reach.
  delete f.team.roles.hand;
  assert.strictEqual(f.m._resolveAssignee(f.team, 'hand'), null,
    'ENTER: `assign t1 hand` now bounces — exactly the state the old raw `ticket.role` walked into');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected\ntasks/t1-dir — notes' });
  const target = respecAssignTarget(f.reply(), 't1');
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  assert.strictEqual(target, 'team-hand', 'the live pin is what remains recoverable once the role key is gone');
});

test('t632: respec still names the ROLE when it resolves, so "always emit the placeholder" reds', () => {
  const f = mkRespec();
  startedThenParked(f);
  assert.strictEqual(f.m._resolveAssignee(f.team, 'hand'), 'hand', 'ENTER: the role is intact here — the anti-degenerate half');

  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'respec', who: null, id: 't1', body: 'corrected\ntasks/t1-dir — notes' });
  const target = respecAssignTarget(f.reply(), 't1');
  assert.ok(f.m._resolveAssignee(f.team, target) != null,
    `the named target must be one assign accepts — got ${target}`);
  // A lead handed `<role|name>` for a ticket whose role is right there has to go
  // look it up, so degrading to the placeholder is not a safe universal answer.
  assert.strictEqual(target, 'hand', 'and it is the role the ticket was filed under, not the placeholder');
});
