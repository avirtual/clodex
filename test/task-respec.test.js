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
const { intentEnabled } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');

function mkRespec(extra = {}) {
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-respec-'));
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

// A ticket open and pinned to a live seat — the state the whole verb is for.
// Asserts the seat really resolves, so a delivery assertion below cannot pass
// vacuously against a ticket nobody holds.
function openPinned(f, spec = 'the original spec\nwith detail') {
  const lead = f.seat('lead');
  f.seat('team-hand');
  f.m._handleTask(lead, { type: 'task', sub: 'add', who: 'hand', id: null, body: spec });
  const t = f.one('t1');
  t.assignee = 'team-hand';
  delete t.role;
  f.tstore.save(f.team.root, f.load().map((x) => (x.id === 't1' ? t : x)));
  assert.strictEqual(f.m._ticketAssigneeSeat(f.team, f.one('t1')), 'team-hand',
    'ENTER: the ticket resolves to a live seat — otherwise every delivery assertion below is vacuous');
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
});
