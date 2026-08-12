'use strict';
// Run: node --test test/task-start.test.js
//
// t308 §1 — `task start` is the seam dispatch was split onto. Before it, `add`
// wrote the ticket AND spawned the seat in one act, so there was no moment the
// loop could hang a step on: "the lead filed this" and "this is running" were
// the same event, and every later step (verify, review, auto-reject) needs them
// to be two.
//
// The fixture is deliberately the one the ticket verbs already use in
// session-manager.test.js (a real temp clodex HOME so the board round-trips to
// disk), rebuilt here rather than imported: these assertions are about the verb,
// and coupling them to that file's fixture would make either file's edits break
// the other.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');

function mkStart(extra = {}) {
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-ts-'));
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: { instantiate: 'subagent', brief: 'the reviewer' },
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
    notes: () => injected.join('\n'),
  };
}

// Ordinary open-then-start, used wherever the test's subject is what start DOES
// rather than how the ticket got there.
function opened(f, who = 'hand', body = 'the spec') {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who, id: null, body });
  assert.strictEqual(f.gated.length, 0, 'ENTER: add delivered nothing — otherwise the delivery below is not start`s');
  return f.one('t1');
}

// ── the grammar ────────────────────────────────────────────────────────────
// `start` parses like `park`: an id positional and NO body. The body mode
// matters beyond tidiness — a greedy verb captures the lines that follow it in
// the turn, so a mis-registered `start` would swallow the lead's next intent.

test('grammar: [agent:task start <id>] parses id-positional with no body', () => {
  assert.deepStrictEqual(parseIntent('[agent:task start t7]'),
    { type: 'task', sub: 'start', id: 't7', who: null, body: '' });
  // Trailing prose is DISCARDED, not captured: start takes no body, and text
  // after the bracket is the lead thinking out loud.
  assert.deepStrictEqual(parseIntent('[agent:task start t7] go on then'),
    { type: 'task', sub: 'start', id: 't7', who: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task start]'),
    { type: 'task', sub: 'start', id: null, who: null, body: '' });
});

test('grammar: start carries no body, so it cannot swallow the next line of the turn', () => {
  const { bodyModeFor } = require('../intent-registry');
  // ENTER: bodyModeFor(null) is ALSO 'none', so without this the assertion below
  // is satisfied by a `start` that does not parse at all — it passed against the
  // unfixed source for exactly that reason.
  assert.ok(parseIntent('[agent:task start t7]'), 'ENTER: start must parse, or "none" below is the null default');
  assert.strictEqual(bodyModeFor(parseIntent('[agent:task start t7]')), 'none');
  // The contrast that makes the assertion mean something: add IS greedy, so
  // "none" here is a real choice rather than the default for every task verb.
  assert.strictEqual(bodyModeFor(parseIntent('[agent:task add hand] spec')), 'greedy');
});

test('grammar: the alternation is closed — `started` is not `start`', () => {
  assert.strictEqual(parseIntent('[agent:task started t1]'), null,
    'a near-miss must not dispatch: `started` reads as a status report, and parsing it as start would run work the lead was describing, not requesting');
});

// ── add no longer dispatches ───────────────────────────────────────────────

test('add writes the ticket and spawns NOTHING, even for an assigned, unparked ticket', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget' });
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket was minted, so the absences below are about dispatch and not about a failed add');
  assert.deepStrictEqual(f.gated, [], 'no delivery');
  assert.strictEqual(t.assignee, 'hand', 'still on the ROLE — the re-pin is a delivery-time act');
  assert.strictEqual(t.role, undefined, 'and no delivery-time role marker');
});

// ── start dispatches ───────────────────────────────────────────────────────

test('start delivers the spec, re-pins to the receiving seat, and wakes it', () => {
  const f = mkStart();
  opened(f, 'hand', 'build the widget\ndetail');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] build the widget\ndetail' }]);
  // Urgency is the t82 property, and it belongs to whichever verb dispatches:
  // a work assignment that sits parked leaves the board reading "assigned"
  // while nothing runs.
  assert.deepStrictEqual(f.urgents, [true], 'the dispatch wakes the seat');
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand', 'pinned to the seat that received it');
  assert.strictEqual(t.role, 'hand', 'and the filed role survives the pin');
});

test('start unparks: a parked ticket is one nobody started, and starting it clears the flag', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'later work' });
  assert.strictEqual(f.one('t1').parked, true, 'ENTER: parked, or the clear below asserts nothing');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  // Absence, not `false` — the store's convention, and a started ticket left
  // flagged stays EXEMPT from the stall watchdog, which is the only backstop a
  // loop step that dies has.
  assert.ok(!('parked' in f.one('t1')), 'the flag is cleared, not stored false');
  assert.strictEqual(f.gated.length, 1, 'and the spec goes out');
});

test('start resets the stall clock, so the watchdog measures from the dispatch', () => {
  const f = mkStart();
  const t = opened(f);
  // A ticket can sit unstarted for days; the watchdog's question is "has this
  // been running too long without progress", so its clock starts at dispatch.
  const openedAt = t.lastActivityAt;
  f.one('t1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const after = f.one('t1');
  assert.ok(after.lastActivityAt >= openedAt, 'ENTER: the stamp moved forward or held, never backwards');
  assert.strictEqual(after.nudgedAt, null, 'a fresh stall episode — a stamp left from before the start would spend its one nudge');
});

// ── the refusals, each with the reason named ───────────────────────────────

test('start is lead-only', () => {
  const f = mkStart();
  opened(f);
  f.gated.length = 0;
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.match(f.notes(), /only the team lead \(lead\) can start a ticket/);
  assert.deepStrictEqual(f.gated, [], 'nothing dispatched by a non-lead');
});

test('start refuses an unknown id, and names it', () => {
  const f = mkStart();
  f.seat('lead');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't99', body: '' });
  assert.match(f.notes(), /no ticket t99 on team/);
});

test('start refuses a missing id rather than guessing a ticket', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: null, body: '' });
  assert.match(f.notes(), /start needs a ticket id/);
  assert.deepStrictEqual(f.gated, [], 'no ticket is picked for the lead — a wrong guess dispatches real work');
});

test('start refuses a ticket that is not open, naming the state it is in', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't1', body: 'never mind' });
  assert.strictEqual(f.one('t1').state, 'cancelled', 'ENTER: the ticket really left the open state');
  f.gated.length = 0;
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.match(f.notes(), /ticket t1 is cancelled, not open/);
  assert.deepStrictEqual(f.gated, [], 'a cancel is a decision the lead already made — start must not overrule it');
});

test('start refuses a BACKLOG ticket and points at assign, which files AND dispatches', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: null, id: null, body: 'someday' });
  assert.strictEqual(f.one('t1').assignee, null, 'ENTER: backlog means no assignee');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.match(f.notes(), /ticket t1 is backlog \(no assignee\)/);
  // The recovery has to be USABLE: start cannot invent an assignee, so the
  // reply names the verb that takes one.
  assert.match(f.notes(), /\[agent:task assign t1 <role\|name>\]/, 'and names the verb that can supply one');
  assert.deepStrictEqual(f.gated, [], 'nothing dispatched');
});

test('start refuses a ticket already started, and points at the re-send verb', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1, 'ENTER: the FIRST start dispatched — the second is what must refuse');
  assert.strictEqual(f.one('t1').assignee, 'team-hand', 'ENTER: and it left the seat pin the refusal keys off');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.gated.length, 1,
    'a second start must NOT re-deliver: the seat is mid-work, and a duplicate spec is indistinguishable from a fresh assignment from inside it');
  assert.match(f.notes(), /ticket t1 is already started/);
  assert.match(f.notes(), /\[agent:task assign t1 hand\]/, 'and names assign as the deliberate re-send');
});

test('a name-addressed ticket carries no role, and is still startable', () => {
  const f = mkStart();
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'team-hand', id: null, body: 'name-addressed work' });
  const t = f.one('t1');
  assert.strictEqual(t.assignee, 'team-hand', 'ENTER: the SEAT NAME is the assignee');
  assert.strictEqual(t.role, undefined, 'ENTER: and no role — this is the shape the started-check must not mistake for started');
  // ENTER: add must have delivered NOTHING, or the delivery asserted below is
  // add's and this passes without `start` existing at all.
  assert.deepStrictEqual(f.gated, [], 'ENTER: add dispatched nothing, so the delivery below belongs to start');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: '[ticket t1] name-addressed work' }],
    'a seat-named ticket must start — reading "assignee is a live seat name" as "already started" would make every one of them unstartable');
});

test('start on a role with nobody live keeps the ticket on the role and says so', () => {
  const f = mkStart();
  f.seat('lead');   // no team-hand
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body: 'spec' });
  // ENTER: the warning must come from START. Against the pre-t308 source, `add`
  // itself emitted this text, so without pinning where it comes from the test
  // passes whether or not `start` exists.
  assert.doesNotMatch(f.notes(), /no live seat/, 'ENTER: add says nothing about delivery — it does not attempt one');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  assert.strictEqual(f.one('t1').assignee, 'hand', 'the role stays the durable assignee');
  assert.deepStrictEqual(f.gated, [], 'nothing to deliver to');
  assert.match(f.notes(), /no live seat for "hand"/,
    'the lead must learn the spec did not land — believing it started is what leaves a ticket silently unworked');
});

// The ticket is still open and still assigned after a refusal, so a lead that
// fixes the cause can start it. A refusal that half-mutated would leave the
// board describing a dispatch that never happened.
test('a refused start changes nothing on the record', () => {
  const f = mkStart();
  opened(f);
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });
  const afterFirst = JSON.stringify(f.one('t1'));
  f.m._handleTask(f.seat('team-hand'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });   // non-lead
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', who: null, id: 't1', body: '' });        // already started
  assert.strictEqual(JSON.stringify(f.one('t1')), afterFirst,
    'neither refusal touched the record — a refusal that stamped lastActivityAt would defer the watchdog nudge once per retry');
});
